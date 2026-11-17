from pathlib import Path

from .project_format.service import (
    PROJECT_CONFIG_FILE,
    PROJECT_SUFFIX,
    ProjectFormatError,
    read_project_config_payload,
    validate_project_folder,
)
from .project_format.manifest import ProjectManifestError, parse_project_manifest
from .schemas.project_session import (
    ProjectCatalogEntry,
    ProjectCatalogResponse,
    ProjectDirectoryEntry,
    ProjectDirectoryListingResponse,
)

DEFAULT_PROJECT_DIRECTORY_NAME = ".narrative"


class ProjectCatalogError(ValueError):
    """Reports an unreadable or invalid user-selected workspace directory."""


class ProjectDirectoryError(ValueError):
    """Reports a directory that cannot be exposed by the local folder browser."""


def list_project_directories(directory: Path | None = None) -> ProjectDirectoryListingResponse:
    """Resolve one directory and expose only its readable immediate children."""

    resolved = (directory or Path.home()).expanduser().resolve()
    if not resolved.is_dir():
        raise ProjectDirectoryError(f"Directory does not exist: {resolved}")
    try:
        children = [
            ProjectDirectoryEntry(name=child.name, path=str(child.resolve()))
            for child in resolved.iterdir()
            if _is_navigable_directory(child)
        ]
    except OSError as error:
        raise ProjectDirectoryError(f"Directory cannot be read: {resolved}") from error
    children.sort(key=lambda child: child.name.casefold())
    parent = resolved.parent if resolved.parent != resolved else None
    return ProjectDirectoryListingResponse(
        directory=str(resolved),
        parent=str(parent) if parent else None,
        directories=children,
    )


def discover_project_catalog(
    directory: Path | None = None,
    *,
    home_directory: Path | None = None,
) -> ProjectCatalogResponse:
    """Create the default directory when needed and list valid direct children."""

    default_directory = (home_directory or Path.home()) / DEFAULT_PROJECT_DIRECTORY_NAME
    requested_default = directory is None
    resolved = (default_directory if requested_default else directory).expanduser().resolve()
    if requested_default:
        try:
            resolved.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            raise ProjectCatalogError(f"Default project directory cannot be created: {resolved}") from error
    if not resolved.is_dir():
        raise ProjectCatalogError(f"Project directory does not exist: {resolved}")

    try:
        candidates = sorted(
            (
                child
                for child in resolved.iterdir()
                if child.is_dir() and child.suffix == PROJECT_SUFFIX
            ),
            key=lambda child: child.name.casefold(),
        )
    except OSError as error:
        raise ProjectCatalogError(f"Project directory cannot be read: {resolved}") from error

    projects = [
        entry
        for candidate in candidates
        if (entry := _catalog_entry(candidate)) is not None
    ]
    projects.sort(key=lambda project: (project.updated_at, project.name.casefold()), reverse=True)
    return ProjectCatalogResponse(
        directory=str(resolved),
        is_default=requested_default,
        projects=projects,
    )


def _catalog_entry(path: Path) -> ProjectCatalogEntry | None:
    """Ignore malformed candidates so one broken folder cannot block discovery."""

    try:
        folder = validate_project_folder(path)
        manifest = parse_project_manifest(
            read_project_config_payload(path / PROJECT_CONFIG_FILE)
        )
    except (OSError, ProjectFormatError, ProjectManifestError):
        return None
    return ProjectCatalogEntry(
        project_id=folder.project_id,
        name=folder.name,
        description=folder.description,
        path=str(path.resolve()),
        format_version=folder.format_version,
        updated_at=manifest.updated_at,
    )


def _is_navigable_directory(path: Path) -> bool:
    """Filter inaccessible entries without failing the entire directory level."""

    try:
        return path.is_dir() and (
            not path.name.startswith(".")
            or path.name == DEFAULT_PROJECT_DIRECTORY_NAME
        )
    except OSError:
        return False

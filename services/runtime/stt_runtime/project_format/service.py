import json
import os
import sqlite3
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from pydantic import ValidationError

from .manifest import (
    PROJECT_FORMAT_VERSION,
    ProjectManifestError,
    ProjectManifestV2,
    ProjectSettings,
    create_project_manifest,
    parse_project_manifest,
)

PROJECT_SUFFIX = ".narrative"
PROJECT_CONFIG_FILE = "project.config.json"
PROJECT_DATABASE_FILE = "project.sqlite"
PROJECT_DIRECTORIES = ("assets", "exports", "snapshots", "styles", "cache")


class ProjectFormatError(ValueError):
    def __init__(self, message: str, *, missing: list[str] | None = None) -> None:
        super().__init__(message)
        self.missing = missing or []


@dataclass(frozen=True)
class ProjectFolder:
    path: Path
    project_id: str
    name: str
    description: str
    format_version: int


def create_project_folder(
    path: Path,
    name: str | None = None,
    *,
    description: str = "",
    settings: ProjectSettings | None = None,
) -> ProjectFolder:
    project_path = _normalize_project_path(path)
    _ensure_project_suffix(project_path)

    if project_path.exists() and not project_path.is_dir():
        raise ProjectFormatError(f"Project path exists and is not a folder: {project_path}")

    if project_path.exists() and any(project_path.iterdir()):
        raise ProjectFormatError(f"Project folder is not empty: {project_path}")

    project_name = name or project_path.stem
    project_path.mkdir(parents=True, exist_ok=True)

    for directory in PROJECT_DIRECTORIES:
        (project_path / directory).mkdir(exist_ok=True)

    _initialize_sqlite_database(project_path / PROJECT_DATABASE_FILE)
    manifest = _write_project_config(
        project_path / PROJECT_CONFIG_FILE,
        project_name,
        description=description,
        settings=settings,
    )

    return _project_folder(project_path, manifest)


def validate_project_folder(path: Path) -> ProjectFolder:
    project_path = _normalize_project_path(path)
    _ensure_project_suffix(project_path)

    missing = _missing_required_entries(project_path)
    if missing:
        raise ProjectFormatError(
            f"Project folder is missing required entries: {', '.join(missing)}",
            missing=missing,
        )

    manifest = _read_project_config(project_path / PROJECT_CONFIG_FILE)
    return _project_folder(project_path, manifest)


def _normalize_project_path(path: Path) -> Path:
    return path.expanduser().resolve()


def _ensure_project_suffix(path: Path) -> None:
    if path.suffix != PROJECT_SUFFIX:
        raise ProjectFormatError(f"Project folder must end with {PROJECT_SUFFIX}: {path}")


def _initialize_sqlite_database(path: Path) -> None:
    connection = sqlite3.connect(path)
    connection.close()


def _write_project_config(
    path: Path,
    name: str,
    *,
    description: str = "",
    settings: ProjectSettings | None = None,
) -> ProjectManifestV2:
    manifest = create_project_manifest(
        project_id=str(uuid4()),
        name=name,
        now=datetime.now(UTC),
        description=description,
        settings=settings,
    )
    write_project_manifest(path, manifest)
    return manifest


def _read_project_config(path: Path) -> ProjectManifestV2:
    payload = read_project_config_payload(path)
    try:
        return parse_project_manifest(payload)
    except ProjectManifestError as error:
        raise ProjectFormatError(f"Project config is invalid: {error}") from error
    except ValidationError as error:
        details = "; ".join(
            f"{'.'.join(str(part) for part in item['loc'])}: {item['msg']}"
            for item in error.errors(include_input=False)
        )
        raise ProjectFormatError(f"Project config is invalid: {details}") from error


def read_project_config_payload(path: Path) -> dict[str, object]:
    """Read JSON without applying a version migration or modifying the file."""

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise ProjectFormatError(f"Project config cannot be read: {path}") from error
    except json.JSONDecodeError as error:
        raise ProjectFormatError(f"Project config is invalid JSON: {path}") from error

    if not isinstance(payload, dict):
        raise ProjectFormatError(f"Project config root must be an object: {path}")
    return payload


def write_project_manifest(path: Path, manifest: ProjectManifestV2) -> None:
    """Atomically replace portable metadata after the caller has made a backup."""

    payload = manifest.model_dump(mode="json")
    temporary_path = path.with_name(f".{path.name}.tmp")
    with temporary_path.open("w", encoding="utf-8") as temporary:
        temporary.write(json.dumps(payload, indent=2, sort_keys=True) + "\n")
        temporary.flush()
        os.fsync(temporary.fileno())
    temporary_path.replace(path)
    # Windows CRT cannot open directories for fsync. The file was already
    # flushed before atomic replacement; do not claim POSIX directory durability.
    if sys.platform == "win32":
        return
    directory_fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def _project_folder(path: Path, manifest: ProjectManifestV2) -> ProjectFolder:
    return ProjectFolder(
        path=path,
        project_id=manifest.project_id,
        name=manifest.name,
        description=manifest.description,
        format_version=manifest.format_version,
    )


def _missing_required_entries(path: Path) -> list[str]:
    missing: list[str] = []

    if not path.is_dir():
        missing.append(".")
        return missing

    for filename in (PROJECT_DATABASE_FILE, PROJECT_CONFIG_FILE):
        if not (path / filename).is_file():
            missing.append(filename)

    for directory in PROJECT_DIRECTORIES:
        if not (path / directory).is_dir():
            missing.append(f"{directory}/")

    return missing

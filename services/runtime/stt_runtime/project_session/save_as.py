from pathlib import Path
import shutil
from typing import Iterable
from uuid import uuid4

from ..project_document.service import ProjectDocumentService
from ..project_format.manifest import ProjectManifestV2
from ..project_format.service import (
    PROJECT_CONFIG_FILE,
    PROJECT_DATABASE_FILE,
    PROJECT_SUFFIX,
    create_project_folder,
    write_project_manifest,
)
from .scoped_uow import project_unit_of_work
from ..schemas.project_document import ProjectDocument
from ..schemas.project_session import ProjectSessionSaveAsResponse, ProjectSessionState
from .checkpoints import backup_sqlite, checkpoint_path
from .database import create_session_factory, ensure_project_root, open_database, upgrade_database
from .errors import ProjectSessionError


def validate_save_as_destination(source: Path, destination: Path) -> None:
    """Keep staging and replacement outside the source project tree."""

    if destination.suffix != PROJECT_SUFFIX:
        raise ProjectSessionError(
            "project_suffix_invalid",
            required_suffix=PROJECT_SUFFIX,
        )
    if destination == source or source in destination.parents:
        raise ProjectSessionError("project_save_as_destination_invalid")
    if not destination.parent.is_dir():
        raise ProjectSessionError(
            "project_save_as_parent_missing",
            path=str(destination.parent),
        )


def validate_portable_assets(
    project_path: Path,
    asset_paths: Iterable[str],
) -> None:
    """Fail before staging when a manifest-owned relative asset is unavailable."""

    for relative_path in asset_paths:
        if not (project_path / relative_path).exists():
            raise ProjectSessionError(
                "project_save_as_asset_missing",
                path=relative_path,
            )
    for directory in ("assets", "exports", "snapshots", "styles"):
        for candidate in (project_path / directory).rglob("*"):
            if candidate.is_symlink():
                raise ProjectSessionError(
                    "project_save_as_symlink_unsupported",
                    path=str(candidate.relative_to(project_path)),
                )


def install_save_as_copy(
    source_path: Path,
    source_state: ProjectSessionState,
    destination: Path,
    manifest: ProjectManifestV2,
    document: ProjectDocument,
    *,
    replace_existing: bool,
) -> ProjectSessionSaveAsResponse:
    """Build beside the destination, then replace it with rollback ownership."""

    staging = destination.parent / (
        f".{destination.stem}.save-as-{uuid4().hex}.tmp{PROJECT_SUFFIX}"
    )
    backup: Path | None = None
    try:
        build_portable_copy(source_path, staging, destination, manifest, document)
        if destination.exists():
            if not replace_existing:
                raise ProjectSessionError(
                    "project_save_as_destination_exists",
                    path=str(destination),
                )
            backup = destination.with_name(
                f"{destination.name}.backup-{uuid4().hex[:8]}"
            )
            destination.replace(backup)
        try:
            staging.replace(destination)
        except Exception:
            if backup is not None and backup.exists() and not destination.exists():
                backup.replace(destination)
            raise
        return ProjectSessionSaveAsResponse(
            source_session=source_state,
            destination_path=str(destination),
            project_id=manifest.project_id,
            saved_revision=manifest.saved_revision,
            backup_path=str(backup) if backup is not None else None,
        )
    except ProjectSessionError:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    except Exception as error:
        shutil.rmtree(staging, ignore_errors=True)
        if backup is not None and backup.exists() and not destination.exists():
            backup.replace(destination)
        raise ProjectSessionError("project_save_as_failed") from error


def build_portable_copy(
    source: Path,
    staging: Path,
    destination: Path,
    manifest: ProjectManifestV2,
    document: ProjectDocument,
) -> None:
    """Materialize one local SQLite authority without copying runtime secrets."""

    create_project_folder(
        staging,
        manifest.name,
        description=manifest.description,
        settings=manifest.settings,
    )
    for directory in ("assets", "exports", "styles"):
        shutil.copytree(source / directory, staging / directory, dirs_exist_ok=True)
    source_snapshots = source / "snapshots"
    if any(source_snapshots.iterdir()):
        history = staging / "snapshots" / (
            f"source-history-{manifest.saved_revision:08d}"
        )
        shutil.copytree(source_snapshots, history)

    write_project_manifest(staging / PROJECT_CONFIG_FILE, manifest)
    upgrade_database(
        staging / PROJECT_DATABASE_FILE,
        project_path=staging,
        backup_existing=False,
    )
    engine = open_database(staging / PROJECT_DATABASE_FILE)
    try:
        session_factory = create_session_factory(engine)
        ensure_project_root(session_factory, destination, manifest)
        with project_unit_of_work(session_factory, manifest) as uow:
            copied = ProjectDocumentService().reconcile(uow, document)
        if copied.checksum != document.checksum:
            raise ProjectSessionError("project_save_as_checksum_mismatch")
    finally:
        engine.dispose()

    checkpoint = checkpoint_path(staging, manifest.saved_revision)
    checkpoint.mkdir(parents=False, exist_ok=False)
    backup_sqlite(
        staging / PROJECT_DATABASE_FILE,
        checkpoint / PROJECT_DATABASE_FILE,
    )
    write_project_manifest(checkpoint / PROJECT_CONFIG_FILE, manifest)

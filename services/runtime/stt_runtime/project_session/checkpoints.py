import json
from pathlib import Path
import shutil
from uuid import uuid4

from pydantic import ValidationError
from sqlalchemy.orm import Session, sessionmaker

from ..project_document.service import ProjectDocumentService
from ..db.sqlite_backup import backup_sqlite
from ..project_format.manifest import ProjectManifestError, ProjectManifestV2, parse_project_manifest
from ..project_format.service import (
    PROJECT_CONFIG_FILE,
    PROJECT_DATABASE_FILE,
    ProjectFormatError,
    read_project_config_payload,
    write_project_manifest,
)
from ..repositories.sqlite import SqlAlchemyUnitOfWork
from ..schemas.project_document import ProjectDocument, parse_project_document
from .database import create_session_factory, open_database
from .documents import document_with_manifest
from .errors import ProjectSessionError

CHECKPOINT_PREFIX = "revision-"
MAX_CHECKPOINTS = 3
PROJECT_DOCUMENT_CHECKPOINT_FILE = "project.document.json"
RECOVERY_MARKER_FILENAME = "save-recovery.json"


def checkpoint_path(project_path: Path, revision: int) -> Path:
    """Return the deterministic checkpoint path for a saved revision."""

    return project_path / "snapshots" / f"{CHECKPOINT_PREFIX}{revision:08d}"


def recovery_marker_path(project_path: Path) -> Path:
    """Return the project-local marker used for crash recovery."""

    return project_path / "cache" / RECOVERY_MARKER_FILENAME


def stage_checkpoint(
    project_path: Path,
    session_factory: sessionmaker[Session],
    manifest: ProjectManifestV2,
) -> Path:
    """Build a checkpoint without publishing it as the current saved revision."""

    staged = project_path / "snapshots" / f".checkpoint-{uuid4().hex}.tmp"
    staged.mkdir(parents=False, exist_ok=False)
    try:
        if manifest.settings.storage.mode == "local_sqlite":
            backup_sqlite(
                project_path / PROJECT_DATABASE_FILE,
                staged / PROJECT_DATABASE_FILE,
            )
        else:
            with SqlAlchemyUnitOfWork(session_factory, project_id=manifest.project_id) as uow:
                document = ProjectDocumentService().load(uow, manifest)
            (staged / PROJECT_DOCUMENT_CHECKPOINT_FILE).write_text(
                json.dumps(
                    document.model_dump(mode="json"),
                    ensure_ascii=True,
                    indent=2,
                    sort_keys=True,
                )
                + "\n",
                encoding="utf-8",
            )
        write_project_manifest(staged / PROJECT_CONFIG_FILE, manifest)
        return staged
    except Exception:
        shutil.rmtree(staged, ignore_errors=True)
        raise


def restore_local_checkpoint(project_path: Path, checkpoint: Path) -> None:
    """Restore SQLite and manifest while discarding WAL from the abandoned image."""

    database = project_path / PROJECT_DATABASE_FILE
    temporary_database = database.with_suffix(".restore.tmp")
    shutil.copy2(checkpoint / PROJECT_DATABASE_FILE, temporary_database)
    Path(f"{database}-wal").unlink(missing_ok=True)
    Path(f"{database}-shm").unlink(missing_ok=True)
    temporary_database.replace(database)
    write_project_manifest(
        project_path / PROJECT_CONFIG_FILE,
        read_checkpoint_manifest(checkpoint / PROJECT_CONFIG_FILE),
    )


def read_document_checkpoint(checkpoint: Path) -> ProjectDocument:
    """Validate a secret-free external-storage checkpoint before restore."""

    try:
        payload = json.loads(
            (checkpoint / PROJECT_DOCUMENT_CHECKPOINT_FILE).read_text(encoding="utf-8")
        )
        return parse_project_document(payload)
    except (OSError, json.JSONDecodeError, ValidationError, ValueError) as error:
        raise ProjectSessionError("project_checkpoint_invalid") from error


def load_checkpoint_document(
    checkpoint: Path,
    manifest: ProjectManifestV2,
) -> ProjectDocument:
    """Read either checkpoint representation under its current saved manifest."""

    database = checkpoint / PROJECT_DATABASE_FILE
    if database.is_file():
        engine = open_database(database)
        try:
            with SqlAlchemyUnitOfWork(create_session_factory(engine), project_id=manifest.project_id) as uow:
                return ProjectDocumentService().load(uow, manifest)
        finally:
            engine.dispose()
    return document_with_manifest(read_document_checkpoint(checkpoint), manifest)


def read_checkpoint_manifest(path: Path) -> ProjectManifestV2:
    """Parse a checkpoint manifest and normalize failures to lifecycle errors."""

    try:
        return parse_project_manifest(read_project_config_payload(path))
    except (ProjectFormatError, ProjectManifestError, ValidationError) as error:
        raise ProjectSessionError("project_checkpoint_invalid") from error


def prune_checkpoints(project_path: Path) -> None:
    """Retain only the bounded set of newest revision checkpoints."""

    checkpoints = sorted(
        path
        for path in (project_path / "snapshots").glob(f"{CHECKPOINT_PREFIX}*")
        if path.is_dir()
    )
    for checkpoint in checkpoints[:-MAX_CHECKPOINTS]:
        shutil.rmtree(checkpoint)

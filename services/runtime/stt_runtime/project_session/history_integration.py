from dataclasses import dataclass
from pathlib import Path

from ..project_format.manifest import ProjectManifestV2
from ..schemas.project_session import ProjectSessionState
from ..project_document.restore import restore_history_in_place
from ..project_document.service import ProjectDocumentService


@dataclass(frozen=True, slots=True)
class HistoryPersistenceSnapshot:
    """State needed to roll back manifest and recovery metadata atomically."""

    state: ProjectSessionState
    manifest: ProjectManifestV2
    config_bytes: bytes
    marker_bytes: bytes | None


def reconcile_history_document(uow, candidate, *, current=None):
    """Reuse only this command's fresh source; unsupported structure stays complete."""
    documents = ProjectDocumentService()
    if current is None or not restore_history_in_place(uow, current, candidate):
        return documents.reconcile(uow, candidate)
    restored = documents.load(uow, candidate.manifest)
    # Validate exact persisted fields before local commit or the remote owner's
    # borrowed flush. A bad restore must not advance data with an unchanged stack.
    if restored.checksum != candidate.checksum:
        raise ValueError("history_restore_checksum_mismatch")
    uow.commit()
    return restored


def capture_history_persistence(
    state: ProjectSessionState,
    manifest: ProjectManifestV2,
    config_path: Path,
    marker_path: Path,
) -> HistoryPersistenceSnapshot:
    """Capture lifecycle-owned files before a history-backed document commit."""

    return HistoryPersistenceSnapshot(
        state=state,
        manifest=manifest,
        config_bytes=config_path.read_bytes(),
        marker_bytes=marker_path.read_bytes() if marker_path.is_file() else None,
    )


def restore_history_persistence(
    snapshot: HistoryPersistenceSnapshot,
    config_path: Path,
    marker_path: Path,
) -> None:
    """Restore lifecycle files after a failed history or authoring commit."""

    config_path.write_bytes(snapshot.config_bytes)
    if snapshot.marker_bytes is None:
        marker_path.unlink(missing_ok=True)
    else:
        marker_path.write_bytes(snapshot.marker_bytes)

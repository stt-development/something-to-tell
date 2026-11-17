from datetime import UTC, datetime
from pathlib import Path

import pytest

from services.runtime.stt_runtime.project_format.manifest import parse_project_manifest
from services.runtime.stt_runtime.project_format.service import (
    PROJECT_CONFIG_FILE,
    create_project_folder,
    read_project_config_payload,
)
from services.runtime.stt_runtime.project_session.checkpoints import (
    checkpoint_path,
    prune_checkpoints,
    recovery_marker_path,
)
from services.runtime.stt_runtime.project_session.documents import replace_project_identity
from services.runtime.stt_runtime.project_session.errors import ProjectSessionError
from services.runtime.stt_runtime.project_session.history_integration import (
    capture_history_persistence,
    restore_history_persistence,
)
from services.runtime.stt_runtime.project_session.save_as import (
    validate_save_as_destination,
)
from services.runtime.stt_runtime.project_session.storage_migration import (
    prepare_migration_target,
)
from services.runtime.stt_runtime.schemas.project_session import ProjectSessionState
from services.runtime.stt_runtime.storage_profiles import StorageProfileRegistry


def test_replace_project_identity_rebinds_typed_and_json_owners() -> None:
    source = "source-project"
    destination = "destination-project"
    value = {
        "project_id": source,
        "metadata": '{"nested":{"project_id":"source-project"}}',
        "unrelated": "source-project",
    }

    rebound = replace_project_identity(value, source, destination)

    assert rebound == {
        "project_id": destination,
        "metadata": '{"nested":{"project_id":"destination-project"}}',
        "unrelated": source,
    }


@pytest.mark.parametrize("revisions", [(0, 1, 2, 3, 4), (4, 1, 3, 0, 2)])
def test_checkpoint_paths_are_deterministic_and_pruning_is_bounded(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    revisions: tuple[int, ...],
) -> None:
    project_path = tmp_path / "Checkpoint.narrative"
    (project_path / "snapshots").mkdir(parents=True)
    (project_path / "cache").mkdir()
    for revision in revisions:
        checkpoint_path(project_path, revision).mkdir()

    original_iterdir = Path.iterdir

    def unordered_entries(path: Path):
        entries = list(original_iterdir(path))
        if path == project_path / "snapshots":
            # Directory order is unspecified; reproduce the Linux CI listing.
            entries.sort(key=lambda entry: entry.name)
            entries = entries[1:] + entries[:1]
        return iter(entries)

    monkeypatch.setattr(Path, "iterdir", unordered_entries)
    prune_checkpoints(project_path)

    names = [path.name for path in (project_path / "snapshots").iterdir()]
    assert names != sorted(names)
    assert sorted(names) == [
        "revision-00000002",
        "revision-00000003",
        "revision-00000004",
    ]
    assert recovery_marker_path(project_path) == project_path / "cache/save-recovery.json"


def test_save_as_destination_validation_rejects_nested_and_invalid_paths(
    tmp_path: Path,
) -> None:
    source = tmp_path / "Source.narrative"
    source.mkdir()

    with pytest.raises(ProjectSessionError) as nested:
        validate_save_as_destination(source, source / "Nested.narrative")
    with pytest.raises(ProjectSessionError) as suffix:
        validate_save_as_destination(source, tmp_path / "Copy")

    assert nested.value.code == "project_save_as_destination_invalid"
    assert suffix.value.code == "project_suffix_invalid"


def test_history_persistence_snapshot_restores_manifest_and_marker(
    tmp_path: Path,
) -> None:
    project_path = tmp_path / "History.narrative"
    create_project_folder(project_path, "History")
    config_path = project_path / PROJECT_CONFIG_FILE
    manifest = parse_project_manifest(read_project_config_payload(config_path))
    marker_path = recovery_marker_path(project_path)
    marker_path.write_bytes(b"original-marker")
    state = ProjectSessionState(
        session_id="session",
        project_id=manifest.project_id,
        project_path=str(project_path),
        storage_mode="local_sqlite",
        loaded_revision=0,
        saved_revision=0,
        opened_at=datetime.now(UTC),
    )
    snapshot = capture_history_persistence(
        state,
        manifest,
        config_path,
        marker_path,
    )
    config_path.write_bytes(b"changed")
    marker_path.unlink()

    restore_history_persistence(snapshot, config_path, marker_path)

    restored_manifest = parse_project_manifest(read_project_config_payload(config_path))
    assert restored_manifest == manifest
    assert marker_path.read_bytes() == b"original-marker"
    assert snapshot.state is state


def test_local_storage_migration_target_is_provisioned_without_registry_state(
    tmp_path: Path,
) -> None:
    project_path = tmp_path / "Migration.narrative"
    create_project_folder(project_path, "Migration")
    manifest = parse_project_manifest(
        read_project_config_payload(project_path / PROJECT_CONFIG_FILE)
    )

    engine = prepare_migration_target(
        project_path,
        manifest,
        StorageProfileRegistry(),
    )

    try:
        assert engine.url.get_backend_name() == "sqlite"
    finally:
        engine.dispose()

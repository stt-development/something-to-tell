"""Real remote release preserves authoring/checkpoints and cannot release another lease."""

import os
from unittest.mock import Mock

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import OperationalError

from services.runtime.stt_runtime.project_session.closing import release_remote_project
from services.runtime.stt_runtime.project_session.remote_ownership import claim, lease_for
from services.runtime.stt_runtime.project_session.remote_files import pending_path
from services.runtime.stt_runtime.project_session.service import ProjectSessionRegistry
from services.runtime.stt_runtime.schemas.remote_storage import RemoteStorageReleaseV1
from services.runtime.stt_runtime.storage_profiles import StorageProfileRegistry
from services.runtime.tests.test_remote_storage_protocol_audit import audit_database, _profile

pytestmark = pytest.mark.skipif(not os.getenv("STT_TEST_POSTGRES_URL"), reason="Disposable PostgreSQL required")


def working_state(engine, project_id):
    with engine.connect() as connection:
        row = connection.execute(text("""SELECT storage_generation,authoring_revision,saved_authoring_revision,
            saved_revision,checksum,canonical_manifest FROM project_storage_heads WHERE project_id=:id"""), {"id": project_id}).one()
        checkpoints = list(connection.execute(text("SELECT * FROM remote_saved_checkpoints WHERE project_id=:id ORDER BY saved_revision"), {"id": project_id}))
        roots = list(connection.execute(text("SELECT * FROM projects WHERE id=:id"), {"id": project_id}))
        return row, checkpoints, roots


@pytest.mark.parametrize("condition", ["healthy", "unavailable", "replacement-owner"])
def test_local_release_does_not_require_capture_or_change_remote_working_and_saved_data(audit_database, tmp_path, monkeypatch, condition):
    registry = ProjectSessionRegistry(StorageProfileRegistry([_profile(audit_database)]))
    observer = create_engine(audit_database)
    replacement = None
    try:
        opened = registry.create(tmp_path / "Release.narrative", "Release")
        session_id = opened.session.session_id
        registry.migrate_storage(session_id, expected_revision=0, target_mode="postgresql", target_profile_id="audit")
        active = registry._sessions[session_id]
        lease = lease_for(active.session_factory)
        lease.stopped.set()
        if lease.worker is not None:
            lease.worker.join(timeout=2)
            assert not lease.worker.is_alive()
        before = working_state(observer, active.state.project_id)
        if condition == "replacement-owner":
            with observer.begin() as connection:
                connection.execute(text("UPDATE project_storage_heads SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE project_id=:id"), {"id": active.state.project_id})
                replacement = claim(connection, active.state.project_id)
        pending = pending_path(active.path)
        pending.write_text("test-owned pending recovery", encoding="utf-8")
        manifest = (active.path / "project.config.json").read_bytes()
        capture = Mock(side_effect=AssertionError("release captured remote document"))
        monkeypatch.setattr(registry, "_load_document", capture)
        with monkeypatch.context() as patch:
            if condition == "unavailable":
                patch.setattr(active.engine, "connect", Mock(side_effect=OperationalError(None, None, Exception("private network detail"))))
            result = release_remote_project(registry, session_id, RemoteStorageReleaseV1(protocol_version=1,
                storage_generation=lease.generation, confirmation="leave_remote_working_data_unchanged"))
        assert result.status == "local_session_released" and session_id not in registry._sessions
        assert lease.token not in result.model_dump_json()
        assert not (active.path / "cache/project.lock.json").exists()
        assert pending.read_text(encoding="utf-8") == "test-owned pending recovery"
        assert (active.path / "project.config.json").read_bytes() == manifest
        assert working_state(observer, active.state.project_id) == before
        capture.assert_not_called()
        with observer.connect() as connection:
            token = connection.scalar(text("SELECT owner_token FROM project_storage_heads WHERE project_id=:id"), {"id": active.state.project_id})
            assert token == (replacement.token if replacement else lease.token if condition == "unavailable" else None)
    finally:
        if replacement is not None:
            replacement.close()
        registry.close_all(); observer.dispose()

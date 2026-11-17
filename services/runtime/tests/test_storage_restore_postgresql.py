"""Real owned target validation/reset, rollback and retained generation history."""

from dataclasses import replace
import os
from pathlib import Path

import pytest
from sqlalchemy import create_engine, event, select, text, update
from sqlalchemy.pool import NullPool

from services.runtime.scripts.benchmark_storage import _profile, disposable_database
from services.runtime.scripts.prepare_frontend_baseline import prepare
from services.runtime.stt_runtime.db.remote_ownership import checkpoints, control, head, receipts
from services.runtime.stt_runtime.project_session import remote_store
from services.runtime.stt_runtime.project_session.errors import ProjectSessionError
from services.runtime.stt_runtime.project_session.service import ProjectSessionRegistry
from services.runtime.stt_runtime.storage_profiles import StorageProfileRegistry
from services.runtime.stt_runtime.storage_restore import reset_restored_generations

pytestmark = pytest.mark.skipif(not os.getenv("STT_TEST_POSTGRES_URL"), reason="Disposable PostgreSQL required")


@pytest.fixture
def destination(tmp_path):
    with disposable_database() as url:
        registry = ProjectSessionRegistry(StorageProfileRegistry([_profile(url)], master_key_file=tmp_path / "key"))
        try:
            fixture = prepare(tmp_path / "fixture", "small")
            opened = registry.open(Path(fixture["path"]))
            sid = opened.session.session_id
            migrated = registry.migrate_storage(sid, expected_revision=opened.session.saved_revision,
                                               target_mode="postgresql", target_profile_id="scale-test").project
            saved = registry.save(sid, expected_revision=migrated.session.saved_revision, reason="manual")
            with registry.authoring_unit_of_work(sid, command_kind="update_node", label_key="history.command.updateNode") as uow:
                node = next(node for node in uow.nodes.list(project_id=migrated.session.project_id) if node.type == "Lore")
                uow.nodes.update(replace(node, body=node.body + " Unpublished saved-boundary distinction."))
                uow.commit()
            working = registry.inspect(sid)
            registry.close_all()
            engine = create_engine(url, poolclass=NullPool)
            try:
                with engine.begin() as connection:
                    connection.execute(update(control).values(maintenance=True))
                yield engine, saved.document, working.document
            finally:
                engine.dispose()
        finally:
            registry.close_all()
    assert not list(tmp_path.rglob("project.lock.json"))


def _state(engine):
    with engine.connect() as connection:
        return {table.name: [dict(row) for row in connection.execute(select(table)).mappings()]
                for table in (head, checkpoints, receipts)}


def test_rotation_preserves_complete_working_saved_revisions_and_old_receipts(destination):
    engine, saved, working = destination
    before = _state(engine)
    result = reset_restored_generations(engine, expected_database=engine.url.database, confirmed=True)
    after = _state(engine)
    old, new = before[head.name][0], after[head.name][0]
    assert result == {"projects": 1, "copied_checkpoints": len(before[checkpoints.name]), "maintenance": True}
    assert new["storage_generation"] != old["storage_generation"]
    assert new["writer_epoch"] == old["writer_epoch"] + 1
    assert new["owner_token"] is new["lease_expires_at"] is None
    for field in ("checksum", "authoring_revision", "saved_revision", "saved_authoring_revision", "canonical_manifest"):
        assert new[field] == old[field]
    assert after[receipts.name] == before[receipts.name]
    assert all(row in after[checkpoints.name] for row in before[checkpoints.name])
    from sqlalchemy.orm import sessionmaker
    factory = sessionmaker(bind=engine)
    restored, row = remote_store.capture(factory, working.manifest.project_id)
    assert restored == working and restored.checksum != saved.checksum
    with engine.connect() as connection:
        assert remote_store.saved_document(connection, working.manifest.project_id, row) == saved
        assert connection.scalar(select(control.c.maintenance)) is True
    guard = remote_store.lookup_guard(working.manifest.project_id, old["storage_generation"], before[receipts.name][0]["command_id"])
    with pytest.raises(ProjectSessionError, match="remote_generation_mismatch"):
        remote_store.outcome(factory, guard)


@pytest.mark.parametrize("failure", ["database", "maintenance", "live_lease", "checksum", "checkpoint", "post_write"])
def test_rejection_or_failure_never_partially_publishes_reset(destination, failure):
    engine, _, _ = destination
    with engine.begin() as connection:
        if failure == "maintenance":
            connection.execute(update(control).values(maintenance=False))
        elif failure == "live_lease":
            connection.execute(update(head).values(owner_token="test-private-token", lease_expires_at=text("clock_timestamp()+interval '60 seconds'")))
        elif failure == "checksum":
            connection.execute(update(head).values(checksum="f" * 64))
        elif failure == "checkpoint":
            connection.execute(update(checkpoints).values(checksum="f" * 64))
    before = _state(engine)

    def fail_after_write(_conn, _cursor, statement, *args):
        if statement.startswith("UPDATE project_storage_heads"):
            raise RuntimeError("injected_after_head_update")

    if failure == "post_write":
        event.listen(engine, "after_cursor_execute", fail_after_write)
    try:
        with pytest.raises((ProjectSessionError, RuntimeError)):
            reset_restored_generations(engine, expected_database="wrong" if failure == "database" else engine.url.database, confirmed=True)
    finally:
        if failure == "post_write":
            event.remove(engine, "after_cursor_execute", fail_after_write)
    assert _state(engine) == before


def test_other_idle_client_is_not_terminated_to_make_restore_succeed(destination):
    engine, _, _ = destination
    before = _state(engine)
    with engine.connect() as other:
        with pytest.raises(ProjectSessionError, match="remote_schema_busy"):
            reset_restored_generations(engine, expected_database=engine.url.database, confirmed=True)
        assert other.scalar(text("SELECT 1")) == 1
    assert _state(engine) == before

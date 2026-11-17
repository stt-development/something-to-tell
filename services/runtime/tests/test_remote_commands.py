"""Durable command, Save and failure/restart proofs in disposable PostgreSQL."""

import json
import os
import multiprocessing
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, text, update

from services.runtime.tests.test_remote_storage_protocol_audit import audit_database, _profile
from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.db.remote_ownership import head, receipts, checkpoints
from services.runtime.stt_runtime.project_session import remote_store, remote_files
from services.runtime.stt_runtime.project_session.remote_recovery import current_head
from services.runtime.stt_runtime.storage_profiles import StorageProfileRegistry

pytestmark = pytest.mark.skipif(not os.getenv("STT_TEST_POSTGRES_URL"), reason="Disposable PostgreSQL required")


@pytest.fixture
def workspace(audit_database, tmp_path):
    app = create_app()
    registry = app.state.project_sessions
    registry._storage_profiles = StorageProfileRegistry([_profile(audit_database)])
    with TestClient(app) as client:
        opened = registry.create(tmp_path / "Remote.narrative", "Remote")
        opened = registry.migrate_storage(opened.session.session_id, expected_revision=0,
            target_mode="postgresql", target_profile_id="audit").project
        yield client, registry, opened.session.session_id
    assert not list(tmp_path.rglob("project.lock.json"))


def headers(registry, session_id, *, command_id=None):
    value = current_head(registry, session_id)
    return {"X-Project-Session-Id": session_id, "X-Remote-Storage-Version": "1",
        "X-Remote-Storage-Generation": value.storage_generation, "X-Remote-Writer-Epoch": value.writer_epoch,
        "X-Remote-Expected-Revision": value.authoring_revision, "X-Remote-Command-Id": command_id or str(uuid4())}


def node_payload(registry, session_id, title="Gate"):
    return dict(project_id=registry._sessions[session_id].manifest.project_id, type="Event", title=title)


def test_guarded_write_replay_normalized_digest_and_changed_reuse(workspace):
    client, registry, sid = workspace
    guard = headers(registry, sid)
    body = node_payload(registry, sid)
    response = client.post("/api/nodes", headers=guard, json=body)
    assert response.status_code == 201, response.text
    assert response.headers["X-Remote-Result-Revision"] == "1"
    replay = client.post("/api/nodes", headers=guard, json={**body, "summary": "", "body": ""})
    assert replay.status_code == 200, replay.text
    assert replay.headers["X-Remote-Replayed"] == "1"
    assert replay.json()["result_revision"] == "1"
    reused = client.post("/api/nodes", headers=guard, json={**body, "title": "Different intent"})
    assert reused.status_code == 409 and reused.json()["detail"]["code"] == "remote_command_reused"
    snapshot = registry.inspect(sid)
    assert snapshot.session.session_version == 2
    assert len(snapshot.document.nodes) == 1
    active = registry._sessions[sid]
    with active.engine.connect() as connection:
        assert len(connection.execute(select(receipts)).all()) == 1
    assert registry.inspect_history(sid).history_revision == 1


def test_missing_or_stale_guards_never_mutate(workspace):
    client, registry, sid = workspace
    body = node_payload(registry, sid)
    missing = client.post("/api/nodes", headers={"X-Project-Session-Id": sid}, json=body)
    assert missing.status_code == 400, missing.text
    guard = headers(registry, sid)
    assert client.post("/api/nodes", headers=guard, json=body).status_code == 201
    guard["X-Remote-Command-Id"] = str(uuid4())
    stale = client.post("/api/nodes", headers=guard, json=node_payload(registry, sid, "Stale"))
    assert stale.status_code == 409, stale.text
    assert stale.json()["detail"]["code"] == "remote_revision_stale"
    assert len(registry.inspect(sid).document.nodes) == 1


def test_invalid_body_is_rejected_before_threaded_transaction_dependency(workspace):
    client, registry, sid = workspace
    guard = headers(registry, sid)
    response = client.post("/api/nodes", headers=guard, json={"title": "Missing type and project"})
    assert response.status_code == 422, response.text
    assert current_head(registry, sid).authoring_revision == "0"
    assert not (registry._sessions[sid].path / "cache/remote-pending.json").exists()


def test_save_noop_settings_undo_discard_and_saved_boundary(workspace):
    client, registry, sid = workspace
    snapshot = registry.inspect(sid)
    settings = snapshot.document.manifest.settings.model_dump(mode="json")
    noop = client.put(f"/api/project-sessions/{sid}/settings", headers=headers(registry, sid),
        json=dict(name="Remote", description="", settings=settings))
    assert noop.status_code == 200, noop.text
    assert noop.headers["X-Remote-Result-Revision"] == "0"
    assert registry.inspect_history(sid).history_revision == 0
    created = client.post("/api/nodes", headers=headers(registry, sid), json=node_payload(registry, sid))
    assert created.status_code == 201, created.text
    saved = client.post(f"/api/project-sessions/{sid}/save", headers=headers(registry, sid),
        json=dict(expected_revision=0, reason="manual"))
    assert saved.status_code == 200, saved.text
    assert saved.json()["session"]["remote_storage"]["authoring_revision"] == "2"
    assert saved.json()["session"]["saved_revision"] == 1
    changed = client.put(f"/api/project-sessions/{sid}/settings", headers=headers(registry, sid),
        json=dict(name="Renamed", description="Draft", settings=settings))
    assert changed.status_code == 200, changed.text
    revision = registry.inspect_history(sid).history_revision
    undone = client.post(f"/api/project-sessions/{sid}/history/undo", headers=headers(registry, sid),
        json=dict(expected_history_revision=revision))
    assert undone.status_code == 200, undone.text
    assert undone.json()["project"]["document"]["manifest"]["name"] == "Remote"
    assert current_head(registry, sid).authoring_revision == "4"
    with registry._sessions[sid].engine.connect() as connection:
        assert remote_store.saved_document(connection, snapshot.session.project_id).manifest.saved_revision == 1
    redone = client.post(f"/api/project-sessions/{sid}/history/redo", headers=headers(registry, sid),
        json=dict(expected_history_revision=registry.inspect_history(sid).history_revision))
    assert redone.status_code == 200, redone.text
    assert redone.json()["project"]["document"]["manifest"]["name"] == "Renamed"
    discarded = client.post(f"/api/project-sessions/{sid}/discard", headers=headers(registry, sid))
    assert discarded.status_code == 200, discarded.text
    assert discarded.json()["document"]["manifest"]["name"] == "Remote"
    assert current_head(registry, sid).authoring_revision == "6"
    assert current_head(registry, sid).saved_revision == "1"


def test_precommit_failure_has_no_receipt_or_data(workspace, monkeypatch):
    client, registry, sid = workspace
    def fail(*args, **kwargs):
        raise ValueError("injected before commit")
    monkeypatch.setattr(remote_store, "publish", fail)
    guard = headers(registry, sid)
    # TestClient re-raises the deliberately injected programming failure.
    with pytest.raises(ValueError, match="injected before commit"):
        client.post("/api/nodes", headers=guard, json=node_payload(registry, sid))
    active = registry._sessions[sid]
    with active.engine.connect() as connection:
        assert connection.scalar(text("SELECT count(*) FROM nodes")) == 0
        assert connection.scalar(text("SELECT count(*) FROM remote_command_receipts")) == 0
    assert current_head(registry, sid).authoring_revision == "0"


def test_save_local_publication_failure_is_committed_and_recoverable(workspace, monkeypatch):
    client, registry, sid = workspace
    guard = headers(registry, sid)
    original = remote_files.publish_local
    def fail(*args, **kwargs):
        raise OSError("injected local disk failure")
    monkeypatch.setattr("services.runtime.stt_runtime.project_session.remote_commands.publish_local", fail)
    failed = client.post(f"/api/project-sessions/{sid}/save", headers=guard,
        json=dict(expected_revision=0, reason="manual"))
    assert failed.status_code == 409, failed.text
    assert failed.headers["X-Remote-Result-Revision"] == "1"
    assert failed.json()["detail"]["code"] == "remote_local_publication_required"
    resolved = client.get(f"/api/project-sessions/{sid}/remote-commands/{guard['X-Remote-Command-Id']}",
        params={"generation": guard["X-Remote-Storage-Generation"]})
    assert resolved.json()["status"] == "committed", resolved.text
    assert current_head(registry, sid).saved_revision == "1"
    monkeypatch.setattr("services.runtime.stt_runtime.project_session.remote_commands.publish_local", original)
    reconnected = client.post(f"/api/project-sessions/{sid}/remote-storage/reconnect",
        headers={"X-Remote-Storage-Version": "1"}, json=dict(protocol_version=1,
            storage_generation=guard["X-Remote-Storage-Generation"], observed_revision="0",
            unresolved_command_id=guard["X-Remote-Command-Id"]))
    assert reconnected.status_code == 200, reconnected.text
    new_id = reconnected.json()["session"]["session_id"]
    assert new_id != sid
    assert reconnected.json()["session"]["remote_state"] == "ready"
    assert registry.inspect(new_id).session.saved_revision == 1


def test_lost_commit_ack_is_resolved_without_reapplying_effect(workspace, monkeypatch):
    from services.runtime.stt_runtime.project_session.errors import ProjectSessionError
    client, registry, sid = workspace
    active = registry._sessions[sid]
    original = active.session_factory.class_.commit
    guard = headers(registry, sid)
    def lost_ack(session):
        original(session)
        raise ProjectSessionError("remote_storage_unavailable")
    with monkeypatch.context() as patch:
        patch.setattr(active.session_factory.class_, "commit", lost_ack)
        failed = client.post("/api/nodes", headers=guard, json=node_payload(registry, sid))
    assert failed.status_code == 503 and failed.json()["detail"]["code"] == "remote_commit_unknown", failed.text
    assert current_head(registry, sid).state == "outcome_unknown"
    outcome = client.get(f"/api/project-sessions/{sid}/remote-commands/{guard['X-Remote-Command-Id']}",
        params={"generation": guard["X-Remote-Storage-Generation"]})
    assert outcome.json()["status"] == "committed", outcome.text
    replay = client.post("/api/nodes", headers=guard, json=node_payload(registry, sid))
    assert replay.status_code == 200 and replay.headers["X-Remote-Replayed"] == "1"
    assert len(registry.inspect(sid).document.nodes) == 1
    assert current_head(registry, sid).authoring_revision == "1"


def test_server_manifest_and_working_data_win_over_old_folder(workspace):
    client, registry, sid = workspace
    active = registry._sessions[sid]
    path = active.path
    stale = (path / "project.config.json").read_bytes()
    created = client.post("/api/nodes", headers=headers(registry, sid), json=node_payload(registry, sid))
    assert created.status_code == 201, created.text
    client.put(f"/api/project-sessions/{sid}/settings", headers=headers(registry, sid),
        json=dict(name="Server title", description="Server metadata", settings=active.manifest.settings.model_dump(mode="json")))
    registry.close_all()
    (path / "project.config.json").write_bytes(stale)
    (path / "cache/save-recovery.json").write_text(json.dumps({"base_revision": 0}))
    reopened = registry.open(path, recovery_mode="last_saved")
    assert reopened.document.manifest.name == "Server title"
    assert len(reopened.document.nodes) == 1
    assert reopened.session.save_status == "dirty"


def test_remote_to_sqlite_handoff_has_source_receipt_and_local_v1(workspace):
    client, registry, sid = workspace
    source_engine = registry._sessions[sid].engine
    guard = headers(registry, sid)
    migrated = client.post("/api/storage-migrations", headers=guard,
        json=dict(session_id=sid, expected_revision=0, target_mode="local_sqlite", target_profile_id=None))
    assert migrated.status_code == 200, migrated.text
    assert migrated.json()["project"]["session"]["session_version"] == 1
    assert migrated.headers["X-Remote-Command-Id"] == guard["X-Remote-Command-Id"]
    with source_engine.connect() as connection:
        assert connection.scalar(select(receipts.c.command_id)) == guard["X-Remote-Command-Id"]
        assert connection.scalar(select(head.c.owner_token)) is None
    assert registry.inspect(sid).session.storage_mode == "local_sqlite"
    replay = client.post("/api/storage-migrations", headers=guard,
        json=dict(session_id=sid, expected_revision=0, target_mode="local_sqlite", target_profile_id=None))
    assert replay.status_code == 200 and replay.headers["X-Remote-Replayed"] == "1", replay.text
    stale = client.post("/api/nodes", headers={**guard, "X-Remote-Command-Id": str(uuid4())},
        json=node_payload(registry, sid))
    assert stale.status_code == 409 and stale.json()["detail"]["code"] == "remote_generation_mismatch"


def test_handoff_local_failure_resolves_source_before_switching(workspace, monkeypatch):
    client, registry, sid = workspace
    from services.runtime.stt_runtime.project_session import remote_handoff
    original = remote_handoff.write_project_manifest
    def fail(*args, **kwargs):
        raise OSError("injected handoff publication failure")
    guard = headers(registry, sid)
    monkeypatch.setattr(remote_handoff, "write_project_manifest", fail)
    failed = client.post("/api/storage-migrations", headers=guard,
        json=dict(session_id=sid, expected_revision=0, target_mode="local_sqlite", target_profile_id=None))
    assert failed.status_code == 409, failed.text
    assert failed.json()["detail"]["code"] == "remote_local_publication_required"
    assert registry.inspect(sid).session.storage_mode == "postgresql"
    monkeypatch.setattr(remote_handoff, "write_project_manifest", original)
    recovered = client.post(f"/api/project-sessions/{sid}/remote-storage/reconnect",
        headers={"X-Remote-Storage-Version": "1"}, json=dict(protocol_version=1,
            storage_generation=guard["X-Remote-Storage-Generation"], observed_revision="0", unresolved_command_id=None))
    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["session"]["storage_mode"] == "local_sqlite"


def test_64_bit_revision_and_noop_receipt_survive_json(workspace):
    client, registry, sid = workspace
    active = registry._sessions[sid]
    with active.engine.begin() as connection:
        connection.execute(update(head).values(authoring_revision=9007199254740993))
    current = registry.inspect(sid)
    assert current.session.remote_storage.authoring_revision == "9007199254740993"
    unchanged = client.put(f"/api/project-sessions/{sid}/settings", headers=headers(registry, sid),
        json=dict(name="Remote", description="", settings=current.document.manifest.settings.model_dump(mode="json")))
    assert unchanged.status_code == 200, unchanged.text
    assert unchanged.headers["X-Remote-Result-Revision"] == "9007199254740993"


def test_readonly_export_keeps_heads_and_receipts_unchanged(workspace):
    client, registry, sid = workspace
    active = registry._sessions[sid]
    before = current_head(registry, sid)
    plan = client.post(f"/api/exports/{sid}/plans", headers=headers(registry, sid),
        json=dict(options=dict(format="json", scope="whole_project", engine_tag_target="generic")))
    assert plan.status_code == 200, plan.text
    planned = plan.json()
    written = client.post(f"/api/exports/{sid}/writes", json=dict(options=planned["options"],
        expected_plan_fingerprint=planned["plan_fingerprint"],
        expected_source_checksum=planned["source"]["source_checksum"]))
    assert written.status_code == 200, written.text
    assert Path(written.json()["artifact"]["installed_path"]).is_file()
    assert current_head(registry, sid) == before
    with active.engine.connect() as connection:
        assert connection.scalar(text("SELECT count(*) FROM remote_command_receipts")) == 0


def test_legacy_remote_open_and_create_fail_before_publication(workspace, tmp_path):
    client, registry, sid = workspace
    active = registry._sessions[sid]
    path, engine, project_id = active.path, active.engine, active.manifest.project_id
    with engine.connect() as connection:
        epoch = connection.scalar(select(head.c.writer_epoch).where(head.c.project_id == project_id))
    registry.close(sid)
    rejected = client.post("/api/project-sessions/open", json=dict(path=str(path)))
    assert rejected.status_code == 400, rejected.text
    assert rejected.json()["detail"]["code"] == "remote_storage_protocol_unsupported"
    assert not (path / "cache/project.lock.json").exists()
    with engine.connect() as connection:
        assert connection.scalar(select(head.c.writer_epoch).where(head.c.project_id == project_id)) == epoch
    destination = tmp_path / "MustNotExist.narrative"
    rejected = client.post("/api/project-sessions/create", json=dict(path=str(destination), name="Legacy",
        settings=active.manifest.settings.model_dump(mode="json")))
    assert rejected.status_code == 400, rejected.text
    assert not destination.exists()


def test_export_rejects_a_new_head_even_when_checksum_is_equal(workspace):
    client, registry, sid = workspace
    active = registry._sessions[sid]
    options = dict(format="json", scope="whole_project", engine_tag_target="generic")
    plan = client.post(f"/api/exports/{sid}/plans", json=dict(options=options)).json()
    with active.engine.begin() as connection:
        connection.execute(update(head).values(authoring_revision=1))
    stale = client.post(f"/api/exports/{sid}/writes", json=dict(options=options,
        expected_plan_fingerprint=plan["plan_fingerprint"], expected_source_checksum=plan["source"]["source_checksum"],
        overwrite=False))
    assert stale.status_code == 409, stale.text
    assert stale.json()["detail"]["code"] == "export_source_stale"
    assert not list((active.path / "exports").iterdir())


def test_saved_checkpoints_are_bounded_but_receipts_are_not_pruned(workspace):
    client, registry, sid = workspace
    for revision in range(4):
        saved = client.post(f"/api/project-sessions/{sid}/save", headers=headers(registry, sid),
            json=dict(expected_revision=revision, reason="manual"))
        assert saved.status_code == 200, saved.text
    with registry._sessions[sid].engine.connect() as connection:
        assert connection.scalars(select(checkpoints.c.saved_revision).order_by(checkpoints.c.saved_revision)).all() == [2, 3, 4]
        assert connection.scalar(text("SELECT count(*) FROM remote_command_receipts")) == 4


def test_generation_rotation_retains_old_generation_ledger(workspace):
    client, registry, sid = workspace
    active = registry._sessions[sid]
    guard = headers(registry, sid)
    assert client.post("/api/nodes", headers=guard, json=node_payload(registry, sid)).status_code == 201
    with active.engine.begin() as connection:
        connection.execute(update(head).values(storage_generation=str(uuid4()), owner_token=None,
            lease_expires_at=None, writer_epoch=2))
        assert connection.scalar(select(receipts.c.storage_generation)) == guard["X-Remote-Storage-Generation"]
        assert connection.scalar(select(checkpoints.c.storage_generation)) == guard["X-Remote-Storage-Generation"]


def test_outcome_absence_is_unknown_while_writer_holds_head(workspace):
    client, registry, sid = workspace
    active = registry._sessions[sid]
    guard = headers(registry, sid)
    from services.runtime.stt_runtime.project_session.remote_recovery import lookup_guard
    lookup = lookup_guard(active.manifest.project_id, guard["X-Remote-Storage-Generation"], guard["X-Remote-Command-Id"])
    with active.engine.begin() as writer:
        writer.execute(select(head).where(head.c.project_id == active.manifest.project_id).with_for_update())
        unresolved = remote_store.outcome(active.session_factory, lookup)
        assert unresolved.status == "unknown"
        # A diagnostic timeout must not revoke the legitimate writer itself.
        from services.runtime.stt_runtime.project_session.remote_ownership import lease_for
        assert not lease_for(active.session_factory).lost.is_set()
    assert remote_store.outcome(active.session_factory, lookup).status == "not_committed"


def test_repeatable_read_capture_does_not_mix_head_and_rows(workspace, monkeypatch):
    client, registry, sid = workspace
    created = client.post("/api/nodes", headers=headers(registry, sid), json=node_payload(registry, sid))
    assert created.status_code == 201, created.text
    active = registry._sessions[sid]
    before = registry.inspect(sid).document
    from services.runtime.stt_runtime.schemas.project_document import create_project_document
    from services.runtime.stt_runtime.project_document.service import ProjectDocumentService
    payload = before.model_dump(mode="json", exclude={"checksum"})
    payload["nodes"][0]["title"] = "Concurrent commit"
    after = create_project_document(**payload)
    original = ProjectDocumentService.load
    changed = False
    def interleave(self, uow, manifest):
        nonlocal changed
        if not changed:
            changed = True
            # An independent SQL writer commits between capture's head and row reads.
            with active.engine.begin() as connection:
                connection.execute(text("UPDATE nodes SET title='Concurrent commit' WHERE project_id=:project"),
                    {"project": active.manifest.project_id})
                connection.execute(update(head).where(head.c.project_id == active.manifest.project_id).values(
                    checksum=after.checksum, authoring_revision=2))
        return original(self, uow, manifest)
    with monkeypatch.context() as patch:
        patch.setattr(ProjectDocumentService, "load", interleave)
        captured, row = remote_store.capture(active.session_factory, active.manifest.project_id)
    assert row["authoring_revision"] == 1
    assert captured.checksum == before.checksum
    fresh, row = remote_store.capture(active.session_factory, active.manifest.project_id)
    assert row["authoring_revision"] == 2 and fresh.checksum == after.checksum


def _crash_after_saved_commit(url, path, pipe):
    """No test process/registry or provider keys are shared with this writer."""
    from services.runtime.stt_runtime.project_session.service import ProjectSessionRegistry
    from services.runtime.stt_runtime.project_session.errors import ProjectSessionError
    from services.runtime.stt_runtime.domain.entities import NodeEntity
    registry = ProjectSessionRegistry(StorageProfileRegistry([_profile(url)]))
    opened = registry.open(Path(path))
    sid = opened.session.session_id
    with registry.authoring_unit_of_work(sid, command_kind="create_node", label_key="history.command.createNode") as uow:
        uow.nodes.add(NodeEntity(project_id=opened.session.project_id, type="Event", title="Survives process exit"))
        uow.commit()
    factory = registry._sessions[sid].session_factory
    commit = factory.class_.commit
    def lost_ack(session):
        commit(session)
        raise ProjectSessionError("remote_storage_unavailable")
    factory.class_.commit = lost_ack
    try:
        registry.save(sid, expected_revision=0, reason="manual")
    except ProjectSessionError as error:
        assert error.code == "remote_commit_unknown"
    pipe.send(json.loads((Path(path) / "cache/remote-pending.json").read_text()))
    pipe.close()
    os._exit(0)  # Deliberately omit shutdown cleanup, as with a real runtime crash.


def test_restart_repairs_pending_save_from_server_not_old_folder(workspace, audit_database):
    _, registry, sid = workspace
    active = registry._sessions[sid]
    path, engine = active.path, active.engine
    registry.close_all()
    context = multiprocessing.get_context("spawn")
    reader, sender = context.Pipe(duplex=False)
    worker = context.Process(target=_crash_after_saved_commit,
        args=(audit_database.render_as_string(hide_password=False), str(path), sender))
    try:
        worker.start()
        assert reader.poll(35), "Crashed worker did not publish its pending identity"
        pending = reader.recv()
        worker.join(timeout=10)
        assert worker.exitcode == 0
        assert json.loads((path / "project.config.json").read_text())["saved_revision"] == 0
        with engine.begin() as connection:
            connection.execute(update(head).values(lease_expires_at=text("clock_timestamp() - interval '1 second'")))
        opened = registry.open(path, recover_stale_lock=True)
        assert opened.session.saved_revision == 1
        assert opened.session.remote_storage.authoring_revision == "2"
        assert opened.document.nodes[0].title == "Survives process exit"
        assert not (path / "cache/remote-pending.json").exists()
        resolved = remote_store.outcome(registry._sessions[opened.session.session_id].session_factory,
            remote_store.lookup_guard(opened.session.project_id, pending["storage_generation"], pending["command_id"]))
        assert resolved.status == "committed"
    finally:
        if worker.is_alive():
            worker.terminate()
            worker.join(timeout=5)
        reader.close()
        sender.close()
        registry.close_all()
        (path / "cache/project.lock.json").unlink(missing_ok=True)

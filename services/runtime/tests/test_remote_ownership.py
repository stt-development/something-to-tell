"""Production lease regression proofs; only generated disposable databases are used."""

import os
import json
import multiprocessing
import shutil
from datetime import UTC, datetime
from threading import Event
import pytest
from sqlalchemy import create_engine, event, select, text, update
from fastapi import HTTPException
from fastapi.testclient import TestClient
from services.runtime.stt_runtime.app import create_app

from services.runtime.stt_runtime.db.remote_ownership import control, head
from services.runtime.stt_runtime.db.models import Node
from services.runtime.stt_runtime.domain.entities import NodeEntity, ProjectEntity
from services.runtime.stt_runtime.project_session.database import create_session_factory, upgrade_external_database
from services.runtime.stt_runtime.project_session.errors import ProjectSessionError
from services.runtime.stt_runtime.project_session.remote_ownership import bind_lease, claim, ownership_guard, revoke_remote
from services.runtime.stt_runtime.repositories.sqlite import SqlAlchemyUnitOfWork
from services.runtime.tests.test_remote_storage_protocol_audit import audit_database, _connect, _profile, _open_worker
from services.runtime.stt_runtime.project_session.service import ProjectSessionRegistry
from services.runtime.stt_runtime.storage_profiles import StorageProfileRegistry

pytestmark = pytest.mark.skipif(not os.getenv("STT_TEST_POSTGRES_URL"), reason="Requires disposable PostgreSQL CREATE DATABASE permission")


@pytest.fixture
def authority(audit_database):
    upgrade_external_database(audit_database)
    engine = create_engine(audit_database, pool_size=4)
    factory = create_session_factory(engine)
    with SqlAlchemyUnitOfWork(factory) as uow:
        for project_id in ("a", "b"):
            uow.projects.add(ProjectEntity(id=project_id, name=project_id, path="/tmp/lease", format_version=2))
        uow.commit()
    with engine.begin() as connection:
        connection.execute(head.insert(), [dict(project_id=p, storage_generation=p + "-generation") for p in ("a", "b")])
    try:
        yield engine, factory
    finally:
        engine.dispose()


def own(engine, project="a"):
    with engine.begin() as connection:
        return claim(connection, project)


def expire(engine, project="a"):
    with engine.begin() as connection:
        connection.execute(update(head).where(head.c.project_id == project).values(
            lease_expires_at=text("clock_timestamp() - interval '1 second'")))


def assert_code(code, call):
    with pytest.raises(ProjectSessionError) as caught:
        call()
    assert caught.value.code == code


def test_claim_busy_independent_projects_release_and_old_release(authority):
    engine, _ = authority
    first, other = own(engine), own(engine, "b")
    assert first.epoch == other.epoch == 1
    assert_code("remote_project_busy", lambda: own(engine))
    expire(engine)
    second = own(engine)
    assert second.epoch == 2 and second.token != first.token
    first.close()  # Closing an obsolete process cannot release the replacement.
    assert_code("remote_project_busy", lambda: own(engine))
    second.close()
    third = own(engine)
    assert third.epoch == 3
    third.close()
    other.close()


def test_expired_owner_cannot_renew_or_write_after_transfer(authority):
    engine, factory = authority
    first = own(engine)
    bind_lease(factory, first)
    expire(engine)
    assert_code("remote_writer_lost", first.renew)
    second = own(engine)
    with SqlAlchemyUnitOfWork(factory, project_id="a") as uow:
        assert_code("remote_writer_lost", lambda: uow.nodes.add(NodeEntity(project_id="a", type="Event", title="Stale")))
    # A successful ping never clears lost state.
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT 1")) == 1
        assert connection.scalar(text("SELECT count(*) FROM nodes")) == 0
    assert first.lost.is_set()
    second.close()


@pytest.mark.parametrize("invalidation", ["expiry", "epoch", "generation"])
def test_final_expiry_predicate_rolls_back_already_flushed_data(authority, invalidation):
    engine, factory = authority
    lease = own(engine)
    bind_lease(factory, lease)
    with pytest.raises(ProjectSessionError, match="remote_writer_lost"):
        with SqlAlchemyUnitOfWork(factory, project_id="a") as uow:
            uow.nodes.add(NodeEntity(project_id="a", type="Event", title="Must roll back"))
            # Deterministic invalidation while this transaction holds the head lock.
            values = {
                "expiry": {"lease_expires_at": text("clock_timestamp() - interval '1 second'")},
                "epoch": {"writer_epoch": lease.epoch + 1},
                "generation": {"storage_generation": "replacement-generation"},
            }[invalidation]
            uow._require_session().connection().execute(update(head).where(head.c.project_id == "a").values(**values))
            uow.commit()
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT count(*) FROM nodes")) == 0
    lease.close()


def test_bulk_sql_and_manifest_only_publication_are_fenced(authority):
    engine, factory = authority
    lease = own(engine)
    bind_lease(factory, lease)
    # Revocation does not rely on the old heartbeat noticing it.
    with engine.begin() as connection:
        connection.execute(update(head).where(head.c.project_id == "a").values(writer_epoch=lease.epoch + 1))
    with factory() as session:
        assert_code("remote_writer_lost", lambda: session.execute(update(Node).values(title="stale")))
    called = []
    with pytest.raises(ProjectSessionError):
        with ownership_guard(factory):
            called.append(True)
    assert called == []
    lease.close()


def test_commit_fences_after_implicit_flush_not_before_it(authority):
    engine, factory = authority
    lease = own(engine)
    bind_lease(factory, lease)
    with factory() as session:
        def expire_during_flush(session, _):
            session.connection().execute(update(head).where(head.c.project_id == "a").values(
                lease_expires_at=text("clock_timestamp() - interval '1 second'")))
        event.listen(session, "after_flush_postexec", expire_during_flush)
        session.add(Node(id="pending", project_id="a", type="Event", title="Implicit flush"))
        assert_code("remote_writer_lost", session.commit)
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT count(*) FROM nodes")) == 0
    lease.close()


def test_renewal_extends_only_live_owner_and_maintenance_blocks_claim(authority):
    engine, _ = authority
    lease = own(engine)
    with engine.connect() as connection:
        before = connection.scalar(select(head.c.lease_expires_at).where(head.c.project_id == "a"))
    lease.renew()
    with engine.begin() as connection:
        assert connection.scalar(select(head.c.lease_expires_at).where(head.c.project_id == "a")) > before
        connection.execute(update(control).values(maintenance=True))
    assert_code("remote_schema_busy", lambda: own(engine, "b"))
    lease.close()  # Shutdown release is allowed during maintenance.
    with engine.begin() as connection:
        connection.execute(update(control).values(maintenance=False))
    own(engine).close()


def test_server_transaction_timeout_is_set_and_local_deadline_rolls_back(authority):
    engine, factory = authority
    lease = own(engine)
    bind_lease(factory, lease)
    with pytest.raises(ProjectSessionError, match="remote_storage_timeout"):
        with SqlAlchemyUnitOfWork(factory, project_id="a") as uow:
            uow.nodes.add(NodeEntity(project_id="a", type="Event", title="Timeout"))
            session = uow._require_session()
            assert session.scalar(text("SHOW transaction_timeout")) == "20s"
            session.info["remote_fence"] -= 21
            uow.commit()
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT count(*) FROM nodes")) == 0
    lease.close()


def test_disconnect_fails_closed_even_after_database_recovers(authority):
    engine, factory = authority
    lease = own(engine)
    bind_lease(factory, lease)
    with pytest.raises(ProjectSessionError, match="remote_storage_unavailable"):
        with SqlAlchemyUnitOfWork(factory, project_id="a") as uow:
            uow.nodes.add(NodeEntity(project_id="a", type="Event", title="Disconnected"))
            pid = uow._require_session().scalar(text("SELECT pg_backend_pid()"))
            with _connect(engine.url) as admin:
                assert admin.execute("SELECT pg_terminate_backend(%s)", (pid,)).fetchone() == (True,)
            uow.commit()
    assert lease.lost.is_set()
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT count(*) FROM nodes")) == 0
    assert_code("remote_writer_lost", lease.renew)
    revoke_remote(engine, "a")
    replacement = own(engine)
    assert replacement.epoch == lease.epoch + 2
    lease.close()
    assert_code("remote_project_busy", lambda: own(engine))
    replacement.close()


def test_heartbeat_failure_stops_renewal_without_silent_reacquisition(authority, monkeypatch):
    engine, _ = authority
    lease = own(engine)
    attempted = Event()
    def unavailable():
        attempted.set()
        raise OSError("simulated partition")
    monkeypatch.setattr(lease, "renew", unavailable)
    lease.renew_seconds = 0  # Test scheduling only; server policy remains unchanged.
    lease.start()
    assert attempted.wait(5)
    lease.worker.join(timeout=5)
    assert not lease.worker.is_alive()
    assert lease.lost.is_set()
    assert_code("remote_project_busy", lambda: own(engine))
    lease.close()


def test_provisioning_root_head_and_copy_failure_roll_back_together(audit_database, tmp_path):
    from services.runtime.stt_runtime.project_format.manifest import create_project_manifest
    from services.runtime.stt_runtime.schemas.project_document import create_project_document
    from services.runtime.stt_runtime.project_session.remote_ownership import provision_target
    upgrade_external_database(audit_database)
    engine = create_engine(audit_database)
    factory = create_session_factory(engine)
    manifest = create_project_manifest(project_id="atomic-copy", name="Atomic copy", now=datetime.now(UTC))
    try:
        with pytest.raises(RuntimeError, match="injected_copy_failure"):
            with SqlAlchemyUnitOfWork(factory, project_id=manifest.project_id) as uow:
                provision_target(uow, factory, create_project_document(manifest=manifest), tmp_path)
                uow.nodes.add(NodeEntity(project_id=manifest.project_id, type="Event", title="Transient"))
                raise RuntimeError("injected_copy_failure")
        with engine.connect() as connection:
            for table in ("projects", "project_storage_heads", "nodes"):
                assert connection.scalar(text(f"SELECT count(*) FROM {table}")) == 0
    finally:
        engine.dispose()


@pytest.fixture
def remote_folder(audit_database, tmp_path):
    registry = ProjectSessionRegistry(StorageProfileRegistry([_profile(audit_database)]))
    path = tmp_path / "Remote.narrative"
    try:
        opened = registry.create(path, "Remote")
        registry.migrate_storage(opened.session.session_id, expected_revision=0,
                                 target_mode="postgresql", target_profile_id="audit")
    finally:
        registry.close_all()
    yield path
    assert not list(tmp_path.rglob("project.lock.json"))


def test_profile_alias_and_different_folder_cannot_bypass_owner(remote_folder, audit_database, tmp_path):
    other_path = tmp_path / "Alias.narrative"
    shutil.copytree(remote_folder, other_path)
    config = other_path / "project.config.json"
    payload = json.loads(config.read_text())
    payload["settings"]["storage"]["connection_profile_id"] = "alias"
    config.write_text(json.dumps(payload))
    profile = _profile(audit_database)
    first = ProjectSessionRegistry(StorageProfileRegistry([profile]))
    second = ProjectSessionRegistry(StorageProfileRegistry([profile.model_copy(update={"profile_id": "alias"})]))
    try:
        opened = first.open(remote_folder)
        assert_code("remote_project_busy", lambda: second.open(other_path, remote_profile_id="alias"))
        assert not (other_path / "cache/project.lock.json").exists()
        # Ownership capabilities never appear in the API/document representation.
        token = next(iter(first._sessions.values())).session_factory.kw["info"]["remote_lease"].token
        assert token not in opened.model_dump_json()
        first.close(opened.session.session_id)
        reopened = second.open(other_path, remote_profile_id="alias")
        assert reopened.session.lifecycle == "open"
    finally:
        first.close_all()
        second.close_all()


def test_crashed_runtime_requires_expiry_then_explicit_reload(remote_folder, audit_database):
    context = multiprocessing.get_context("spawn")
    ready, release = context.Queue(), context.Event()
    worker = context.Process(target=_open_worker, args=(audit_database.render_as_string(hide_password=False),
                                                       str(remote_folder), ready, release))
    registry = ProjectSessionRegistry(StorageProfileRegistry([_profile(audit_database)]))
    engine = create_engine(audit_database)
    try:
        worker.start()
        assert ready.get(timeout=20)[0] == "opened"
        worker.terminate()
        worker.join(timeout=10)
        assert not worker.is_alive()
        # A dead local PID is not permission to steal a still-live database lease.
        assert_code("remote_project_busy", lambda: registry.open(remote_folder, recover_stale_lock=True))
        with engine.begin() as connection:
            connection.execute(update(head).values(lease_expires_at=text("clock_timestamp() - interval '1 second'")))
        reopened = registry.open(remote_folder)
        assert reopened.session.lifecycle == "open"
        with engine.connect() as connection:
            assert connection.scalar(select(head.c.writer_epoch)) == 3  # migration, crashed open, fresh open
    finally:
        # A process killed inside Event.wait may leave its condition mutex locked.
        # Never call Event.set on that crashed process's synchronization primitive.
        if worker.is_alive():
            worker.terminate()
            worker.join(timeout=10)
        registry.close_all()
        (remote_folder / "cache/project.lock.json").unlink(missing_ok=True)
        engine.dispose()
        ready.close()


def test_failed_open_releases_lease_and_missing_head_is_not_upserted(remote_folder, audit_database, monkeypatch):
    registry = ProjectSessionRegistry(StorageProfileRegistry([_profile(audit_database)]))
    engine = create_engine(audit_database)
    def fail(_, **kwargs):
        raise ProjectSessionError("injected_open_failure")
    try:
        monkeypatch.setattr("services.runtime.stt_runtime.project_session.opening.publish_local", fail)
        assert_code("injected_open_failure", lambda: registry.open(remote_folder))
        assert not registry._sessions
        assert not (remote_folder / "cache/project.lock.json").exists()
        with engine.begin() as connection:
            assert connection.scalar(select(head.c.owner_token)) is None
            connection.execute(head.delete())
        assert_code("remote_project_not_provisioned", lambda: registry.open(remote_folder))
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT count(*) FROM project_storage_heads")) == 0
            assert connection.scalar(text("SELECT count(*) FROM projects")) == 1
    finally:
        registry.close_all()
        engine.dispose()


@pytest.mark.parametrize("code, expected", [
    ("remote_writer_lost", 409), ("remote_project_busy", 409),
    ("remote_storage_unavailable", 503), ("remote_storage_timeout", 503),
    ("remote_storage_version_unsupported", 400), ("ordinary_domain_error", 400),
])
def test_remote_errors_keep_stable_status_through_older_domain_wrappers(code, expected):
    app = create_app()
    @app.get("/lease-error-probe")
    def probe():
        raise HTTPException(400, detail={"code": code, "parameters": {}})
    with TestClient(app) as client:
        response = client.get("/lease-error-probe")
    assert response.status_code == expected
    detail = response.json()["detail"]
    assert detail["code"] == code and detail["parameters"] == {}
    if code.startswith("remote_"):
        assert detail["message_key"] == f"remote_storage.error.{code}"

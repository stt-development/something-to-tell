"""Baseline exposures and test-only SQL primitives, NOT integrated storage guarantees.

Each test owns a new database; never reset the configured URL's public schema.
Convert exposure assertions to protection regressions in P9-002 through P9-007.
"""

import multiprocessing
import os
import shutil
from dataclasses import replace
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from fastapi import HTTPException
from alembic import command
from psycopg import sql
from sqlalchemy import create_engine, make_url
from sqlalchemy.orm import sessionmaker

from services.runtime.stt_runtime.api.crud import get_node
from services.runtime.stt_runtime.domain.entities import NodeEntity, ProjectEntity
from services.runtime.stt_runtime.project_fixture import import_project_fixture
from services.runtime.stt_runtime.project_session.database import alembic_config, upgrade_external_database
from services.runtime.stt_runtime.project_session.documents import document_with_project_identity
from services.runtime.stt_runtime.project_session.service import ProjectSessionRegistry
from services.runtime.stt_runtime.repositories.sqlite import SqlAlchemyUnitOfWork
from services.runtime.stt_runtime.repositories.project_scope import ProjectScopeError
from services.runtime.stt_runtime.storage_profiles import PostgreSqlProfile, StorageProfileError, StorageProfileRegistry

pytestmark = pytest.mark.skipif(not os.getenv("STT_TEST_POSTGRES_URL"), reason="Requires disposable PostgreSQL CREATE DATABASE permission")


def _connect(url):
    url = make_url(url)
    return psycopg.connect(host=url.host, port=url.port, dbname=url.database,
                           user=url.username, password=url.password,
                           sslmode=url.query.get("sslmode", "verify-full"), connect_timeout=5,
                           autocommit=True)


@pytest.fixture
def audit_database():
    """Only the generated database name can reach the cleanup statement."""
    url = make_url(os.environ["STT_TEST_POSTGRES_URL"])
    name = "stt_p9_audit_" + uuid4().hex
    with _connect(url) as admin:
        admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
        isolated = url.set(database=name)
        try:
            yield isolated
        finally:
            admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))


def _profile(url):
    url = make_url(url)
    return PostgreSqlProfile(profile_id="audit", label="Disposable audit", host=url.host,
                             port=url.port, database=url.database, username=url.username,
                             password=url.password, tls_policy=url.query.get("sslmode", "verify-full"))


def _open_worker(url, path, ready, release):
    """A spawned process has an independent session registry and local lock."""
    registry = ProjectSessionRegistry(StorageProfileRegistry([_profile(url)]))
    try:
        opened = registry.open(Path(path))
        ready.put(("opened", opened.session.session_id))
        if not release.wait(30):
            raise TimeoutError("Parent did not release audit worker")
    except Exception as error:
        ready.put(("error", getattr(error, "code", type(error).__name__)))
        if getattr(error, "code", None) != "remote_project_busy":
            raise
    finally:
        registry.close_all()


def test_two_runtime_processes_cannot_both_open_same_remote_project(audit_database, tmp_path):
    fixture = Path(__file__).parents[3] / "fixtures/projects/project-aurora-export.v1.json"
    first = tmp_path / "First.narrative"
    second = tmp_path / "Second.narrative"
    import_project_fixture(fixture, first)
    registry = ProjectSessionRegistry(StorageProfileRegistry([_profile(audit_database)]))
    try:
        opened = registry.open(first)
        registry.migrate_storage(opened.session.session_id, expected_revision=opened.session.saved_revision,
                                 target_mode="postgresql", target_profile_id="audit")
    finally:
        registry.close_all()
    shutil.copytree(first, second)
    context = multiprocessing.get_context("spawn")
    ready, release = context.Queue(), context.Event()
    url = audit_database.render_as_string(hide_password=False)
    workers = [context.Process(target=_open_worker, args=(url, str(path), ready, release)) for path in (first, second)]
    try:
        for worker in workers:
            worker.start()
        results = [ready.get(timeout=30) for _ in workers]
        assert sorted(status for status, _ in results) == ["error", "opened"]
        assert next(value for status, value in results if status == "error") == "remote_project_busy"
    finally:
        release.set()
        for worker in workers:
            worker.join(timeout=15)
            if worker.is_alive():
                worker.terminate()
                worker.join(timeout=5)
        ready.close()
    assert all(worker.exitcode == 0 for worker in workers)
    assert not list(tmp_path.rglob("project.lock.json"))


def test_scoped_foreign_lookup_and_project_relative_id_coexistence(audit_database):
    upgrade_external_database(audit_database)
    engine = create_engine(audit_database)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    foreign = NodeEntity(project_id="project-b", id="same-id", type="character", title="Foreign character")
    try:
        with SqlAlchemyUnitOfWork(factory) as uow:
            for project_id in ("project-a", "project-b"):
                uow.projects.add(ProjectEntity(id=project_id, name=project_id, path="/tmp/audit", format_version=2))
            uow.commit()
        with SqlAlchemyUnitOfWork(factory) as uow:
            uow.nodes.add(foreign)
            uow.commit()
        with SqlAlchemyUnitOfWork(factory, project_id="project-a") as uow:
            assert [node.id for node in uow.nodes.list(project_id="project-a")] == []
            # Missing in A stays hidden even though the canonical id exists in B.
            with pytest.raises(HTTPException) as hidden:
                get_node(uow, foreign.id)
            assert hidden.value.status_code == 404
        with SqlAlchemyUnitOfWork(factory, project_id="project-a") as uow:
            uow.nodes.add(replace(foreign, project_id="project-a", title="Own character"))
            uow.commit()
            assert get_node(uow, foreign.id).project_id == "project-a"
        with SqlAlchemyUnitOfWork(factory, project_id="project-b") as uow:
            assert uow.nodes.get(foreign.id).project_id == "project-b"
        with SqlAlchemyUnitOfWork(factory) as uow:
            with pytest.raises(ProjectScopeError):
                uow.nodes.get(foreign.id)
    finally:
        engine.dispose()


def test_baseline_independent_copy_preserves_all_canonical_ids(tmp_path):
    fixture = Path(__file__).parents[3] / "fixtures/projects/project-aurora-export.v1.json"
    source = import_project_fixture(fixture, tmp_path / "Original.narrative").document
    manifest = source.manifest.model_copy(update={"project_id": "independent-copy"})
    copy = document_with_project_identity(source, manifest, source.manifest.project_id)
    assert copy.manifest.project_id != source.manifest.project_id
    assert [node.id for node in copy.nodes] == [node.id for node in source.nodes]
    assert all(node.project_id == "independent-copy" for node in copy.nodes)


def test_older_schema_is_rejected_and_profile_checkout_is_bounded(audit_database):
    command.upgrade(alembic_config(audit_database.render_as_string(hide_password=False)), "20260911_0008")
    profile = _profile(audit_database)
    with pytest.raises(StorageProfileError) as caught:
        StorageProfileRegistry([profile]).test("audit")
    assert caught.value.code == "storage_profile_schema_mismatch"
    engine = StorageProfileRegistry([profile]).create_engine("audit")
    try:
        assert engine.pool.timeout() == 5
        assert engine.hide_parameters is True
    finally:
        engine.dispose()


def _claim_worker(url, project_id, ready, start):
    with _connect(url) as connection:
        ready.put("ready")
        if not start.wait(20):
            raise TimeoutError("Parent did not start lease probe")
        with connection.transaction():
            connection.execute("SELECT project_id FROM probe_head WHERE project_id=%s FOR UPDATE", (project_id,))
            claimed = connection.execute("""
                UPDATE probe_head SET epoch=epoch+1, owner=%s,
                  expires=clock_timestamp()+interval '60 seconds'
                WHERE project_id=%s AND (expires IS NULL OR expires <= clock_timestamp())
                RETURNING epoch
            """, (uuid4().hex, project_id)).fetchone()
        ready.put("claimed" if claimed else "busy")


def _prepare_probe(url):
    """Tiny SQL-only model: it is deliberately not a production adapter/migration."""
    with _connect(url) as connection:
        connection.execute("""CREATE TABLE probe_head (
          project_id text PRIMARY KEY, epoch bigint NOT NULL DEFAULT 0,
          owner text, expires timestamptz, revision bigint NOT NULL DEFAULT 0,
          effect_count integer NOT NULL DEFAULT 0)""")
        connection.execute("INSERT INTO probe_head(project_id) VALUES ('a'), ('b')")
        connection.execute("""CREATE TABLE probe_receipt (
          project_id text, command_id text, digest text NOT NULL, revision bigint NOT NULL,
          PRIMARY KEY(project_id, command_id))""")


def test_sql_primitive_claim_serialization_and_expired_owner_fencing(audit_database):
    _prepare_probe(audit_database)
    context = multiprocessing.get_context("spawn")
    ready, start = context.Queue(), context.Event()
    url = audit_database.render_as_string(hide_password=False)
    workers = [context.Process(target=_claim_worker, args=(url, "a", ready, start)) for _ in range(2)]
    try:
        for worker in workers:
            worker.start()
        assert [ready.get(timeout=20) for _ in workers] == ["ready", "ready"]
        start.set()
        assert sorted(ready.get(timeout=20) for _ in workers) == ["busy", "claimed"]
    finally:
        start.set()
        for worker in workers:
            worker.join(timeout=10)
            if worker.is_alive():
                worker.terminate()
                worker.join(timeout=5)
        ready.close()
    assert all(worker.exitcode == 0 for worker in workers)
    with _connect(url) as connection:
        assert connection.execute("SELECT epoch FROM probe_head WHERE project_id='b'").fetchone() == (0,)
        assert connection.execute("UPDATE probe_head SET epoch=epoch+1, owner='independent' WHERE project_id='b' RETURNING epoch").fetchone() == (1,)
        old_epoch, old_owner = connection.execute("SELECT epoch, owner FROM probe_head WHERE project_id='a'").fetchone()
        # Expiry is controlled by SQL, not timing-sensitive sleeps.
        connection.execute("UPDATE probe_head SET expires=clock_timestamp()-interval '1 second' WHERE project_id='a'")
        assert connection.execute("""UPDATE probe_head SET expires=clock_timestamp()+interval '60 seconds'
          WHERE project_id='a' AND epoch=%s AND owner=%s AND expires>clock_timestamp() RETURNING epoch""",
                                  (old_epoch, old_owner)).fetchone() is None
        connection.execute("UPDATE probe_head SET epoch=epoch+1, owner='replacement' WHERE project_id='a'")
        assert connection.execute("""UPDATE probe_head SET effect_count=effect_count+1
          WHERE project_id='a' AND epoch=%s AND owner=%s RETURNING epoch""",
                                  (old_epoch, old_owner)).fetchone() is None


def _probe_command(connection, command_id, digest, expected_revision):
    """Exercise receipt-before-revision ordering; no retained request/Undo payload."""
    with connection.transaction():
        head = connection.execute("SELECT revision FROM probe_head WHERE project_id='a' FOR UPDATE").fetchone()[0]
        receipt = connection.execute("SELECT digest, revision FROM probe_receipt WHERE project_id='a' AND command_id=%s", (command_id,)).fetchone()
        if receipt:
            if receipt[0] != digest:
                raise ValueError("remote_command_reused")
            return receipt[1]
        if head != expected_revision:
            raise ValueError("remote_revision_stale")
        revision = connection.execute("UPDATE probe_head SET revision=revision+1, effect_count=effect_count+1 WHERE project_id='a' RETURNING revision").fetchone()[0]
        connection.execute("INSERT INTO probe_receipt VALUES ('a', %s, %s, %s)", (command_id, digest, revision))
        return revision


def test_sql_primitive_lost_response_receipt_and_unknown_outcome_lock(audit_database):
    _prepare_probe(audit_database)
    with _connect(audit_database) as writer, _connect(audit_database) as resolver:
        with pytest.raises(RuntimeError, match="before commit"):
            with writer.transaction():
                _probe_command(writer, "rolled-back", "digest-0", 0)
                raise RuntimeError("before commit")
        assert resolver.execute("SELECT count(*) FROM probe_receipt").fetchone() == (0,)
        assert resolver.execute("SELECT revision, effect_count FROM probe_head WHERE project_id='a'").fetchone() == (0, 0)
        _probe_command(writer, "command-1", "digest-1", 0)  # Deliberately discard committed response.
        assert _probe_command(resolver, "command-1", "digest-1", 0) == 1
        with pytest.raises(ValueError, match="remote_command_reused"):
            _probe_command(resolver, "command-1", "different", 0)
        assert resolver.execute("SELECT revision, effect_count FROM probe_head WHERE project_id='a'").fetchone() == (1, 1)
        with writer.transaction():
            writer.execute("SELECT revision FROM probe_head WHERE project_id='a' FOR UPDATE")
            with pytest.raises(psycopg.errors.LockNotAvailable):
                with resolver.transaction():
                    resolver.execute("SET LOCAL lock_timeout='100ms'")
                    # A timeout must become unknown, not proof of an absent receipt.
                    resolver.execute("SELECT revision FROM probe_head WHERE project_id='a' FOR SHARE")
        with resolver.transaction():
            assert resolver.execute("SELECT revision FROM probe_head WHERE project_id='a' FOR SHARE").fetchone() == (1,)
            assert resolver.execute("SELECT revision FROM probe_receipt WHERE command_id='command-1'").fetchone() == (1,)

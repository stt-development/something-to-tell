"""E2 reviewed upgrades on generated databases; operator fences are never auto-restored."""

import os
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import Mock
from uuid import uuid4

from alembic import command
import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.pool import NullPool

from services.runtime.stt_runtime import schema_upgrade as upgrade
from services.runtime.stt_runtime.project_session.errors import ProjectSessionError
from services.runtime.stt_runtime.schema_plan_context import capture_schema_plan_context
from services.runtime.stt_runtime.schema_plans import SchemaPlanRegistry
from services.runtime.stt_runtime.storage_profiles import StorageProfileRegistry
from services.runtime.stt_runtime.schemas.remote_storage import (
    RemoteSchemaBackupAttestationRequestV1, RemoteSchemaExecuteRequestV1, RemoteSchemaPlanRequestV1,
)
from services.runtime.tests.test_remote_storage_protocol_audit import audit_database, _profile
from services.runtime.tests.test_schema_plan_context_postgresql import source

pytestmark = pytest.mark.skipif(not os.getenv("STT_TEST_POSTGRES_URL"), reason="Disposable PostgreSQL required")


def prepare(source, revision="20261022_0011", *, backup=True):
    engine, config, folder, profiles = source
    command.upgrade(config, revision)
    with engine.begin() as connection:
        for project in ("a", "b"):
            connection.execute(text("""INSERT INTO projects(id,name,path,format_version,metadata,created_at,updated_at)
                VALUES (:id,:id,'fixture',2,'{}',now(),now())"""), {"id": project})
            for index in (1, 2):
                node = f"{project}-node-{index}"
                connection.execute(text("""INSERT INTO nodes(id,project_id,type,title,summary,body,status,metadata,created_at,updated_at)
                    VALUES (:id,:project,'Event',:id,'Summary','Authored body','canon','{}',now(),now())"""),
                    {"id": node, "project": project})
            connection.execute(text("""INSERT INTO edges(id,project_id,source_node_id,target_node_id,type,label,condition,metadata,created_at,updated_at)
                VALUES (:id,:project,:source,:target,'related','Authored label','','{}',now(),now())"""),
                {"id": f"{project}-edge", "project": project, "source": f"{project}-node-1", "target": f"{project}-node-2"})
            if revision == "20261022_0011":
                connection.execute(text("INSERT INTO project_storage_heads(project_id,storage_generation) VALUES (:id,:generation)"),
                                   {"id": project, "generation": str(uuid4())})
    # An operator must actually close other DB clients, not just claim to do so.
    engine.dispose()
    return review(folder, profiles, revision, backup=backup)


def review(folder, profiles, revision, *, backup=True):
    plans = SchemaPlanRegistry()
    context = capture_schema_plan_context(profiles, folder, "audit")
    plan = plans.create(RemoteSchemaPlanRequestV1(project_path=str(folder.path), profile_id="audit", action="upgrade",
        expected_schema_revision=revision), context)
    attestation = plans.attest(RemoteSchemaBackupAttestationRequestV1(project_path=str(folder.path), profile_id="audit",
        plan_id=plan.plan_id, plan_fingerprint=plan.plan_fingerprint, confirmation="backup_and_restore_verified"), context) if backup else None
    request = RemoteSchemaExecuteRequestV1(project_path=str(folder.path), profile_id="audit", plan_id=plan.plan_id,
        plan_fingerprint=plan.plan_fingerprint, backup_attestation_id=attestation.backup_attestation_id if attestation else None)
    return plans, request, context


def authored(engine):
    with engine.connect() as connection:
        result = {name: list(connection.execute(text(f'SELECT * FROM "{name}" ORDER BY id')).mappings())
                  for name in ("projects", "nodes", "edges")}
    engine.dispose()
    return result


def files(folder):
    return {p: p.read_bytes() for p in folder.path.rglob("*") if p.is_file()}


@pytest.mark.parametrize("revision", ["20260919_0009", "20261022_0011"])
def test_complete_seeded_multi_project_data_exact_target_and_single_use(source, revision):
    engine, _, folder, profiles = source
    plans, request, context = prepare(source, revision)
    before, local = authored(engine), files(folder)
    result = upgrade.execute_upgrade(profiles, folder, request, plans)
    assert result.inspection.schema_revision == context.target_schema_revision
    assert result.inspection.schema_status == "current" and not result.maintenance
    assert authored(engine) == before and files(folder) == local
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT maintenance FROM remote_storage_control")) is False
        assert connection.scalar(text("SELECT count(*) FROM project_storage_heads")) == 2
    with pytest.raises(ProjectSessionError, match="remote_schema_plan_stale"):
        plans.claim(request, context)


def test_missing_backup_never_sets_maintenance_or_runs_ddl(source, monkeypatch):
    engine, _, folder, profiles = source
    plans, request, _ = prepare(source, backup=False)
    migrate = Mock(side_effect=AssertionError("unexpected migration"))
    monkeypatch.setattr(upgrade.command, "upgrade", migrate)
    with pytest.raises(ProjectSessionError, match="remote_schema_backup_required"):
        upgrade.execute_upgrade(profiles, folder, request, plans)
    migrate.assert_not_called()
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT maintenance FROM remote_storage_control")) is False


@pytest.mark.parametrize("revision", ["20260919_0009", "20261022_0011"])
def test_failed_ddl_restores_data_and_retains_existing_committed_maintenance(source, monkeypatch, revision):
    engine, _, folder, profiles = source
    plans, request, context = prepare(source, revision)
    before = authored(engine)
    real_upgrade = command.upgrade
    def fail(config, target):
        real_upgrade(config, target)
        if target == context.target_schema_revision:
            config.attributes["connection"].execute(text("SELECT 1/0"))
    monkeypatch.setattr(upgrade.command, "upgrade", fail)
    with pytest.raises(ProjectSessionError, match="remote_storage_unavailable"):
        upgrade.execute_upgrade(profiles, folder, request, plans)
    assert authored(engine) == before
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == revision
        if revision == "20261022_0011":
            assert connection.scalar(text("SELECT maintenance FROM remote_storage_control")) is True
        else:
            assert "remote_storage_control" not in inspect(connection).get_table_names()
    with pytest.raises(ProjectSessionError, match="remote_schema_plan_stale"):
        plans.claim(request, context)


def test_postcondition_failure_leaves_maintenance_and_requires_explicit_recovery(source, monkeypatch):
    engine, _, folder, profiles = source
    plans, request, context = prepare(source)
    real_upgrade = command.upgrade
    def incomplete(config, target):
        real_upgrade(config, target)
        config.attributes["connection"].execute(text("ALTER TABLE nodes DROP COLUMN title"))
    monkeypatch.setattr(upgrade.command, "upgrade", incomplete)
    with pytest.raises(ProjectSessionError, match="remote_schema_partial"):
        upgrade.execute_upgrade(profiles, folder, request, plans)
    observed = capture_schema_plan_context(profiles, folder, "audit")
    assert observed.maintenance and observed.inspection.schema_revision == "20261022_0011"
    with pytest.raises(ProjectSessionError, match="remote_schema_busy"):
        plans.create(RemoteSchemaPlanRequestV1(project_path=str(folder.path), profile_id="audit",
            action="upgrade", expected_schema_revision="20261022_0011"), observed)
    assert request.plan_id not in plans._plans
    # Only this explicit operator action clears a proven old-schema rollback.
    with engine.begin() as connection:
        connection.execute(text("UPDATE remote_storage_control SET maintenance=false WHERE id=1"))
    engine.dispose()
    recovered = capture_schema_plan_context(profiles, folder, "audit")
    assert not recovered.maintenance and recovered.inspection.schema_revision == context.inspection.schema_revision


def test_lost_upgrade_commit_ack_is_unknown_but_inspection_finds_complete_schema(source, monkeypatch):
    engine, _, folder, profiles = source
    plans, request, _ = prepare(source)
    before = authored(engine)
    real_commit, commits = engine.dialect.do_commit, []
    def lost_ack(dbapi):
        real_commit(dbapi); commits.append(True)
        if len(commits) == 2:  # Committed marker first, complete DDL second.
            raise OperationalError("redacted", None, Exception("private driver detail"))
    with monkeypatch.context() as patch:
        patch.setattr(profiles, "create_engine", lambda *_: engine)
        patch.setattr(engine.dialect, "do_commit", lost_ack)
        with pytest.raises(ProjectSessionError, match="remote_commit_unknown"):
            upgrade.execute_upgrade(profiles, folder, request, plans)
    observed = capture_schema_plan_context(profiles, folder, "audit")
    assert observed.inspection.schema_status == "current" and not observed.maintenance
    assert authored(engine) == before and request.plan_id not in plans._plans


def test_new_client_after_marker_commit_is_detected_before_any_ddl(source, monkeypatch):
    engine, _, folder, profiles = source
    plans, request, _ = prepare(source)
    other = create_engine(engine.url, poolclass=NullPool)
    clients = []
    real_marker = upgrade._commit_maintenance
    def marker(value):
        real_marker(value)
        clients.append(other.connect())
    migrate = Mock(side_effect=AssertionError("DDL despite new client"))
    monkeypatch.setattr(upgrade, "_commit_maintenance", marker)
    monkeypatch.setattr(upgrade.command, "upgrade", migrate)
    try:
        with pytest.raises(ProjectSessionError, match="remote_schema_busy"):
            upgrade.execute_upgrade(profiles, folder, request, plans)
        migrate.assert_not_called()
        assert clients[0].scalar(text("SELECT 1")) == 1
    finally:
        for client in clients:
            client.close()
        other.dispose()
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT maintenance FROM remote_storage_control")) is True
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "20261022_0011"


def test_separate_non_superuser_schema_admin_with_dormant_cluster_dba(source):
    engine, _, folder, _ = source
    prepare(source)
    role, password = "stt_e2_admin_" + uuid4().hex, uuid4().hex
    quote = engine.dialect.identifier_preparer.quote_identifier
    try:
        with engine.begin() as connection:
            # Only a fresh UUID role and this generated DB's objects are altered.
            connection.exec_driver_sql(f'CREATE ROLE {quote(role)} LOGIN PASSWORD \'{password}\'')
            connection.exec_driver_sql(f'ALTER SCHEMA public OWNER TO {quote(role)}')
            for table in inspect(connection).get_table_names(schema="public"):
                connection.exec_driver_sql(f'ALTER TABLE public.{quote(table)} OWNER TO {quote(role)}')
            connection.exec_driver_sql(f'GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO {quote(role)}')
            assert connection.execute(text("SELECT rolsuper,rolcanlogin FROM pg_roles WHERE rolname=current_user")).one() == (True, True)
        engine.dispose()
        profile = _profile(engine.url).model_copy(update={"username": role, "password": password})
        profiles = StorageProfileRegistry([profile])
        plans, request, _ = review(folder, profiles, "20261022_0011")
        result = upgrade.execute_upgrade(profiles, folder, request, plans)
        assert result.inspection.schema_status == "current"
        with engine.connect() as connection:
            assert connection.execute(text("SELECT rolsuper,rolcanlogin FROM pg_roles WHERE rolname=current_user")).one() == (True, True)
            assert connection.execute(text("SELECT rolsuper,rolcanlogin FROM pg_roles WHERE rolname=:role"), {"role": role}).one() == (False, True)
    finally:
        with engine.begin() as connection:
            # The new role owns only objects in this fixture DB, not shared DBs.
            connection.exec_driver_sql(f'REASSIGN OWNED BY {quote(role)} TO CURRENT_USER')
            connection.exec_driver_sql(f'DROP OWNED BY {quote(role)}')
            connection.exec_driver_sql(f'DROP ROLE {quote(role)}')


def test_parallel_upgrade_attempts_do_not_bypass_busy_and_only_one_plan_executes(source, monkeypatch):
    engine, _, folder, profiles = source
    first, request_a, _ = prepare(source)
    second, request_b, _ = review(folder, profiles, "20261022_0011")
    blocker = create_engine(engine.url, poolclass=NullPool)
    start = Barrier(2)
    real_upgrade, calls = command.upgrade, []
    def migrate(config, target):
        calls.append(target)
        real_upgrade(config, target)
    def attempt(plans, request):
        start.wait(timeout=5)
        try:
            upgrade.execute_upgrade(profiles, folder, request, plans)
        except ProjectSessionError as error:
            return error.code
        return "completed"
    monkeypatch.setattr(upgrade.command, "upgrade", migrate)
    try:
        with blocker.connect(), ThreadPoolExecutor(max_workers=2) as pool:
            a = pool.submit(attempt, first, request_a)
            b = pool.submit(attempt, second, request_b)
            assert a.result(timeout=20) == b.result(timeout=20) == "remote_schema_busy"
        assert calls == []
        assert request_a.plan_id in first._plans and request_b.plan_id in second._plans
        assert upgrade.execute_upgrade(profiles, folder, request_a, first).inspection.schema_status == "current"
        with pytest.raises(ProjectSessionError, match="remote_schema_plan_stale"):
            upgrade.execute_upgrade(profiles, folder, request_b, second)
        assert calls == ["20261022_0012"]
    finally:
        blocker.dispose()


@pytest.mark.parametrize("drift", ["future", "unknown", "partial"])
def test_changed_incompatible_source_never_reaches_migration(source, monkeypatch, drift):
    engine, _, folder, profiles = source
    plans, request, _ = prepare(source)
    with engine.begin() as connection:
        if drift == "partial":
            connection.execute(text("ALTER TABLE nodes DROP COLUMN title"))
        else:
            value = "20990101_0099" if drift == "future" else "unrecognized-revision"
            connection.execute(text("UPDATE alembic_version SET version_num=:revision"), {"revision": value})
    engine.dispose()
    migrate = Mock(side_effect=AssertionError("incompatible upgrade executed"))
    monkeypatch.setattr(upgrade.command, "upgrade", migrate)
    with pytest.raises(ProjectSessionError, match="remote_schema_plan_stale"):
        upgrade.execute_upgrade(profiles, folder, request, plans)
    migrate.assert_not_called()
    assert request.plan_id not in plans._plans

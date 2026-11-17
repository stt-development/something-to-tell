"""D2b real transactional DDL on generated databases only; no application sessions."""

from concurrent.futures import ThreadPoolExecutor
import os
from threading import Event, current_thread
from unittest.mock import Mock

from alembic import command
import pytest
from sqlalchemy import event, inspect, text

from services.runtime.stt_runtime import schema_provisioning as provisioning
from services.runtime.stt_runtime.schema_admin_transaction import SCHEMA_MIGRATION_LOCK
from services.runtime.stt_runtime.project_session.errors import ProjectSessionError
from services.runtime.stt_runtime.schema_plan_context import capture_schema_plan_context
from services.runtime.stt_runtime.schema_plans import SchemaPlanRegistry
from services.runtime.stt_runtime.schemas.remote_storage import RemoteSchemaPlanRequestV1, RemoteSchemaExecuteRequestV1
from services.runtime.tests.test_remote_storage_protocol_audit import audit_database
from services.runtime.tests.test_schema_plan_context_postgresql import source
from services.runtime.tests.test_storage_profile_permissions import restricted_profile

pytestmark = pytest.mark.skipif(not os.getenv("STT_TEST_POSTGRES_URL"), reason="Disposable PostgreSQL required")


def prepare(folder, profiles, plans=None):
    plans = plans or SchemaPlanRegistry()
    context = capture_schema_plan_context(profiles, folder, "audit")
    plan = plans.create(RemoteSchemaPlanRequestV1(project_path=str(folder.path), profile_id="audit",
        action="provision", expected_schema_revision=None), context)
    request = RemoteSchemaExecuteRequestV1(project_path=str(folder.path), profile_id="audit",
        plan_id=plan.plan_id, plan_fingerprint=plan.plan_fingerprint, backup_attestation_id=None)
    return plans, request, context


def files(folder):
    return {str(p.relative_to(folder.path)): p.read_bytes() for p in folder.path.rglob("*") if p.is_file()}


def assert_consumed(plans, request, context):
    with pytest.raises(ProjectSessionError, match="remote_schema_plan_stale"):
        plans.claim(request, context)


def test_exact_target_commit_one_connection_no_project_writes_and_single_use(source, monkeypatch):
    engine, _, folder, profiles = source
    plans, request, context = prepare(folder, profiles)
    before = files(folder)
    connections, statements = set(), []
    monkeypatch.setattr(profiles, "create_engine", lambda *_: engine)
    @event.listens_for(engine, "before_cursor_execute")
    def trace(connection, _, sql, *___):
        connections.add(id(connection)); statements.append(sql)
    result = provisioning.execute_provisioning(profiles, folder, request, plans)
    assert len(connections) == 1
    lock_index = next(i for i, sql in enumerate(statements) if "pg_advisory_xact_lock" in sql)
    context_index = next(i for i, sql in enumerate(statements) if "pg_control_system" in sql)
    assert lock_index < context_index
    assert result.inspection.schema_status == "current"
    assert result.inspection.schema_revision == context.target_schema_revision
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == context.target_schema_revision
        assert connection.scalar(text("SELECT count(*) FROM projects")) == 0
        assert connection.scalar(text("SELECT count(*) FROM project_storage_heads")) == 0
    assert files(folder) == before
    assert_consumed(plans, request, context)


@pytest.mark.parametrize("failure", ["migration", "postcondition", "commit"])
def test_late_failure_rolls_back_entire_schema_without_reviving_claim(source, monkeypatch, failure):
    engine, _, folder, profiles = source
    plans, request, context = prepare(folder, profiles)
    before = files(folder)
    monkeypatch.setattr(profiles, "create_engine", lambda *_: engine)
    real_upgrade = command.upgrade
    def upgrade(config, target):
        real_upgrade(config, target)
        if failure == "migration":
            config.attributes["connection"].execute(text("SELECT 1/0"))
        elif failure == "postcondition":
            config.attributes["connection"].execute(text("DROP TABLE agent_memories"))
    monkeypatch.setattr(provisioning.command, "upgrade", upgrade)
    def refuse_commit(_):
        raise RuntimeError("injected-before-commit")
    if failure == "commit":
        event.listen(engine, "commit", refuse_commit)
    with pytest.raises((ProjectSessionError, RuntimeError)) as caught:
        provisioning.execute_provisioning(profiles, folder, request, plans)
    assert str(caught.value) in {"remote_storage_unavailable", "remote_schema_partial", "injected-before-commit"}
    if failure == "commit":
        event.remove(engine, "commit", refuse_commit)
    with engine.connect() as connection:
        assert inspect(connection).get_table_names() == []
    assert files(folder) == before
    assert_consumed(plans, request, context)


@pytest.mark.parametrize("change", ["catalog", "current", "profile"])
def test_stale_catalog_current_schema_and_rebound_profile_never_run_ddl(source, monkeypatch, change):
    engine, config, folder, profiles = source
    plans, request, context = prepare(folder, profiles)
    if change == "catalog":
        with engine.begin() as connection:
            connection.execute(text("CREATE TABLE unrelated(id integer)"))
    elif change == "current":
        command.upgrade(config, "head")
    else:
        # A different effective identity must invalidate the same opaque plan.
        original_capture = provisioning._capture
        def changed(*args):
            return original_capture(*args).model_copy(update={"authority_fingerprint": "e" * 64})
        monkeypatch.setattr(provisioning, "_capture", changed)
    migrate = Mock(side_effect=AssertionError("unexpected DDL"))
    monkeypatch.setattr(provisioning.command, "upgrade", migrate)
    with pytest.raises(ProjectSessionError, match="remote_schema_plan_stale"):
        provisioning.execute_provisioning(profiles, folder, request, plans)
    migrate.assert_not_called()
    assert_consumed(plans, request, context)


def test_lock_timeout_is_bounded_and_preclaim_plan_can_be_explicitly_retried(source):
    engine, _, folder, profiles = source
    plans, request, context = prepare(folder, profiles)
    with engine.begin() as blocker:
        blocker.execute(SCHEMA_MIGRATION_LOCK)
        with pytest.raises(ProjectSessionError, match="remote_schema_busy"):
            provisioning.execute_provisioning(profiles, folder, request, plans)
        with engine.connect() as observer:
            assert inspect(observer).get_table_names() == []
    result = provisioning.execute_provisioning(profiles, folder, request, plans)
    assert result.inspection.schema_status == "current"
    assert_consumed(plans, request, context)


def test_independent_admins_wait_then_reobserve_without_duplicate_ddl(source, monkeypatch):
    _, _, folder, profiles = source
    first, first_request, _ = prepare(folder, profiles)
    second, second_request, second_context = prepare(folder, profiles)
    entered, release, waiting = Event(), Event(), Event()
    real_upgrade, create_engine, real_capture = command.upgrade, profiles.create_engine, provisioning._capture
    calls = []
    def engine(*args):
        value = create_engine(*args)
        @event.listens_for(value, "before_cursor_execute")
        def observe(_, __, sql, *___):
            if current_thread().name.startswith("second") and "pg_advisory_xact_lock" in sql:
                waiting.set()
        return value
    def upgrade(config, target):
        calls.append(target)
        real_upgrade(config, target)
    def capture(*args):
        result = real_capture(*args)
        # Hold only the already-validated precommit boundary, not the whole DDL
        # chain: lock_timeout is intentionally shorter than a slow full migration.
        if current_thread().name.startswith("first") and result.inspection.schema_status == "current":
            entered.set()
            assert release.wait(5)
        return result
    monkeypatch.setattr(profiles, "create_engine", engine)
    monkeypatch.setattr(provisioning.command, "upgrade", upgrade)
    monkeypatch.setattr(provisioning, "_capture", capture)
    with ThreadPoolExecutor(max_workers=1, thread_name_prefix="first") as a, ThreadPoolExecutor(max_workers=1, thread_name_prefix="second") as b:
        winner = a.submit(provisioning.execute_provisioning, profiles, folder, first_request, first)
        try:
            assert entered.wait(20)
            loser = b.submit(provisioning.execute_provisioning, profiles, folder, second_request, second)
            assert waiting.wait(5)
        finally:
            release.set()
        assert winner.result(timeout=20).inspection.schema_status == "current"
        with pytest.raises(ProjectSessionError, match="remote_schema_plan_stale"):
            loser.result(timeout=20)
    assert len(calls) == 1
    assert_consumed(second, second_request, second_context)


def test_revoked_administrator_cannot_execute_plan(restricted_profile, tmp_path):
    profiles, admin, _, role, _ = restricted_profile
    from services.runtime.stt_runtime.project_format.service import create_project_folder
    folder = create_project_folder(tmp_path / "Restricted.narrative")
    with admin.begin() as connection:
        connection.exec_driver_sql(f'GRANT CREATE ON SCHEMA public TO "{role}"')
        connection.exec_driver_sql(f'GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO "{role}"')
    plans, request, _ = prepare(folder, profiles)
    with admin.begin() as connection:
        connection.exec_driver_sql(f'REVOKE CREATE ON SCHEMA public FROM "{role}"')
    with pytest.raises(ProjectSessionError, match="remote_admin_required"):
        provisioning.execute_provisioning(profiles, folder, request, plans)
    with admin.connect() as connection:
        assert inspect(connection).get_table_names() == []

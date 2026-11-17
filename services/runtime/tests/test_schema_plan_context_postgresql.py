"""Trusted contexts from isolated real SQL snapshots, not user projects or credentials."""

import os
from uuid import uuid4

import pytest
from alembic import command
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, event, text

from services.runtime.scripts.benchmark_storage import disposable_database
from services.runtime.tests.test_remote_storage_protocol_audit import audit_database, _profile
from services.runtime.tests.test_storage_profile_permissions import restricted_profile
from services.runtime.stt_runtime.project_format.service import create_project_folder
from services.runtime.stt_runtime.project_session.database import alembic_config
from services.runtime.stt_runtime.project_session.errors import ProjectSessionError
from services.runtime.stt_runtime.schema_plan_context import capture_schema_plan_context
from services.runtime.stt_runtime.schema_plans import SchemaPlanRegistry
from services.runtime.stt_runtime.schemas.remote_storage import RemoteSchemaPlanRequestV1, RemoteSchemaBackupAttestationRequestV1
from services.runtime.stt_runtime.storage_profiles import StorageProfileRegistry

pytestmark = pytest.mark.skipif(not os.getenv("STT_TEST_POSTGRES_URL"), reason="Disposable PostgreSQL required")


@pytest.fixture
def source(audit_database, tmp_path):
    engine = create_engine(audit_database, hide_parameters=True)
    folder = create_project_folder(tmp_path / "Context.narrative")
    profiles = StorageProfileRegistry([_profile(audit_database)])
    config = alembic_config(audit_database.render_as_string(hide_password=False))
    try:
        yield engine, config, folder, profiles
    finally:
        engine.dispose()


def plan_request(folder, context):
    return RemoteSchemaPlanRequestV1(project_path=str(folder.path), profile_id="audit", action="upgrade",
        expected_schema_revision=context.inspection.schema_revision)


def confirmation(folder, plan):
    return RemoteSchemaBackupAttestationRequestV1(project_path=str(folder.path), profile_id="audit",
        plan_id=plan.plan_id, plan_fingerprint=plan.plan_fingerprint, confirmation="backup_and_restore_verified")


def test_empty_context_is_stable_secret_free_and_one_readonly_snapshot(source, monkeypatch):
    engine, config, folder, profiles = source
    monkeypatch.setattr(profiles, "create_engine", lambda *_: engine)
    statements, connections = [], set()
    before = {str(path.relative_to(folder.path)): path.read_bytes() for path in folder.path.rglob("*") if path.is_file()}
    @event.listens_for(engine, "before_cursor_execute")
    def trace(connection, _, sql, *___):
        statements.append(sql)
        connections.add(id(connection))
        if "pg_catalog.pg_control_system()" in sql:
            cursor = connection.connection.cursor()
            try:
                cursor.execute("SHOW transaction_read_only")
                assert cursor.fetchone()[0] == "on"
                cursor.execute("SHOW transaction_isolation")
                assert cursor.fetchone()[0] == "repeatable read"
            finally:
                cursor.close()
    first = capture_schema_plan_context(profiles, folder, "audit")
    assert len(connections) == 1
    assert all(sql.lstrip().upper().startswith(("SELECT", "SET", "SHOW")) for sql in statements)
    event.remove(engine, "before_cursor_execute", trace)
    second = capture_schema_plan_context(profiles, folder, "audit")
    scripts = ScriptDirectory.from_config(config)
    assert first == second and first.inspection.schema_status == "empty"
    assert first.migration_revisions == tuple(r.revision for r in reversed(list(scripts.walk_revisions())))
    assert str(folder.path) not in first.model_dump_json() and profiles.resolve("audit").password not in first.model_dump_json()
    assert before == {str(path.relative_to(folder.path)): path.read_bytes() for path in folder.path.rglob("*") if path.is_file()}
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT count(*) FROM pg_tables WHERE schemaname='public'")) == 0


def test_exact_upgrade_steps_and_current_reinspection_invalidate_old_plan(source):
    engine, config, folder, profiles = source
    command.upgrade(config, "20261021_0010")
    old = capture_schema_plan_context(profiles, folder, "audit")
    assert old.migration_revisions == ("20261022_0011", "20261022_0012")
    command.upgrade(config, "20261022_0011")
    context = capture_schema_plan_context(profiles, folder, "audit")
    assert context.migration_revisions == ("20261022_0012",)
    owner = SchemaPlanRegistry()
    plan = owner.create(plan_request(folder, context), context)
    command.upgrade(config, "head")  # Only the isolated fixture performs DDL.
    current = capture_schema_plan_context(profiles, folder, "audit")
    assert current.inspection.schema_status == "current" and current.migration_revisions == ()
    with pytest.raises(ProjectSessionError, match="remote_schema_plan_stale"):
        owner.attest(confirmation(folder, plan), current)
    with engine.begin() as connection:
        connection.execute(text("UPDATE remote_storage_control SET capabilities='[\"consistent_capture\",\"durable_commands\",\"server_checkpoints\",\"additional\"]'"))
    assert capture_schema_plan_context(profiles, folder, "audit").schema_fingerprint != current.schema_fingerprint


def test_ddl_changes_are_bound_but_ordinary_rows_are_not_copied(source):
    engine, config, folder, profiles = source
    command.upgrade(config, "20261022_0011")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE author_notes(id integer, body text)"))
    original = capture_schema_plan_context(profiles, folder, "audit")
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO author_notes VALUES (1,'private narrative text')"))
        connection.execute(text("ANALYZE author_notes"))
    assert capture_schema_plan_context(profiles, folder, "audit") == original
    with engine.begin() as connection:
        connection.execute(text("ALTER TABLE nodes ADD COLUMN extra_note text"))
    changed = capture_schema_plan_context(profiles, folder, "audit")
    assert changed.schema_fingerprint != original.schema_fingerprint
    assert changed.authority_fingerprint == original.authority_fingerprint
    assert "private narrative text" not in changed.model_dump_json()
    with engine.begin() as connection:
        connection.execute(text("GRANT SELECT ON nodes TO PUBLIC"))
    assert capture_schema_plan_context(profiles, folder, "audit").schema_fingerprint != changed.schema_fingerprint


def test_control_and_head_changes_bind_context_but_heartbeat_expiry_does_not(source):
    engine, config, folder, profiles = source
    command.upgrade(config, "20261022_0011")
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO projects(id,name,path,format_version,metadata,created_at,updated_at) VALUES ('p','P','fixture',2,'{}',now(),now())"))
        connection.execute(text("INSERT INTO project_storage_heads(project_id,storage_generation,writer_epoch,owner_token,lease_expires_at) VALUES ('p',:generation,1,'private-owner-token',clock_timestamp()+interval '60 seconds')"), {"generation": str(uuid4())})
    original = capture_schema_plan_context(profiles, folder, "audit")
    with engine.begin() as connection:
        connection.execute(text("UPDATE project_storage_heads SET lease_expires_at=clock_timestamp()+interval '120 seconds'"))
    assert capture_schema_plan_context(profiles, folder, "audit") == original
    for update in ("writer_epoch=writer_epoch+1", "authoring_revision=authoring_revision+1", f"storage_generation='{uuid4()}'"):
        with engine.begin() as connection:
            connection.execute(text(f"UPDATE project_storage_heads SET {update}"))
        changed = capture_schema_plan_context(profiles, folder, "audit")
        assert changed.schema_fingerprint != original.schema_fingerprint
        original = changed
    with engine.begin() as connection:
        connection.execute(text("UPDATE remote_storage_control SET maintenance=true"))
    changed = capture_schema_plan_context(profiles, folder, "audit")
    assert changed.maintenance and changed.schema_fingerprint != original.schema_fingerprint
    assert "private-owner-token" not in changed.model_dump_json()


def test_missing_operational_metadata_is_partial_not_a_ready_legacy_context(source):
    engine, config, folder, profiles = source
    command.upgrade(config, "20261022_0011")
    with engine.begin() as connection:
        connection.execute(text("DROP TABLE remote_storage_control"))
    captured = capture_schema_plan_context(profiles, folder, "audit")
    assert captured.inspection.schema_status == "partial"
    with pytest.raises(ProjectSessionError, match="remote_schema_partial"):
        SchemaPlanRegistry().create(plan_request(folder, captured), captured)


def test_database_identity_is_actual_not_a_profile_alias(source):
    engine, _, folder, profiles = source
    original = capture_schema_plan_context(profiles, folder, "audit")
    alias = _profile(engine.url).model_copy(update={"profile_id": "alias"})
    via_alias = capture_schema_plan_context(StorageProfileRegistry([alias]), folder, "alias")
    assert via_alias.authority_fingerprint == original.authority_fingerprint
    assert via_alias.schema_fingerprint == original.schema_fingerprint
    with disposable_database() as other_url:
        other = capture_schema_plan_context(StorageProfileRegistry([_profile(other_url)]), folder, "audit")
        assert other.authority_fingerprint != original.authority_fingerprint


def test_identity_privilege_is_explicit_and_effective_role_is_bound(restricted_profile, tmp_path):
    profiles, admin, _, role, _ = restricted_profile
    folder = create_project_folder(tmp_path / "Restricted.narrative")
    with admin.begin() as connection:
        connection.exec_driver_sql(f'GRANT CREATE ON SCHEMA public TO "{role}"')
        connection.execute(text("REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system() FROM PUBLIC"))
    with pytest.raises(ProjectSessionError, match="remote_admin_required"):
        capture_schema_plan_context(profiles, folder, "audit")
    with admin.begin() as connection:
        connection.exec_driver_sql(f'GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO "{role}"')
    restricted = capture_schema_plan_context(profiles, folder, "audit")
    administrator = capture_schema_plan_context(StorageProfileRegistry([_profile(admin.url)]), folder, "audit")
    assert restricted.authority_fingerprint != administrator.authority_fingerprint

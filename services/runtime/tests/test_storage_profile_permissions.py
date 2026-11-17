"""Profile health with real restricted roles in disposable PostgreSQL databases."""

import os
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, event, text

from services.runtime.stt_runtime.project_session.database import upgrade_external_database
from services.runtime.stt_runtime.storage_profiles import StorageProfileRegistry
from services.runtime.tests.test_remote_storage_protocol_audit import audit_database, _profile

pytestmark = pytest.mark.skipif(not os.getenv("STT_TEST_POSTGRES_URL"), reason="Disposable PostgreSQL required")


@pytest.fixture
def restricted_profile(audit_database, monkeypatch):
    """Use an actual restricted login; credentials exist only in this test process."""
    admin = create_engine(audit_database)
    role = "stt_p9_health_" + uuid4().hex
    password = uuid4().hex
    profile = _profile(audit_database).model_copy(update={"username": role, "password": password})
    restricted = create_engine(profile.database_url(), hide_parameters=True)
    statements = []

    @event.listens_for(restricted, "connect")
    def require_readonly(dbapi_connection, _):
        with dbapi_connection.cursor() as cursor:
            cursor.execute("SET default_transaction_read_only = on")
        dbapi_connection.commit()

    @event.listens_for(restricted, "before_cursor_execute")
    def record_statement(_, __, statement, *___):
        statements.append(statement)

    with admin.begin() as connection:
        # Both interpolated values are locally generated UUID identifiers, not input.
        connection.exec_driver_sql(f'CREATE ROLE "{role}" LOGIN PASSWORD \'{password}\'')
        connection.exec_driver_sql("REVOKE CREATE ON SCHEMA public FROM PUBLIC")
        connection.exec_driver_sql(f'GRANT USAGE ON SCHEMA public TO "{role}"')
    registry = StorageProfileRegistry([profile])
    monkeypatch.setattr(registry, "create_engine", lambda *args: restricted)
    try:
        yield registry, admin, restricted, role, statements
    finally:
        restricted.dispose()
        with admin.begin() as connection:
            connection.exec_driver_sql(f'DROP OWNED BY "{role}"')
            connection.exec_driver_sql(f'DROP ROLE "{role}"')
        admin.dispose()


def grant_runtime(admin, role):
    """Match real runtime needs, without owner, CREATE or control-policy grants."""
    upgrade_external_database(admin.url)
    with admin.begin() as connection:
        connection.exec_driver_sql(f'GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO "{role}"')
        for table in ("remote_storage_control", "project_storage_heads", "remote_command_receipts",
                      "remote_saved_checkpoints", "alembic_version"):
            connection.exec_driver_sql(f'REVOKE ALL ON "{table}" FROM "{role}"')
        for table, grants in {
            "remote_storage_control": "SELECT,UPDATE(id)",
            "project_storage_heads": "SELECT,INSERT,UPDATE",
            "remote_command_receipts": "SELECT,INSERT",
            "remote_saved_checkpoints": "SELECT,INSERT,DELETE",
            "alembic_version": "SELECT",
        }.items():
            connection.exec_driver_sql(f'GRANT {grants} ON "{table}" TO "{role}"')


def assert_observational(statements):
    assert statements
    assert all(sql.lstrip().upper().startswith(("SELECT", "SET", "SHOW")) for sql in statements)
    assert not any("stt_permission_probe" in sql for sql in statements)


def test_current_schema_accepts_runtime_without_create_and_never_touches_probe(restricted_profile):
    registry, admin, restricted, role, statements = restricted_profile
    grant_runtime(admin, role)
    with admin.begin() as connection:
        connection.execute(text("CREATE TABLE stt_permission_probe(id integer PRIMARY KEY)"))
        connection.execute(text("INSERT INTO stt_permission_probe VALUES (99)"))
        before = connection.execute(text("SELECT * FROM remote_storage_control")).one()
    result = registry.test("audit")
    assert result.connected and result.permissions_valid and result.schema_status == "current"
    assert_observational(statements)
    with admin.connect() as connection:
        assert connection.scalar(text("SELECT id FROM stt_permission_probe")) == 99
        assert connection.execute(text("SELECT * FROM remote_storage_control")).one() == before
    with restricted.connect() as connection:
        assert connection.scalar(text("SELECT has_schema_privilege(current_schema(),'CREATE')")) is False
        assert connection.scalar(text("SHOW transaction_read_only")) == "on"


@pytest.mark.parametrize("revocation", [
    "DELETE ON nodes", "UPDATE ON project_storage_heads", "INSERT ON remote_command_receipts",
    "DELETE ON remote_saved_checkpoints", "UPDATE(id) ON remote_storage_control",
])
def test_missing_runtime_grant_is_not_hidden_by_other_grants(restricted_profile, revocation):
    registry, admin, _, role, statements = restricted_profile
    grant_runtime(admin, role)
    with admin.begin() as connection:
        connection.exec_driver_sql(f'REVOKE {revocation} FROM "{role}"')
    result = registry.test("audit")
    assert result.connected and result.schema_status == "current"
    assert result.permissions_valid is False
    assert_observational(statements)


@pytest.mark.parametrize("can_create", [False, True])
def test_empty_schema_reports_capability_without_provisioning(restricted_profile, can_create):
    registry, admin, _, role, statements = restricted_profile
    if can_create:
        with admin.begin() as connection:
            connection.exec_driver_sql(f'GRANT CREATE ON SCHEMA public TO "{role}"')
    result = registry.test("audit")
    assert result.schema_status == "empty" and result.schema_revision is None
    assert result.permissions_valid is can_create
    assert_observational(statements)
    with admin.connect() as connection:
        assert connection.scalar(text("SELECT count(*) FROM pg_tables WHERE schemaname='public'")) == 0


def test_current_version_with_missing_table_fails_permissions_closed(restricted_profile):
    registry, admin, _, role, _ = restricted_profile
    grant_runtime(admin, role)
    with admin.begin() as connection:
        connection.execute(text("DROP TABLE legacy_engine_tags"))
    assert registry.test("audit").permissions_valid is False

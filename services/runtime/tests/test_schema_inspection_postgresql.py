"""Read-only inspection of isolated schemas, never an upgrade of user storage."""

import os

import pytest
from alembic import command
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, event, inspect, text

from services.runtime.stt_runtime.project_session.database import alembic_config
from services.runtime.stt_runtime.schema_inspection import inspect_schema, SchemaInspection
from services.runtime.tests.test_remote_storage_protocol_audit import audit_database

pytestmark = pytest.mark.skipif(not os.getenv("STT_TEST_POSTGRES_URL"), reason="Disposable PostgreSQL required")


@pytest.fixture
def storage(audit_database):
    engine = create_engine(audit_database, hide_parameters=True)
    config = alembic_config(audit_database.render_as_string(hide_password=False))
    scripts = ScriptDirectory.from_config(config)
    try:
        yield engine, config, scripts
    finally:
        engine.dispose()


def test_empty_and_unversioned_objects_are_never_initialized(storage):
    engine, _, scripts = storage
    assert inspect_schema(engine, scripts) == SchemaInspection("empty", None)
    with engine.begin() as connection:
        assert connection.scalar(text("SELECT count(*) FROM pg_tables WHERE schemaname='public'")) == 0
        connection.execute(text("CREATE VIEW author_view AS SELECT 1 AS id"))
    assert inspect_schema(engine, scripts) == SchemaInspection("unknown", None)
    with engine.begin() as connection:
        connection.execute(text("DROP VIEW author_view"))
        connection.execute(text("CREATE TYPE author_mood AS ENUM ('draft')"))
    assert inspect_schema(engine, scripts) == SchemaInspection("unknown", None)
    with engine.begin() as connection:
        connection.execute(text("DROP TYPE author_mood"))
        connection.execute(text("CREATE TABLE author_data(id integer)"))
        connection.execute(text("INSERT INTO author_data VALUES (7)"))
    assert inspect_schema(engine, scripts) == SchemaInspection("unknown", None)
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT id FROM author_data")) == 7


def test_real_older_and_current_schema_are_observed_not_upgraded(storage):
    engine, config, scripts = storage
    command.upgrade(config, "20261022_0011")
    assert inspect_schema(engine, scripts) == SchemaInspection("older", "20261022_0011")
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "20261022_0011"
    command.upgrade(config, "head")
    assert inspect_schema(engine, scripts) == SchemaInspection("current", scripts.get_current_head())


@pytest.mark.parametrize("damage", [
    "DROP TABLE legacy_engine_tags",
    "ALTER TABLE nodes DROP COLUMN summary",
    "ALTER TABLE nodes ALTER COLUMN title TYPE integer USING 0",
    "ALTER TABLE nodes ALTER COLUMN title DROP NOT NULL",
    "primary_key",
    "foreign_key",
])
def test_current_stamp_does_not_hide_structural_damage(storage, damage):
    engine, config, scripts = storage
    command.upgrade(config, "head")
    with engine.begin() as connection:
        if damage in {"primary_key", "foreign_key"}:
            inspector = inspect(connection)
            constraint = (inspector.get_pk_constraint("legacy_engine_tags") if damage == "primary_key"
                          else inspector.get_foreign_keys("legacy_engine_tags")[0])
            name = connection.dialect.identifier_preparer.quote(constraint["name"])
            connection.exec_driver_sql(f"ALTER TABLE legacy_engine_tags DROP CONSTRAINT {name}")
        else:
            connection.execute(text(damage))
    assert inspect_schema(engine, scripts) == SchemaInspection("partial", scripts.get_current_head())


def test_version_anomalies_are_reported_without_repair(storage):
    engine, _, scripts = storage
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE alembic_version(version_num text)"))
    assert inspect_schema(engine, scripts) == SchemaInspection("partial", None)
    for stamp, status in [("20261023_0013", "future"), ("foreign-branch", "unknown"), ("bad\nstamp", "unknown")]:
        with engine.begin() as connection:
            connection.execute(text("DELETE FROM alembic_version"))
            connection.execute(text("INSERT INTO alembic_version VALUES (:stamp)"), {"stamp": stamp})
        assert inspect_schema(engine, scripts).status == status
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == stamp
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO alembic_version VALUES ('20261022_0011')"))
    assert inspect_schema(engine, scripts) == SchemaInspection("partial", None)
    with engine.begin() as connection:
        connection.execute(text("ALTER TABLE alembic_version RENAME COLUMN version_num TO broken"))
    assert inspect_schema(engine, scripts) == SchemaInspection("partial", None)


def test_inspection_runs_in_readonly_snapshot_and_cannot_mutate(storage):
    engine, config, scripts = storage
    command.upgrade(config, "head")
    statements = []
    @event.listens_for(engine, "before_cursor_execute")
    def verify_snapshot(connection, _, statement, *___):
        statements.append(statement)
        if statement.startswith("SELECT current_schema"):
            cursor = connection.connection.cursor()
            try:
                cursor.execute("SHOW transaction_read_only")
                assert cursor.fetchone()[0] == "on"
                cursor.execute("SHOW transaction_isolation")
                assert cursor.fetchone()[0] == "repeatable read"
            finally:
                cursor.close()
    assert inspect_schema(engine, scripts).status == "current"
    assert all(sql.lstrip().upper().startswith(("SELECT", "SET")) for sql in statements)

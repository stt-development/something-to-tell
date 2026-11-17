"""Same-connection observations in caller-owned SQL, without provision execution."""

import os
from unittest.mock import Mock

from alembic import command
from alembic.script import ScriptDirectory
import pytest
from sqlalchemy import event, text

from services.runtime.stt_runtime.schema_plan_context import capture_schema_plan_context, capture_schema_plan_context_connection
from services.runtime.stt_runtime.storage_inspection import inspect_storage_connection
from services.runtime.tests.test_remote_storage_protocol_audit import audit_database
from services.runtime.tests.test_schema_plan_context_postgresql import source

pytestmark = pytest.mark.skipif(not os.getenv("STT_TEST_POSTGRES_URL"), reason="Disposable PostgreSQL required")


def borrowed_context(connection, scripts, folder):
    observed = inspect_storage_connection(connection, scripts, "disable")
    return capture_schema_plan_context_connection(connection, scripts, folder, "audit", observed)


@pytest.mark.parametrize("legacy", [False, True])
def test_borrowed_matches_public_snapshot_and_never_changes_transaction(source, monkeypatch, legacy):
    engine, config, folder, profiles = source
    if legacy:
        command.upgrade(config, "20261022_0011")  # Fixture-only setup.
    expected = capture_schema_plan_context(profiles, folder, "audit")
    before = {p: p.read_bytes() for p in folder.path.rglob("*") if p.is_file()}
    scripts = ScriptDirectory.from_config(config)
    with monkeypatch.context() as patch:
        patch.setattr(profiles, "create_engine", Mock(side_effect=AssertionError("second engine")))
        with engine.connect().execution_options(isolation_level="READ COMMITTED") as connection:
            transaction = connection.begin()
            finalizations, statements = [], []
            event.listen(connection, "commit", lambda _: finalizations.append("commit"))
            event.listen(connection, "rollback", lambda _: finalizations.append("rollback"))
            event.listen(connection, "before_cursor_execute", lambda _, __, sql, *___: statements.append(sql))
            assert borrowed_context(connection, scripts, folder) == expected
            assert connection.scalar(text("SHOW transaction_isolation")) == "read committed"
            assert connection.scalar(text("SHOW transaction_read_only")) == "off"
            assert all(sql.lstrip().upper().startswith(("SELECT", "SHOW")) for sql in statements)
            assert transaction.is_active and not connection.closed and not finalizations
            transaction.rollback()
            assert finalizations == ["rollback"]
        profiles.create_engine.assert_not_called()
    assert capture_schema_plan_context(profiles, folder, "audit") == expected
    assert {p: p.read_bytes() for p in folder.path.rglob("*") if p.is_file()} == before


def test_borrowed_reader_sees_caller_local_control_and_catalog_changes(source):
    engine, config, folder, profiles = source
    command.upgrade(config, "20261022_0011")
    scripts = ScriptDirectory.from_config(config)
    expected = capture_schema_plan_context(profiles, folder, "audit")
    with engine.connect() as connection:
        transaction = connection.begin()
        finalizations = []
        event.listen(connection, "commit", lambda _: finalizations.append("commit"))
        event.listen(connection, "rollback", lambda _: finalizations.append("rollback"))
        assert borrowed_context(connection, scripts, folder) == expected
        connection.execute(text("UPDATE remote_storage_control SET maintenance=true"))
        changed_control = borrowed_context(connection, scripts, folder)
        assert changed_control.maintenance and changed_control.schema_fingerprint != expected.schema_fingerprint
        connection.execute(text("ALTER TABLE nodes ADD COLUMN caller_local_note text"))
        changed_schema = borrowed_context(connection, scripts, folder)
        assert changed_schema.schema_fingerprint != changed_control.schema_fingerprint
        assert changed_schema.authority_fingerprint == expected.authority_fingerprint
        with engine.connect() as observer:
            assert observer.scalar(text("SELECT maintenance FROM remote_storage_control")) is False
        assert transaction.is_active and not finalizations and not connection.closed
        transaction.rollback()
        assert finalizations == ["rollback"]
    assert capture_schema_plan_context(profiles, folder, "audit") == expected

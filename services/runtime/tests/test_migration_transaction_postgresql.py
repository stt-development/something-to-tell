"""D1 real PostgreSQL DDL atomicity; no provision coordinator or user storage."""

import os

from alembic import command
from alembic.script import ScriptDirectory
import pytest
from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.exc import DBAPIError

from services.runtime.stt_runtime.project_session.database import alembic_config
from services.runtime.tests.test_remote_storage_protocol_audit import audit_database

pytestmark = pytest.mark.skipif(not os.getenv("STT_TEST_POSTGRES_URL"), reason="Disposable PostgreSQL required")


@pytest.fixture
def authority(audit_database):
    engine = create_engine(audit_database, hide_parameters=True)
    # This URL must never be used: only the caller-supplied connection is valid.
    config = alembic_config("postgresql+psycopg://must-not-connect.invalid/unused")
    try:
        yield engine, config, ScriptDirectory.from_config(config).get_current_head()
    finally:
        engine.dispose()


@pytest.mark.parametrize("commit", [True, False])
def test_caller_alone_commits_or_rolls_back_complete_chain(authority, commit):
    engine, config, target = authority
    with engine.connect() as connection:
        transaction = connection.begin()
        finalizations = []
        event.listen(connection, "commit", lambda _: finalizations.append("commit"))
        event.listen(connection, "rollback", lambda _: finalizations.append("rollback"))
        config.attributes["connection"] = connection
        command.upgrade(config, target)
        assert transaction.is_active and not connection.closed and not finalizations
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == target
        assert connection.scalar(text("SELECT count(*) FROM project_storage_heads")) == 0
        with engine.connect() as observer:
            assert inspect(observer).get_table_names() == []
        if commit:
            transaction.commit()
        else:
            transaction.rollback()
        assert finalizations == ["commit" if commit else "rollback"]
    with engine.connect() as observer:
        tables = set(inspect(observer).get_table_names())
        if commit:
            assert {"nodes", "projects", "alembic_version", "remote_storage_control"}.issubset(tables)
            assert observer.scalar(text("SELECT version_num FROM alembic_version")) == target
        else:
            assert tables == set()


def test_late_database_failure_leaves_rollback_to_caller_and_retry_is_clean(authority):
    engine, config, target = authority
    with engine.connect() as connection:
        transaction = connection.begin()
        finalizations, reached = [], []
        event.listen(connection, "commit", lambda _: finalizations.append("commit"))
        event.listen(connection, "rollback", lambda _: finalizations.append("rollback"))
        def fail_late(_, __, sql, *___):
            if sql.startswith("UPDATE alembic_version") and target in sql:
                reached.append(True)
                # Real server error after the final migration's DDL, not a mock
                # transaction: PostgreSQL must remain aborted until caller rollback.
                connection.exec_driver_sql("SELECT 1 / 0")
        event.listen(connection, "before_cursor_execute", fail_late)
        config.attributes["connection"] = connection
        try:
            with pytest.raises(DBAPIError):
                command.upgrade(config, target)
        finally:
            event.remove(connection, "before_cursor_execute", fail_late)
        assert reached and transaction.is_active and not connection.closed and not finalizations
        transaction.rollback()
        assert finalizations == ["rollback"]
        assert inspect(connection).get_table_names() == []
        connection.rollback()  # Finish only the caller's inspection transaction.
        with connection.begin():
            command.upgrade(config, target)
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == target
    with engine.connect() as observer:
        assert observer.scalar(text("SELECT version_num FROM alembic_version")) == target


def test_autocommit_is_rejected_even_with_sqlalchemy_transaction(authority):
    engine, config, target = authority
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as connection:
        with connection.begin():
            assert connection.in_transaction() and connection.connection.driver_connection.autocommit
            config.attributes["connection"] = connection
            with pytest.raises(ValueError, match="migration_external_transaction_required"):
                command.upgrade(config, target)
        assert not connection.closed
    with engine.connect() as observer:
        assert inspect(observer).get_table_names() == []

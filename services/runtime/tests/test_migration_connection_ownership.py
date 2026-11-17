"""Alembic's borrowed-connection branch must not become a transaction owner."""

from contextlib import nullcontext
from pathlib import Path
import runpy
from types import SimpleNamespace
from unittest.mock import Mock

from alembic import context
from alembic.config import Config
import pytest
from sqlalchemy import Connection

ENV = Path(__file__).parents[1] / "migrations/env.py"


@pytest.fixture
def environment(monkeypatch):
    config = Config()
    monkeypatch.setattr(context, "config", config, raising=False)
    monkeypatch.setattr(context, "is_offline_mode", lambda: False)
    configure, migrate, factory = Mock(), Mock(), Mock()
    monkeypatch.setattr(context, "configure", configure)
    monkeypatch.setattr(context, "begin_transaction", lambda: nullcontext())
    monkeypatch.setattr(context, "run_migrations", migrate)
    monkeypatch.setattr("sqlalchemy.engine_from_config", factory)
    return config, configure, migrate, factory


@pytest.mark.parametrize("dialect,active,autocommit", [
    ("postgresql", False, False), ("sqlite", True, False), ("postgresql", True, True),
])
def test_unsupported_or_inactive_connection_rejected_before_work(environment, dialect, active, autocommit):
    config, configure, migrate, factory = environment
    connection = Mock(spec=Connection)
    connection.dialect = SimpleNamespace(name=dialect)
    connection.in_transaction.return_value = active
    connection.connection = SimpleNamespace(driver_connection=SimpleNamespace(autocommit=autocommit))
    config.attributes["connection"] = connection
    with pytest.raises(ValueError, match="migration_external_transaction_required"):
        runpy.run_path(str(ENV))
    configure.assert_not_called()
    migrate.assert_not_called()
    factory.assert_not_called()
    connection.commit.assert_not_called()
    connection.rollback.assert_not_called()
    connection.close.assert_not_called()


def test_non_connection_is_rejected(environment):
    config, configure, migrate, factory = environment
    config.attributes["connection"] = object()
    with pytest.raises(ValueError, match="migration_external_transaction_required"):
        runpy.run_path(str(ENV))
    configure.assert_not_called()
    migrate.assert_not_called()
    factory.assert_not_called()


@pytest.mark.parametrize("failure", [False, True])
def test_success_or_failure_never_finalizes_caller_connection(environment, failure):
    config, configure, migrate, factory = environment
    connection = Mock(spec=Connection)
    connection.dialect = SimpleNamespace(name="postgresql")
    connection.in_transaction.return_value = True
    connection.connection = SimpleNamespace(driver_connection=SimpleNamespace(autocommit=False))
    config.attributes["connection"] = connection
    if failure:
        migrate.side_effect = RuntimeError("injected migration failure")
        with pytest.raises(RuntimeError, match="injected migration failure"):
            runpy.run_path(str(ENV))
    else:
        runpy.run_path(str(ENV))
    assert configure.call_args.kwargs["connection"] is connection
    migrate.assert_called_once()
    factory.assert_not_called()
    connection.commit.assert_not_called()
    connection.rollback.assert_not_called()
    connection.close.assert_not_called()

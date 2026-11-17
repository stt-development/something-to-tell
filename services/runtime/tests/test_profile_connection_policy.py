"""Profile policy uses the shared ceilings, without changing SQL/history ownership."""

from unittest.mock import Mock

import pytest
from sqlalchemy.exc import OperationalError

from services.runtime.stt_runtime import storage_profiles
from services.runtime.stt_runtime.schemas.remote_storage import (
    REMOTE_CONNECT_TIMEOUT_SECONDS, REMOTE_POOL_TIMEOUT_SECONDS,
)
from services.runtime.stt_runtime.storage_profiles import PostgreSqlProfile, StorageProfileError, StorageProfileRegistry


def registry():
    return StorageProfileRegistry([PostgreSqlProfile(profile_id="policy", label="Policy", host="localhost",
        database="policy", username="operator", password="never-return-secret", tls_policy="disable")])


def test_profile_engine_uses_bounded_defaults_without_eager_connect(monkeypatch):
    create = Mock()
    monkeypatch.setattr(storage_profiles, "create_engine", create)
    profiles = registry()
    assert profiles.create_engine("policy") is create.return_value
    url, = create.call_args.args
    assert url.password == "never-return-secret"
    assert create.call_args.kwargs == dict(pool_pre_ping=True, hide_parameters=True, pool_size=5,
        max_overflow=10, pool_timeout=REMOTE_POOL_TIMEOUT_SECONDS,
        connect_args={"connect_timeout": REMOTE_CONNECT_TIMEOUT_SECONDS,
                      "options": "-c statement_timeout=10000 -c lock_timeout=3000"})
    create.return_value.connect.assert_not_called()


@pytest.mark.parametrize("failure", [OperationalError(None, None, Exception("never-return-secret")), KeyboardInterrupt()])
def test_health_disposes_even_on_connect_failure_or_cancellation(monkeypatch, failure):
    profiles, engine = registry(), Mock()
    engine.connect.side_effect = failure
    monkeypatch.setattr(profiles, "create_engine", lambda *_: engine)
    expected = StorageProfileError if isinstance(failure, Exception) else KeyboardInterrupt
    with pytest.raises(expected) as caught:
        profiles.test("policy")
    assert "never-return-secret" not in str(caught.value)
    engine.dispose.assert_called_once()


@pytest.mark.parametrize("major", [16, 18])
def test_health_rejects_unsupported_major_before_pg17_only_setting(monkeypatch, major):
    profiles, engine, connection = registry(), Mock(), Mock()
    engine.connect.return_value.execution_options.return_value.__enter__ = Mock(return_value=connection)
    engine.connect.return_value.execution_options.return_value.__exit__ = Mock(return_value=False)
    connection.scalar.return_value = major * 10000
    monkeypatch.setattr(profiles, "create_engine", lambda *_: engine)
    with pytest.raises(StorageProfileError, match="remote_server_version_unsupported"):
        profiles.test("policy")
    assert all("transaction_timeout" not in str(call) for call in connection.execute.call_args_list)
    engine.dispose.assert_called_once()

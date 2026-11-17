"""Real bounded health IO on generated DBs only; no shared service reconfiguration."""

import os
import socket
from time import monotonic

import pytest
from alembic import command
from sqlalchemy import text
from sqlalchemy.exc import TimeoutError as PoolTimeout

from services.runtime.stt_runtime import storage_profiles
from services.runtime.stt_runtime.storage_profiles import StorageProfileError, StorageProfileRegistry
from services.runtime.tests.test_remote_storage_protocol_audit import audit_database, _profile
from services.runtime.tests.test_schema_plan_context_postgresql import source

pytestmark = pytest.mark.skipif(not os.getenv("STT_TEST_POSTGRES_URL"), reason="Disposable PostgreSQL required")


def test_refused_profile_connection_is_bounded_and_redacted():
    # Keep the selected local port reserved but not listening; no external network.
    with socket.socket() as reserved:
        reserved.bind(("127.0.0.1", 0))
        from sqlalchemy.engine import make_url
        profile = _profile(make_url(os.environ["STT_TEST_POSTGRES_URL"])).model_copy(
            update={"host": "127.0.0.1", "port": reserved.getsockname()[1], "password": "policy-private-password"})
        started = monotonic()
        with pytest.raises(StorageProfileError) as caught:
            StorageProfileRegistry([profile]).test("audit")
        assert monotonic() - started < 8
        # The host can reject immediately or drop the SYN until libpq's deadline.
        assert caught.value.code in {"storage_profile_unavailable", "remote_storage_timeout"}
        assert "policy-private-password" not in str(caught.value)


def test_profile_pool_checkout_has_a_finite_wait(source):
    _, _, folder, profiles = source
    engine = profiles.create_engine("audit", folder.path)
    held = []
    try:
        assert engine.pool.size() == 5
        for _ in range(15):
            held.append(engine.connect())
        assert held[0].scalar(text("SHOW statement_timeout")) == "10s"
        assert held[0].scalar(text("SHOW lock_timeout")) == "3s"
        started = monotonic()
        with pytest.raises(PoolTimeout):
            engine.connect()
        assert 4 <= monotonic() - started < 8
    finally:
        for connection in held:
            connection.close()
        engine.dispose()
    assert engine.pool.checkedout() == 0


@pytest.mark.parametrize("blocked", [False, True])
def test_health_query_and_lock_deadlines_cancel_without_persisted_changes(source, monkeypatch, blocked):
    engine, config, _, profiles = source
    command.upgrade(config, "head")
    original = storage_profiles.profile_permissions_valid
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE policy_lock(id integer)"))
    with engine.connect() as blocker:
        if blocked:
            blocker.execute(text("LOCK TABLE policy_lock IN ACCESS EXCLUSIVE MODE"))
        def check(connection, **kwargs):
            assert connection.scalar(text("SHOW transaction_read_only")) == "on"
            assert connection.scalar(text("SHOW lock_timeout")) == "3s"
            assert connection.scalar(text("SHOW statement_timeout")) == "10s"
            assert connection.scalar(text("SHOW transaction_timeout")) == "20s"
            connection.execute(text("SELECT * FROM policy_lock" if blocked else "SELECT pg_sleep(30)"))
            return original(connection, **kwargs)
        monkeypatch.setattr(storage_profiles, "profile_permissions_valid", check)
        started = monotonic()
        with pytest.raises(StorageProfileError, match="remote_storage_timeout"):
            profiles.test("audit")
        elapsed = monotonic() - started
        assert (2 if blocked else 9) <= elapsed < (9 if blocked else 16)
    # The timed-out transaction is gone and fresh readers/writers remain usable.
    with engine.begin() as connection:
        assert connection.scalar(text("SELECT count(*) FROM policy_lock")) == 0
        connection.execute(text("INSERT INTO policy_lock VALUES (1)"))

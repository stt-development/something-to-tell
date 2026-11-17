"""Native libpq certificate/authentication checks, not an encrypted-flag mock."""

from pathlib import Path

import pytest

from services.runtime.stt_runtime.project_session.errors import ProjectSessionError
from services.runtime.stt_runtime.storage_inspection import inspect_storage
from services.runtime.stt_runtime.storage_profiles import PostgreSqlProfile, StorageProfileError, StorageProfileRegistry
from services.runtime.tests.tls_postgresql_fixture import tls_postgres


def profiles(server, policy, **overrides):
    return StorageProfileRegistry([PostgreSqlProfile(profile_id="tls", label="TLS fixture", host=server.url.host,
        port=server.url.port, database=server.url.database, username=server.url.username,
        password=server.url.password, tls_policy=policy).model_copy(update=overrides)])


@pytest.mark.parametrize("policy", ["verify-full", "require", "disable"])
def test_modes_report_real_encryption_and_only_verified_identity(tls_postgres, monkeypatch, policy):
    monkeypatch.setenv("PGSSLROOTCERT", str(tls_postgres.root if policy == "verify-full" else tls_postgres.missing))
    # An inherited environment policy must not override the selected profile.
    monkeypatch.setenv("PGSSLMODE", "disable")
    registry = profiles(tls_postgres, policy)
    observed = inspect_storage(registry, Path("/unused"), "tls")
    assert observed.tls_active is (policy != "disable")
    assert observed.identity_verified is (policy == "verify-full")
    assert observed.schema_status == "empty"
    tested = registry.test("tls")
    assert tested.connected and tested.tls_active is (policy != "disable")


@pytest.mark.parametrize("failure", ["untrusted", "hostname", "missing-ca"])
def test_certificate_failures_are_explicit_never_downgraded(tls_postgres, monkeypatch, failure):
    root = tls_postgres.untrusted if failure == "untrusted" else tls_postgres.missing if failure == "missing-ca" else tls_postgres.root
    monkeypatch.setenv("PGSSLROOTCERT", str(root))
    registry = profiles(tls_postgres, "verify-full", **({"host": "127.0.0.1"} if failure == "hostname" else {}))
    for operation, expected in ((lambda: inspect_storage(registry, Path("/unused"), "tls"), ProjectSessionError),
                                (lambda: registry.test("tls"), StorageProfileError)):
        with pytest.raises(expected) as caught:
            operation()
        assert caught.value.code == "remote_tls_failed"
        assert tls_postgres.url.password not in str(caught.value) and str(root) not in str(caught.value)
    assert registry.resolve("tls").tls_policy == "verify-full"


def test_bad_password_is_authentication_failure_not_an_unavailable_provider(tls_postgres, monkeypatch):
    monkeypatch.setenv("PGSSLROOTCERT", str(tls_postgres.root))
    registry = profiles(tls_postgres, "verify-full", password="wrong-private-password")
    for operation, expected in ((lambda: inspect_storage(registry, Path("/unused"), "tls"), ProjectSessionError),
                                (lambda: registry.test("tls"), StorageProfileError)):
        with pytest.raises(expected) as caught:
            operation()
        assert caught.value.code == "remote_auth_failed"
        assert "wrong-private-password" not in str(caught.value)

"""Stable diagnostics never return credentials, driver messages or raw SQL."""

from psycopg import OperationalError as DriverError
from psycopg.errors import ConnectionTimeout
from pydantic import ValidationError
import pytest
from sqlalchemy.exc import OperationalError, TimeoutError as PoolTimeout

from services.runtime.stt_runtime.storage_failures import storage_failure_code
from services.runtime.stt_runtime.storage_profiles import PostgreSqlProfile
from services.runtime.stt_runtime.schemas.storage import StorageProfileDefinitionRequest
from services.runtime.tests.test_schema_profile_discovery_api import workspace
from services.runtime.tests.test_schema_plan_api import HEADERS


@pytest.mark.parametrize("state,code", [("28P01", "remote_auth_failed"), ("28000", "remote_auth_failed"),
    ("42501", "remote_admin_required"), ("57014", "remote_storage_timeout"), ("55P03", "remote_storage_timeout"),
    ("25P04", "remote_storage_timeout"), ("08006", "remote_storage_unavailable")])
def test_structured_diagnostics_take_precedence(state, code):
    error = DriverError("SSL error: certificate verify failed; private detail")
    error.sqlstate = state
    assert storage_failure_code(OperationalError(None, None, error)) == code


@pytest.mark.parametrize("message,code", [
    ('connection failed: FATAL: password authentication failed for user "private-user"', "remote_auth_failed"),
    ('connection failed: FATAL: no pg_hba.conf entry for host "private-host"', "remote_auth_failed"),
    ('connection failed: SSL error: certificate verify failed', "remote_tls_failed"),
    ('server certificate for "private-name" does not match host name "private-host"', "remote_tls_failed"),
    ('root certificate file "/private/ca" does not exist', "remote_tls_failed"),
    ('server does not support SSL, but SSL was required', "remote_tls_failed"),
    ('connection refused; private-host', "remote_storage_unavailable"),
    ('неизвестная ошибка подключения', "remote_storage_unavailable"),
])
def test_only_known_libpq_handshake_failures_are_recognized(message, code):
    assert storage_failure_code(OperationalError(None, None, DriverError(message))) == code
    assert storage_failure_code(ValueError(message)) == "remote_storage_unavailable"


@pytest.mark.parametrize("error", [PoolTimeout("private pool detail"), ConnectionTimeout("private timeout")])
def test_timeout_types_do_not_require_message_matching(error):
    assert storage_failure_code(error) == "remote_storage_timeout"


def test_profile_health_uses_the_same_safe_pool_timeout_code(monkeypatch):
    from services.runtime.tests.test_profile_connection_policy import registry
    profiles = registry()
    from unittest.mock import Mock
    engine = Mock()
    engine.connect.side_effect = PoolTimeout("private-host private-password")
    monkeypatch.setattr(profiles, "create_engine", lambda *_: engine)
    from services.runtime.stt_runtime.storage_profiles import StorageProfileError
    with pytest.raises(StorageProfileError) as caught:
        profiles.test("policy")
    assert caught.value.code == "remote_storage_timeout"
    assert "private" not in str(caught.value)
    engine.dispose.assert_called_once()


@pytest.mark.parametrize("host", ["db-a,db-b", "db host", "bad\x00host", "x" * 254, " ", "bad\nhost"])
def test_api_and_registry_share_single_host_validation(workspace, host):
    _, client, folder, _, _, _, sql = workspace
    values = dict(label="Test", host=host, database="test", username="user", password="private-secret", tls_policy="verify-full")
    for model, extra in ((StorageProfileDefinitionRequest, {}), (PostgreSqlProfile, {"profile_id": "test"})):
        with pytest.raises(ValidationError):
            model(**values, **extra)
    response = client.post("/api/storage-profiles/folder", headers=HEADERS, json={"project_path": str(folder.path), **values})
    assert response.status_code == 422 and "private-secret" not in response.text
    sql.assert_not_called()


@pytest.mark.parametrize("host", [" localhost ", "127.0.0.1", "::1", "db.example.org", "/tmp/postgresql"])
def test_single_host_formats_preserve_supported_connection_material(host):
    value = StorageProfileDefinitionRequest(label="Test", host=host, database="test", username="user", password="secret")
    assert value.host == host.strip()


@pytest.mark.parametrize("code", ["remote_auth_failed", "remote_tls_failed", "remote_storage_timeout", "storage_profile_unavailable"])
def test_health_http_preserves_specific_redacted_diagnostics(workspace, monkeypatch, code):
    from services.runtime.stt_runtime.storage_profiles import StorageProfileError
    _, client, _, _, profiles, _, sql = workspace
    def fail(*_):
        raise StorageProfileError(code)
    monkeypatch.setattr(profiles, "test", fail)
    response = client.post("/api/storage-profiles/test", json={"profile_id": "global-admin"})
    assert response.status_code == (503 if code == "remote_storage_timeout" else 400)
    assert response.json()["detail"]["code"] == code
    assert "private-test-password" not in response.text
    sql.assert_not_called()

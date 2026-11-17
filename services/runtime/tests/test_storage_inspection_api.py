"""Inspection transport authorization, TLS composition and redacted failure contracts."""

from contextlib import nullcontext
from pathlib import Path
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import OperationalError

from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.core.config import RuntimeSettings
from services.runtime.stt_runtime.project_format.service import create_project_folder
from services.runtime.stt_runtime.project_session.errors import ProjectSessionError
from services.runtime.stt_runtime.schema_inspection import SchemaInspection
from services.runtime.stt_runtime.schemas.remote_storage import RemoteStorageInspectionV1
from services.runtime.stt_runtime.storage_profiles import PostgreSqlProfile, StorageProfileRegistry
from services.runtime.stt_runtime import storage_inspection
from services.runtime.stt_runtime.api.routes import storage


@pytest.fixture
def workspace(tmp_path):
    folder = create_project_folder(tmp_path / "Inspection.narrative").path
    app = create_app(RuntimeSettings(storage_profiles_file=tmp_path / "profiles.json",
        storage_master_key_file=tmp_path / "key", canon_provider_profiles_file=tmp_path / "providers.enc"))
    with TestClient(app) as client:
        yield app, client, folder


def inspection():
    return RemoteStorageInspectionV1(server_major=17, schema_status="empty", schema_revision=None,
        tls_policy="disable", tls_active=False, identity_verified=False, privileges="administrator")


def post(client, folder, **overrides):
    return client.post("/api/storage-profiles/inspect", headers={"X-Remote-Storage-Version": "1"},
        json={"protocol_version": 1, "project_path": str(folder), "profile_id": "audit", **overrides})


def test_inspection_validates_folder_and_never_opens_it(workspace, monkeypatch):
    app, client, folder = workspace
    action = Mock(return_value=inspection())
    monkeypatch.setattr(storage, "inspect_storage", action)
    response = post(client, folder)
    assert response.status_code == 200, response.text
    assert response.json() == inspection().model_dump(mode="json")
    action.assert_called_once_with(app.state.storage_profiles, folder, "audit")
    assert not app.state.project_sessions._sessions
    assert not (folder / "cache/project.lock.json").exists()


@pytest.mark.parametrize("version", [None, "2"])
def test_protocol_is_required_before_profile_or_connection_access(workspace, monkeypatch, version):
    _, client, folder = workspace
    action = Mock()
    monkeypatch.setattr(storage, "inspect_storage", action)
    response = client.post("/api/storage-profiles/inspect",
        headers={} if version is None else {"X-Remote-Storage-Version": version},
        json=dict(project_path=str(folder), profile_id="audit"))
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "remote_storage_protocol_unsupported"
    action.assert_not_called()


@pytest.mark.parametrize("path", ["relative.narrative", "/missing/Inspection.narrative"])
def test_invalid_path_never_reaches_profiles(workspace, monkeypatch, path):
    _, client, _ = workspace
    action = Mock()
    monkeypatch.setattr(storage, "inspect_storage", action)
    response = post(client, path)
    assert response.status_code == 400
    assert response.json()["detail"]["parameters"] == {}
    action.assert_not_called()


def test_body_rejects_credentials_and_missing_profile_is_redacted(workspace):
    _, client, folder = workspace
    response = post(client, folder, password="must-not-return")
    assert response.status_code == 422 and "must-not-return" not in response.text
    response = post(client, folder)
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "remote_storage_binding_required"
    assert str(folder) not in response.text


@pytest.mark.parametrize("code", ["remote_tls_failed", "remote_auth_failed", "remote_admin_required"])
def test_inspection_errors_have_protocol_status_and_no_raw_details(workspace, monkeypatch, code):
    _, client, folder = workspace
    monkeypatch.setattr(storage, "inspect_storage", Mock(side_effect=ProjectSessionError(code)))
    response = post(client, folder)
    assert response.status_code == 400
    assert response.json()["detail"] == {"code": code, "message_key": f"remote_storage.error.{code}", "parameters": {}}


@pytest.mark.parametrize("matches", [True, False])
def test_selected_session_must_match_explicit_folder(workspace, monkeypatch, matches):
    app, client, folder = workspace
    monkeypatch.setattr(app.state.project_sessions, "project_path", lambda _: folder if matches else folder.parent)
    action = Mock(return_value=inspection())
    monkeypatch.setattr(storage, "inspect_storage", action)
    response = client.post("/api/storage-profiles/inspect",
        headers={"X-Remote-Storage-Version": "1", "X-Project-Session-Id": "selected"},
        json=dict(project_path=str(folder), profile_id="audit"))
    assert response.status_code == (200 if matches else 409)
    assert action.call_count == int(matches)


@pytest.fixture
def composition(monkeypatch):
    profile = PostgreSqlProfile(profile_id="audit", label="Test", host="unused.invalid", database="test",
        username="writer", password="never-return", tls_policy="disable")
    profiles = StorageProfileRegistry([profile])
    engine, connection = Mock(), Mock()
    monkeypatch.setattr(profiles, "create_engine", lambda *_: engine)
    monkeypatch.setattr(storage_inspection, "schema_snapshot", lambda _: nullcontext(connection))
    monkeypatch.setattr(storage_inspection, "inspect_schema_connection",
        lambda *_: SchemaInspection("current", "20261022_0012"))
    monkeypatch.setattr(storage_inspection, "inspection_privileges", lambda *_, **__: "runtime")
    return profiles, profile, engine, connection


@pytest.mark.parametrize("policy,tls,verified", [
    ("disable", False, False), ("require", True, False), ("verify-full", True, True),
])
def test_tls_identity_is_distinct_from_encryption(composition, monkeypatch, policy, tls, verified):
    profiles, profile, engine, connection = composition
    monkeypatch.setattr(profiles, "resolve", lambda *_: profile.model_copy(update={"tls_policy": policy}))
    connection.scalar.side_effect = [170010, tls]
    result = storage_inspection.inspect_storage(profiles, Path("/unused"), "audit")
    assert result.identity_verified is verified and result.tls_active is tls
    assert result.privileges == "runtime"
    engine.dispose.assert_called_once()


@pytest.mark.parametrize("policy,tls", [("disable", True), ("require", False), ("verify-full", False)])
def test_tls_mismatch_never_falls_back(composition, monkeypatch, policy, tls):
    profiles, profile, engine, connection = composition
    monkeypatch.setattr(profiles, "resolve", lambda *_: profile.model_copy(update={"tls_policy": policy}))
    connection.scalar.side_effect = [170010, tls]
    with pytest.raises(ProjectSessionError, match="remote_tls_failed"):
        storage_inspection.inspect_storage(profiles, Path("/unused"), "audit")
    engine.dispose.assert_called_once()


def test_project_encrypted_profile_cannot_be_selected_from_another_folder(workspace, composition, tmp_path):
    app, client, folder = workspace
    profiles, _, engine, connection = composition
    profiles._master_key_file = tmp_path / "inspection-test.key"
    created = profiles.add(folder, label="Project only", host="unused.invalid", port=5432,
        database="test", username="writer", password="project-only-secret", tls_policy="disable")
    app.state.storage_profiles = profiles
    connection.scalar.side_effect = [170010, False]
    response = post(client, folder, profile_id=created.profile_id)
    assert response.status_code == 200, response.text
    other = create_project_folder(tmp_path / "Other.narrative").path
    denied = post(client, other, profile_id=created.profile_id)
    assert denied.status_code == 400
    assert denied.json()["detail"]["code"] == "remote_storage_binding_required"
    assert "project-only-secret" not in response.text + denied.text
    engine.dispose.assert_called_once()


@pytest.mark.parametrize("state,code", [("28P01", "remote_auth_failed"), ("42501", "remote_admin_required"),
    ("57014", "remote_storage_timeout"), (None, "remote_storage_unavailable")])
def test_driver_errors_are_redacted_and_engine_disposed(composition, state, code):
    profiles, _, engine, connection = composition
    class DriverFailure(Exception):
        sqlstate = state
    connection.scalar.side_effect = OperationalError(None, None, DriverFailure("password=never-return /secret/path"))
    with pytest.raises(ProjectSessionError) as caught:
        storage_inspection.inspect_storage(profiles, Path("/unused"), "audit")
    assert caught.value.code == code and caught.value.parameters == {}
    assert "never-return" not in str(caught.value)
    engine.dispose.assert_called_once()

"""Path-scoped profile discovery is read-only even for a project that cannot Open."""

from unittest.mock import Mock

from fastapi.testclient import TestClient
import pytest

from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.project_format.service import create_project_folder
from services.runtime.stt_runtime.project_session.errors import ProjectSessionError
from services.runtime.stt_runtime.storage_profiles import PostgreSqlProfile, StorageProfileRegistry
from services.runtime.tests.test_schema_plan_api import HEADERS, settings

AVAILABLE = "/api/storage-profiles/available"


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    folder = create_project_folder(tmp_path / "Selected.narrative")
    other = create_project_folder(tmp_path / "Other.narrative")
    profile = PostgreSqlProfile(profile_id="global-admin", label="Shared admin", host="127.0.0.1", port=5432,
        database="unused", username="admin", password="private-test-password", tls_policy="disable")
    profiles = StorageProfileRegistry([profile], master_key_file=tmp_path / "profile.key")
    local = profiles.add(folder.path, label="Folder admin", host=profile.host, port=profile.port,
        database=profile.database, username=profile.username, password=profile.password, tls_policy=profile.tls_policy)
    app = create_app(settings(tmp_path)); app.state.storage_profiles = profiles
    sql = Mock(side_effect=AssertionError("discovery connected SQL"))
    monkeypatch.setattr(profiles, "create_engine", sql)
    with TestClient(app) as client:
        yield app, client, folder, other, profiles, local, sql


def snapshot(folder):
    return {p: p.read_bytes() for p in folder.path.rglob("*") if p.is_file()}


def test_encrypted_folder_choices_are_canonical_isolated_and_never_open_sql(workspace, tmp_path):
    app, client, folder, other, _, local, sql = workspace
    before = snapshot(folder), snapshot(other)
    alias = tmp_path / "Alias.narrative"; alias.symlink_to(folder.path, target_is_directory=True)
    response = client.post(AVAILABLE, headers=HEADERS, json={"project_path": str(alias)})
    assert response.status_code == 200, response.text
    assert {p["profile_id"] for p in response.json()["profiles"]} == {"global-admin", local.profile_id}
    foreign = client.post(AVAILABLE, headers=HEADERS, json={"project_path": str(other.path)})
    assert [p["profile_id"] for p in foreign.json()["profiles"]] == ["global-admin"]
    assert "private-test-password" not in response.text + foreign.text
    assert all("password" not in p for p in response.json()["profiles"])
    assert not app.state.project_sessions._sessions
    assert (snapshot(folder), snapshot(other)) == before
    sql.assert_not_called()


@pytest.mark.parametrize("headers,path,expected", [
    ({}, None, 400), ({"X-Remote-Storage-Version": "2"}, None, 400),
    (HEADERS, "relative.narrative", 400), (HEADERS, "/missing/Project.narrative", 400),
])
def test_protocol_and_folder_guards_precede_profile_resolution(workspace, monkeypatch, headers, path, expected):
    _, client, folder, _, profiles, _, sql = workspace
    summaries = Mock(side_effect=AssertionError("unauthorized profile read"))
    monkeypatch.setattr(profiles, "summaries", summaries)
    response = client.post(AVAILABLE, headers=headers, json={"project_path": path or str(folder.path)})
    assert response.status_code == expected
    summaries.assert_not_called(); sql.assert_not_called()


@pytest.mark.parametrize("selection", ["match", "other", "unknown"])
def test_selected_session_scope_applies_before_profile_read(workspace, monkeypatch, selection):
    app, client, folder, other, profiles, _, sql = workspace
    def selected(_):
        if selection == "unknown":
            raise ProjectSessionError("project_session_not_found")
        return folder.path if selection == "match" else other.path
    monkeypatch.setattr(app.state.project_sessions, "project_path", selected)
    summaries = Mock(wraps=profiles.summaries)
    monkeypatch.setattr(profiles, "summaries", summaries)
    response = client.post(AVAILABLE, headers=HEADERS | {"X-Project-Session-Id": "selected"}, json={"project_path": str(folder.path)})
    assert response.status_code == (200 if selection == "match" else 409)
    assert summaries.call_count == (1 if selection == "match" else 0)
    sql.assert_not_called()


@pytest.mark.parametrize("extra", [{"profile_id": "admin"}, {"password": "private"}, {"protocol_version": True}])
def test_path_only_request_refuses_credentials_or_extra_scope_fields(workspace, extra):
    _, client, folder, _, _, _, sql = workspace
    response = client.post(AVAILABLE, headers=HEADERS, json={"project_path": str(folder.path)} | extra)
    assert response.status_code == 422 and "private" not in response.text
    sql.assert_not_called()


def test_missing_key_is_reported_without_creating_a_new_key_or_modifying_bundle(workspace):
    _, client, folder, _, profiles, _, sql = workspace
    before = snapshot(folder)
    profiles._master_key_file.unlink()
    response = client.post(AVAILABLE, headers=HEADERS, json={"project_path": str(folder.path)})
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "storage_profile_key_missing"
    assert not profiles._master_key_file.exists() and snapshot(folder) == before
    sql.assert_not_called()

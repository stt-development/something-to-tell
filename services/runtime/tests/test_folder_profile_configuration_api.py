"""Explicit pre-Open configuration reuses the encrypted profile owner, never SQL."""

from unittest.mock import Mock
from concurrent.futures import ThreadPoolExecutor

import pytest

from services.runtime.tests.test_schema_profile_discovery_api import workspace, snapshot
from services.runtime.tests.test_schema_plan_api import HEADERS

CREATE = "/api/storage-profiles/folder"


def body(folder):
    return dict(protocol_version=1, project_path=str(folder.path), label="New schema admin",
        host="db.example.test", port=5432, database="story", username="schema-admin",
        password="new-private-test-password", tls_policy="verify-full")


def test_explicit_configuration_appends_one_fresh_encrypted_definition_without_open(workspace):
    app, client, folder, other, profiles, existing, sql = workspace
    before, foreign, key = snapshot(folder), snapshot(other), profiles._master_key_file.read_bytes()
    response = client.post(CREATE, headers=HEADERS, json=body(folder))
    assert response.status_code == 201, response.text
    summary = response.json()
    assert summary["profile_id"] not in {"global-admin", existing.profile_id}
    assert summary["label"] == "New schema admin" and "password" not in summary
    assert "new-private-test-password" not in response.text
    assert profiles.resolve(summary["profile_id"], folder.path).password == "new-private-test-password"
    assert profiles.resolve(existing.profile_id, folder.path).profile_id == existing.profile_id
    after = snapshot(folder)
    assert {p for p in before if before[p] != after[p]} == {folder.path / "storage-profiles.enc"}
    assert "new-private-test-password".encode() not in (folder.path / "storage-profiles.enc").read_bytes()
    assert profiles._master_key_file.read_bytes() == key and snapshot(other) == foreign
    assert not app.state.project_sessions._sessions
    sql.assert_not_called()


@pytest.mark.parametrize("headers,path", [({}, None), ({"X-Remote-Storage-Version": "2"}, None),
    (HEADERS, "relative.narrative"), (HEADERS, "/missing/Project.narrative")])
def test_scope_guards_precede_configuration(workspace, monkeypatch, headers, path):
    _, client, folder, _, profiles, _, sql = workspace
    add = Mock(side_effect=AssertionError("unauthorized profile write")); monkeypatch.setattr(profiles, "add", add)
    response = client.post(CREATE, headers=headers, json=body(folder) | ({"project_path": path} if path else {}))
    assert response.status_code == 400
    add.assert_not_called(); sql.assert_not_called()


@pytest.mark.parametrize("extra", [{"session_id": "unknown"}, {"action": "drop"}, {"protocol_version": True},
    {"port": "5432"}, {"port": 0}, {"tls_policy": "off"}, {"password": ""}])
def test_strict_fields_reject_unreviewed_scope_or_malformed_credentials(workspace, extra):
    _, client, folder, _, _, _, sql = workspace
    before = snapshot(folder)
    response = client.post(CREATE, headers=HEADERS, json=body(folder) | extra)
    assert response.status_code == 422 and "new-private-test-password" not in response.text
    assert snapshot(folder) == before
    sql.assert_not_called()


def test_selected_session_mismatch_never_writes_other_folder(workspace, monkeypatch):
    app, client, folder, other, _, _, sql = workspace
    before = snapshot(folder)
    monkeypatch.setattr(app.state.project_sessions, "project_path", lambda _: other.path)
    response = client.post(CREATE, headers=HEADERS | {"X-Project-Session-Id": "other"}, json=body(folder))
    assert response.status_code == 409 and response.json()["detail"]["code"] == "remote_project_scope_mismatch"
    assert snapshot(folder) == before
    sql.assert_not_called()


def test_missing_decryption_key_never_overwrites_existing_encrypted_profiles(workspace):
    _, client, folder, _, profiles, _, sql = workspace
    before = snapshot(folder); profiles._master_key_file.unlink()
    response = client.post(CREATE, headers=HEADERS, json=body(folder))
    assert response.status_code == 400 and response.json()["detail"]["code"] == "storage_profile_key_missing"
    assert snapshot(folder) == before and not profiles._master_key_file.exists()
    sql.assert_not_called()


def test_overlapping_local_configuration_keeps_every_new_definition(workspace):
    _, _, folder, _, profiles, existing, sql = workspace
    fields = {key: value for key, value in body(folder).items() if key not in {"protocol_version", "project_path"}}
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda index: profiles.add(folder.path, **(fields | {"label": f"Admin {index}"})), range(8)))
    actual = {profile.profile_id for profile in profiles.summaries(folder.path)}
    assert actual == {"global-admin", existing.profile_id, *(profile.profile_id for profile in results)}
    sql.assert_not_called()

"""Execution transport guards; coordinator SQL is separately exercised on real PostgreSQL."""

from unittest.mock import Mock
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from services.runtime.stt_runtime.api.routes import storage
from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.project_format.service import create_project_folder
from services.runtime.stt_runtime.project_session.errors import ProjectSessionError
from services.runtime.tests.test_schema_plan_api import settings, HEADERS
from services.runtime.tests.test_schema_plans import context

EXECUTE = "/api/storage-profiles/schema-plans/execute"


def payload(folder):
    return dict(project_path=str(folder.path), profile_id="admin", plan_id=str(uuid4()),
        plan_fingerprint="a" * 64, backup_attestation_id=None)


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    folder = create_project_folder(tmp_path / "Execute.narrative")
    app = create_app(settings(tmp_path))
    completed = context().model_copy(update={"inspection": context().inspection.model_copy(
        update={"schema_status": "current", "schema_revision": "20261022_0012"})})
    execute = Mock(return_value=completed)
    monkeypatch.setattr(storage, "execute_provisioning", execute)
    monkeypatch.setattr(app.state.schema_plans, "execution_action", Mock(return_value="provision"))
    with TestClient(app) as client:
        yield app, client, folder, execute


def test_alias_uses_canonical_scope_and_only_known_completed_result(workspace, tmp_path):
    app, client, folder, execute = workspace
    alias = tmp_path / "Alias.narrative"
    alias.symlink_to(folder.path, target_is_directory=True)
    request = payload(folder) | {"project_path": str(alias)}
    before = {p: p.read_bytes() for p in folder.path.rglob("*") if p.is_file()}
    response = client.post(EXECUTE, json=request, headers=HEADERS)
    assert response.status_code == 200, response.text
    assert response.json() == dict(protocol_version=1, plan_id=request["plan_id"],
        action="provision", schema_revision="20261022_0012", status="completed")
    registry, actual_folder, canonical, plans = execute.call_args.args
    assert registry is app.state.storage_profiles and plans is app.state.schema_plans
    assert actual_folder == folder and canonical.project_path == str(folder.path)
    assert not app.state.project_sessions._sessions
    assert {p: p.read_bytes() for p in folder.path.rglob("*") if p.is_file()} == before


@pytest.mark.parametrize("override,headers,code", [
    ({}, {}, "remote_storage_protocol_unsupported"),
    ({}, {"X-Remote-Storage-Version": "2"}, "remote_storage_protocol_unsupported"),
    ({"project_path": "relative.narrative"}, HEADERS, "remote_contract_invalid"),
    ({"project_path": "/missing/Project.narrative"}, HEADERS, "remote_contract_invalid"),
])
def test_guards_reject_before_execution(workspace, override, headers, code):
    _, client, folder, execute = workspace
    response = client.post(EXECUTE, json=payload(folder) | override, headers=headers)
    assert response.status_code == 400 and response.json()["detail"]["code"] == code
    execute.assert_not_called()


@pytest.mark.parametrize("selection", ["match", "other", "unknown"])
def test_selected_session_matches_authorized_folder(workspace, monkeypatch, selection):
    app, client, folder, execute = workspace
    def selected(_):
        if selection == "unknown":
            raise ProjectSessionError("project_session_not_found")
        return folder.path if selection == "match" else folder.path.parent
    monkeypatch.setattr(app.state.project_sessions, "project_path", selected)
    response = client.post(EXECUTE, json=payload(folder), headers=HEADERS | {"X-Project-Session-Id": "selected"})
    assert response.status_code == (200 if selection == "match" else 409)
    assert execute.call_count == (1 if selection == "match" else 0)


@pytest.mark.parametrize("extra", [{"password": "private"}, {"authority_fingerprint": "a" * 64},
    {"sql": "DROP TABLE"}, {"protocol_version": True}, {"backup_attestation_id": "bad"}])
def test_unknown_trusted_secret_and_malformed_fields_fail_validation(workspace, extra):
    _, client, folder, execute = workspace
    response = client.post(EXECUTE, json=payload(folder) | extra, headers=HEADERS)
    assert response.status_code == 422 and "private" not in response.text
    execute.assert_not_called()


@pytest.mark.parametrize("code,status", [("remote_schema_busy", 409), ("remote_schema_plan_stale", 409),
    ("remote_admin_required", 400), ("remote_contract_invalid", 400),
    ("remote_storage_unavailable", 503), ("remote_commit_unknown", 503), ("remote_storage_timeout", 503)])
def test_failure_outcomes_are_redacted_never_completed(workspace, code, status):
    _, client, folder, execute = workspace
    execute.side_effect = ProjectSessionError(code)
    response = client.post(EXECUTE, json=payload(folder), headers=HEADERS)
    assert response.status_code == status
    assert response.json() == {"detail": dict(code=code, message_key=f"remote_storage.error.{code}", parameters={})}


def test_dispatch_uses_the_bound_plan_action_and_the_same_canonical_scope(workspace, monkeypatch):
    app, client, folder, provision = workspace
    app.state.schema_plans.execution_action.return_value = "upgrade"
    execute = Mock(return_value=provision.return_value)
    monkeypatch.setattr(storage, "execute_upgrade", execute)
    request = payload(folder)
    response = client.post(EXECUTE, json=request, headers=HEADERS)
    assert response.status_code == 200 and response.json()["action"] == "upgrade"
    provision.assert_not_called()
    assert execute.call_args.args[1] == folder
    assert app.state.schema_plans.execution_action.call_args.args[0] == execute.call_args.args[2]


def test_unknown_expired_or_misbound_plan_never_reaches_a_coordinator(workspace, monkeypatch):
    app, client, folder, provision = workspace
    app.state.schema_plans.execution_action.side_effect = ProjectSessionError("remote_schema_plan_stale")
    upgrade = Mock(side_effect=AssertionError("unknown plan reached SQL"))
    monkeypatch.setattr(storage, "execute_upgrade", upgrade)
    response = client.post(EXECUTE, json=payload(folder), headers=HEADERS)
    assert response.status_code == 409 and response.json()["detail"]["code"] == "remote_schema_plan_stale"
    provision.assert_not_called(); upgrade.assert_not_called()

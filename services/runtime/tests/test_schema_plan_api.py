"""C3b HTTP scope and lifecycle checks; SQL capture itself has isolated SQL tests."""

from unittest.mock import Mock
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from services.runtime.stt_runtime.api.routes import storage
from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.core.config import RuntimeSettings
from services.runtime.stt_runtime.project_format.service import create_project_folder
from services.runtime.stt_runtime.project_session.errors import ProjectSessionError
from services.runtime.stt_runtime.schema_plans import SchemaPlanRegistry
from services.runtime.tests.test_schema_plans import Clock, context

PLAN = "/api/storage-profiles/schema-plans"
ACK = PLAN + "/backup-attestations"
HEADERS = {"X-Remote-Storage-Version": "1"}


def settings(tmp_path):
    return RuntimeSettings(storage_profiles_file=tmp_path / "profiles.json",
        storage_master_key_file=tmp_path / "key", canon_provider_profiles_file=tmp_path / "providers.enc")


def body(folder, endpoint=PLAN, **updates):
    fields = (dict(action="upgrade", expected_schema_revision="20261022_0011") if endpoint == PLAN
              else dict(plan_id=str(uuid4()), plan_fingerprint="a" * 64, confirmation="backup_and_restore_verified"))
    return dict(project_path=str(folder), profile_id="admin", **fields) | updates


def confirmation(folder, plan, **updates):
    return body(folder, ACK, plan_id=plan["plan_id"], plan_fingerprint=plan["plan_fingerprint"], **updates)


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    folder = create_project_folder(tmp_path / "Review.narrative")
    app = create_app(settings(tmp_path))
    capture = Mock(side_effect=lambda _, target, profile: context(upgrade=True).model_copy(
        update={"project_id": target.project_id, "profile_id": profile}))
    monkeypatch.setattr(storage, "capture_schema_plan_context", capture)
    with TestClient(app) as client:
        yield app, client, folder, capture


def test_preparation_and_idempotent_confirmation_use_fresh_context_without_open(workspace, tmp_path):
    app, client, folder, capture = workspace
    before = {p: p.read_bytes() for p in folder.path.rglob("*") if p.is_file()}
    alias = tmp_path / "Alias.narrative"
    alias.symlink_to(folder.path, target_is_directory=True)
    plan = client.post(PLAN, headers=HEADERS, json=body(alias))
    assert plan.status_code == 200, plan.text
    data = confirmation(folder.path, plan.json())
    first = client.post(ACK, headers=HEADERS, json=data)
    second = client.post(ACK, headers=HEADERS, json=data)
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    assert first.json()["expires_at"] == plan.json()["expires_at"]
    assert capture.call_count == 3
    for args in capture.call_args_list:
        assert args.args == (app.state.storage_profiles, folder, "admin")
    assert not app.state.project_sessions._sessions
    assert before == {p: p.read_bytes() for p in folder.path.rglob("*") if p.is_file()}
    assert str(folder.path) not in plan.text + first.text
    assert not (folder.path / "cache/project.lock.json").exists()


@pytest.mark.parametrize("endpoint", [PLAN, ACK])
@pytest.mark.parametrize("version", [None, "2"])
def test_protocol_rejected_before_capture(workspace, endpoint, version):
    _, client, folder, capture = workspace
    response = client.post(endpoint, headers={} if version is None else {"X-Remote-Storage-Version": version},
        json=body(folder.path, endpoint))
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "remote_storage_protocol_unsupported"
    capture.assert_not_called()


@pytest.mark.parametrize("endpoint", [PLAN, ACK])
@pytest.mark.parametrize("path", ["relative.narrative", "/missing/Review.narrative"])
def test_invalid_folder_rejected_before_capture(workspace, endpoint, path):
    _, client, _, capture = workspace
    response = client.post(endpoint, headers=HEADERS, json=body(path, endpoint))
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "remote_contract_invalid"
    capture.assert_not_called()


@pytest.mark.parametrize("endpoint", [PLAN, ACK])
@pytest.mark.parametrize("selection", ["match", "other", "unknown"])
def test_selected_session_scope(workspace, monkeypatch, endpoint, selection):
    app, client, folder, capture = workspace
    def selected(_):
        if selection == "unknown":
            raise ProjectSessionError("project_session_not_found")
        return folder.path if selection == "match" else folder.path.parent
    monkeypatch.setattr(app.state.project_sessions, "project_path", selected)
    response = client.post(endpoint, headers=HEADERS | {"X-Project-Session-Id": "selected"},
        json=body(folder.path, endpoint))
    if selection == "match":
        assert response.status_code == (200 if endpoint == PLAN else 409)
        capture.assert_called_once()
    else:
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "remote_project_scope_mismatch"
        capture.assert_not_called()


@pytest.mark.parametrize("endpoint", [PLAN, ACK])
@pytest.mark.parametrize("extra", [{"password": "secret"}, {"authority_fingerprint": "a" * 64}])
def test_client_cannot_supply_secrets_or_trusted_observations(workspace, endpoint, extra):
    _, client, folder, capture = workspace
    response = client.post(endpoint, headers=HEADERS, json=body(folder.path, endpoint, **extra))
    assert response.status_code == 422 and "secret" not in response.text
    capture.assert_not_called()


@pytest.mark.parametrize("endpoint", [PLAN, ACK])
@pytest.mark.parametrize("code,status", [("remote_storage_timeout", 503), ("remote_tls_failed", 400),
    ("remote_admin_required", 400), ("remote_storage_binding_required", 400)])
def test_capture_errors_use_redacted_protocol_response(workspace, endpoint, code, status):
    _, client, folder, capture = workspace
    capture.side_effect = ProjectSessionError(code)
    response = client.post(endpoint, headers=HEADERS, json=body(folder.path, endpoint))
    assert response.status_code == status
    assert response.json()["detail"] == dict(code=code, message_key=f"remote_storage.error.{code}", parameters={})


@pytest.mark.parametrize("field,value", [("authority_fingerprint", "c" * 64),
    ("schema_fingerprint", "d" * 64), ("maintenance", True)])
def test_changed_sql_observation_permanently_invalidates_plan(workspace, field, value):
    app, client, folder, capture = workspace
    plan = client.post(PLAN, headers=HEADERS, json=body(folder.path)).json()
    original = capture.side_effect
    capture.side_effect = lambda *args: original(*args).model_copy(update={field: value})
    response = client.post(ACK, headers=HEADERS, json=confirmation(folder.path, plan))
    assert response.status_code == 409 and response.json()["detail"]["code"] == "remote_schema_plan_stale"
    capture.side_effect = original
    assert client.post(ACK, headers=HEADERS, json=confirmation(folder.path, plan)).status_code == 409
    assert not app.state.schema_plans._plans


@pytest.mark.parametrize("wrong", ["folder", "profile", "fingerprint"])
def test_wrong_binding_does_not_consume_legitimate_plan(workspace, tmp_path, wrong):
    _, client, folder, _ = workspace
    plan = client.post(PLAN, headers=HEADERS, json=body(folder.path)).json()
    data = confirmation(folder.path, plan)
    if wrong == "folder":
        data["project_path"] = str(create_project_folder(tmp_path / "Other.narrative").path)
    elif wrong == "profile":
        data["profile_id"] = "other"
    else:
        data["plan_fingerprint"] = "f" * 64
    response = client.post(ACK, headers=HEADERS, json=data)
    assert response.status_code == 409 and response.json()["detail"]["code"] == "remote_schema_plan_stale"
    assert client.post(ACK, headers=HEADERS, json=confirmation(folder.path, plan)).status_code == 200


def test_expiry_capacity_and_source_revision_are_enforced(workspace):
    app, client, folder, _ = workspace
    clock = Clock()
    app.state.schema_plans = SchemaPlanRegistry(max_pending=1, monotonic_clock=lambda: clock.monotonic,
        utc_clock=lambda: clock.utc)
    stale = client.post(PLAN, headers=HEADERS, json=body(folder.path, expected_schema_revision="20261021_0010"))
    assert stale.status_code == 409 and stale.json()["detail"]["code"] == "remote_schema_plan_stale"
    plan = client.post(PLAN, headers=HEADERS, json=body(folder.path)).json()
    full = client.post(PLAN, headers=HEADERS, json=body(folder.path))
    assert full.status_code == 409 and full.json()["detail"]["code"] == "remote_schema_plan_limit"
    clock.monotonic += 300
    expired = client.post(ACK, headers=HEADERS, json=confirmation(folder.path, plan))
    assert expired.status_code == 409 and expired.json()["detail"]["code"] == "remote_schema_plan_stale"
    assert client.post(PLAN, headers=HEADERS, json=body(folder.path)).status_code == 200


def test_shutdown_and_new_app_forget_confirmations(tmp_path, monkeypatch):
    folder = create_project_folder(tmp_path / "Restart.narrative")
    monkeypatch.setattr(storage, "capture_schema_plan_context", lambda *_: context(upgrade=True))
    app = create_app(settings(tmp_path))
    with TestClient(app) as client:
        plan = client.post(PLAN, headers=HEADERS, json=body(folder.path)).json()
        data = confirmation(folder.path, plan)
        assert client.post(ACK, headers=HEADERS, json=data).status_code == 200
        assert app.state.schema_plans._plans
    assert not app.state.schema_plans._plans
    with TestClient(create_app(settings(tmp_path))) as client:
        response = client.post(ACK, headers=HEADERS, json=data)
        assert response.status_code == 409 and response.json()["detail"]["code"] == "remote_schema_plan_stale"


def test_execution_requires_its_strict_contract_before_sql(workspace, monkeypatch):
    _, client, folder, capture = workspace
    execute = Mock(side_effect=AssertionError("unvalidated execution"))
    monkeypatch.setattr(storage, "execute_provisioning", execute)
    response = client.post(PLAN + "/execute", headers=HEADERS, json=body(folder.path))
    assert response.status_code == 422
    capture.assert_not_called()
    execute.assert_not_called()

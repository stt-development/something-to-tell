"""Explicit release must not depend on a readable database or fake a Saved document."""

import json
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi.testclient import TestClient
import pytest

from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.project_session.closing import release_remote_project
from services.runtime.stt_runtime.project_session.errors import ProjectSessionError
from services.runtime.stt_runtime.project_session.service import ProjectSessionRegistry
from services.runtime.stt_runtime.project_session.remote_files import pending_path
from services.runtime.stt_runtime.schemas.remote_storage import RemoteStorageReleaseV1
from services.runtime.tests.test_schema_plan_api import settings

GENERATION = "11111111-1111-4111-8111-111111111111"
BODY = dict(protocol_version=1, storage_generation=GENERATION, confirmation="leave_remote_working_data_unchanged")
HEADERS = {"X-Remote-Storage-Version": "1"}


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    registry = ProjectSessionRegistry()
    opened = registry.create(tmp_path / "Release.narrative", "Release")
    active = registry._sessions[opened.session.session_id]
    active.engine.dispose()
    engine, lease = Mock(), Mock()
    lease.generation = GENERATION; lease.lost.is_set.return_value = False
    active.engine = engine; active.session_factory = SimpleNamespace(kw={"info": {"remote_lease": lease}})
    active.state = active.state.model_copy(update={"storage_mode": "postgresql", "save_status": "dirty"})
    monkeypatch.setattr(registry, "_load_document", Mock(side_effect=AssertionError("release loaded a document")))
    registry._on_session_closed = Mock()
    app = create_app(settings(tmp_path)); app.state.project_sessions = registry
    with TestClient(app) as client:
        yield registry, active, engine, lease, client


def endpoint(active):
    return f"/api/project-sessions/{active.state.session_id}/remote-storage/release"


@pytest.mark.parametrize("state", ["ready", "unavailable", "writer_lost", "outcome_unknown"])
def test_acknowledges_only_exact_local_release_without_document_save_or_recovery_rewrite(workspace, state):
    registry, active, engine, lease, client = workspace
    active.remote_state = state
    pending = pending_path(active.path)
    pending.write_text("test-owned unresolved intent", encoding="utf-8")
    manifest = (active.path / "project.config.json").read_bytes()
    response = client.post(endpoint(active), headers=HEADERS, json=BODY)
    assert response.status_code == 200, response.text
    assert response.json() == dict(protocol_version=1, session_id=active.state.session_id,
        project_id=active.state.project_id, storage_generation=GENERATION, status="local_session_released")
    assert active.state.session_id not in registry._sessions and active.path not in registry._paths
    assert not (active.path / "cache/project.lock.json").exists()
    assert pending.read_text(encoding="utf-8") == "test-owned unresolved intent"
    assert (active.path / "project.config.json").read_bytes() == manifest
    lease.close.assert_called_once(); engine.dispose.assert_called_once(); engine.connect.assert_not_called()
    registry._load_document.assert_not_called()
    registry._on_session_closed.assert_called_once_with(active.state.session_id, active.state.project_id)


@pytest.mark.parametrize("headers,body,status,code", [
    ({}, BODY, 400, "remote_storage_protocol_unsupported"),
    ({"X-Remote-Storage-Version": "2"}, BODY, 400, "remote_storage_protocol_unsupported"),
    (HEADERS | {"X-Project-Session-Id": "foreign"}, BODY, 409, "remote_project_scope_mismatch"),
    (HEADERS, BODY | {"storage_generation": "22222222-2222-4222-8222-222222222222"}, 409, "remote_generation_mismatch"),
])
def test_guards_precede_any_resource_release(workspace, headers, body, status, code):
    registry, active, engine, lease, client = workspace
    response = client.post(endpoint(active), headers=headers, json=body)
    assert response.status_code == status
    assert response.json()["detail"]["code"] == code
    assert active.state.session_id in registry._sessions
    assert (active.path / "cache/project.lock.json").exists()
    lease.close.assert_not_called(); engine.dispose.assert_not_called()


@pytest.mark.parametrize("extra", [{"confirmation": "discard"}, {"confirmation": True}, {"protocol_version": True},
    {"password": "private"}, {"force_unlock": True}, {"storage_generation": "invalid"}])
def test_invalid_confirmation_or_secret_fields_never_enter_release(workspace, extra):
    _, active, engine, lease, client = workspace
    response = client.post(endpoint(active), headers=HEADERS, json=BODY | extra)
    assert response.status_code == 422 and "private" not in response.text
    lease.close.assert_not_called(); engine.dispose.assert_not_called()


def test_sqlite_is_not_a_backdoor_around_the_ordinary_dirty_guard(workspace):
    registry, active, engine, lease, client = workspace
    with pytest.raises(ProjectSessionError, match="project_unsaved_changes"):
        registry.close(active.state.session_id)
    active.state = active.state.model_copy(update={"storage_mode": "local_sqlite"})
    response = client.post(endpoint(active), headers=HEADERS, json=BODY)
    assert response.status_code == 400 and response.json()["detail"]["code"] == "remote_contract_invalid"
    lease.close.assert_not_called(); engine.dispose.assert_not_called()


def test_foreign_folder_lock_is_never_removed_even_when_this_local_session_releases(workspace):
    _, active, _, _, client = workspace
    lock = active.path / "cache/project.lock.json"
    content = json.loads(lock.read_text()); content["session_id"] = "foreign-local-owner"
    lock.write_text(json.dumps(content), encoding="utf-8")
    response = client.post(endpoint(active), headers=HEADERS, json=BODY)
    assert response.status_code == 200
    assert json.loads(lock.read_text())["session_id"] == "foreign-local-owner"


def test_cleanup_failure_cannot_return_a_false_local_release_acknowledgement(workspace):
    registry, active, engine, _, _ = workspace
    engine.dispose.side_effect = RuntimeError("injected cleanup failure")
    try:
        with pytest.raises(RuntimeError, match="injected cleanup failure"):
            release_remote_project(registry, active.state.session_id, RemoteStorageReleaseV1(**BODY))
        assert active.state.session_id in registry._sessions
    finally:
        engine.dispose.side_effect = None


def test_unknown_session_cannot_release_the_selected_local_owner(workspace):
    registry, active, engine, lease, client = workspace
    response = client.post("/api/project-sessions/unknown/remote-storage/release", headers=HEADERS, json=BODY)
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "project_session_not_found"
    assert active.state.session_id in registry._sessions
    lease.close.assert_not_called(); engine.dispose.assert_not_called()

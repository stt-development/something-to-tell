"""Correlation must not replay lifecycle work or orphan a late candidate."""

from concurrent.futures import ThreadPoolExecutor
from threading import Event, RLock
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.project_session import remote_reconnect as tracking
from services.runtime.stt_runtime.project_session.errors import ProjectSessionError
from services.runtime.stt_runtime.schemas.remote_storage import (
    RemoteReconnectBeginV1, RemoteReconnectAbandonV1, RemoteReconnectScopeV1,
)
from services.runtime.tests.test_schema_plan_api import settings

GENERATION = "11111111-1111-4111-8111-111111111111"
HEADERS = {"X-Remote-Storage-Version": "1"}


def active(session_id):
    return SimpleNamespace(state=SimpleNamespace(session_id=session_id, project_id="project-a", storage_mode="postgresql"),
        session_factory=SimpleNamespace(kw={"info": {"remote_lease": SimpleNamespace(generation=GENERATION)}}), write_guard=RLock(), lifecycle_identity=object())


@pytest.fixture
def workspace(monkeypatch):
    source, candidate = active("source"), active("candidate")
    registry = SimpleNamespace(_guard=RLock(), _remote_reconnect_guard=RLock(), _remote_reconnects={}, _sessions={"source": source})

    def require(session_id):
        if session_id not in registry._sessions:
            raise ProjectSessionError("project_session_not_found")
        return registry._sessions[session_id]

    def reconnect(*_):
        registry._sessions.pop("source", None)
        registry._sessions["candidate"] = candidate
        return SimpleNamespace(session=candidate.state)

    def release(_, session_id, request):
        assert request.storage_generation == GENERATION
        registry._sessions.pop(session_id)

    registry._require_session = require
    registry.close_all = Mock()
    begin = RemoteReconnectBeginV1(protocol_version=1, project_id="project-a", storage_generation=GENERATION,
        attempt_id=str(uuid4()), observed_revision="0", unresolved_command_id=None, confirmation="reload_remote_working_data")
    perform, cleanup = Mock(side_effect=reconnect), Mock(side_effect=release)
    monkeypatch.setattr(tracking.remote_recovery, "reconnect", perform)
    monkeypatch.setattr(tracking, "release_remote_project", cleanup)
    return registry, begin, perform, cleanup


def scope(begin):
    return RemoteReconnectScopeV1(**{k: getattr(begin, k) for k in ("protocol_version", *tracking.SCOPE_FIELDS)})


def abandon(begin):
    return RemoteReconnectAbandonV1(**scope(begin).model_dump(), confirmation="leave_remote_working_data_unchanged")


def test_lost_result_is_discoverable_after_source_is_gone_without_replaying(workspace):
    registry, begin, perform, _ = workspace
    tracking.begin_attempt(registry, "source", begin)  # Deliberately discard ACK.
    result = tracking.inspect_attempt(registry, "source", scope(begin))
    assert result.status == "ready" and result.result_session_id == "candidate"
    assert "source" not in registry._sessions
    record = registry._remote_reconnects[begin.attempt_id]
    assert record.candidate_id == "candidate"
    assert record.candidate_identity is registry._sessions["candidate"].lifecycle_identity
    assert all(value is not registry._sessions["candidate"] for value in vars(record).values())
    assert tracking.begin_attempt(registry, "source", begin) == result
    perform.assert_called_once()
    with pytest.raises(ProjectSessionError, match="remote_command_reused"):
        tracking.begin_attempt(registry, "source", begin.model_copy(update={"observed_revision": "1"}))


@pytest.mark.parametrize("field,value", [("project_id", "foreign"), ("storage_generation", str(uuid4()))])
def test_lookup_and_cancel_reject_foreign_scope_without_cleanup(workspace, field, value):
    registry, begin, _, cleanup = workspace
    tracking.begin_attempt(registry, "source", begin)
    for operation, request in [(tracking.inspect_attempt, scope(begin)), (tracking.abandon_attempt, abandon(begin))]:
        with pytest.raises(ProjectSessionError, match="remote_project_scope_mismatch"):
            operation(registry, "source", request.model_copy(update={field: value}))
        with pytest.raises(ProjectSessionError, match="remote_project_scope_mismatch"):
            operation(registry, "foreign-source", request)
    cleanup.assert_not_called()


def test_pending_lookup_duplicate_begin_and_abandon_do_not_wait_on_sql_or_replay(workspace):
    registry, begin, perform, cleanup = workspace
    entered, finish = Event(), Event()
    actual = perform.side_effect

    def delayed(*args):
        # Ordinary open may hold the registry lock during DB admission. The
        # metadata guard must remain independently readable/cancellable.
        with registry._guard:
            entered.set()
            assert finish.wait(5)
            return actual(*args)

    perform.side_effect = delayed
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(tracking.begin_attempt, registry, "source", begin)
        try:
            assert entered.wait(5)
            assert tracking.inspect_attempt(registry, "source", scope(begin)).status == "pending"
            assert tracking.begin_attempt(registry, "source", begin).status == "pending"
            assert tracking.abandon_attempt(registry, "source", abandon(begin)).status == "pending"
        finally:
            finish.set()
        assert future.result(timeout=5).status == "released"
    assert not registry._sessions
    perform.assert_called_once(); cleanup.assert_called_once()


def test_abandon_before_begin_prevents_late_execution_and_preserves_source(workspace):
    registry, begin, perform, cleanup = workspace
    assert tracking.abandon_attempt(registry, "source", abandon(begin)).status == "released"
    assert tracking.begin_attempt(registry, "source", begin).status == "released"
    assert list(registry._sessions) == ["source"]
    perform.assert_not_called(); cleanup.assert_not_called()


def test_cleanup_failure_retains_candidate_for_explicit_retry_without_reconnect(workspace):
    registry, begin, perform, cleanup = workspace
    tracking.begin_attempt(registry, "source", begin)
    actual = cleanup.side_effect
    cleanup.side_effect = RuntimeError("private driver detail")
    result = tracking.abandon_attempt(registry, "source", abandon(begin))
    assert result.status == "release_failed" and result.result_session_id == "candidate"
    assert result.error_code == "remote_storage_unavailable"
    assert "private" not in result.model_dump_json()
    cleanup.side_effect = actual
    assert tracking.abandon_attempt(registry, "source", abandon(begin)).status == "released"
    perform.assert_called_once()


def test_closed_candidate_never_aliases_a_replacement(workspace):
    registry, begin, _, cleanup = workspace
    tracking.begin_attempt(registry, "source", begin)
    registry._sessions["candidate"] = active("candidate")
    assert tracking.inspect_attempt(registry, "source", scope(begin)).status == "released"
    assert tracking.abandon_attempt(registry, "source", abandon(begin)).status == "released"
    cleanup.assert_not_called()


@pytest.mark.parametrize("error,code", [(ProjectSessionError("remote_auth_failed"), "remote_auth_failed"),
    (RuntimeError("secret"), "remote_storage_unavailable")])
def test_failed_attempt_is_redacted_and_never_reexecuted(workspace, error, code):
    registry, begin, perform, _ = workspace
    perform.side_effect = error
    result = tracking.begin_attempt(registry, "source", begin)
    assert result.status == "failed" and result.error_code == code
    assert tracking.begin_attempt(registry, "source", begin) == result
    perform.assert_called_once()


def test_unknown_lookup_is_inert_after_restart_or_pruning(workspace):
    registry, begin, perform, cleanup = workspace
    registry._sessions.clear()
    assert tracking.inspect_attempt(registry, "source", scope(begin)).status == "unknown"
    perform.assert_not_called(); cleanup.assert_not_called()


def test_capacity_preserves_pre_begin_tombstone_while_source_is_live(workspace, monkeypatch):
    registry, begin, perform, _ = workspace
    monkeypatch.setattr(tracking, "MAX_ATTEMPTS", 1)
    tracking.abandon_attempt(registry, "source", abandon(begin))
    with pytest.raises(ProjectSessionError, match="remote_project_busy"):
        tracking.begin_attempt(registry, "source", begin.model_copy(update={"attempt_id": str(uuid4())}))
    assert tracking.begin_attempt(registry, "source", begin).status == "released"
    perform.assert_not_called()


def test_changed_generation_candidate_is_released_not_published_as_ready(workspace):
    registry, begin, perform, cleanup = workspace
    actual = perform.side_effect

    def changed(*args):
        response = actual(*args)
        candidate = registry._sessions["candidate"]
        candidate.session_factory.kw["info"]["remote_lease"].generation = str(uuid4())
        return response

    perform.side_effect = changed
    cleanup.side_effect = lambda _, session_id, request: registry._sessions.pop(session_id)
    result = tracking.begin_attempt(registry, "source", begin)
    assert result.status == "failed" and result.error_code == "remote_generation_mismatch"
    assert not registry._sessions
    cleanup.assert_called_once()


def test_capacity_never_evicts_pending_record_but_releases_terminal_slots(workspace, monkeypatch):
    registry, begin, perform, _ = workspace
    monkeypatch.setattr(tracking, "MAX_ATTEMPTS", 1)
    record = tracking._Attempt("another", begin)
    registry._remote_reconnects[str(uuid4())] = record
    with pytest.raises(ProjectSessionError, match="remote_project_busy"):
        tracking.begin_attempt(registry, "source", begin)
    perform.assert_not_called()
    record.status, record.error = "failed", "remote_storage_unavailable"
    assert tracking.begin_attempt(registry, "source", begin).status == "ready"
    assert len(registry._remote_reconnects) == 1


def test_http_version_scope_validation_and_read_only_outcome(workspace, tmp_path):
    registry, begin, perform, cleanup = workspace
    app = create_app(settings(tmp_path)); app.state.project_sessions = registry
    path = "/api/project-sessions/source/remote-storage/reconnect-attempts"
    query = f"/{begin.attempt_id}?project_id=project-a&storage_generation={GENERATION}"
    with TestClient(app) as client:
        assert client.post(path, json=begin.model_dump()).status_code == 400
        assert client.post(path, headers=HEADERS, json=begin.model_dump() | {"password": "secret"}).status_code == 422
        assert client.get(path + "/bad?project_id=a&storage_generation=bad", headers=HEADERS).status_code == 422
        response = client.post(path, headers=HEADERS, json=begin.model_dump())
        assert response.status_code == 200, response.text
        assert client.get(path + query, headers=HEADERS).json() == response.json()
        assert client.get(path + query, headers=HEADERS | {"X-Project-Session-Id": "foreign"}).status_code == 409
        assert client.post(path + f"/{uuid4()}/abandon", headers=HEADERS, json=abandon(begin).model_dump()).status_code == 409
        assert client.post(path + f"/{begin.attempt_id}/abandon", headers=HEADERS, json=abandon(begin).model_dump()).json()["status"] == "released"
    perform.assert_called_once(); cleanup.assert_called_once()

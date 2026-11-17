"""Native lost-result and late-cancel acceptance uses only UUID-owned databases."""

from concurrent.futures import ThreadPoolExecutor
from threading import Event
from uuid import uuid4

import pytest
from sqlalchemy import create_engine

from services.runtime.stt_runtime.project_session import remote_reconnect as tracking
from services.runtime.stt_runtime.project_session.service import ProjectSessionRegistry
from services.runtime.stt_runtime.schemas.remote_storage import RemoteReconnectBeginV1, RemoteReconnectScopeV1, RemoteReconnectAbandonV1
from services.runtime.stt_runtime.storage_profiles import StorageProfileRegistry
from services.runtime.tests.test_remote_storage_protocol_audit import audit_database, _profile
from services.runtime.tests.test_remote_release_postgresql import working_state


@pytest.fixture
def workspace(audit_database, tmp_path):
    registry = ProjectSessionRegistry(StorageProfileRegistry([_profile(audit_database)]))
    observer = create_engine(audit_database)
    try:
        opened = registry.create(tmp_path / "Reconnect.narrative", "Reconnect")
        session_id = opened.session.session_id
        migrated = registry.migrate_storage(session_id, expected_revision=0, target_mode="postgresql", target_profile_id="audit")
        head = migrated.project.session.remote_storage
        request = RemoteReconnectBeginV1(protocol_version=1, project_id=opened.session.project_id,
            storage_generation=head.storage_generation, attempt_id=str(uuid4()), observed_revision=head.authoring_revision,
            unresolved_command_id=None, confirmation="reload_remote_working_data")
        scope = RemoteReconnectScopeV1(**{k: getattr(request, k) for k in ("protocol_version", *tracking.SCOPE_FIELDS)})
        abandon = RemoteReconnectAbandonV1(**scope.model_dump(), confirmation="leave_remote_working_data_unchanged")
        yield registry, session_id, request, scope, abandon, migrated.project.document, observer
    finally:
        registry.close_all()
        observer.dispose()


def test_discarded_result_is_recovered_without_second_open_and_working_data_is_unchanged(workspace, monkeypatch):
    registry, source, request, scope, abandon, before, observer = workspace
    canonical = working_state(observer, request.project_id)
    original_open = registry.open
    calls = []

    def counted(*args, **kwargs):
        calls.append(1)
        return original_open(*args, **kwargs)

    monkeypatch.setattr(registry, "open", counted)
    tracking.begin_attempt(registry, source, request)  # Lost successful response.
    found = tracking.inspect_attempt(registry, source, scope)
    assert found.status == "ready" and found.result_session_id != source
    assert source not in registry._sessions
    assert tracking.begin_attempt(registry, source, request) == found
    assert len(calls) == 1 and len(registry._sessions) == 1
    current = registry.inspect(found.result_session_id)
    assert current.document.checksum == before.checksum
    assert current.session.saved_revision == before.manifest.saved_revision
    assert tracking.abandon_attempt(registry, source, abandon).status == "released"
    assert not registry._sessions
    assert working_state(observer, request.project_id) == canonical


def test_abandon_during_real_open_cleans_late_candidate_without_rewriting_checkpoint(workspace, monkeypatch):
    registry, source, request, scope, abandon, _, observer = workspace
    entered, proceed = Event(), Event()
    original_open = registry.open
    path = registry._sessions[source].path
    canonical = working_state(observer, request.project_id)
    assert canonical[1]  # Actual server checkpoints, not an empty local directory.

    def delayed(*args, **kwargs):
        # Model the existing open's broad guard: metadata calls must not wait.
        with registry._guard:
            entered.set()
            assert proceed.wait(10)
            return original_open(*args, **kwargs)

    monkeypatch.setattr(registry, "open", delayed)
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(tracking.begin_attempt, registry, source, request)
        try:
            assert entered.wait(10)
            assert tracking.inspect_attempt(registry, source, scope).status == "pending"
            assert tracking.abandon_attempt(registry, source, abandon).status == "pending"
        finally:
            proceed.set()
        assert future.result(timeout=20).status == "released"
    assert not registry._sessions and not (path / "cache/project.lock.json").exists()
    assert working_state(observer, request.project_id) == canonical

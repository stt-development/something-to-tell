"""Bounded correlation in the session registry; lifecycle ownership stays unchanged."""

from dataclasses import dataclass
from typing import Any, get_args

from ..schemas.remote_storage import (
    RemoteReconnectOutcomeV1, RemoteStorageErrorCode, RemoteStorageReconnectV1,
    RemoteStorageReleaseV1,
)
from ..storage_failures import storage_failure_code
from . import remote_recovery
from .closing import release_remote_project
from .errors import ProjectSessionError
from .remote_ownership import lease_for

MAX_ATTEMPTS = 128
SCOPE_FIELDS = ("project_id", "storage_generation", "attempt_id")


@dataclass
class _Attempt:
    source: str
    scope: Any
    request: Any = None
    status: str = "pending"
    candidate_id: str | None = None
    candidate_identity: object | None = None
    abandon: bool = False
    error: str | None = None


def _match(record, source, scope):
    if record.source != source or any(getattr(record.scope, key) != getattr(scope, key) for key in SCOPE_FIELDS):
        raise ProjectSessionError("remote_project_scope_mismatch")


def _candidate(registry, record):
    active = registry._sessions.get(record.candidate_id)
    return active if active is not None and active.lifecycle_identity is record.candidate_identity else None


def _snapshot(registry, record):
    # A closed/replaced candidate cannot be resolved into an unrelated open session.
    if record.status in {"ready", "release_failed"} and _candidate(registry, record) is None:
        record.status, record.candidate_id, record.candidate_identity, record.error = "released", None, None, None
    return RemoteReconnectOutcomeV1(**{key: getattr(record.scope, key) for key in SCOPE_FIELDS},
        protocol_version=1, source_session_id=record.source, status=record.status,
        result_session_id=record.candidate_id if record.status in {"ready", "release_failed"} else None,
        error_code=record.error)


def _admit(registry, source, scope):
    active = registry._require_session(source)
    if active.state.project_id != scope.project_id:
        raise ProjectSessionError("remote_project_scope_mismatch")
    lease = lease_for(active.session_factory)
    if active.state.storage_mode != "postgresql" or lease is None:
        raise ProjectSessionError("remote_contract_invalid")
    if lease.generation != scope.storage_generation:
        raise ProjectSessionError("remote_generation_mismatch")
    # Never evict an identity that might still own a local candidate or be opening.
    if len(registry._remote_reconnects) >= MAX_ATTEMPTS:
        for key, record in list(registry._remote_reconnects.items()):
            if (_snapshot(registry, record).status in {"released", "failed"}
                    and record.source not in registry._sessions):
                del registry._remote_reconnects[key]
    if len(registry._remote_reconnects) >= MAX_ATTEMPTS:
        raise ProjectSessionError("remote_project_busy")
    return active


def inspect_attempt(registry, source, scope):
    """Pure registry lookup, including when the source no longer exists or SQL is down."""
    with registry._remote_reconnect_guard:
        record = registry._remote_reconnects.get(scope.attempt_id)
        if record is None:
            return RemoteReconnectOutcomeV1(**scope.model_dump(), source_session_id=source,
                status="unknown", result_session_id=None, error_code=None)
        _match(record, source, scope)
        return _snapshot(registry, record)


def begin_attempt(registry, source, request):
    with registry._remote_reconnect_guard:
        record = registry._remote_reconnects.get(request.attempt_id)
        if record is not None:
            _match(record, source, request)
            if record.request is not None and record.request != request:
                raise ProjectSessionError("remote_command_reused")
            return _snapshot(registry, record)
        active = _admit(registry, source, request)
        if any(item.source == source and item.status in {"pending", "releasing", "ready", "release_failed"}
               for item in registry._remote_reconnects.values()):
            raise ProjectSessionError("remote_project_busy")
        record = _Attempt(source, request, request=request)
        registry._remote_reconnects[request.attempt_id] = record
    try:
        # The ordinary reconnect remains the only reacquisition owner. Do not hold
        # the registry lock across SQL; a separate request must be able to abandon.
        with active.write_guard:
            with registry._guard:
                if registry._sessions.get(source) is not active:
                    raise ProjectSessionError("remote_writer_lost")
            with registry._remote_reconnect_guard:
                if record.abandon:
                    record.status = "released"
                    return _snapshot(registry, record)
            response = remote_recovery.reconnect(registry, source, RemoteStorageReconnectV1(
                storage_generation=request.storage_generation, observed_revision=request.observed_revision,
                unresolved_command_id=request.unresolved_command_id))
        with registry._remote_reconnect_guard:
            candidate = registry._require_session(response.session.session_id)
            # Keep identity only, not the closed session's engine/history/drafts.
            record.candidate_id, record.candidate_identity = candidate.state.session_id, candidate.lifecycle_identity
            record.status = "ready"
            lease = lease_for(candidate.session_factory)
            mismatch = (candidate.state.project_id != request.project_id or lease is None
                        or lease.generation != request.storage_generation)
            if mismatch:
                record.abandon = True
            abandoned = record.abandon
    except Exception as error:
        with registry._remote_reconnect_guard:
            code = getattr(error, "code", None)
            record.error = code if code in get_args(RemoteStorageErrorCode) else storage_failure_code(error)
            record.status = "failed"
            return _snapshot(registry, record)
    if abandoned:
        result = _release_candidate(registry, record)
        if mismatch and result.status == "released":
            with registry._remote_reconnect_guard:
                record.status, record.error = "failed", "remote_generation_mismatch"
                return _snapshot(registry, record)
        return result
    with registry._remote_reconnect_guard:
        return _snapshot(registry, record)


def abandon_attempt(registry, source, request):
    with registry._remote_reconnect_guard:
        record = registry._remote_reconnects.get(request.attempt_id)
        if record is None:
            # Tombstone a valid source before a delayed begin arrives. No source
            # close is implied: the original editor may still contain drafts.
            _admit(registry, source, request)
            record = _Attempt(source, request, status="released", abandon=True)
            registry._remote_reconnects[request.attempt_id] = record
        _match(record, source, request)
        record.abandon = True
        if record.status not in {"ready", "release_failed"}:
            return _snapshot(registry, record)
    return _release_candidate(registry, record)


def _release_candidate(registry, record):
    with registry._remote_reconnect_guard:
        if _snapshot(registry, record).status not in {"ready", "release_failed"}:
            return _snapshot(registry, record)
        candidate = _candidate(registry, record)
        record.status, record.error = "releasing", None
    try:
        with candidate.write_guard:
            with registry._guard:
                same = registry._sessions.get(candidate.state.session_id) is candidate
            if same:
                release_remote_project(registry, candidate.state.session_id, RemoteStorageReleaseV1(
                    protocol_version=1, storage_generation=lease_for(candidate.session_factory).generation,
                    confirmation="leave_remote_working_data_unchanged"))
        with registry._remote_reconnect_guard:
            record.status, record.candidate_id, record.candidate_identity = "released", None, None
    except Exception:
        with registry._remote_reconnect_guard:
            record.status, record.error = "release_failed", "remote_storage_unavailable"
    with registry._remote_reconnect_guard:
        return _snapshot(registry, record)

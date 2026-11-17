from collections.abc import Callable
from pathlib import Path
from typing import Annotated, TypeVar

from fastapi import APIRouter, Depends, HTTPException, Request, status

from ...project_catalog import (
    ProjectCatalogError,
    ProjectDirectoryError,
    discover_project_catalog,
    list_project_directories,
)
from ...project_session.service import ProjectSessionError, ProjectSessionRegistry
from ...project_history.service import ProjectHistoryError
from ...schemas.project_history import (
    ProjectHistoryMutation,
    ProjectHistoryMutationResponse,
    ProjectHistorySummary,
)
from ...schemas.project_session import (
    ProjectCatalogResponse,
    ProjectDirectoryListingResponse,
    ProjectSessionCreate,
    ProjectSessionExit,
    ProjectSessionOpen,
    ProjectSessionResponse,
    ProjectSessionSave,
    ProjectSessionSaveAs,
    ProjectSessionSaveAsResponse,
    ProjectSessionState,
    RemoteProjectSessionState,
    ProjectSessionSettingsUpdate,
)
from ...schemas.remote_storage import RemoteStorageHeadV1, RemoteCommandOutcomeV1, RemoteStorageReconnectV1
from ...schemas.remote_storage import RemoteReconnectBeginV1, RemoteReconnectAbandonV1, RemoteReconnectOutcomeV1, RemoteReconnectScopeV1
from ...schemas.remote_storage import RemoteId, RemoteUuid
from ...project_session import remote_reconnect
from ...schemas.remote_storage import RemoteStorageReleaseV1, RemoteStorageReleaseResultV1
from ...project_session.closing import release_remote_project
from ...project_session import remote_recovery

router = APIRouter(prefix="/project-sessions", tags=["project-sessions"])
ResponseT = TypeVar("ResponseT")


def get_project_session_registry(request: Request) -> ProjectSessionRegistry:
    """Resolve the process-owned registry without exposing engines to routes."""

    return request.app.state.project_sessions


RegistryDep = Annotated[ProjectSessionRegistry, Depends(get_project_session_registry)]


@router.post(
    "/create",
    response_model=ProjectSessionResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_project_session(
    payload: ProjectSessionCreate,
    registry: RegistryDep,
) -> ProjectSessionResponse:
    return _call(
        lambda: registry.create(
            Path(payload.path),
            payload.name,
            payload.description,
            payload.settings,
        )
    )


@router.post("/open", response_model=ProjectSessionResponse)
def open_project_session(
    payload: ProjectSessionOpen,
    registry: RegistryDep,
) -> ProjectSessionResponse:
    return _call(
        lambda: registry.open(
            Path(payload.path),
            recover_stale_lock=payload.recover_stale_lock,
            recovery_mode=payload.recovery_mode,
            expected_lock_session_id=payload.expected_lock_session_id,
            remote_profile_id=payload.remote_profile_id,
            initialize_remote_storage=payload.initialize_remote_storage,
        )
    )


@router.get("/catalog", response_model=ProjectCatalogResponse)
def list_project_catalog(path: str | None = None) -> ProjectCatalogResponse:
    """Resolve the default workspace or scan an explicitly selected directory."""

    try:
        return discover_project_catalog(Path(path) if path else None)
    except ProjectCatalogError as error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "project_catalog_invalid",
                "message_key": "project_catalog.invalid",
                "parameters": {"path": path or "~/.narrative"},
            },
        ) from error


@router.get("/directories", response_model=ProjectDirectoryListingResponse)
def list_directories(path: str | None = None) -> ProjectDirectoryListingResponse:
    """Expose one folder level for the local application's directory tree."""

    try:
        return list_project_directories(Path(path) if path else None)
    except ProjectDirectoryError as error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "project_directory_invalid",
                "message_key": "project_directory.invalid",
                "parameters": {"path": path or "~"},
            },
        ) from error


@router.get("/{session_id}", response_model=ProjectSessionResponse)
def inspect_project_session(
    session_id: str,
    registry: RegistryDep,
) -> ProjectSessionResponse:
    return _call(lambda: registry.inspect(session_id))


@router.get("/{session_id}/history", response_model=ProjectHistorySummary)
def inspect_project_history(
    session_id: str,
    registry: RegistryDep,
) -> ProjectHistorySummary:
    return _call(lambda: registry.inspect_history(session_id))


@router.get("/{session_id}/remote-storage", response_model=RemoteStorageHeadV1)
def inspect_remote_storage(session_id: str, registry: RegistryDep):
    return _call(lambda: remote_recovery.current_head(registry, session_id))


@router.get("/{session_id}/remote-commands/{command_id}", response_model=RemoteCommandOutcomeV1)
def resolve_remote_command(session_id: str, command_id: str, generation: str, registry: RegistryDep):
    return _call(lambda: remote_recovery.command_outcome(registry, session_id, command_id, generation))


@router.post("/{session_id}/remote-storage/reconnect", response_model=ProjectSessionResponse)
def reconnect_remote_storage(session_id: str, payload: RemoteStorageReconnectV1, registry: RegistryDep):
    return _call(lambda: remote_recovery.reconnect(registry, session_id, payload))


@router.post("/{session_id}/remote-storage/reconnect-attempts", response_model=RemoteReconnectOutcomeV1)
def begin_remote_reconnect(session_id: RemoteId, payload: RemoteReconnectBeginV1, registry: RegistryDep):
    return _call(lambda: remote_reconnect.begin_attempt(registry, session_id, payload))


@router.get("/{session_id}/remote-storage/reconnect-attempts/{attempt_id}", response_model=RemoteReconnectOutcomeV1)
def inspect_remote_reconnect(session_id: RemoteId, attempt_id: RemoteUuid, project_id: RemoteId, storage_generation: RemoteUuid, registry: RegistryDep):
    scope = RemoteReconnectScopeV1(protocol_version=1, project_id=project_id, storage_generation=storage_generation, attempt_id=attempt_id)
    return _call(lambda: remote_reconnect.inspect_attempt(registry, session_id, scope))


@router.post("/{session_id}/remote-storage/reconnect-attempts/{attempt_id}/abandon", response_model=RemoteReconnectOutcomeV1)
def abandon_remote_reconnect(session_id: RemoteId, attempt_id: RemoteUuid, payload: RemoteReconnectAbandonV1, registry: RegistryDep):
    if attempt_id != payload.attempt_id:
        raise HTTPException(status_code=409, detail={"code": "remote_project_scope_mismatch"})
    return _call(lambda: remote_reconnect.abandon_attempt(registry, session_id, payload))


@router.post("/{session_id}/remote-storage/release", response_model=RemoteStorageReleaseResultV1)
def release_remote_storage(session_id: str, payload: RemoteStorageReleaseV1, registry: RegistryDep):
    """Release local ownership without requiring a readable remote document."""
    return _call(lambda: release_remote_project(registry, session_id, payload))


@router.post(
    "/{session_id}/history/undo",
    response_model=ProjectHistoryMutationResponse,
)
def undo_project_history(
    session_id: str,
    payload: ProjectHistoryMutation,
    registry: RegistryDep,
) -> ProjectHistoryMutationResponse:
    return _call(
        lambda: registry.undo_history(
            session_id,
            expected_history_revision=payload.expected_history_revision,
        )
    )


@router.post(
    "/{session_id}/history/redo",
    response_model=ProjectHistoryMutationResponse,
)
def redo_project_history(
    session_id: str,
    payload: ProjectHistoryMutation,
    registry: RegistryDep,
) -> ProjectHistoryMutationResponse:
    return _call(
        lambda: registry.redo_history(
            session_id,
            expected_history_revision=payload.expected_history_revision,
        )
    )


@router.put("/{session_id}/settings", response_model=ProjectSessionResponse)
def update_project_settings(
    session_id: str,
    payload: ProjectSessionSettingsUpdate,
    registry: RegistryDep,
) -> ProjectSessionResponse:
    """Persist project metadata without applying an unconfirmed UI draft."""

    return _call(
        lambda: registry.update_settings(
            session_id,
            name=payload.name,
            description=payload.description,
            settings=payload.settings,
            expected_history_revision=payload.expected_history_revision,
        )
    )


@router.post("/{session_id}/save", response_model=ProjectSessionResponse)
def save_project_session(
    session_id: str,
    payload: ProjectSessionSave,
    registry: RegistryDep,
) -> ProjectSessionResponse:
    return _call(
        lambda: registry.save(
            session_id,
            expected_revision=payload.expected_revision,
            reason=payload.reason,
        )
    )


@router.post("/{session_id}/save-as", response_model=ProjectSessionSaveAsResponse)
def save_project_session_as(
    session_id: str,
    payload: ProjectSessionSaveAs,
    registry: RegistryDep,
) -> ProjectSessionSaveAsResponse:
    """Install a portable copy without moving the source session lock."""

    return _call(
        lambda: registry.save_as(
            session_id,
            destination=Path(payload.path),
            expected_revision=payload.expected_revision,
            identity=payload.identity,
            replace_existing=payload.replace_existing,
        )
    )


@router.post("/{session_id}/discard", response_model=ProjectSessionResponse)
def discard_project_session(
    session_id: str,
    registry: RegistryDep,
) -> ProjectSessionResponse:
    return _call(lambda: registry.discard(session_id))


@router.post("/{session_id}/close", response_model=ProjectSessionResponse)
def close_project_session(
    session_id: str,
    registry: RegistryDep,
) -> ProjectSessionResponse:
    return _call(lambda: registry.close(session_id))


@router.post("/{session_id}/exit", response_model=ProjectSessionState | RemoteProjectSessionState)
def exit_project_session(
    session_id: str,
    payload: ProjectSessionExit,
    registry: RegistryDep,
) -> ProjectSessionState:
    """Checkpoint a confirmed page exit and release its otherwise live lock."""

    return _call(
        lambda: registry.exit(
            session_id,
            expected_revision=payload.expected_revision,
        )
    )


def _call(operation: Callable[[], ResponseT]) -> ResponseT:
    try:
        return operation()
    except ProjectHistoryError as error:
        raise HTTPException(
            status_code=_history_status_code(error.code),
            detail={
                "code": error.code,
                "message_key": f"history.error.{error.code}",
                "parameters": error.parameters,
            },
        ) from error
    except ProjectSessionError as error:
        raise HTTPException(
            status_code=_status_code(error.code),
            detail={
                "code": error.code,
                "message_key": f"project_session.{error.code}",
                "parameters": error.parameters,
            },
        ) from error


def _status_code(code: str) -> int:
    if code in {"remote_storage_version_unsupported", "remote_server_version_unsupported", "remote_contract_invalid",
                "remote_storage_binding_required", "remote_storage_protocol_unsupported"}:
        return status.HTTP_400_BAD_REQUEST
    if code.startswith("remote_"):
        return status.HTTP_503_SERVICE_UNAVAILABLE if code in {
            "remote_storage_unavailable", "remote_storage_timeout", "remote_commit_unknown"
        } else status.HTTP_409_CONFLICT
    if code == "project_session_not_found":
        return status.HTTP_404_NOT_FOUND
    if code in {
        "project_already_open",
        "project_identity_mismatch",
        "project_identity_already_open",
        "project_lock_race",
        "project_lock_stale",
        "project_locked",
        "project_save_in_progress",
        "project_save_revision_stale",
        "project_save_as_destination_exists",
        "project_unsaved_changes",
        "project_recovery_required",
        "project_storage_migration_required",
    }:
        return status.HTTP_409_CONFLICT
    return status.HTTP_400_BAD_REQUEST


def _history_status_code(code: str) -> int:
    if code in {
        "history_revision_stale",
        "history_document_stale",
        "history_undo_empty",
        "history_redo_empty",
        "history_command_duplicate",
    }:
        return status.HTTP_409_CONFLICT
    return status.HTTP_400_BAD_REQUEST

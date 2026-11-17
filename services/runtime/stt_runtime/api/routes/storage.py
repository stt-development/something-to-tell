from typing import Annotated
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, status

from ...schemas.storage import (
    StorageMigrationRequest,
    StorageMigrationResponse,
    StorageProfileCreateRequest,
    StorageFolderProfileCreateRequest,
    StorageProfileSummary,
    StorageProfilesResponse,
    StorageProfileTestRequest,
    StorageProfileTestResponse,
)
from ...storage_profiles import StorageProfileError, StorageProfileRegistry
from ...storage_inspection import inspect_storage
from ...schema_plan_context import capture_schema_plan_context
from ...schema_provisioning import execute_provisioning
from ...schema_upgrade import execute_upgrade
from ...schemas.remote_storage import (
    RemoteStorageFolderRequestV1, RemoteStorageInspectRequestV1, RemoteStorageInspectionV1,
    RemoteSchemaPlanRequestV1, RemoteSchemaPlanV1,
    RemoteSchemaBackupAttestationRequestV1, RemoteSchemaBackupAttestationV1,
    RemoteSchemaExecuteRequestV1, RemoteSchemaExecutionV1,
)
from ...project_format.service import validate_project_folder, ProjectFormatError
from ...project_session.errors import ProjectSessionError

router = APIRouter(tags=["storage"])


def get_storage_profiles(request: Request) -> StorageProfileRegistry:
    """Resolve the runtime-owned secret registry without exposing profiles."""

    return request.app.state.storage_profiles


ProfileRegistryDep = Annotated[StorageProfileRegistry, Depends(get_storage_profiles)]


@router.post("/storage-profiles/available", response_model=StorageProfilesResponse)
def available_storage_profiles(payload: RemoteStorageFolderRequestV1, request: Request, registry: ProfileRegistryDep):
    """Discover safe scoped choices even when the remote schema prevents Open."""
    folder = _authorized_storage_folder(payload, request)
    try:
        return StorageProfilesResponse(profiles=registry.summaries(folder.path))
    except StorageProfileError as error:
        raise _profile_http_error(error) from None


@router.post("/storage-profiles/folder", response_model=StorageProfileSummary, status_code=status.HTTP_201_CREATED)
def create_folder_storage_profile(payload: StorageFolderProfileCreateRequest, request: Request, registry: ProfileRegistryDep):
    """Add a fresh encrypted definition before Open; never replace an active profile."""
    folder = _authorized_storage_folder(payload, request)
    try:
        return registry.add(folder.path, **payload.model_dump(exclude={"protocol_version", "project_path"}))
    except StorageProfileError as error:
        raise _profile_http_error(error) from None


@router.post("/storage-profiles/inspect", response_model=RemoteStorageInspectionV1)
def inspect_storage_profile(payload: RemoteStorageInspectRequestV1, request: Request, registry: ProfileRegistryDep):
    """Inspect a selected folder/profile without opening or mutating a project."""
    folder = _authorized_storage_folder(payload, request)
    return inspect_storage(registry, folder.path, payload.profile_id)


@router.post("/storage-profiles/schema-plans", response_model=RemoteSchemaPlanV1)
def prepare_storage_schema_plan(payload: RemoteSchemaPlanRequestV1, request: Request, registry: ProfileRegistryDep):
    """Prepare review metadata only; browser input never supplies SQL observations."""
    folder = _authorized_storage_folder(payload, request)
    context = capture_schema_plan_context(registry, folder, payload.profile_id)
    canonical = payload.model_copy(update={"project_path": str(folder.path)})
    return request.app.state.schema_plans.create(canonical, context)


@router.post("/storage-profiles/schema-plans/backup-attestations", response_model=RemoteSchemaBackupAttestationV1)
def attest_storage_schema_backup(payload: RemoteSchemaBackupAttestationRequestV1, request: Request, registry: ProfileRegistryDep):
    """Record the operator's acknowledgement, not proof of an inspected backup."""
    folder = _authorized_storage_folder(payload, request)
    context = capture_schema_plan_context(registry, folder, payload.profile_id)
    canonical = payload.model_copy(update={"project_path": str(folder.path)})
    return request.app.state.schema_plans.attest(canonical, context)


@router.post("/storage-profiles/schema-plans/execute", response_model=RemoteSchemaExecutionV1)
def execute_storage_schema_plan(payload: RemoteSchemaExecuteRequestV1, request: Request, registry: ProfileRegistryDep):
    """Execute only the stored reviewed action, never implicitly upgrade on Open/Test."""
    folder = _authorized_storage_folder(payload, request)
    canonical = payload.model_copy(update={"project_path": str(folder.path)})
    plans = request.app.state.schema_plans
    action = plans.execution_action(canonical)
    execute = execute_provisioning if action == "provision" else execute_upgrade
    result = execute(registry, folder, canonical, plans)
    return RemoteSchemaExecutionV1(plan_id=payload.plan_id, action=action,
        schema_revision=result.inspection.schema_revision, status="completed")


def _authorized_storage_folder(payload: RemoteStorageFolderRequestV1, request: Request):
    """Share pre-connection folder/session scoping across reviewed admin APIs."""
    if request.headers.get("x-remote-storage-version") != "1":
        raise ProjectSessionError("remote_storage_protocol_unsupported")
    try:
        path = Path(payload.project_path).expanduser()
        if not path.is_absolute():
            raise ProjectFormatError("Absolute project path required")
        folder = validate_project_folder(path)
    except (ProjectFormatError, OSError, ValueError):
        raise ProjectSessionError("remote_contract_invalid") from None
    selected = request.headers.get("x-project-session-id")
    if selected:
        try:
            selected_path = request.app.state.project_sessions.project_path(selected)
        except ProjectSessionError:
            raise ProjectSessionError("remote_project_scope_mismatch") from None
        if selected_path != folder.path:
            raise ProjectSessionError("remote_project_scope_mismatch")
    return folder


@router.get("/storage-profiles", response_model=StorageProfilesResponse)
def list_storage_profiles(
    request: Request,
    registry: ProfileRegistryDep,
    session_id: str | None = None,
) -> StorageProfilesResponse:
    project_path = (
        request.app.state.project_sessions.project_path(session_id)
        if session_id
        else None
    )
    return StorageProfilesResponse(profiles=registry.summaries(project_path))


@router.post(
    "/storage-profiles",
    response_model=StorageProfileSummary,
    status_code=status.HTTP_201_CREATED,
)
def create_storage_profile(
    payload: StorageProfileCreateRequest,
    request: Request,
    registry: ProfileRegistryDep,
) -> StorageProfileSummary:
    project_path = request.app.state.project_sessions.project_path(payload.session_id)
    return registry.add(
        project_path,
        label=payload.label,
        host=payload.host,
        port=payload.port,
        database=payload.database,
        username=payload.username,
        password=payload.password,
        tls_policy=payload.tls_policy,
    )


@router.post("/storage-profiles/test", response_model=StorageProfileTestResponse)
def test_storage_profile(
    payload: StorageProfileTestRequest,
    request: Request,
    registry: ProfileRegistryDep,
) -> StorageProfileTestResponse:
    try:
        project_path = (
            request.app.state.project_sessions.project_path(payload.session_id)
            if payload.session_id
            else None
        )
        return registry.test(payload.profile_id, project_path)
    except StorageProfileError as error:
        raise _profile_http_error(error) from error


@router.post("/storage-migrations", response_model=StorageMigrationResponse)
def migrate_storage(
    payload: StorageMigrationRequest,
    request: Request,
) -> StorageMigrationResponse:
    try:
        return request.app.state.project_sessions.migrate_storage(
            payload.session_id,
            expected_revision=payload.expected_revision,
            target_mode=payload.target_mode,
            target_profile_id=payload.target_profile_id,
        )
    except StorageProfileError as error:
        raise _profile_http_error(error) from error
    except ValueError as error:
        # ProjectSessionError deliberately exposes only stable code/parameters.
        code = getattr(error, "code", "storage_migration_failed")
        parameters = getattr(error, "parameters", {})
        http_status = (
            status.HTTP_409_CONFLICT
            if code in {
                "project_save_revision_stale",
                "project_unsaved_changes",
                "storage_migration_same_target",
            }
            else status.HTTP_400_BAD_REQUEST
        )
        raise HTTPException(
            status_code=http_status,
            detail={
                "code": code,
                "message_key": f"storage_migration.{code}",
                "parameters": parameters,
            },
        ) from error


def _profile_http_error(error: StorageProfileError) -> HTTPException:
    status_code = (
        status.HTTP_404_NOT_FOUND
        if error.code == "storage_profile_not_found"
        else status.HTTP_400_BAD_REQUEST
    )
    return HTTPException(
        status_code=status_code,
        detail={
            "code": error.code,
            "message_key": f"storage_profile.{error.code}",
            "parameters": {"profile_id": error.profile_id},
        },
    )

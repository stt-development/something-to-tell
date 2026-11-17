from collections.abc import Callable
from typing import Annotated, TypeVar

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status

from ..crud import api_error
from ..dependencies import PROJECT_SESSION_HEADER, get_uow
from ...repositories.interfaces import UnitOfWork
from ...schemas.composable_story_flow import FlowExit, FlowExitBinding, FlowInvocation
from ...schemas.composable_story_flow_api import (
    ComposableFlowProjection,
    ComposableIntegrityReport,
    CompositionDeleteCommand,
    CompositionDeletionImpact,
    FlowCompositionSnapshot,
    FlowExitBindingCreate,
    FlowExitBindingUpdate,
    FlowExitCreate,
    FlowExitUpdate,
    FlowInvocationCreate,
    FlowInvocationUpdate,
    OutcomeSideFlowCreate,
    OutcomeSideFlowResponse,
)
from ...story_flow.composable_service import ComposableStoryFlowService
from ...story_flow.service import StoryFlowServiceError

router = APIRouter(prefix="/flow-composition", tags=["flow-composition"])
UowDep = Annotated[UnitOfWork, Depends(get_uow, scope="function")]
ResponseT = TypeVar("ResponseT")


@router.get("/projects/{project_id}", response_model=FlowCompositionSnapshot)
def get_composition(project_id: str, uow: UowDep) -> FlowCompositionSnapshot:
    return _call(uow, lambda: ComposableStoryFlowService().snapshot(uow, project_id))


@router.post("/invocations", response_model=FlowInvocation, status_code=status.HTTP_201_CREATED)
def create_invocation(
    payload: FlowInvocationCreate,
    request: Request,
    uow: UowDep,
    session_id: str | None = Header(default=None, alias=PROJECT_SESSION_HEADER),
) -> FlowInvocation:
    _require_revision(request, session_id, payload.expected_revision)
    return _call(uow, lambda: ComposableStoryFlowService().create_invocation(uow, payload))


@router.put("/invocations/{invocation_id}", response_model=FlowInvocation)
def update_invocation(
    invocation_id: str,
    payload: FlowInvocationUpdate,
    request: Request,
    uow: UowDep,
    session_id: str | None = Header(default=None, alias=PROJECT_SESSION_HEADER),
) -> FlowInvocation:
    _require_revision(request, session_id, payload.expected_revision)
    return _call(
        uow,
        lambda: ComposableStoryFlowService().update_invocation(uow, invocation_id, payload),
    )


@router.post(
    "/outcomes/new-side-flow",
    response_model=OutcomeSideFlowResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_outcome_side_flow(
    payload: OutcomeSideFlowCreate,
    request: Request,
    uow: UowDep,
    session_id: str | None = Header(default=None, alias=PROJECT_SESSION_HEADER),
) -> OutcomeSideFlowResponse:
    """Commit specialized outcome replacement as one project revision command."""

    _require_revision(request, session_id, payload.expected_revision)
    return _call(
        uow,
        lambda: ComposableStoryFlowService().create_outcome_side_flow(uow, payload),
    )


@router.get("/invocations/{invocation_id}/impact", response_model=CompositionDeletionImpact)
def get_invocation_impact(invocation_id: str, uow: UowDep) -> CompositionDeletionImpact:
    return _call(uow, lambda: ComposableStoryFlowService().invocation_impact(uow, invocation_id))


@router.delete("/invocations/{invocation_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_invocation(
    invocation_id: str,
    payload: CompositionDeleteCommand,
    request: Request,
    uow: UowDep,
    session_id: str | None = Header(default=None, alias=PROJECT_SESSION_HEADER),
) -> Response:
    _require_revision(request, session_id, payload.expected_revision)
    _call(
        uow,
        lambda: ComposableStoryFlowService().delete_invocation(
            uow, invocation_id, impact_reviewed=payload.impact_reviewed
        ),
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/exits", response_model=FlowExit, status_code=status.HTTP_201_CREATED)
def create_exit(
    payload: FlowExitCreate,
    request: Request,
    uow: UowDep,
    session_id: str | None = Header(default=None, alias=PROJECT_SESSION_HEADER),
) -> FlowExit:
    _require_revision(request, session_id, payload.expected_revision)
    return _call(uow, lambda: ComposableStoryFlowService().create_exit(uow, payload))


@router.put("/exits/{exit_id}", response_model=FlowExit)
def update_exit(
    exit_id: str,
    payload: FlowExitUpdate,
    request: Request,
    uow: UowDep,
    session_id: str | None = Header(default=None, alias=PROJECT_SESSION_HEADER),
) -> FlowExit:
    _require_revision(request, session_id, payload.expected_revision)
    return _call(uow, lambda: ComposableStoryFlowService().update_exit(uow, exit_id, payload))


@router.get("/exits/{exit_id}/impact", response_model=CompositionDeletionImpact)
def get_exit_impact(exit_id: str, uow: UowDep) -> CompositionDeletionImpact:
    return _call(uow, lambda: ComposableStoryFlowService().exit_impact(uow, exit_id))


@router.delete("/exits/{exit_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_exit(
    exit_id: str,
    payload: CompositionDeleteCommand,
    request: Request,
    uow: UowDep,
    session_id: str | None = Header(default=None, alias=PROJECT_SESSION_HEADER),
) -> Response:
    _require_revision(request, session_id, payload.expected_revision)
    _call(
        uow,
        lambda: ComposableStoryFlowService().delete_exit(
            uow, exit_id, impact_reviewed=payload.impact_reviewed
        ),
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/bindings",
    response_model=FlowExitBinding,
    status_code=status.HTTP_201_CREATED,
    name="create_flow_exit_binding",
)
def create_binding(
    payload: FlowExitBindingCreate,
    request: Request,
    uow: UowDep,
    session_id: str | None = Header(default=None, alias=PROJECT_SESSION_HEADER),
) -> FlowExitBinding:
    _require_revision(request, session_id, payload.expected_revision)
    return _call(uow, lambda: ComposableStoryFlowService().create_binding(uow, payload))


@router.put(
    "/bindings/{binding_id}",
    response_model=FlowExitBinding,
    name="update_flow_exit_binding",
)
def update_binding(
    binding_id: str,
    payload: FlowExitBindingUpdate,
    request: Request,
    uow: UowDep,
    session_id: str | None = Header(default=None, alias=PROJECT_SESSION_HEADER),
) -> FlowExitBinding:
    _require_revision(request, session_id, payload.expected_revision)
    return _call(
        uow, lambda: ComposableStoryFlowService().update_binding(uow, binding_id, payload)
    )


@router.delete(
    "/bindings/{binding_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    name="delete_flow_exit_binding",
)
def delete_binding(
    binding_id: str,
    payload: CompositionDeleteCommand,
    request: Request,
    uow: UowDep,
    session_id: str | None = Header(default=None, alias=PROJECT_SESSION_HEADER),
) -> Response:
    _require_revision(request, session_id, payload.expected_revision)
    _call(uow, lambda: ComposableStoryFlowService().delete_binding(uow, binding_id))
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/flows/{flow_id}/impact", response_model=CompositionDeletionImpact)
def get_flow_impact(flow_id: str, uow: UowDep) -> CompositionDeletionImpact:
    return _call(uow, lambda: ComposableStoryFlowService().flow_impact(uow, flow_id))


@router.get("/projects/{project_id}/nodes/{node_id}/impact", response_model=CompositionDeletionImpact)
def get_node_impact(project_id: str, node_id: str, uow: UowDep) -> CompositionDeletionImpact:
    return _call(uow, lambda: ComposableStoryFlowService().node_impact(uow, project_id, node_id))


@router.get(
    "/projects/{project_id}/flows/{root_flow_id}/integrity",
    response_model=ComposableIntegrityReport,
)
def get_integrity(project_id: str, root_flow_id: str, uow: UowDep) -> ComposableIntegrityReport:
    return _call(
        uow, lambda: ComposableStoryFlowService().integrity(uow, project_id, root_flow_id)
    )


@router.get(
    "/projects/{project_id}/flows/{root_flow_id}/story",
    response_model=ComposableFlowProjection,
)
def get_story_projection(
    project_id: str, root_flow_id: str, uow: UowDep
) -> ComposableFlowProjection:
    return _call(
        uow,
        lambda: ComposableStoryFlowService().projection(uow, project_id, root_flow_id, "story"),
    )


@router.get(
    "/projects/{project_id}/flows/{root_flow_id}/playback",
    response_model=ComposableFlowProjection,
)
def get_playback_projection(
    project_id: str, root_flow_id: str, uow: UowDep
) -> ComposableFlowProjection:
    return _call(
        uow,
        lambda: ComposableStoryFlowService().projection(
            uow, project_id, root_flow_id, "playback"
        ),
    )


def _require_revision(request: Request, session_id: str | None, expected_revision: int) -> None:
    """Reject commands based on a checkpoint older than the active project session."""

    if session_id is None:
        return
    current = request.app.state.project_sessions.inspect(session_id).session.saved_revision
    if expected_revision != current:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "composable_flow_revision_stale",
                "message_key": "composableFlow.error.composable_flow_revision_stale",
                "parameters": {
                    "expected_revision": expected_revision,
                    "saved_revision": current,
                },
            },
        )


def _call(uow: UnitOfWork, operation: Callable[[], ResponseT]) -> ResponseT:
    try:
        return operation()
    except StoryFlowServiceError as error:
        uow.rollback()
        missing = {
            "composable_flow_project_not_found",
            "composable_flow_flow_not_found",
            "composable_flow_node_not_found",
            "composable_flow_member_not_found",
            "composable_flow_invocation_not_found",
            "composable_flow_exit_not_found",
            "composable_flow_binding_not_found",
        }
        status_code = status.HTTP_404_NOT_FOUND if error.code in missing else status.HTTP_409_CONFLICT
        raise api_error(status_code, error.code, str(error)) from error

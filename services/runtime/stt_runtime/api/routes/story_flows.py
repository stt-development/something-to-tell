from typing import Annotated

from fastapi import APIRouter, Depends, Response, status

from ..crud import api_error
from ..dependencies import get_uow
from ...repositories.interfaces import UnitOfWork
from ...schemas.story_flow import (
    FlowTransition,
    StoryFlow,
    StoryFlowDeletionImpact,
    StoryFlowIntegrityReport,
    StoryFlowNodeDeletionImpact,
    StoryFlowSnapshot,
)
from ...schemas.story_flow_api import (
    ContinueExistingNode,
    ContinueNewNode,
    FlowTransitionCreate,
    FlowTransitionOrderUpdate,
    FlowTransitionUpdate,
    SceneFlowBoundaryUpsert,
    StoryFlowContinuationResponse,
    StoryFlowBootstrapCreate,
    StoryFlowBootstrapResponse,
    StoryFlowCreate,
    StoryFlowEntryUpdate,
    StoryFlowMembershipCreate,
    StoryFlowProjectCommand,
    StoryFlowUpdate,
)
from ...story_flow.service import StoryFlowService, StoryFlowServiceError
from ...story_flow.integrity_service import StoryFlowIntegrityService

router = APIRouter(prefix="/story-flows", tags=["story-flows"])
UowDep = Annotated[UnitOfWork, Depends(get_uow, scope="function")]


@router.post("", response_model=StoryFlow, status_code=status.HTTP_201_CREATED)
def create_story_flow(payload: StoryFlowCreate, uow: UowDep) -> StoryFlow:
    return _call(uow, lambda: StoryFlowService().create(uow, payload))


@router.post("/bootstrap", response_model=StoryFlowBootstrapResponse, status_code=status.HTTP_201_CREATED)
def bootstrap_story_flow(payload: StoryFlowBootstrapCreate, uow: UowDep) -> StoryFlowBootstrapResponse:
    return _call(uow, lambda: StoryFlowService().bootstrap(uow, payload))


@router.get("", response_model=list[StoryFlow])
def list_story_flows(project_id: str, uow: UowDep) -> list[StoryFlow]:
    return _call(uow, lambda: StoryFlowService().list(uow, project_id))


@router.get("/{flow_id}", response_model=StoryFlowSnapshot)
def get_story_flow(flow_id: str, uow: UowDep) -> StoryFlowSnapshot:
    return _call(uow, lambda: StoryFlowService().snapshot(uow, flow_id))


@router.get("/{flow_id}/integrity", response_model=StoryFlowIntegrityReport)
def get_story_flow_integrity(flow_id: str, uow: UowDep) -> StoryFlowIntegrityReport:
    """Return read-only Flow and project composition facts for authoring UI."""

    return _call(uow, lambda: StoryFlowIntegrityService().inspect(uow, flow_id))


@router.put("/{flow_id}", response_model=StoryFlowSnapshot)
def update_story_flow(flow_id: str, payload: StoryFlowUpdate, uow: UowDep) -> StoryFlowSnapshot:
    return _call(uow, lambda: StoryFlowService().update(uow, flow_id, payload))


@router.post("/{flow_id}/archive", response_model=StoryFlow)
def archive_story_flow(flow_id: str, payload: StoryFlowProjectCommand, uow: UowDep) -> StoryFlow:
    return _call(uow, lambda: StoryFlowService().archive(uow, flow_id, payload.project_id))


@router.get("/{flow_id}/impact", response_model=StoryFlowDeletionImpact)
def get_story_flow_deletion_impact(flow_id: str, uow: UowDep) -> StoryFlowDeletionImpact:
    return _call(uow, lambda: StoryFlowService().deletion_impact(uow, flow_id))


@router.delete("/{flow_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_story_flow(flow_id: str, uow: UowDep, confirmed: bool = False) -> Response:
    _call(uow, lambda: StoryFlowService().delete(uow, flow_id, confirmed=confirmed))
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{flow_id}/nodes", response_model=StoryFlowSnapshot, status_code=status.HTTP_201_CREATED)
def add_story_flow_membership(
    flow_id: str,
    payload: StoryFlowMembershipCreate,
    uow: UowDep,
) -> StoryFlowSnapshot:
    return _call(uow, lambda: StoryFlowService().add_membership(uow, flow_id, payload))


@router.post("/{flow_id}/entry", response_model=StoryFlowSnapshot)
def set_story_flow_entry(
    flow_id: str,
    payload: StoryFlowEntryUpdate,
    uow: UowDep,
) -> StoryFlowSnapshot:
    return _call(uow, lambda: StoryFlowService().set_entry(uow, flow_id, payload))


@router.get("/{flow_id}/nodes/{node_id}/impact", response_model=StoryFlowNodeDeletionImpact)
def get_membership_deletion_impact(
    flow_id: str,
    node_id: str,
    uow: UowDep,
) -> StoryFlowNodeDeletionImpact:
    return _call(uow, lambda: StoryFlowService().membership_deletion_impact(uow, flow_id, node_id))


@router.delete("/{flow_id}/nodes/{node_id}", response_model=StoryFlowSnapshot)
def remove_story_flow_membership(
    flow_id: str,
    node_id: str,
    uow: UowDep,
    confirmed: bool = False,
) -> StoryFlowSnapshot:
    return _call(
        uow,
        lambda: StoryFlowService().remove_membership(uow, flow_id, node_id, confirmed=confirmed),
    )


@router.post("/{flow_id}/transitions", response_model=FlowTransition, status_code=status.HTTP_201_CREATED)
def create_flow_transition(
    flow_id: str,
    payload: FlowTransitionCreate,
    uow: UowDep,
) -> FlowTransition:
    return _call(uow, lambda: StoryFlowService().create_transition(uow, flow_id, payload))


@router.put("/{flow_id}/transitions/{transition_id}", response_model=FlowTransition)
def update_flow_transition(
    flow_id: str,
    transition_id: str,
    payload: FlowTransitionUpdate,
    uow: UowDep,
) -> FlowTransition:
    return _call(
        uow,
        lambda: StoryFlowService().update_transition(uow, flow_id, transition_id, payload),
    )


@router.delete("/{flow_id}/transitions/{transition_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_flow_transition(flow_id: str, transition_id: str, uow: UowDep) -> Response:
    _call(uow, lambda: StoryFlowService().delete_transition(uow, flow_id, transition_id))
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/{flow_id}/nodes/{source_node_id}/transition-order", response_model=StoryFlowSnapshot)
def reorder_flow_transitions(
    flow_id: str,
    source_node_id: str,
    payload: FlowTransitionOrderUpdate,
    uow: UowDep,
) -> StoryFlowSnapshot:
    if source_node_id != payload.source_node_id:
        raise api_error(
            status.HTTP_409_CONFLICT,
            "story_flow_transition_source_mismatch",
            "Transition order source does not match the route.",
        )
    return _call(uow, lambda: StoryFlowService().reorder_transitions(uow, flow_id, payload))


@router.put("/{flow_id}/scenes/{scene_node_id}/boundary", response_model=StoryFlowSnapshot)
def upsert_scene_flow_boundary(
    flow_id: str,
    scene_node_id: str,
    payload: SceneFlowBoundaryUpsert,
    uow: UowDep,
) -> StoryFlowSnapshot:
    return _call(
        uow,
        lambda: StoryFlowService().upsert_scene_boundary(uow, flow_id, scene_node_id, payload),
    )


@router.delete(
    "/{flow_id}/scenes/{scene_node_id}/boundary",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_scene_flow_boundary(flow_id: str, scene_node_id: str, uow: UowDep) -> Response:
    _call(uow, lambda: StoryFlowService().delete_scene_boundary(uow, flow_id, scene_node_id))
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/{flow_id}/continue-existing",
    response_model=StoryFlowContinuationResponse,
    status_code=status.HTTP_201_CREATED,
)
def continue_with_existing(
    flow_id: str,
    payload: ContinueExistingNode,
    uow: UowDep,
) -> StoryFlowContinuationResponse:
    return _call(uow, lambda: StoryFlowService().continue_existing(uow, flow_id, payload))


@router.post(
    "/{flow_id}/continue-new",
    response_model=StoryFlowContinuationResponse,
    status_code=status.HTTP_201_CREATED,
)
def continue_with_new(
    flow_id: str,
    payload: ContinueNewNode,
    uow: UowDep,
) -> StoryFlowContinuationResponse:
    return _call(uow, lambda: StoryFlowService().continue_new(uow, flow_id, payload))


def _call(uow: UnitOfWork, operation):
    try:
        return operation()
    except StoryFlowServiceError as error:
        uow.rollback()
        raise _story_flow_api_error(error) from error


def _story_flow_api_error(error: StoryFlowServiceError):
    missing_codes = {
        "story_flow_project_not_found",
        "story_flow_not_found",
        "story_flow_node_not_found",
        "story_flow_membership_not_found",
        "story_flow_transition_not_found",
        "story_flow_boundary_not_found",
    }
    status_code = status.HTTP_404_NOT_FOUND if error.code in missing_codes else status.HTTP_409_CONFLICT
    return api_error(status_code, error.code, str(error))

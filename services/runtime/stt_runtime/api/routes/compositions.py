from typing import Annotated

from fastapi import APIRouter, Depends, Response, status

from ..crud import api_error
from ..dependencies import get_uow
from ...composition.service import CompositionService, CompositionServiceError
from ...repositories.interfaces import UnitOfWork
from ...schemas.composition import (
    CompositionFrameCreate,
    CompositionFrameResponse,
    CompositionDeletionImpact,
    ProjectCompositionSnapshot,
    VisualPlacement,
    VisualPlacementBatchUpdate,
    VisualPlacementCreate,
    VisualPlacementUpdate,
)

router = APIRouter(prefix="/compositions", tags=["compositions"])
UowDep = Annotated[UnitOfWork, Depends(get_uow, scope="function")]


@router.get("/entities/{node_id}/impact", response_model=CompositionDeletionImpact)
def get_composition_deletion_impact(node_id: str, uow: UowDep) -> CompositionDeletionImpact:
    try:
        return CompositionService().deletion_impact(uow, node_id)
    except CompositionServiceError as error:
        uow.rollback()
        raise _composition_api_error(error) from error


@router.delete("/entities/{node_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_composition_entity(node_id: str, uow: UowDep) -> Response:
    try:
        CompositionService().delete_entity(uow, node_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    except CompositionServiceError as error:
        uow.rollback()
        raise _composition_api_error(error) from error


@router.post("/frames", response_model=CompositionFrameResponse, status_code=status.HTTP_201_CREATED)
def create_composition_frame(payload: CompositionFrameCreate, uow: UowDep) -> CompositionFrameResponse:
    try:
        return CompositionService().create_frame(uow, payload)
    except CompositionServiceError as error:
        uow.rollback()
        raise _composition_api_error(error) from error


@router.get("", response_model=ProjectCompositionSnapshot)
def get_composition_snapshot(project_id: str, uow: UowDep) -> ProjectCompositionSnapshot:
    try:
        return CompositionService().list_snapshot(uow, project_id)
    except CompositionServiceError as error:
        uow.rollback()
        raise _composition_api_error(error) from error


@router.get("/placements", response_model=list[VisualPlacement])
def list_visual_placements(
    project_id: str,
    uow: UowDep,
    container_node_id: str | None = None,
) -> list[VisualPlacement]:
    try:
        return CompositionService().list_placements(uow, project_id, container_node_id)
    except CompositionServiceError as error:
        uow.rollback()
        raise _composition_api_error(error) from error


@router.post("/placements", response_model=ProjectCompositionSnapshot, status_code=status.HTTP_201_CREATED)
def create_visual_placement(payload: VisualPlacementCreate, uow: UowDep) -> ProjectCompositionSnapshot:
    try:
        return CompositionService().create(uow, payload)
    except CompositionServiceError as error:
        uow.rollback()
        raise _composition_api_error(error) from error


@router.put("/placements/{placement_id}", response_model=ProjectCompositionSnapshot)
def update_visual_placement(
    placement_id: str,
    payload: VisualPlacementUpdate,
    uow: UowDep,
) -> ProjectCompositionSnapshot:
    try:
        return CompositionService().update(uow, placement_id, payload)
    except CompositionServiceError as error:
        uow.rollback()
        raise _composition_api_error(error) from error


@router.put("/placements", response_model=ProjectCompositionSnapshot)
def update_visual_placements(
    payload: VisualPlacementBatchUpdate,
    uow: UowDep,
) -> ProjectCompositionSnapshot:
    try:
        return CompositionService().update_many(uow, payload)
    except CompositionServiceError as error:
        uow.rollback()
        raise _composition_api_error(error) from error


@router.delete("/placements/{placement_id}", response_model=ProjectCompositionSnapshot)
def remove_visual_placement(placement_id: str, uow: UowDep) -> ProjectCompositionSnapshot:
    try:
        return CompositionService().remove(uow, placement_id)
    except CompositionServiceError as error:
        uow.rollback()
        raise _composition_api_error(error) from error


def _composition_api_error(error: CompositionServiceError):
    missing_codes = {
        "composition_project_not_found",
        "composition_canonical_not_found",
        "composition_container_not_found",
        "composition_placement_not_found",
    }
    status_code = status.HTTP_404_NOT_FOUND if error.code in missing_codes else status.HTTP_409_CONFLICT
    return api_error(status_code, error.code, str(error))

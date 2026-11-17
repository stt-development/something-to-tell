from typing import Annotated

from fastapi import APIRouter, Depends, status

from ..crud import api_error
from ..dependencies import get_uow
from ...dialogue.service import DialogueServiceError
from ...dialogue.transition_service import DialogueTransitionService
from ...repositories.interfaces import UnitOfWork
from ...schemas.dialogue_transition import DialogueTransitionCreate, DialogueTransitionResponse, DialogueTransitionUpdate

router = APIRouter(prefix="/dialogue-transitions", tags=["dialogue-transitions"])
UowDep = Annotated[UnitOfWork, Depends(get_uow, scope="function")]


@router.post("", response_model=DialogueTransitionResponse, status_code=status.HTTP_201_CREATED)
def create_dialogue_transition(payload: DialogueTransitionCreate, uow: UowDep) -> DialogueTransitionResponse:
    try:
        return DialogueTransitionService().create(uow, payload)
    except DialogueServiceError as error:
        uow.rollback()
        raise _transition_api_error(error) from error


@router.put("/{edge_id}", response_model=DialogueTransitionResponse)
def update_dialogue_transition(edge_id: str, payload: DialogueTransitionUpdate, uow: UowDep) -> DialogueTransitionResponse:
    try:
        return DialogueTransitionService().update(uow, edge_id, payload)
    except DialogueServiceError as error:
        uow.rollback()
        raise _transition_api_error(error) from error


def _transition_api_error(error: DialogueServiceError):
    missing_codes = {"dialogue_node_not_found", "dialogue_transition_not_found", "dialogue_transition_target_not_found"}
    return api_error(status.HTTP_404_NOT_FOUND if error.code in missing_codes else status.HTTP_409_CONFLICT, error.code, str(error))

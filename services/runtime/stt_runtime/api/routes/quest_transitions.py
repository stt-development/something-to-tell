from typing import Annotated

from fastapi import APIRouter, Depends, status

from ..crud import api_error
from ..dependencies import get_uow
from ...quest.service import QuestServiceError
from ...quest.transition_service import QuestTransitionService
from ...repositories.interfaces import UnitOfWork
from ...schemas.quest_transition import QuestTransitionCreate, QuestTransitionResponse, QuestTransitionUpdate

router = APIRouter(prefix="/quest-transitions", tags=["quest-transitions"])
UowDep = Annotated[UnitOfWork, Depends(get_uow, scope="function")]


@router.post("", response_model=QuestTransitionResponse, status_code=status.HTTP_201_CREATED)
def create_quest_transition(payload: QuestTransitionCreate, uow: UowDep) -> QuestTransitionResponse:
    try:
        return QuestTransitionService().create(uow, payload)
    except QuestServiceError as error:
        uow.rollback()
        raise _transition_api_error(error) from error


@router.put("/{edge_id}", response_model=QuestTransitionResponse)
def update_quest_transition(edge_id: str, payload: QuestTransitionUpdate, uow: UowDep) -> QuestTransitionResponse:
    try:
        return QuestTransitionService().update(uow, edge_id, payload)
    except QuestServiceError as error:
        uow.rollback()
        raise _transition_api_error(error) from error


def _transition_api_error(error: QuestServiceError):
    missing = {"quest_node_not_found", "quest_transition_not_found", "quest_transition_target_not_found"}
    return api_error(status.HTTP_404_NOT_FOUND if error.code in missing else status.HTTP_409_CONFLICT, error.code, str(error))

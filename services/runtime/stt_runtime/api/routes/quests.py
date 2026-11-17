from typing import Annotated

from fastapi import APIRouter, Depends, status

from ..crud import api_error
from ..dependencies import get_uow
from ...quest.service import QuestService, QuestServiceError
from ...repositories.interfaces import UnitOfWork
from ...schemas.quest import QuestDocument

router = APIRouter(prefix="/quests", tags=["quests"])
UowDep = Annotated[UnitOfWork, Depends(get_uow, scope="function")]


@router.get("/{node_id}", response_model=QuestDocument)
def get_quest_document(node_id: str, uow: UowDep) -> QuestDocument:
    try:
        return QuestService().get_document(uow, node_id)
    except QuestServiceError as error:
        uow.rollback()
        raise _quest_api_error(error) from error


@router.put("/{node_id}", response_model=QuestDocument)
def update_quest_document(node_id: str, payload: QuestDocument, uow: UowDep) -> QuestDocument:
    try:
        return QuestService().update_document(uow, node_id, payload)
    except QuestServiceError as error:
        uow.rollback()
        raise _quest_api_error(error) from error


def _quest_api_error(error: QuestServiceError):
    return api_error(status.HTTP_404_NOT_FOUND if error.code == "quest_node_not_found" else status.HTTP_409_CONFLICT, error.code, str(error))

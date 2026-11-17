from typing import Annotated

from fastapi import APIRouter, Depends, status

from ..crud import api_error
from ..dependencies import get_uow
from ...dialogue.integrity_service import DialogueIntegrityService
from ...dialogue.service import DialogueService, DialogueServiceError
from ...repositories.interfaces import UnitOfWork
from ...schemas.dialogue import DialogueDocument
from ...schemas.dialogue_integrity import DialogueIntegrityReport

router = APIRouter(prefix="/dialogues", tags=["dialogues"])
UowDep = Annotated[UnitOfWork, Depends(get_uow, scope="function")]


@router.get("/{node_id}/integrity", response_model=DialogueIntegrityReport)
def get_dialogue_integrity(node_id: str, uow: UowDep) -> DialogueIntegrityReport:
    try:
        return DialogueIntegrityService().inspect(uow, node_id)
    except DialogueServiceError as error:
        uow.rollback()
        raise _dialogue_api_error(error) from error


@router.get("/{node_id}", response_model=DialogueDocument)
def get_dialogue_document(node_id: str, uow: UowDep) -> DialogueDocument:
    try:
        return DialogueService().get_document(uow, node_id)
    except DialogueServiceError as error:
        uow.rollback()
        raise _dialogue_api_error(error) from error


@router.put("/{node_id}", response_model=DialogueDocument)
def update_dialogue_document(node_id: str, payload: DialogueDocument, uow: UowDep) -> DialogueDocument:
    try:
        return DialogueService().update_document(uow, node_id, payload)
    except DialogueServiceError as error:
        uow.rollback()
        raise _dialogue_api_error(error) from error


def _dialogue_api_error(error: DialogueServiceError):
    status_code = status.HTTP_404_NOT_FOUND if error.code == "dialogue_node_not_found" else status.HTTP_409_CONFLICT
    return api_error(status_code, error.code, str(error))

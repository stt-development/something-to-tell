from typing import Annotated

from fastapi import APIRouter, Depends, Response, status
from pydantic import ValidationError

from ..crud import api_error, create_suggestion, delete_suggestion, get_suggestion, list_suggestions, suggestion_response, update_suggestion
from ..dependencies import get_uow
from ...analysis.patch_application import PatchApplicationError, SuggestionDecisionService
from ...repositories.interfaces import UnitOfWork
from ...schemas.resources import SuggestionCreate, SuggestionResponse, SuggestionUpdate

router = APIRouter(prefix="/suggestions", tags=["suggestions"])
UowDep = Annotated[UnitOfWork, Depends(get_uow, scope="function")]


@router.post("", response_model=SuggestionResponse, status_code=status.HTTP_201_CREATED)
def create_suggestion_resource(payload: SuggestionCreate, uow: UowDep) -> SuggestionResponse:
    return create_suggestion(uow, payload)


@router.get("", response_model=list[SuggestionResponse])
def list_suggestion_resources(project_id: str, uow: UowDep) -> list[SuggestionResponse]:
    return list_suggestions(uow, project_id)


@router.get("/{suggestion_id}", response_model=SuggestionResponse)
def get_suggestion_resource(suggestion_id: str, uow: UowDep) -> SuggestionResponse:
    return get_suggestion(uow, suggestion_id)


@router.put("/{suggestion_id}", response_model=SuggestionResponse)
def update_suggestion_resource(suggestion_id: str, payload: SuggestionUpdate, uow: UowDep) -> SuggestionResponse:
    return update_suggestion(uow, suggestion_id, payload)


@router.delete("/{suggestion_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_suggestion_resource(suggestion_id: str, uow: UowDep) -> Response:
    delete_suggestion(uow, suggestion_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{suggestion_id}/approve", response_model=SuggestionResponse)
def approve_suggestion_resource(suggestion_id: str, uow: UowDep) -> SuggestionResponse:
    try:
        return suggestion_response(SuggestionDecisionService().approve(uow, suggestion_id))
    except ValidationError as error:
        uow.rollback()
        raise api_error(status.HTTP_409_CONFLICT, "invalid_patch", "Stored suggestion patch is invalid.") from error
    except PatchApplicationError as error:
        uow.rollback()
        status_code = status.HTTP_404_NOT_FOUND if error.code == "suggestion_not_found" else status.HTTP_409_CONFLICT
        raise api_error(status_code, error.code, str(error)) from error


@router.post("/{suggestion_id}/reject", response_model=SuggestionResponse)
def reject_suggestion_resource(suggestion_id: str, uow: UowDep) -> SuggestionResponse:
    try:
        return suggestion_response(SuggestionDecisionService().reject(uow, suggestion_id))
    except PatchApplicationError as error:
        uow.rollback()
        status_code = status.HTTP_404_NOT_FOUND if error.code == "suggestion_not_found" else status.HTTP_409_CONFLICT
        raise api_error(status_code, error.code, str(error)) from error


@router.post("/{suggestion_id}/operations/{operation_index}/approve", response_model=SuggestionResponse)
def approve_suggestion_operation_resource(suggestion_id: str, operation_index: int, uow: UowDep) -> SuggestionResponse:
    try:
        return suggestion_response(SuggestionDecisionService().approve_operation(uow, suggestion_id, operation_index))
    except ValidationError as error:
        uow.rollback()
        raise api_error(status.HTTP_409_CONFLICT, "invalid_patch", "Stored suggestion patch is invalid.") from error
    except PatchApplicationError as error:
        uow.rollback()
        status_code = status.HTTP_404_NOT_FOUND if error.code in {"suggestion_not_found", "operation_not_found"} else status.HTTP_409_CONFLICT
        raise api_error(status_code, error.code, str(error)) from error


@router.post("/{suggestion_id}/operations/{operation_index}/reject", response_model=SuggestionResponse)
def reject_suggestion_operation_resource(suggestion_id: str, operation_index: int, uow: UowDep) -> SuggestionResponse:
    try:
        return suggestion_response(SuggestionDecisionService().reject_operation(uow, suggestion_id, operation_index))
    except ValidationError as error:
        uow.rollback()
        raise api_error(status.HTTP_409_CONFLICT, "invalid_patch", "Stored suggestion patch is invalid.") from error
    except PatchApplicationError as error:
        uow.rollback()
        status_code = status.HTTP_404_NOT_FOUND if error.code in {"suggestion_not_found", "operation_not_found"} else status.HTTP_409_CONFLICT
        raise api_error(status_code, error.code, str(error)) from error

from typing import Annotated

from fastapi import APIRouter, Depends, Response, status

from ..crud import create_engine_tag, delete_engine_tag, get_engine_tag, list_engine_tags, update_engine_tag
from ..dependencies import get_uow
from ...repositories.interfaces import UnitOfWork
from ...schemas.resources import EngineTagCreate, EngineTagResponse, EngineTagUpdate

router = APIRouter(prefix="/engine-tags", tags=["engine-tags"])
UowDep = Annotated[UnitOfWork, Depends(get_uow, scope="function")]


@router.post("", response_model=EngineTagResponse, status_code=status.HTTP_201_CREATED)
def create_engine_tag_resource(payload: EngineTagCreate, uow: UowDep) -> EngineTagResponse:
    return create_engine_tag(uow, payload)


@router.get("", response_model=list[EngineTagResponse])
def list_engine_tag_resources(project_id: str, uow: UowDep) -> list[EngineTagResponse]:
    return list_engine_tags(uow, project_id)


@router.get("/{engine_tag_id}", response_model=EngineTagResponse)
def get_engine_tag_resource(engine_tag_id: str, uow: UowDep) -> EngineTagResponse:
    return get_engine_tag(uow, engine_tag_id)


@router.put("/{engine_tag_id}", response_model=EngineTagResponse)
def update_engine_tag_resource(engine_tag_id: str, payload: EngineTagUpdate, uow: UowDep) -> EngineTagResponse:
    return update_engine_tag(uow, engine_tag_id, payload)


@router.delete("/{engine_tag_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_engine_tag_resource(engine_tag_id: str, uow: UowDep) -> Response:
    delete_engine_tag(uow, engine_tag_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)

from typing import Annotated

from fastapi import APIRouter, Depends, Response, status

from ..crud import create_edge, delete_edge, get_edge, list_edges, update_edge
from ..dependencies import get_uow
from ...repositories.interfaces import UnitOfWork
from ...schemas.resources import EdgeCreate, EdgeResponse, EdgeUpdate

router = APIRouter(prefix="/edges", tags=["edges"])
UowDep = Annotated[UnitOfWork, Depends(get_uow, scope="function")]


@router.post("", response_model=EdgeResponse, status_code=status.HTTP_201_CREATED)
def create_edge_resource(payload: EdgeCreate, uow: UowDep) -> EdgeResponse:
    return create_edge(uow, payload)


@router.get("", response_model=list[EdgeResponse])
def list_edge_resources(project_id: str, uow: UowDep) -> list[EdgeResponse]:
    return list_edges(uow, project_id)


@router.get("/{edge_id}", response_model=EdgeResponse)
def get_edge_resource(edge_id: str, uow: UowDep) -> EdgeResponse:
    return get_edge(uow, edge_id)


@router.put("/{edge_id}", response_model=EdgeResponse)
def update_edge_resource(edge_id: str, payload: EdgeUpdate, uow: UowDep) -> EdgeResponse:
    return update_edge(uow, edge_id, payload)


@router.delete("/{edge_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_edge_resource(edge_id: str, uow: UowDep) -> Response:
    delete_edge(uow, edge_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)

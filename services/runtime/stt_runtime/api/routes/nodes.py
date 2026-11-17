from typing import Annotated

from fastapi import APIRouter, Depends, Response, status

from ..crud import create_node, delete_node, get_node, list_nodes, update_node
from ..dependencies import get_uow
from ...repositories.interfaces import UnitOfWork
from ...schemas.resources import NodeCreate, NodeResponse, NodeUpdate

router = APIRouter(prefix="/nodes", tags=["nodes"])
UowDep = Annotated[UnitOfWork, Depends(get_uow, scope="function")]


@router.post("", response_model=NodeResponse, status_code=status.HTTP_201_CREATED)
def create_node_resource(payload: NodeCreate, uow: UowDep) -> NodeResponse:
    return create_node(uow, payload)


@router.get("", response_model=list[NodeResponse])
def list_node_resources(project_id: str, uow: UowDep) -> list[NodeResponse]:
    return list_nodes(uow, project_id)


@router.get("/{node_id}", response_model=NodeResponse)
def get_node_resource(node_id: str, uow: UowDep) -> NodeResponse:
    return get_node(uow, node_id)


@router.put("/{node_id}", response_model=NodeResponse)
def update_node_resource(node_id: str, payload: NodeUpdate, uow: UowDep) -> NodeResponse:
    return update_node(uow, node_id, payload)


@router.delete("/{node_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_node_resource(node_id: str, uow: UowDep) -> Response:
    delete_node(uow, node_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)

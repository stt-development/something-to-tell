from typing import Annotated

from fastapi import APIRouter, Depends, Response, status

from ..crud import api_error
from ..dependencies import get_uow
from ...membership.service import MembershipService, MembershipServiceError
from ...repositories.interfaces import UnitOfWork
from ...schemas.membership import FactionMembershipCreate
from ...schemas.resources import EdgeResponse

router = APIRouter(prefix="/factions", tags=["faction-memberships"])
UowDep = Annotated[UnitOfWork, Depends(get_uow, scope="function")]


@router.get("/{faction_id}/members", response_model=list[EdgeResponse])
def list_faction_members(faction_id: str, uow: UowDep) -> list[EdgeResponse]:
    """List graph-traversable membership relationships for one Faction."""
    return _call(uow, lambda: MembershipService().list(uow, faction_id))


@router.post("/{faction_id}/members", response_model=EdgeResponse, status_code=status.HTTP_201_CREATED)
def add_faction_member(faction_id: str, payload: FactionMembershipCreate, uow: UowDep) -> EdgeResponse:
    """Add an existing Character without changing either canonical node."""
    return _call(uow, lambda: MembershipService().add(uow, faction_id, payload.character_node_id))


@router.delete("/{faction_id}/members/{character_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_faction_member(faction_id: str, character_id: str, uow: UowDep) -> Response:
    """Remove only the semantic membership relationship."""
    _call(uow, lambda: MembershipService().remove(uow, faction_id, character_id))
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _call(uow: UnitOfWork, operation):
    """Translate service errors consistently and roll back failed writes."""
    try:
        return operation()
    except MembershipServiceError as error:
        uow.rollback()
        missing = error.code in {"membership_node_not_found", "membership_not_found"}
        raise api_error(status.HTTP_404_NOT_FOUND if missing else status.HTTP_409_CONFLICT, error.code, str(error)) from error

from ..domain.entities import EdgeEntity
from ..engine_tags.automatic import add_relationship_with_automatic_tag
from ..repositories.interfaces import UnitOfWork
from ..schemas.resources import EdgeResponse

MEMBERSHIP_TYPE = "member_of"


class MembershipServiceError(ValueError):
    """Carries a stable membership validation code to the HTTP boundary."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class MembershipService:
    """Owns hidden Character-to-Faction relationships and their invariants."""

    def list(self, uow: UnitOfWork, faction_id: str) -> list[EdgeResponse]:
        faction = self._require_kind(uow, faction_id, "Faction")
        return [
            self._response(edge)
            for edge in uow.edges.list(project_id=faction.project_id)
            if edge.type == MEMBERSHIP_TYPE and edge.target_node_id == faction_id
        ]

    def add(self, uow: UnitOfWork, faction_id: str, character_id: str) -> EdgeResponse:
        faction = self._require_kind(uow, faction_id, "Faction")
        character = self._require_kind(uow, character_id, "Character")
        if character.project_id != faction.project_id:
            raise MembershipServiceError("membership_cross_project", "Character and Faction must belong to the same project.")
        existing = self.list(uow, faction_id)
        if any(edge.source_node_id == character_id for edge in existing):
            raise MembershipServiceError("membership_duplicate", "Character is already a member of this Faction.")
        edge = add_relationship_with_automatic_tag(
            uow,
            EdgeEntity(
                project_id=faction.project_id,
                source_node_id=character_id,
                target_node_id=faction_id,
                type=MEMBERSHIP_TYPE,
                label="member of",
                metadata={"canvas_visibility": "hidden", "semantic_scope": "membership"},
            ),
        )
        uow.commit()
        return self._response(edge)

    def remove(self, uow: UnitOfWork, faction_id: str, character_id: str) -> None:
        faction = self._require_kind(uow, faction_id, "Faction")
        membership = next(
            (edge for edge in uow.edges.list(project_id=faction.project_id)
             if edge.type == MEMBERSHIP_TYPE and edge.source_node_id == character_id and edge.target_node_id == faction_id),
            None,
        )
        if membership is None:
            raise MembershipServiceError("membership_not_found", "Faction membership was not found.")
        uow.edges.delete(membership.id)
        uow.commit()

    def _require_kind(self, uow: UnitOfWork, node_id: str, expected_kind: str):
        node = uow.nodes.get(node_id)
        if node is None:
            raise MembershipServiceError("membership_node_not_found", f"Node not found: {node_id}")
        if node.type != expected_kind:
            raise MembershipServiceError("membership_invalid_kind", f"Expected {expected_kind}, received {node.type}.")
        return node

    @staticmethod
    def _response(edge: EdgeEntity) -> EdgeResponse:
        return EdgeResponse(
            id=edge.id,
            project_id=edge.project_id,
            source_node_id=edge.source_node_id,
            target_node_id=edge.target_node_id,
            type=edge.type,
            label=edge.label,
            condition=edge.condition,
            metadata=edge.metadata,
            created_at=edge.created_at,
            updated_at=edge.updated_at,
        )

from dataclasses import replace
from math import isfinite
from typing import cast

from ..domain.entities import EdgeEntity, NodeEntity, VisualPlacementEntity, new_entity_id
from ..engine_tags.automatic import add_node_with_automatic_tag
from ..engine_tags.ownership import owner_removed_with_node, owner_removed_with_relationships
from ..repositories.interfaces import UnitOfWork
from ..schemas.composition import (
    CompositionFrameCreate,
    CompositionFrameResponse,
    CompositionDeletionImpact,
    NARRATIVE_NODE_KINDS,
    NarrativeNodeKind,
    PlacementPresentationState,
    ProjectCompositionSnapshot,
    SemanticRelationship,
    VisualPlacement,
    VisualPlacementBatchUpdate,
    VisualPlacementCreate,
    VisualPlacementUpdate,
    allows_composition,
    has_location_containment_cycle,
)
from ..schemas.resources import NodeResponse

ROOT_SCOPE_KEY = "__root__"
SEMANTIC_SCOPE_METADATA_KEY = "semantic_scope"
COMPOSITION_SEMANTIC_SCOPE = "composition"
CANVAS_VISIBILITY_METADATA_KEY = "canvas_visibility"
HIDDEN_CANVAS_VISIBILITY = "hidden"
DEFAULT_PLACEMENT_WIDTH = 260.0
DEFAULT_PLACEMENT_HEIGHT = 156.0


class CompositionServiceError(ValueError):
    """Carries a stable composition validation code to the local API."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class CompositionService:
    """Persists visual placements and their `contains` edges atomically."""

    def list_snapshot(self, uow: UnitOfWork, project_id: str) -> ProjectCompositionSnapshot:
        self._require_project(uow, project_id)
        self._ensure_legacy_root_placements(uow, project_id)
        return self._snapshot(uow, project_id)

    def create_frame(self, uow: UnitOfWork, payload: CompositionFrameCreate) -> CompositionFrameResponse:
        """Create the canonical frame and root placement in one transaction."""

        self._require_project(uow, payload.project_id)
        node_id = new_entity_id()
        placement_id = new_entity_id()
        metadata = {
            **payload.metadata,
            "composition_frame": True,
            "root_placement_id": placement_id,
            # Legacy graph hydration still reads geometry from node metadata.
            "position": payload.position.model_dump(),
            "width": payload.size.width,
            "height": payload.size.height,
        }
        node = NodeEntity(
            id=node_id,
            project_id=payload.project_id,
            type=payload.kind,
            title=payload.title,
            summary=payload.summary,
            body=payload.body,
            status=payload.status,
            metadata=metadata,
        )
        placement = VisualPlacementEntity(
            id=placement_id,
            project_id=payload.project_id,
            canonical_node_id=node_id,
            scope_key=ROOT_SCOPE_KEY,
            x=payload.position.x,
            y=payload.position.y,
            width=payload.size.width,
            height=payload.size.height,
            is_primary=True,
            metadata={"created_with_frame": True},
        )
        try:
            saved_node = add_node_with_automatic_tag(uow, node)
            saved_placement = uow.visual_placements.add(placement)
            uow.commit()
        except Exception:
            # A frame is unusable if either its canonical record or geometry is absent.
            uow.rollback()
            raise
        return CompositionFrameResponse(
            node=NodeResponse(
                id=saved_node.id,
                project_id=saved_node.project_id,
                type=saved_node.type,
                title=saved_node.title,
                summary=saved_node.summary,
                body=saved_node.body,
                status=saved_node.status,
                metadata=saved_node.metadata,
                created_at=saved_node.created_at,
                updated_at=saved_node.updated_at,
            ),
            placement=self._placement_response(saved_placement),
        )

    def deletion_impact(self, uow: UnitOfWork, node_id: str) -> CompositionDeletionImpact:
        node = uow.nodes.get(node_id)
        if node is None:
            raise CompositionServiceError("composition_canonical_not_found", f"Canonical node not found: {node_id}")
        placements = self._project_placements(uow, node.project_id)
        edges = uow.edges.list(project_id=node.project_id)
        removed_edge_ids = {
            edge.id
            for edge in edges
            if edge.source_node_id == node_id or edge.target_node_id == node_id
        }
        return CompositionDeletionImpact(
            node_id=node_id,
            placement_count=sum(item.canonical_node_id == node_id for item in placements),
            contained_instance_count=sum(item.container_node_id == node_id for item in placements),
            edge_count=sum(edge.source_node_id == node_id or edge.target_node_id == node_id for edge in edges),
            agent_memory_ids=sorted({
                memory.id
                for kind in ("scene", "node", "dialogue_field")
                for memory in uow.agent_memories.list_for_owner(
                    project_id=node.project_id,
                    owner_kind=kind,
                    owner_id=node_id,
                )
            }),
            engine_tag_binding_ids=sorted(
                binding.id
                for binding in uow.engine_tag_bindings.list(project_id=node.project_id)
                if owner_removed_with_node(binding.owner, node_id)
                or owner_removed_with_relationships(binding.owner, removed_edge_ids)
            ),
        )

    def delete_entity(self, uow: UnitOfWork, node_id: str) -> None:
        """Delete canonical content while preserving children that would become invisible."""

        node = uow.nodes.get(node_id)
        if node is None:
            raise CompositionServiceError("composition_canonical_not_found", f"Canonical node not found: {node_id}")
        placements = self._project_placements(uow, node.project_id)
        owned = [item for item in placements if item.canonical_node_id == node_id]
        children = [item for item in placements if item.container_node_id == node_id and item.canonical_node_id != node_id]
        impact = self.deletion_impact(uow, node_id)
        container_origin = self._oldest(owned) if owned else None
        try:
            for child in children:
                uow.visual_placements.delete(child.id)
                remaining = [
                    item for item in placements
                    if item.id != child.id and item.canonical_node_id == child.canonical_node_id
                ]
                if not remaining:
                    uow.visual_placements.add(
                        replace(
                            child,
                            id=new_entity_id(),
                            container_node_id=None,
                            scope_key=ROOT_SCOPE_KEY,
                            x=(container_origin.x if container_origin else 0.0) + child.x,
                            y=(container_origin.y if container_origin else 0.0) + child.y,
                            is_primary=True,
                        )
                    )
                elif child.is_primary:
                    uow.visual_placements.update(replace(self._oldest(remaining), is_primary=True))
            for placement in owned:
                uow.visual_placements.delete(placement.id)
            for edge in uow.edges.list(project_id=node.project_id):
                if edge.source_node_id == node_id or edge.target_node_id == node_id:
                    uow.edges.delete(edge.id)
            # The reviewed impact names each deleted scoped instruction; scope is never broadened.
            for memory_id in impact.agent_memory_ids:
                uow.agent_memories.delete(memory_id)
            # Definitions remain stable; only bindings owned by deleted records leave the registry.
            for binding_id in impact.engine_tag_binding_ids:
                uow.engine_tag_bindings.delete(binding_id)
            uow.nodes.delete(node_id)
            uow.commit()
        except Exception:
            # Canonical content, placements, and restored children form one deletion unit.
            uow.rollback()
            raise

    def list_placements(
        self,
        uow: UnitOfWork,
        project_id: str,
        container_node_id: str | None = None,
    ) -> list[VisualPlacement]:
        self._require_project(uow, project_id)
        self._ensure_legacy_root_placements(uow, project_id)
        placements = self._project_placements(uow, project_id)
        if container_node_id is not None:
            self._require_project_node(uow, container_node_id, project_id, "container")
            placements = [item for item in placements if item.container_node_id == container_node_id]
        ordered = sorted(placements, key=lambda item: (item.created_at, item.id))
        return [self._placement_response(item) for item in ordered]

    def create(self, uow: UnitOfWork, payload: VisualPlacementCreate) -> ProjectCompositionSnapshot:
        canonical = self._require_project_node(uow, payload.canonical_node_id, payload.project_id, "canonical")
        container = self._validated_container(uow, payload.project_id, payload.container_node_id, canonical)
        existing = self._project_placements(uow, payload.project_id)
        self._require_available_scope(existing, payload.container_node_id, canonical.id)
        self._validate_location_cycle(uow, payload.project_id, container, canonical, excluded_container_id=None)

        make_primary = payload.is_primary or not any(item.canonical_node_id == canonical.id for item in existing)
        try:
            if make_primary:
                self._demote_placements(uow, existing, canonical.id)
            uow.visual_placements.add(
                VisualPlacementEntity(
                    project_id=payload.project_id,
                    container_node_id=payload.container_node_id,
                    canonical_node_id=canonical.id,
                    scope_key=self._scope_key(payload.container_node_id),
                    x=payload.position.x,
                    y=payload.position.y,
                    width=payload.size.width,
                    height=payload.size.height,
                    is_primary=make_primary,
                    presentation_state=payload.presentation_state,
                    metadata=payload.metadata,
                )
            )
            if container is not None:
                self._ensure_contains_edge(uow, container, canonical)
            uow.commit()
        except Exception:
            # Placement and semantic membership must never survive independently.
            uow.rollback()
            raise
        return self._snapshot(uow, payload.project_id)

    def update(
        self,
        uow: UnitOfWork,
        placement_id: str,
        payload: VisualPlacementUpdate,
    ) -> ProjectCompositionSnapshot:
        placement = self._require_placement(uow, placement_id)
        if placement.project_id != payload.project_id:
            raise CompositionServiceError("composition_cross_project_placement", "Placement belongs to another project")
        canonical = self._require_project_node(uow, placement.canonical_node_id, payload.project_id, "canonical")
        container = self._validated_container(uow, payload.project_id, payload.container_node_id, canonical)
        existing = self._project_placements(uow, payload.project_id)
        self._require_available_scope(
            existing,
            payload.container_node_id,
            canonical.id,
            excluded_placement_id=placement.id,
        )
        self._validate_location_cycle(
            uow,
            payload.project_id,
            container,
            canonical,
            excluded_container_id=placement.container_node_id,
        )

        try:
            is_primary = self._updated_primary_state(uow, placement, existing, payload.is_primary)
            if placement.container_node_id != payload.container_node_id:
                self._delete_contains_edge(uow, placement.container_node_id, canonical.id, payload.project_id)
                if container is not None:
                    self._ensure_contains_edge(uow, container, canonical)
            uow.visual_placements.update(
                replace(
                    placement,
                    container_node_id=payload.container_node_id,
                    scope_key=self._scope_key(payload.container_node_id),
                    x=payload.position.x,
                    y=payload.position.y,
                    width=payload.size.width,
                    height=payload.size.height,
                    is_primary=is_primary,
                    presentation_state=payload.presentation_state,
                    metadata=payload.metadata,
                )
            )
            uow.commit()
        except Exception:
            uow.rollback()
            raise
        return self._snapshot(uow, payload.project_id)

    def update_many(
        self,
        uow: UnitOfWork,
        payload: VisualPlacementBatchUpdate,
    ) -> ProjectCompositionSnapshot:
        """Validate and persist one group movement without exposing partial geometry."""

        self._require_project(uow, payload.project_id)
        existing = self._project_placements(uow, payload.project_id)
        proposed_by_id = {item.id: item for item in existing}
        canonical_by_placement: dict[str, NodeEntity] = {}
        container_by_placement: dict[str, NodeEntity | None] = {}
        for item in payload.placements:
            placement = self._require_placement(uow, item.placement_id)
            if placement.project_id != payload.project_id:
                raise CompositionServiceError("composition_cross_project_placement", "Placement belongs to another project")
            canonical = self._require_project_node(uow, placement.canonical_node_id, payload.project_id, "canonical")
            container = self._validated_container(uow, payload.project_id, item.container_node_id, canonical)
            canonical_by_placement[placement.id] = canonical
            container_by_placement[placement.id] = container
            proposed_by_id[placement.id] = replace(
                placement,
                container_node_id=item.container_node_id,
                scope_key=self._scope_key(item.container_node_id),
                x=item.position.x,
                y=item.position.y,
                width=item.size.width,
                height=item.size.height,
                is_primary=item.is_primary,
                presentation_state=item.presentation_state,
                metadata=item.metadata,
            )

        proposed = list(proposed_by_id.values())
        scopes = [(item.container_node_id, item.canonical_node_id) for item in proposed]
        if len(scopes) != len(set(scopes)):
            raise CompositionServiceError("composition_duplicate_scope", "Canonical node already has a placement in this scope")
        primary_counts: dict[str, int] = {}
        for item in proposed:
            primary_counts[item.canonical_node_id] = primary_counts.get(item.canonical_node_id, 0) + int(item.is_primary)
        if any(count != 1 for count in primary_counts.values()):
            raise CompositionServiceError("composition_primary_invalid", "Every placed canonical node requires exactly one primary placement")

        node_kinds = {
            node.id: cast(NarrativeNodeKind, node.type)
            for node in uow.nodes.list(project_id=payload.project_id)
            if node.type in NARRATIVE_NODE_KINDS
        }
        containment = [
            SemanticRelationship(
                edge_id=f"batch:{item.id}",
                project_id=payload.project_id,
                relationship_type="contains",
                source_node_id=cast(str, item.container_node_id),
                target_node_id=item.canonical_node_id,
                metadata={},
            )
            for item in proposed
            if item.container_node_id is not None
        ]
        if has_location_containment_cycle(node_kinds, containment):
            raise CompositionServiceError("composition_location_cycle", "Location containment cannot create a cycle")

        try:
            for item in payload.placements:
                previous = proposed_by_id[item.placement_id]
                original = next(candidate for candidate in existing if candidate.id == item.placement_id)
                canonical = canonical_by_placement[item.placement_id]
                container = container_by_placement[item.placement_id]
                if original.container_node_id != previous.container_node_id:
                    self._delete_contains_edge(uow, original.container_node_id, canonical.id, payload.project_id)
                    if container is not None:
                        self._ensure_contains_edge(uow, container, canonical)
                uow.visual_placements.update(previous)
            uow.commit()
        except Exception:
            uow.rollback()
            raise
        return self._snapshot(uow, payload.project_id)

    def remove(self, uow: UnitOfWork, placement_id: str) -> ProjectCompositionSnapshot:
        placement = self._require_placement(uow, placement_id)
        existing = self._project_placements(uow, placement.project_id)
        remaining = [
            item
            for item in existing
            if item.id != placement.id and item.canonical_node_id == placement.canonical_node_id
        ]

        try:
            uow.visual_placements.delete(placement.id)
            self._delete_contains_edge(
                uow,
                placement.container_node_id,
                placement.canonical_node_id,
                placement.project_id,
            )
            if placement.container_node_id is not None and not remaining:
                # Removing the last contained instance restores a root projection
                # so removal cannot silently delete the canonical entity from canvas.
                uow.visual_placements.add(
                    replace(
                        placement,
                        id=new_entity_id(),
                        container_node_id=None,
                        scope_key=ROOT_SCOPE_KEY,
                        is_primary=True,
                    )
                )
            elif placement.is_primary and remaining:
                promoted = self._oldest(remaining)
                uow.visual_placements.update(replace(promoted, is_primary=True))
            uow.commit()
        except Exception:
            uow.rollback()
            raise
        return self._snapshot(uow, placement.project_id)

    def _snapshot(self, uow: UnitOfWork, project_id: str) -> ProjectCompositionSnapshot:
        placements = sorted(self._project_placements(uow, project_id), key=lambda item: (item.created_at, item.id))
        relationships = sorted(self._semantic_relationships(uow, project_id), key=lambda item: item.edge_id)
        return ProjectCompositionSnapshot(
            project_id=project_id,
            placements=[self._placement_response(item) for item in placements],
            semantic_relationships=relationships,
        )

    def _ensure_legacy_root_placements(self, uow: UnitOfWork, project_id: str) -> None:
        existing = self._project_placements(uow, project_id)
        placed_node_ids = {placement.canonical_node_id for placement in existing}
        missing_nodes = [node for node in uow.nodes.list(project_id=project_id) if node.id not in placed_node_ids]
        if not missing_nodes:
            return
        try:
            for index, node in enumerate(missing_nodes):
                position = node.metadata.get("position")
                position_data = position if isinstance(position, dict) else {}
                uow.visual_placements.add(
                    VisualPlacementEntity(
                        project_id=project_id,
                        canonical_node_id=node.id,
                        scope_key=ROOT_SCOPE_KEY,
                        x=self._metadata_number(position_data.get("x"), 80.0 + (index % 4) * 300.0),
                        y=self._metadata_number(position_data.get("y"), 80.0 + (index // 4) * 196.0),
                        width=self._metadata_number(node.metadata.get("width"), DEFAULT_PLACEMENT_WIDTH),
                        height=self._metadata_number(node.metadata.get("height"), DEFAULT_PLACEMENT_HEIGHT),
                        is_primary=True,
                        metadata={"migrated_from_node_metadata": True},
                    )
                )
            # Lazy migration is idempotent and commits before returning the new source of truth.
            uow.commit()
        except Exception:
            uow.rollback()
            raise

    def _semantic_relationships(self, uow: UnitOfWork, project_id: str) -> list[SemanticRelationship]:
        return [
            SemanticRelationship(
                edge_id=edge.id,
                project_id=edge.project_id,
                relationship_type="contains",
                source_node_id=edge.source_node_id,
                target_node_id=edge.target_node_id,
                metadata=edge.metadata,
            )
            for edge in uow.edges.list(project_id=project_id)
            if self._is_managed_contains(edge)
        ]

    def _validated_container(
        self,
        uow: UnitOfWork,
        project_id: str,
        container_id: str | None,
        canonical: NodeEntity,
    ) -> NodeEntity | None:
        if container_id is None:
            return None
        container = self._require_project_node(uow, container_id, project_id, "container")
        if not self._allows_nodes(container, canonical):
            raise CompositionServiceError(
                "composition_child_kind_invalid",
                f"{container.type} cannot contain {canonical.type}",
            )
        return container

    def _validate_location_cycle(
        self,
        uow: UnitOfWork,
        project_id: str,
        container: NodeEntity | None,
        canonical: NodeEntity,
        excluded_container_id: str | None,
    ) -> None:
        if container is None or container.type != "Location" or canonical.type != "Location":
            return
        relationships = [
            item
            for item in self._semantic_relationships(uow, project_id)
            if not (item.source_node_id == excluded_container_id and item.target_node_id == canonical.id)
        ]
        relationships.append(
            SemanticRelationship(
                edge_id="candidate",
                project_id=project_id,
                relationship_type="contains",
                source_node_id=container.id,
                target_node_id=canonical.id,
            )
        )
        kinds = {
            node.id: cast(NarrativeNodeKind, node.type)
            for node in uow.nodes.list(project_id=project_id)
            if node.type in NARRATIVE_NODE_KINDS
        }
        if has_location_containment_cycle(kinds, relationships):
            raise CompositionServiceError("composition_cycle", "Location containment cannot create a cycle")

    def _ensure_contains_edge(self, uow: UnitOfWork, container: NodeEntity, canonical: NodeEntity) -> None:
        if any(
            edge.source_node_id == container.id and edge.target_node_id == canonical.id
            for edge in uow.edges.list(project_id=container.project_id)
            if self._is_managed_contains(edge)
        ):
            return
        uow.edges.add(
            EdgeEntity(
                project_id=container.project_id,
                source_node_id=container.id,
                target_node_id=canonical.id,
                type="contains",
                metadata={
                    SEMANTIC_SCOPE_METADATA_KEY: COMPOSITION_SEMANTIC_SCOPE,
                    CANVAS_VISIBILITY_METADATA_KEY: HIDDEN_CANVAS_VISIBILITY,
                },
            )
        )

    def _delete_contains_edge(
        self,
        uow: UnitOfWork,
        container_id: str | None,
        canonical_id: str,
        project_id: str,
    ) -> None:
        if container_id is None:
            return
        for edge in uow.edges.list(project_id=project_id):
            if (
                self._is_managed_contains(edge)
                and edge.source_node_id == container_id
                and edge.target_node_id == canonical_id
            ):
                uow.edges.delete(edge.id)

    def _updated_primary_state(
        self,
        uow: UnitOfWork,
        placement: VisualPlacementEntity,
        existing: list[VisualPlacementEntity],
        requested_primary: bool,
    ) -> bool:
        siblings = [
            item
            for item in existing
            if item.canonical_node_id == placement.canonical_node_id and item.id != placement.id
        ]
        if requested_primary:
            self._demote_placements(uow, siblings, placement.canonical_node_id)
            return True
        if not placement.is_primary:
            return False
        if siblings:
            promoted = self._oldest(siblings)
            uow.visual_placements.update(replace(promoted, is_primary=True))
            return False
        return True

    def _demote_placements(
        self,
        uow: UnitOfWork,
        placements: list[VisualPlacementEntity],
        canonical_id: str,
    ) -> None:
        for placement in placements:
            if placement.canonical_node_id == canonical_id and placement.is_primary:
                uow.visual_placements.update(replace(placement, is_primary=False))

    def _require_available_scope(
        self,
        placements: list[VisualPlacementEntity],
        container_id: str | None,
        canonical_id: str,
        excluded_placement_id: str | None = None,
    ) -> None:
        if any(
            item.id != excluded_placement_id
            and item.container_node_id == container_id
            and item.canonical_node_id == canonical_id
            for item in placements
        ):
            raise CompositionServiceError(
                "composition_duplicate_placement",
                "Canonical node already has a placement in this scope",
            )

    def _require_project(self, uow: UnitOfWork, project_id: str) -> None:
        if uow.projects.get(project_id) is None:
            raise CompositionServiceError("composition_project_not_found", f"Project not found: {project_id}")

    def _require_project_node(self, uow: UnitOfWork, node_id: str, project_id: str, role: str) -> NodeEntity:
        node = uow.nodes.get(node_id)
        if node is None:
            raise CompositionServiceError(f"composition_{role}_not_found", f"{role.title()} node not found: {node_id}")
        if node.project_id != project_id:
            raise CompositionServiceError(
                "composition_cross_project_node",
                f"{role.title()} node belongs to another project: {node_id}",
            )
        return node

    def _require_placement(self, uow: UnitOfWork, placement_id: str) -> VisualPlacementEntity:
        placement = uow.visual_placements.get(placement_id)
        if placement is None:
            raise CompositionServiceError("composition_placement_not_found", f"Placement not found: {placement_id}")
        return placement

    def _project_placements(self, uow: UnitOfWork, project_id: str) -> list[VisualPlacementEntity]:
        return list(uow.visual_placements.list(project_id=project_id))

    @staticmethod
    def _scope_key(container_id: str | None) -> str:
        return container_id or ROOT_SCOPE_KEY

    @staticmethod
    def _metadata_number(value: object, fallback: float) -> float:
        if isinstance(value, (int, float)) and not isinstance(value, bool) and isfinite(value):
            return float(value)
        return fallback

    @staticmethod
    def _allows_nodes(container: NodeEntity, canonical: NodeEntity) -> bool:
        if container.type not in NARRATIVE_NODE_KINDS or canonical.type not in NARRATIVE_NODE_KINDS:
            return False
        return allows_composition(
            cast(NarrativeNodeKind, container.type),
            cast(NarrativeNodeKind, canonical.type),
        )

    @staticmethod
    def _oldest(placements: list[VisualPlacementEntity]) -> VisualPlacementEntity:
        return min(placements, key=lambda item: (item.created_at, item.id))

    @staticmethod
    def _is_managed_contains(edge: EdgeEntity) -> bool:
        return edge.type == "contains" and edge.metadata.get(SEMANTIC_SCOPE_METADATA_KEY) == COMPOSITION_SEMANTIC_SCOPE

    @staticmethod
    def _placement_response(entity: VisualPlacementEntity) -> VisualPlacement:
        return VisualPlacement(
            id=entity.id,
            project_id=entity.project_id,
            container_node_id=entity.container_node_id,
            canonical_node_id=entity.canonical_node_id,
            position={"x": entity.x, "y": entity.y},
            size={"width": entity.width, "height": entity.height},
            is_primary=entity.is_primary,
            presentation_state=cast(PlacementPresentationState, entity.presentation_state),
            metadata=entity.metadata,
        )

from collections.abc import Mapping, Sequence
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .resources import NodeResponse

NarrativeNodeKind = Literal[
    "Character",
    "Quest",
    "Scene",
    "Lore",
    "Location",
    "Dialogue",
    "Faction",
    "Item",
    "Event",
    "Condition",
    "Consequence",
]
SemanticRelationshipType = Literal["contains", "member_of"]
PlacementPresentationState = Literal["expanded", "collapsed"]
CompositionFrameKind = Literal["Scene", "Location"]

SCENE_CHILD_KINDS: frozenset[str] = frozenset(
    {
        "Character",
        "Quest",
        "Lore",
        "Location",
        "Dialogue",
        "Faction",
        "Item",
        "Event",
        "Condition",
        "Consequence",
    }
)
LOCATION_CHILD_KINDS: frozenset[str] = frozenset(
    {
        "Character",
        "Quest",
        "Lore",
        "Location",
        "Faction",
        "Item",
        "Event",
        "Condition",
        "Consequence",
    }
)

NARRATIVE_NODE_KINDS: frozenset[str] = frozenset({"Scene", *SCENE_CHILD_KINDS})


class PlacementPosition(BaseModel):
    """Container-relative coordinates, or root canvas coordinates for root scope."""

    model_config = ConfigDict(extra="forbid")

    x: float = Field(allow_inf_nan=False)
    y: float = Field(allow_inf_nan=False)


class PlacementSize(BaseModel):
    """Stable rendered bounds independent of canonical narrative content."""

    model_config = ConfigDict(extra="forbid")

    width: float = Field(ge=1, le=100_000, allow_inf_nan=False)
    height: float = Field(ge=1, le=100_000, allow_inf_nan=False)


class VisualPlacement(BaseModel):
    """Runtime-owned Phase 3.6 visual instance contract defined by ADR 0006."""

    model_config = ConfigDict(extra="forbid")

    placement_version: Literal[1] = 1
    id: str = Field(min_length=1, max_length=128)
    project_id: str = Field(min_length=1)
    container_node_id: str | None = Field(default=None, min_length=1)
    canonical_node_id: str = Field(min_length=1)
    position: PlacementPosition
    size: PlacementSize
    is_primary: bool = False
    presentation_state: PlacementPresentationState = "expanded"
    metadata: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_distinct_container(self) -> "VisualPlacement":
        if self.container_node_id == self.canonical_node_id:
            raise ValueError("a canonical node cannot be placed inside itself")
        return self


class SemanticRelationship(BaseModel):
    """Hidden graph relationship consumed by composition and traversal services."""

    model_config = ConfigDict(extra="forbid")

    edge_id: str = Field(min_length=1)
    project_id: str = Field(min_length=1)
    relationship_type: SemanticRelationshipType
    source_node_id: str = Field(min_length=1)
    target_node_id: str = Field(min_length=1)
    canvas_visibility: Literal["hidden"] = "hidden"
    metadata: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_distinct_endpoints(self) -> "SemanticRelationship":
        if self.source_node_id == self.target_node_id:
            raise ValueError("semantic relationship endpoints must be distinct")
        return self


class ProjectCompositionSnapshot(BaseModel):
    """Complete project placement projection used to enforce cross-record invariants."""

    model_config = ConfigDict(extra="forbid")

    composition_version: Literal[1] = 1
    project_id: str = Field(min_length=1)
    placements: list[VisualPlacement] = Field(default_factory=list)
    semantic_relationships: list[SemanticRelationship] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_project_invariants(self) -> "ProjectCompositionSnapshot":
        placement_ids: set[str] = set()
        scopes: set[tuple[str | None, str]] = set()
        primary_counts: dict[str, int] = {}
        for placement in self.placements:
            if placement.project_id != self.project_id:
                raise ValueError("placement belongs to another project")
            if placement.id in placement_ids:
                raise ValueError(f"duplicate placement id: {placement.id}")
            placement_ids.add(placement.id)
            scope = (placement.container_node_id, placement.canonical_node_id)
            if scope in scopes:
                raise ValueError("canonical node has duplicate placements in one scope")
            scopes.add(scope)
            primary_counts[placement.canonical_node_id] = primary_counts.get(placement.canonical_node_id, 0) + int(
                placement.is_primary
            )
        if any(count != 1 for count in primary_counts.values()):
            raise ValueError("every placed canonical node requires exactly one primary placement")
        if any(relationship.project_id != self.project_id for relationship in self.semantic_relationships):
            raise ValueError("semantic relationship belongs to another project")
        return self


class VisualPlacementCreate(BaseModel):
    """Creates one root or linked instance through the composition service."""

    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1)
    container_node_id: str | None = Field(default=None, min_length=1)
    canonical_node_id: str = Field(min_length=1)
    position: PlacementPosition
    size: PlacementSize
    is_primary: bool = False
    presentation_state: PlacementPresentationState = "expanded"
    metadata: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_distinct_container(self) -> "VisualPlacementCreate":
        if self.container_node_id == self.canonical_node_id:
            raise ValueError("a canonical node cannot be placed inside itself")
        return self


class VisualPlacementUpdate(BaseModel):
    """Moves or resizes an existing instance without changing its canonical node."""

    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1)
    container_node_id: str | None = Field(default=None, min_length=1)
    position: PlacementPosition
    size: PlacementSize
    is_primary: bool = False
    presentation_state: PlacementPresentationState = "expanded"
    metadata: dict[str, Any] = Field(default_factory=dict)


class VisualPlacementBatchItem(VisualPlacementUpdate):
    """Identifies one placement inside an atomic group geometry update."""

    placement_id: str = Field(min_length=1, max_length=128)


class VisualPlacementBatchUpdate(BaseModel):
    """Moves multiple visual placements as one validated composition transaction."""

    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1)
    placements: list[VisualPlacementBatchItem] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_unique_placements(self) -> "VisualPlacementBatchUpdate":
        placement_ids = [item.placement_id for item in self.placements]
        if len(placement_ids) != len(set(placement_ids)):
            raise ValueError("batch placement ids must be unique")
        if any(item.project_id != self.project_id for item in self.placements):
            raise ValueError("batch placement belongs to another project")
        return self


class CompositionFrameCreate(BaseModel):
    """Creates a canonical Scene or Location and its root placement atomically."""

    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1)
    kind: CompositionFrameKind
    title: str = Field(min_length=1, max_length=255)
    summary: str = ""
    body: str = ""
    status: str = Field(default="canon", min_length=1, max_length=64)
    position: PlacementPosition
    size: PlacementSize
    metadata: dict[str, Any] = Field(default_factory=dict)


class CompositionFrameResponse(BaseModel):
    """Returns both records needed to reconcile an optimistic canvas frame."""

    model_config = ConfigDict(extra="forbid")

    node: NodeResponse
    placement: VisualPlacement


class CompositionDeletionImpact(BaseModel):
    """Previews the records affected by canonical composition-aware deletion."""

    model_config = ConfigDict(extra="forbid")

    node_id: str
    placement_count: int = Field(ge=0)
    contained_instance_count: int = Field(ge=0)
    edge_count: int = Field(ge=0)
    agent_memory_ids: list[str] = Field(default_factory=list)
    engine_tag_binding_ids: list[str] = Field(default_factory=list)


def allows_composition(container_kind: NarrativeNodeKind, child_kind: NarrativeNodeKind) -> bool:
    """Returns the ADR 0006 child-kind decision without persistence concerns."""
    if container_kind == "Scene":
        return child_kind in SCENE_CHILD_KINDS
    if container_kind == "Location":
        return child_kind in LOCATION_CHILD_KINDS
    return False


def has_location_containment_cycle(
    node_kinds: Mapping[str, NarrativeNodeKind],
    relationships: Sequence[SemanticRelationship],
) -> bool:
    """Detects invalid Location loops while allowing arbitrary canonical reuse."""
    adjacency: dict[str, list[str]] = {}
    for relationship in relationships:
        if (
            relationship.relationship_type == "contains"
            and node_kinds.get(relationship.source_node_id) == "Location"
            and node_kinds.get(relationship.target_node_id) == "Location"
        ):
            adjacency.setdefault(relationship.source_node_id, []).append(relationship.target_node_id)

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(node_id: str) -> bool:
        if node_id in visiting:
            return True
        if node_id in visited:
            return False
        visiting.add(node_id)
        if any(visit(child_id) for child_id in adjacency.get(node_id, [])):
            return True
        visiting.remove(node_id)
        visited.add(node_id)
        return False

    return any(visit(node_id) for node_id in adjacency if node_id not in visited)

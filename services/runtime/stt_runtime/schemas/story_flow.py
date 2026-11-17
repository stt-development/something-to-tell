from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

StoryFlowKind = Literal["main", "side", "standalone"]
StoryFlowStatus = Literal["draft", "active", "archived"]
FlowTransitionKind = Literal["next", "branch", "optional", "return"]
FlowIntegrityLevel = Literal["error", "warning", "info"]
FlowIntegrityFactCode = Literal[
    "missing_entry",
    "invalid_entry",
    "unreachable_member",
    "dangling_transition_endpoint",
    "cross_project_reference",
    "duplicate_membership",
    "duplicate_transition_priority",
    "multiple_default_branches",
    "conditioned_default_branch",
    "branch_without_condition",
    "invalid_scene_boundary",
    "cycle",
    "ending",
    "no_ending",
    "dangling_placement",
    "missing_canonical_node",
    "invalid_child_kind",
    "duplicate_placement",
    "containment_cycle",
    "stale_membership",
]


class StoryFlow(BaseModel):
    """Runtime-owned identity and lifecycle contract for one named Story Flow."""

    model_config = ConfigDict(extra="forbid")

    flow_version: Literal[1] = 1
    id: str = Field(min_length=1, max_length=128)
    project_id: str = Field(min_length=1)
    name: str = Field(min_length=1, max_length=255)
    description: str = ""
    kind: StoryFlowKind = "standalone"
    status: StoryFlowStatus = "draft"
    entry_node_id: str | None = Field(default=None, min_length=1)
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class StoryFlowNode(BaseModel):
    """Explicit author intent to include one canonical node in one Story Flow."""

    model_config = ConfigDict(extra="forbid")

    flow_node_version: Literal[1] = 1
    id: str = Field(min_length=1, max_length=128)
    project_id: str = Field(min_length=1)
    flow_id: str = Field(min_length=1)
    node_id: str = Field(min_length=1)
    presentation_order: int = Field(ge=0)
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class FlowTransition(BaseModel):
    """Directed narrative order owned by one flow, never a semantic relationship."""

    model_config = ConfigDict(extra="forbid")

    transition_version: Literal[1] = 1
    id: str = Field(min_length=1, max_length=128)
    project_id: str = Field(min_length=1)
    flow_id: str = Field(min_length=1)
    source_node_id: str = Field(min_length=1)
    target_node_id: str = Field(min_length=1)
    kind: FlowTransitionKind = "next"
    label: str = Field(default="", max_length=255)
    condition: str = ""
    priority: int = Field(ge=0)
    is_default: bool = False
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime

    @model_validator(mode="after")
    def validate_transition_semantics(self) -> "FlowTransition":
        if self.source_node_id == self.target_node_id:
            raise ValueError("flow transition endpoints must be distinct")
        if self.is_default and self.condition.strip():
            raise ValueError("default flow transition cannot have a condition")
        if self.kind == "branch" and not self.is_default and not self.condition.strip():
            raise ValueError("non-default branch transition requires a condition")
        return self


class SceneFlowBoundary(BaseModel):
    """Explicit entry and exits for detailed flow through one Scene container."""

    model_config = ConfigDict(extra="forbid")

    boundary_version: Literal[1] = 1
    id: str = Field(min_length=1, max_length=128)
    project_id: str = Field(min_length=1)
    flow_id: str = Field(min_length=1)
    scene_node_id: str = Field(min_length=1)
    entry_node_id: str = Field(min_length=1)
    exit_node_ids: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime

    @model_validator(mode="after")
    def validate_boundary_ids(self) -> "SceneFlowBoundary":
        if len(set(self.exit_node_ids)) != len(self.exit_node_ids):
            raise ValueError("scene flow exit node ids must be unique")
        if self.scene_node_id == self.entry_node_id or self.scene_node_id in self.exit_node_ids:
            raise ValueError("scene flow boundary children must differ from the Scene node")
        return self


class StoryFlowSnapshot(BaseModel):
    """Complete flow projection used to enforce invariants spanning its records."""

    model_config = ConfigDict(extra="forbid")

    snapshot_version: Literal[1] = 1
    flow: StoryFlow
    nodes: list[StoryFlowNode] = Field(default_factory=list)
    transitions: list[FlowTransition] = Field(default_factory=list)
    scene_boundaries: list[SceneFlowBoundary] = Field(default_factory=list)
    # Composition supplies canonical child ids; this projection does not copy
    # placement geometry or make containment part of Story Flow ownership.
    scene_children: dict[str, list[str]] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_flow_invariants(self) -> "StoryFlowSnapshot":
        project_id = self.flow.project_id
        flow_id = self.flow.id
        membership_ids: set[str] = set()
        member_node_ids: set[str] = set()
        presentation_orders: set[int] = set()
        for membership in self.nodes:
            self._require_owner(membership.project_id, membership.flow_id, project_id, flow_id, "flow membership")
            if membership.id in membership_ids:
                raise ValueError(f"duplicate flow membership id: {membership.id}")
            if membership.node_id in member_node_ids:
                raise ValueError(f"duplicate flow membership for node: {membership.node_id}")
            if membership.presentation_order in presentation_orders:
                raise ValueError(f"duplicate flow presentation order: {membership.presentation_order}")
            membership_ids.add(membership.id)
            member_node_ids.add(membership.node_id)
            presentation_orders.add(membership.presentation_order)

        if not self.nodes:
            if self.flow.entry_node_id is not None:
                raise ValueError("empty flow cannot have an entry node")
            if self.flow.status == "active":
                raise ValueError("active flow requires at least one member")
        elif self.flow.status == "active" and self.flow.entry_node_id is None:
            raise ValueError("active non-empty flow requires an entry node")
        if self.flow.entry_node_id is not None and self.flow.entry_node_id not in member_node_ids:
            raise ValueError("flow entry node must be a member")

        transition_ids: set[str] = set()
        source_priorities: set[tuple[str, int]] = set()
        default_sources: set[str] = set()
        for transition in self.transitions:
            self._require_owner(transition.project_id, transition.flow_id, project_id, flow_id, "flow transition")
            if transition.id in transition_ids:
                raise ValueError(f"duplicate flow transition id: {transition.id}")
            if transition.source_node_id not in member_node_ids or transition.target_node_id not in member_node_ids:
                raise ValueError(f"flow transition endpoints must be members: {transition.id}")
            source_priority = (transition.source_node_id, transition.priority)
            if source_priority in source_priorities:
                raise ValueError(f"duplicate transition priority from source: {transition.source_node_id}")
            if transition.is_default and transition.source_node_id in default_sources:
                raise ValueError(f"multiple default transitions from source: {transition.source_node_id}")
            transition_ids.add(transition.id)
            source_priorities.add(source_priority)
            if transition.is_default:
                default_sources.add(transition.source_node_id)

        boundary_ids: set[str] = set()
        boundary_scenes: set[str] = set()
        for boundary in self.scene_boundaries:
            self._require_owner(boundary.project_id, boundary.flow_id, project_id, flow_id, "scene flow boundary")
            if boundary.id in boundary_ids or boundary.scene_node_id in boundary_scenes:
                raise ValueError(f"duplicate scene flow boundary: {boundary.scene_node_id}")
            referenced_nodes = {boundary.scene_node_id, boundary.entry_node_id, *boundary.exit_node_ids}
            if not referenced_nodes.issubset(member_node_ids):
                raise ValueError(f"scene flow boundary references must be flow members: {boundary.scene_node_id}")
            child_ids = set(self.scene_children.get(boundary.scene_node_id, []))
            if boundary.scene_node_id not in self.scene_children:
                raise ValueError(f"scene child projection missing for boundary: {boundary.scene_node_id}")
            if boundary.entry_node_id not in child_ids or not set(boundary.exit_node_ids).issubset(child_ids):
                raise ValueError(f"scene flow boundary references must be canonical Scene children: {boundary.scene_node_id}")
            boundary_ids.add(boundary.id)
            boundary_scenes.add(boundary.scene_node_id)
        return self

    @staticmethod
    def _require_owner(record_project_id: str, record_flow_id: str, project_id: str, flow_id: str, label: str) -> None:
        if record_project_id != project_id:
            raise ValueError(f"{label} belongs to another project")
        if record_flow_id != flow_id:
            raise ValueError(f"{label} belongs to another flow")


class StoryFlowDeletionImpact(BaseModel):
    """Previews flow-owned records removed without deleting canonical nodes."""

    model_config = ConfigDict(extra="forbid")

    flow_id: str = Field(min_length=1)
    membership_count: int = Field(ge=0)
    transition_count: int = Field(ge=0)
    scene_boundary_count: int = Field(ge=0)
    invocation_ids: list[str] = Field(default_factory=list)
    exit_ids: list[str] = Field(default_factory=list)
    binding_ids: list[str] = Field(default_factory=list)
    agent_memory_ids: list[str] = Field(default_factory=list)
    canonical_nodes_deleted: Literal[False] = False


class StoryFlowNodeDeletionImpact(BaseModel):
    """Previews references affected when one node leaves a Story Flow."""

    model_config = ConfigDict(extra="forbid")

    flow_id: str = Field(min_length=1)
    node_id: str = Field(min_length=1)
    transition_ids: list[str] = Field(default_factory=list)
    scene_boundary_ids: list[str] = Field(default_factory=list)
    invocation_ids: list[str] = Field(default_factory=list)
    exit_ids: list[str] = Field(default_factory=list)
    binding_ids: list[str] = Field(default_factory=list)
    removes_entry: bool = False
    canonical_node_deleted: Literal[False] = False


class FlowIntegrityFact(BaseModel):
    """Read-only authoring fact prepared for later Phase 4 Issue conversion."""

    model_config = ConfigDict(extra="forbid")

    code: FlowIntegrityFactCode
    level: FlowIntegrityLevel
    message: str = Field(min_length=1)
    action: str = Field(min_length=1)
    flow_id: str | None = Field(default=None, min_length=1)
    node_id: str | None = Field(default=None, min_length=1)
    transition_id: str | None = Field(default=None, min_length=1)
    scene_node_id: str | None = Field(default=None, min_length=1)
    container_node_id: str | None = Field(default=None, min_length=1)
    placement_id: str | None = Field(default=None, min_length=1)
    relationship_id: str | None = Field(default=None, min_length=1)


class StoryFlowIntegrityReport(BaseModel):
    """Deterministic flow and composition facts without persisted Issue entities."""

    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1)
    flow_id: str | None = Field(default=None, min_length=1)
    facts: list[FlowIntegrityFact] = Field(default_factory=list)

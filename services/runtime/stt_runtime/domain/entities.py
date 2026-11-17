from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4


def new_entity_id() -> str:
    return str(uuid4())


def utc_now() -> datetime:
    return datetime.now(UTC)


@dataclass(slots=True)
class ProjectEntity:
    name: str
    path: str
    format_version: int
    id: str = field(default_factory=new_entity_id)
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: datetime = field(default_factory=utc_now)
    updated_at: datetime = field(default_factory=utc_now)


@dataclass(slots=True)
class NodeEntity:
    project_id: str
    type: str
    title: str
    id: str = field(default_factory=new_entity_id)
    summary: str = ""
    body: str = ""
    status: str = "canon"
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: datetime = field(default_factory=utc_now)
    updated_at: datetime = field(default_factory=utc_now)


@dataclass(slots=True)
class EdgeEntity:
    project_id: str
    source_node_id: str
    target_node_id: str
    type: str
    id: str = field(default_factory=new_entity_id)
    label: str = ""
    condition: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: datetime = field(default_factory=utc_now)
    updated_at: datetime = field(default_factory=utc_now)


@dataclass(slots=True)
class IssueEntity:
    project_id: str
    title: str
    id: str = field(default_factory=new_entity_id)
    node_id: str | None = None
    edge_id: str | None = None
    description: str = ""
    severity: str = "info"
    status: str = "open"
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: datetime = field(default_factory=utc_now)
    updated_at: datetime = field(default_factory=utc_now)


@dataclass(slots=True)
class SuggestionEntity:
    project_id: str
    title: str
    id: str = field(default_factory=new_entity_id)
    description: str = ""
    status: str = "pending"
    patch: dict[str, Any] = field(default_factory=dict)
    created_by: str = "local-user"
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: datetime = field(default_factory=utc_now)
    updated_at: datetime = field(default_factory=utc_now)


@dataclass(slots=True)
class ImpactResolutionDecisionEntity:
    """Persistence-neutral, prose-free memory of one reviewed resolution."""

    project_id: str
    finding_fingerprints: list[str]
    proposal_semantic_fingerprint: str
    source_checksum: str
    decision: str
    decided_at: datetime
    id: str = field(default_factory=new_entity_id)
    decision_version: int = 1
    created_at: datetime = field(default_factory=utc_now)
    updated_at: datetime = field(default_factory=utc_now)


@dataclass(slots=True)
class EngineTagEntity:
    project_id: str
    target_type: str
    target_id: str
    engine: str
    key: str
    id: str = field(default_factory=new_entity_id)
    value: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: datetime = field(default_factory=utc_now)
    updated_at: datetime = field(default_factory=utc_now)


@dataclass(slots=True)
class EngineTagDefinitionEntity:
    """Durable canonical identity shared by all target projections."""

    project_id: str
    key: str
    normalized_key: str
    description: str
    status: str
    aliases: list[dict[str, Any]] = field(default_factory=list)
    id: str = field(default_factory=new_entity_id)
    tag_version: int = 1
    created_at: datetime = field(default_factory=utc_now)
    updated_at: datetime = field(default_factory=utc_now)


@dataclass(slots=True)
class EngineTagBindingEntity:
    """Durable typed-owner binding; owner_key makes uniqueness dialect-neutral."""

    project_id: str
    definition_id: str
    owner: dict[str, Any]
    owner_key: str
    value: str = ""
    id: str = field(default_factory=new_entity_id)
    tag_version: int = 1
    created_at: datetime = field(default_factory=utc_now)
    updated_at: datetime = field(default_factory=utc_now)


@dataclass(slots=True)
class LegacyEngineTagEntity:
    """Immutable copy of a v5 generic engine tag kept for reviewed conversion."""

    project_id: str
    target_type: str
    target_id: str
    engine: str
    key: str
    value: str
    metadata: dict[str, Any]
    id: str
    created_at: datetime
    updated_at: datetime


@dataclass(slots=True)
class VisualPlacementEntity:
    """Persistence-neutral visual instance owned by the Phase 3.6 composition boundary."""

    project_id: str
    canonical_node_id: str
    scope_key: str
    x: float
    y: float
    width: float
    height: float
    id: str = field(default_factory=new_entity_id)
    container_node_id: str | None = None
    is_primary: bool = False
    presentation_state: str = "expanded"
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: datetime = field(default_factory=utc_now)
    updated_at: datetime = field(default_factory=utc_now)


@dataclass(slots=True)
class StoryFlowEntity:
    """Persistence-neutral Story Flow aggregate root."""

    project_id: str
    name: str
    normalized_name: str
    id: str = field(default_factory=new_entity_id)
    description: str = ""
    kind: str = "standalone"
    status: str = "draft"
    entry_node_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: datetime = field(default_factory=utc_now)
    updated_at: datetime = field(default_factory=utc_now)


@dataclass(slots=True)
class StoryFlowNodeEntity:
    """Persistence-neutral membership between a canonical node and one flow."""

    project_id: str
    flow_id: str
    node_id: str
    presentation_order: int
    id: str = field(default_factory=new_entity_id)
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: datetime = field(default_factory=utc_now)
    updated_at: datetime = field(default_factory=utc_now)


@dataclass(slots=True)
class FlowTransitionEntity:
    """Persistence-neutral directed ordering record owned by Story Flow."""

    project_id: str
    flow_id: str
    source_node_id: str
    target_node_id: str
    priority: int
    id: str = field(default_factory=new_entity_id)
    kind: str = "next"
    label: str = ""
    condition: str = ""
    is_default: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: datetime = field(default_factory=utc_now)
    updated_at: datetime = field(default_factory=utc_now)


@dataclass(slots=True)
class SceneFlowBoundaryEntity:
    """Persistence-neutral detailed entry and exits for one Scene in one flow."""

    project_id: str
    flow_id: str
    scene_node_id: str
    entry_node_id: str
    id: str = field(default_factory=new_entity_id)
    exit_node_ids: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: datetime = field(default_factory=utc_now)
    updated_at: datetime = field(default_factory=utc_now)


@dataclass(slots=True)
class FlowInvocationEntity:
    """Persistence-neutral call route from one Story Flow into another."""

    project_id: str
    source_flow_id: str
    source_node_id: str
    target_flow_id: str
    priority: int
    id: str = field(default_factory=new_entity_id)
    label: str = ""
    condition: str = ""
    is_default: bool = False
    created_at: datetime = field(default_factory=utc_now)
    updated_at: datetime = field(default_factory=utc_now)


@dataclass(slots=True)
class FlowExitEntity:
    """Persistence-neutral named terminal route owned by one Story Flow."""

    project_id: str
    flow_id: str
    key: str
    source_node_id: str
    id: str = field(default_factory=new_entity_id)
    label: str = ""
    created_at: datetime = field(default_factory=utc_now)
    updated_at: datetime = field(default_factory=utc_now)


@dataclass(slots=True)
class FlowExitBindingEntity:
    """Persistence-neutral return mapping owned by one invocation and exit."""

    project_id: str
    invocation_id: str
    exit_id: str
    target_node_id: str
    id: str = field(default_factory=new_entity_id)
    created_at: datetime = field(default_factory=utc_now)
    updated_at: datetime = field(default_factory=utc_now)


@dataclass(slots=True)
class FlowInitialStateEntity:
    """Persistence-neutral authored root state for one Story Flow."""

    project_id: str
    flow_id: str
    id: str = field(default_factory=new_entity_id)
    state_version: int = 1
    flags: dict[str, bool] = field(default_factory=dict)
    item_custody: list[dict[str, Any]] = field(default_factory=list)
    quest_statuses: dict[str, str] = field(default_factory=dict)
    created_at: datetime = field(default_factory=utc_now)
    updated_at: datetime = field(default_factory=utc_now)


@dataclass(slots=True)
class NarrativeEffectEntity:
    """Persistence-neutral reusable Phase 3.11 effect definition."""

    project_id: str
    operation: str
    payload: dict[str, Any]
    explanation: str
    id: str = field(default_factory=new_entity_id)
    effect_version: int = 1
    repeat_policy: str = "once"
    created_at: datetime = field(default_factory=utc_now)
    updated_at: datetime = field(default_factory=utc_now)


@dataclass(slots=True)
class NarrativeEffectBindingEntity:
    """Persistence-neutral ordered association to one stable temporal owner."""

    project_id: str
    effect_id: str
    owner_kind: str
    owner_id: str
    application_order: int
    id: str = field(default_factory=new_entity_id)
    binding_version: int = 1
    context_node_id: str | None = None
    created_at: datetime = field(default_factory=utc_now)
    updated_at: datetime = field(default_factory=utc_now)


@dataclass(slots=True)
class StyleProfileEntity:
    """Persistence-neutral project-owned narrative style profile."""

    project_id: str
    name: str
    guidance: str
    id: str = field(default_factory=new_entity_id)
    style_profile_version: int = 1
    description: str = ""
    traits: dict[str, Any] = field(default_factory=dict)
    positive_examples: list[str] = field(default_factory=list)
    created_at: datetime = field(default_factory=utc_now)
    updated_at: datetime = field(default_factory=utc_now)


@dataclass(slots=True)
class SceneStyleAssignmentEntity:
    """Persistence-neutral explicit style override for one Scene."""

    project_id: str
    scene_node_id: str
    style_profile_id: str
    id: str = field(default_factory=new_entity_id)
    assignment_version: int = 1
    created_at: datetime = field(default_factory=utc_now)
    updated_at: datetime = field(default_factory=utc_now)


@dataclass(slots=True)
class AgentMemoryEntity:
    """Persistence-neutral reviewed guidance owned by one project and agent."""

    project_id: str
    agent_id: str
    namespace: str
    scope: dict[str, Any]
    content_locale: str
    title: str
    instruction: str
    id: str = field(default_factory=new_entity_id)
    memory_version: int = 1
    rationale: str | None = None
    status: str = "active"
    supersedes_id: str | None = None
    created_at: datetime = field(default_factory=utc_now)
    updated_at: datetime = field(default_factory=utc_now)

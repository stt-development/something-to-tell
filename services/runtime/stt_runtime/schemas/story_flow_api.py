from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .composition import NarrativeNodeKind, PlacementPosition, PlacementSize, VisualPlacement
from .resources import NodeResponse
from .story_flow import (
    FlowTransition,
    FlowTransitionKind,
    StoryFlowKind,
    StoryFlowNode,
    StoryFlowSnapshot,
    StoryFlowStatus,
)


class StoryFlowCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1)
    name: str = Field(min_length=1, max_length=255)
    description: str = ""
    kind: StoryFlowKind = "standalone"
    status: StoryFlowStatus = "draft"
    metadata: dict[str, Any] = Field(default_factory=dict)


class StoryFlowUpdate(StoryFlowCreate):
    pass


class StoryFlowProjectCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1)


class StoryFlowMembershipCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1)
    node_id: str = Field(min_length=1)
    presentation_order: int | None = Field(default=None, ge=0)
    metadata: dict[str, Any] = Field(default_factory=dict)


class StoryFlowEntryUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1)
    node_id: str = Field(min_length=1)


class FlowTransitionFields(BaseModel):
    """Client-authored transition details validated with aggregate siblings."""

    model_config = ConfigDict(extra="forbid")

    kind: FlowTransitionKind = "next"
    label: str = Field(default="", max_length=255)
    condition: str = ""
    priority: int = Field(ge=0)
    is_default: bool = False
    metadata: dict[str, Any] = Field(default_factory=dict)


class FlowTransitionCreate(FlowTransitionFields):
    project_id: str = Field(min_length=1)
    source_node_id: str = Field(min_length=1)
    target_node_id: str = Field(min_length=1)


class FlowTransitionUpdate(FlowTransitionCreate):
    pass


class FlowTransitionOrderUpdate(BaseModel):
    """Atomically assigns sibling priorities in the supplied author order."""

    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1)
    source_node_id: str = Field(min_length=1)
    transition_ids: list[str] = Field(min_length=1)


class SceneFlowBoundaryUpsert(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1)
    entry_node_id: str = Field(min_length=1)
    exit_node_ids: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class StoryFlowNodeDraft(BaseModel):
    """Canonical node fields accepted by atomic create-new continuation."""

    model_config = ConfigDict(extra="forbid")

    type: NarrativeNodeKind
    title: str = Field(min_length=1, max_length=255)
    summary: str = ""
    body: str = ""
    status: str = Field(default="canon", min_length=1, max_length=64)
    metadata: dict[str, Any] = Field(default_factory=dict)


class ContinueExistingNode(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1)
    source_node_id: str = Field(min_length=1)
    target_node_id: str = Field(min_length=1)
    presentation_order: int | None = Field(default=None, ge=0)
    membership_metadata: dict[str, Any] = Field(default_factory=dict)
    transition: FlowTransitionFields


class ContinueNewNode(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1)
    source_node_id: str = Field(min_length=1)
    presentation_order: int | None = Field(default=None, ge=0)
    membership_metadata: dict[str, Any] = Field(default_factory=dict)
    node: StoryFlowNodeDraft
    transition: FlowTransitionFields


class StoryFlowContinuationResponse(BaseModel):
    """Returns every record created or reused by an atomic continuation."""

    model_config = ConfigDict(extra="forbid")

    node: NodeResponse
    membership: StoryFlowNode
    transition: FlowTransition
    snapshot: StoryFlowSnapshot


class StoryFlowBootstrapCreate(BaseModel):
    """Atomic empty-project command spanning canonical, composition, and flow ownership."""

    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1)
    flow_name: str = Field(default="Main Story", min_length=1, max_length=255)
    flow_description: str = ""
    node: StoryFlowNodeDraft
    position: PlacementPosition
    size: PlacementSize

    @model_validator(mode="after")
    def validate_starting_node(self) -> "StoryFlowBootstrapCreate":
        if self.node.type not in {"Scene", "Event"}:
            raise ValueError("Story Flow bootstrap node must be Scene or Event")
        return self


class StoryFlowBootstrapResponse(BaseModel):
    """Returns every record the client needs to reconcile the atomic starter."""

    model_config = ConfigDict(extra="forbid")

    node: NodeResponse
    placement: VisualPlacement
    membership: StoryFlowNode
    snapshot: StoryFlowSnapshot

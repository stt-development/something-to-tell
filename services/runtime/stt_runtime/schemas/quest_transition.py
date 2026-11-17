from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .dialogue_transition import NarrativeNodeKind, NarrativeRelationshipType, OutcomeFlowCompositionReference
from .quest import QuestDocument
from .resources import EdgeResponse, NodeResponse


class QuestTransitionTargetCreate(BaseModel):
    """New canonical target authored atomically with a Quest outcome edge."""

    model_config = ConfigDict(extra="forbid")

    type: NarrativeNodeKind = "Event"
    title: str = Field(min_length=1, max_length=255)
    summary: str = ""
    body: str = ""
    status: str = Field(default="canon", min_length=1, max_length=64)
    metadata: dict[str, Any] = Field(default_factory=dict)


class QuestTransitionCreate(BaseModel):
    """Creates one stage-branch-owned edge to an existing or new target."""

    model_config = ConfigDict(extra="forbid")

    quest_node_id: str = Field(min_length=1)
    quest_stage_id: str = Field(min_length=1, max_length=128)
    quest_branch_id: str = Field(min_length=1, max_length=128)
    target_node_id: str | None = Field(default=None, min_length=1)
    new_target: QuestTransitionTargetCreate | None = None
    relationship_type: NarrativeRelationshipType = "leads_to"
    label: str = Field(default="", max_length=255)
    condition: str = ""
    quest_document: QuestDocument | None = None

    @model_validator(mode="after")
    def validate_target_mode(self) -> "QuestTransitionCreate":
        if (self.target_node_id is None) == (self.new_target is None):
            raise ValueError("exactly one existing or new transition target is required")
        return self


class QuestTransitionUpdate(BaseModel):
    """Updates the branch origin and normal graph-edge semantics."""

    model_config = ConfigDict(extra="forbid")

    quest_stage_id: str = Field(min_length=1, max_length=128)
    quest_branch_id: str = Field(min_length=1, max_length=128)
    target_node_id: str = Field(min_length=1)
    relationship_type: NarrativeRelationshipType = "leads_to"
    label: str = Field(default="", max_length=255)
    condition: str = ""
    outcome_flow_composition: OutcomeFlowCompositionReference | None = None


class QuestTransitionResponse(BaseModel):
    """Returns both resources so optimistic clients can replace local ids."""

    model_config = ConfigDict(extra="forbid")

    edge: EdgeResponse
    target_node: NodeResponse

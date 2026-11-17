from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .dialogue import DialogueDocument
from .resources import EdgeResponse, NodeResponse

NarrativeNodeKind = Literal[
    "Character", "Quest", "Scene", "Lore", "Location", "Dialogue",
    "Faction", "Item", "Event", "Condition", "Consequence",
]
NarrativeRelationshipType = Literal[
    "appears_in", "located_in", "belongs_to", "owns", "allied_with",
    "opposes", "requires", "unlocks", "causes", "reveals", "mentions",
    "contradicts", "depends_on", "changes", "leads_to",
]


class OutcomeFlowCompositionReference(BaseModel):
    """Semantic-outcome pointer to one runtime-owned flow invocation."""

    model_config = ConfigDict(extra="forbid")

    invocation_id: str = Field(min_length=1)
    source_flow_id: str = Field(min_length=1)
    target_flow_id: str = Field(min_length=1)


class DialogueTransitionTargetCreate(BaseModel):
    """New narrative target authored atomically with its transition edge."""

    model_config = ConfigDict(extra="forbid")

    type: NarrativeNodeKind = "Event"
    title: str = Field(min_length=1, max_length=255)
    summary: str = ""
    body: str = ""
    status: str = Field(default="canon", min_length=1, max_length=64)
    metadata: dict[str, Any] = Field(default_factory=dict)


class DialogueTransitionCreate(BaseModel):
    """Creates one line/answer-owned edge to an existing or new target."""

    model_config = ConfigDict(extra="forbid")

    dialogue_node_id: str = Field(min_length=1)
    dialogue_element_id: str = Field(min_length=1, max_length=128)
    target_node_id: str | None = Field(default=None, min_length=1)
    new_target: DialogueTransitionTargetCreate | None = None
    relationship_type: NarrativeRelationshipType = "leads_to"
    label: str = Field(default="", max_length=255)
    condition: str = ""
    dialogue_document: DialogueDocument | None = None

    @model_validator(mode="after")
    def validate_target_mode(self) -> "DialogueTransitionCreate":
        if (self.target_node_id is None) == (self.new_target is None):
            raise ValueError("exactly one existing or new transition target is required")
        return self


class DialogueTransitionUpdate(BaseModel):
    """Updates the authored origin and normal edge semantics."""

    model_config = ConfigDict(extra="forbid")

    dialogue_element_id: str = Field(min_length=1, max_length=128)
    target_node_id: str = Field(min_length=1)
    relationship_type: NarrativeRelationshipType = "leads_to"
    label: str = Field(default="", max_length=255)
    condition: str = ""
    outcome_flow_composition: OutcomeFlowCompositionReference | None = None


class DialogueTransitionResponse(BaseModel):
    """Returns both resources so optimistic clients can replace local ids."""

    model_config = ConfigDict(extra="forbid")

    edge: EdgeResponse
    target_node: NodeResponse

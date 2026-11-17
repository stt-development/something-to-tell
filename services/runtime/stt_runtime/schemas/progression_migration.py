from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .story_flow import FlowTransition, StoryFlowSnapshot


class ProgressionCandidate(BaseModel):
    """Deterministic review candidate derived only from semantic graph data."""

    model_config = ConfigDict(extra="forbid")

    candidate_version: Literal[1] = 1
    fingerprint: str
    project_id: str
    edge_id: str
    source_node_id: str
    target_node_id: str
    origin_kind: Literal["relationship", "dialogue", "quest"]
    label: str
    condition: str
    evidence: list[str]
    origin_metadata: dict[str, str] = Field(default_factory=dict)


class ProgressionDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decision_version: Literal[1] = 1
    id: str
    project_id: str
    fingerprint: str
    edge_id: str
    status: Literal["accepted", "rejected"]
    flow_id: str | None = None
    transition_id: str | None = None
    original_relationship: Literal["preserved", "removed", "unchanged"]
    candidate: ProgressionCandidate


class ProgressionMigrationReview(BaseModel):
    model_config = ConfigDict(extra="forbid")

    review_version: Literal[1] = 1
    pending: list[ProgressionCandidate]
    decisions: list[ProgressionDecision]


class ProgressionMigrationReject(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1)


class ProgressionMigrationAccept(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1)
    flow_id: str = Field(min_length=1)
    preserve_relationship: bool = True
    kind: Literal["next", "branch", "optional", "return"] = "next"
    label: str = Field(default="", max_length=255)
    condition: str = ""
    is_default: bool = False


class ProgressionMigrationAcceptResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decision: ProgressionDecision
    transition: FlowTransition
    snapshot: StoryFlowSnapshot

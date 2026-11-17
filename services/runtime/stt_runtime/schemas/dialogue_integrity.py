from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


DialogueIntegrityFactCode = Literal[
    "missing_participant",
    "broken_reference",
    "unreachable_element",
    "dead_end",
    "stale_external_transition_origin",
]


class DialogueIntegrityFact(BaseModel):
    """Read-only diagnostic fact prepared for later Phase 4 issue conversion."""

    model_config = ConfigDict(extra="forbid")

    code: DialogueIntegrityFactCode
    message: str = Field(min_length=1)
    action: str = Field(min_length=1)
    element_id: str | None = None
    reference_id: str | None = None
    edge_id: str | None = None


class DialogueTopologyCycle(BaseModel):
    """A valid authored loop, kept separate from integrity failures."""

    model_config = ConfigDict(extra="forbid")

    element_ids: list[str] = Field(min_length=1)
    message: str = Field(min_length=1)


class DialogueIntegrityReport(BaseModel):
    """Deterministic dialogue facts without persisted canon Issue entities."""

    model_config = ConfigDict(extra="forbid")

    dialogue_node_id: str = Field(min_length=1)
    facts: list[DialogueIntegrityFact] = Field(default_factory=list)
    cycles: list[DialogueTopologyCycle] = Field(default_factory=list)


from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .narrative_state import (
    ItemCustody,
    NarrativeEffectDefinition,
    NarrativeEffectOwnerRef,
    QuestStateStatus,
)


class RevisionedNarrativeStateCommand(BaseModel):
    """Tie every state mutation to the project revision observed by the caller."""

    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1)
    expected_revision: int = Field(default=0, ge=0)


class FlowInitialStateWrite(RevisionedNarrativeStateCommand):
    """Replace the complete authored initial state of one root Story Flow."""

    flow_id: str = Field(min_length=1)
    flags: dict[str, bool] = Field(default_factory=dict)
    item_custody: list[ItemCustody] = Field(default_factory=list)
    quest_statuses: dict[str, QuestStateStatus] = Field(default_factory=dict)


class FlowInitialStateResponse(BaseModel):
    """Persisted initial-state record returned to authoring clients."""

    model_config = ConfigDict(extra="forbid")

    id: str
    project_id: str
    flow_id: str
    state_version: Literal[1] = 1
    flags: dict[str, bool]
    item_custody: list[ItemCustody]
    quest_statuses: dict[str, QuestStateStatus]
    created_at: datetime
    updated_at: datetime


class NarrativeEffectWrite(RevisionedNarrativeStateCommand):
    """Create or replace one reusable, typed narrative effect definition."""

    effect: NarrativeEffectDefinition


class NarrativeEffectBindingWrite(RevisionedNarrativeStateCommand):
    """Create or replace one effect attachment at an existing temporal owner."""

    effect_id: str = Field(min_length=1)
    owner: NarrativeEffectOwnerRef
    application_order: int = Field(ge=0)


class NarrativeEffectBindingResponse(BaseModel):
    """Persisted ordered binding projection used by all effect editors."""

    model_config = ConfigDict(extra="forbid")

    id: str
    project_id: str
    effect_id: str
    owner: NarrativeEffectOwnerRef
    application_order: int
    created_at: datetime
    updated_at: datetime


class NarrativeEffectOrderItem(BaseModel):
    """One immutable input row in an atomic owner-scoped reorder command."""

    model_config = ConfigDict(extra="forbid")

    binding_id: str = Field(min_length=1)
    application_order: int = Field(ge=0)


class NarrativeEffectBindingBatch(RevisionedNarrativeStateCommand):
    """Declare the complete binding order for exactly one temporal owner."""

    owner: NarrativeEffectOwnerRef
    bindings: list[NarrativeEffectOrderItem] = Field(min_length=1)


class NarrativeStateDeleteCommand(RevisionedNarrativeStateCommand):
    """Confirm that the author reviewed the latest deletion impact."""

    impact_reviewed: bool = False


class NarrativeStateOwnerImpactRequest(BaseModel):
    """Identify one temporal owner whose deletion impact must be reviewed."""

    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1)
    owner: NarrativeEffectOwnerRef


class NarrativeStateDeletionImpact(BaseModel):
    """References affected by deleting a state definition or canonical owner."""

    model_config = ConfigDict(extra="forbid")

    subject_kind: Literal["initial_state", "effect", "owner", "node"]
    subject_id: str
    initial_state_ids: list[str] = Field(default_factory=list)
    effect_ids: list[str] = Field(default_factory=list)
    binding_ids: list[str] = Field(default_factory=list)


class NarrativeStateIntegrityFact(BaseModel):
    """Stable localization-ready authoring fact with canonical record references."""

    model_config = ConfigDict(extra="forbid")

    code: Literal[
        "narrative_state_unbound_effect",
        "narrative_state_transfer_item_uninitialized",
    ]
    level: Literal["info", "warning"]
    effect_id: str | None = None
    node_id: str | None = None
    parameters: dict[str, str | int] = Field(default_factory=dict)


class NarrativeStateIntegrityReport(BaseModel):
    """Deterministic project-wide integrity projection for state authoring."""

    model_config = ConfigDict(extra="forbid")

    project_id: str
    facts: list[NarrativeStateIntegrityFact] = Field(default_factory=list)


class NarrativeStateSnapshot(BaseModel):
    """Project-scoped state records loaded by the authoring workspace."""

    model_config = ConfigDict(extra="forbid")

    project_id: str
    initial_states: list[FlowInitialStateResponse] = Field(default_factory=list)
    effects: list[NarrativeEffectDefinition] = Field(default_factory=list)
    bindings: list[NarrativeEffectBindingResponse] = Field(default_factory=list)
    integrity: NarrativeStateIntegrityReport


class RelationshipInitialStatePreviewRequest(BaseModel):
    """Select the semantic ownership edge and root Flow without mutating either."""

    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1)
    edge_id: str = Field(min_length=1)
    flow_id: str = Field(min_length=1)


class RelationshipInitialStateApply(RevisionedNarrativeStateCommand):
    """Apply a separately reviewed ownership preview to one root initial state."""

    edge_id: str = Field(min_length=1)
    flow_id: str = Field(min_length=1)
    impact_reviewed: bool = False


class RelationshipInitialStatePreview(BaseModel):
    """Explicit proposal derived from, but never coupled to, a semantic edge."""

    model_config = ConfigDict(extra="forbid")

    project_id: str
    edge_id: str
    flow_id: str
    custody: ItemCustody
    already_applied: bool
    conflict_holder: dict[str, object] | None = None


class RelationshipInitialStateApplyResponse(BaseModel):
    """Idempotent conversion result and the resulting complete initial state."""

    model_config = ConfigDict(extra="forbid")

    changed: bool
    initial_state: FlowInitialStateResponse

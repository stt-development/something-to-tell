from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .composable_story_flow import ComposableFlowGraph, FlowExit, FlowExitBinding, FlowInvocation
from .resources import EdgeResponse
from .story_flow import StoryFlowSnapshot


class RevisionedCompositionCommand(BaseModel):
    """Phase 3.10 command envelope tied to the caller-observed saved revision."""

    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1)
    expected_revision: int = Field(default=0, ge=0)


class FlowInvocationFields(BaseModel):
    """Editable invocation route fields shared by create and update commands."""

    model_config = ConfigDict(extra="forbid")

    source_flow_id: str = Field(min_length=1)
    source_node_id: str = Field(min_length=1)
    target_flow_id: str = Field(min_length=1)
    label: str = Field(default="", max_length=255)
    condition: str = ""
    priority: int = Field(ge=0)
    is_default: bool = False


class FlowInvocationCreate(RevisionedCompositionCommand, FlowInvocationFields):
    pass


class FlowInvocationUpdate(RevisionedCompositionCommand, FlowInvocationFields):
    pass


class FlowExitFields(BaseModel):
    """Editable named-exit fields shared by create and update commands."""

    model_config = ConfigDict(extra="forbid")

    flow_id: str = Field(min_length=1)
    key: str = Field(min_length=1, max_length=128, pattern=r"^[a-z][a-z0-9_-]*$")
    label: str = Field(default="", max_length=255)
    source_node_id: str = Field(min_length=1)


class FlowExitCreate(RevisionedCompositionCommand, FlowExitFields):
    pass


class FlowExitUpdate(RevisionedCompositionCommand, FlowExitFields):
    pass


class FlowExitBindingFields(BaseModel):
    """Editable immediate-caller return fields for one call-site exit."""

    model_config = ConfigDict(extra="forbid")

    invocation_id: str = Field(min_length=1)
    exit_id: str = Field(min_length=1)
    target_node_id: str = Field(min_length=1)


class FlowExitBindingCreate(RevisionedCompositionCommand, FlowExitBindingFields):
    pass


class FlowExitBindingUpdate(RevisionedCompositionCommand, FlowExitBindingFields):
    pass


class CompositionDeleteCommand(RevisionedCompositionCommand):
    """Explicitly confirms that the caller reviewed the current impact response."""

    impact_reviewed: bool = False


class OutcomeSideFlowCreate(RevisionedCompositionCommand):
    """Atomically replace one specialized outcome route with a new side flow."""

    edge_id: str = Field(min_length=1)
    source_flow_id: str = Field(min_length=1)
    name: str = Field(min_length=1, max_length=255)
    description: str = ""
    label: str = Field(default="", max_length=255)
    condition: str = ""
    priority: int = Field(ge=0)
    is_default: bool = False


class OutcomeSideFlowResponse(BaseModel):
    """Persisted projections returned after the atomic outcome replacement."""

    model_config = ConfigDict(extra="forbid")

    edge: EdgeResponse
    invocation: FlowInvocation
    source_flow: StoryFlowSnapshot
    target_flow: StoryFlowSnapshot


class CompositionDeletionImpact(BaseModel):
    """Stable references removed with one invocation, exit, flow, or member."""

    model_config = ConfigDict(extra="forbid")

    subject_kind: Literal["invocation", "exit", "flow", "node"]
    subject_id: str = Field(min_length=1)
    invocation_ids: list[str] = Field(default_factory=list)
    exit_ids: list[str] = Field(default_factory=list)
    binding_ids: list[str] = Field(default_factory=list)

    @property
    def has_impacts(self) -> bool:
        if self.subject_kind in {"invocation", "exit"}:
            return bool(self.binding_ids)
        return bool(self.invocation_ids or self.exit_ids or self.binding_ids)


ComposableIntegrityCode = Literal[
    "composable_flow_missing_entry",
    "composable_flow_unbound_exit",
    "composable_flow_unreachable_exit",
    "composable_flow_ambiguous_routes",
    "composable_flow_call_cycle",
    "composable_flow_deleted_reference",
    "composable_flow_called_without_reachable_exit",
]


class ComposableIntegrityFact(BaseModel):
    """Localization-ready fact emitted from permissive persisted drafts."""

    model_config = ConfigDict(extra="forbid")

    code: ComposableIntegrityCode
    level: Literal["error", "warning"]
    flow_id: str | None = None
    node_id: str | None = None
    invocation_id: str | None = None
    exit_id: str | None = None
    binding_id: str | None = None
    parameters: dict[str, str | int] = Field(default_factory=dict)


class ComposableIntegrityReport(BaseModel):
    """Deterministic execution readiness for one reachable call graph."""

    model_config = ConfigDict(extra="forbid")

    project_id: str
    root_flow_id: str
    reachable_flow_ids: list[str] = Field(default_factory=list)
    facts: list[ComposableIntegrityFact] = Field(default_factory=list)
    executable: bool


class ComposableFlowProjection(BaseModel):
    """Validated reachable graph consumed independently by Story and Playback."""

    model_config = ConfigDict(extra="forbid")

    consumer: Literal["story", "playback"]
    root_flow_id: str
    graph: ComposableFlowGraph


class FlowCompositionSnapshot(BaseModel):
    """Project-scoped authoring projection for invocation and exit editors."""

    model_config = ConfigDict(extra="forbid")

    project_id: str
    invocations: list[FlowInvocation] = Field(default_factory=list)
    exits: list[FlowExit] = Field(default_factory=list)
    bindings: list[FlowExitBinding] = Field(default_factory=list)

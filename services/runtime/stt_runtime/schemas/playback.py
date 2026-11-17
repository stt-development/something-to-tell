from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .dialogue import DialogueChoiceElement, DialogueDocument
from .composable_story_flow import ComposableFlowGraph, FlowExitBinding
from .quest import QuestDocument
from .narrative_state import StateHolderRef, TransferItemPayload
from .story_flow import FlowTransitionKind, StoryFlowSnapshot

PlaybackSessionStatus = Literal["ready", "active", "blocked", "ended"]
PlaybackConditionStatus = Literal["true", "false", "invalid"]
PlaybackConditionDiagnosticCode = Literal[
    "unsupported_version",
    "malformed_condition",
    "unknown_condition_path",
    "unsupported_condition_operator",
    "unsupported_condition_function",
    "condition_type_mismatch",
]
PlaybackEffectOperation = Literal[
    "set_flag",
    "clear_flag",
    "add_inventory",
    "remove_inventory",
    "transfer_item",
    "set_quest_status",
    "record_dialogue_choice",
]
PlaybackFactLevel = Literal["error", "warning", "info"]
PlaybackFactCode = Literal[
    "empty_flow",
    "missing_entry",
    "invalid_entry",
    "missing_member",
    "dangling_source",
    "stale_ownership",
    "duplicate_effect_id",
    "unsupported_version",
    "invalid_definition",
    "malformed_condition",
    "unknown_condition_path",
    "no_eligible_transition",
    "multiple_unconditional_transitions",
    "missing_default_branch",
    "malformed_effect",
    "conflicting_effects",
    "repeated_effect",
    "stale_item_holder",
    "visit_threshold",
    "ending_reached",
    "stale_source_revision",
    "missing_exit_binding",
    "call_entered",
    "exit_reached",
    "return_completed",
]
PlaybackTraceOperation = Literal["transition", "dialogue", "call", "exit", "return"]
QuestPlaybackStatus = Literal["inactive", "active", "completed", "failed"]


class PlaybackCanonicalNode(BaseModel):
    """Immutable canonical content projected into one playback definition."""

    model_config = ConfigDict(extra="forbid")

    node_version: Literal[1] = 1
    id: str = Field(min_length=1)
    project_id: str = Field(min_length=1)
    type: str = Field(min_length=1, max_length=64)
    title: str = Field(min_length=1, max_length=255)
    summary: str = ""
    body: str = ""
    status: str = Field(default="canon", min_length=1, max_length=64)
    metadata: dict[str, Any] = Field(default_factory=dict)


class PlaybackEffectOwner(BaseModel):
    """Common accepted-effect ownership; exactly one authored owner is required."""

    model_config = ConfigDict(extra="forbid")

    effect_version: Literal[1] = 1
    id: str = Field(min_length=1, max_length=128)
    project_id: str = Field(min_length=1)
    flow_id: str = Field(min_length=1)
    owner_node_id: str | None = Field(default=None, min_length=1)
    owner_transition_id: str | None = Field(default=None, min_length=1)
    review_status: Literal["accepted"] = "accepted"
    repeatable: bool = False
    explanation: str = Field(min_length=1)
    authored_effect_id: str | None = Field(default=None, min_length=1)
    owner_kind: Literal["node_entry", "flow_transition", "flow_invocation", "flow_exit", "dialogue_element", "dialogue_option", "quest_branch", "quest_outcome"] | None = None
    owner_id: str | None = Field(default=None, min_length=1)
    context_node_id: str | None = Field(default=None, min_length=1)
    application_order: int = Field(default=0, ge=0)

    @model_validator(mode="after")
    def validate_single_owner(self) -> "PlaybackEffectOwner":
        if (self.owner_node_id is None) == (self.owner_transition_id is None):
            raise ValueError("playback effect requires exactly one node or transition owner")
        if (self.owner_kind is None) != (self.owner_id is None):
            raise ValueError("playback effect temporal owner metadata must be complete")
        contextual = self.owner_kind in {"dialogue_element", "dialogue_option", "quest_branch", "quest_outcome"}
        if contextual and (self.context_node_id is None or self.owner_node_id != self.context_node_id):
            raise ValueError("specialized playback effect requires its canonical context node")
        if not contextual and self.context_node_id is not None:
            raise ValueError("non-specialized playback effect cannot carry a context node")
        return self


class PlaybackFlagPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    flag: str = Field(min_length=1, max_length=128)


class PlaybackInventoryPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    node_id: str = Field(min_length=1)


class PlaybackQuestStatusPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    quest_node_id: str = Field(min_length=1)
    status: QuestPlaybackStatus


class PlaybackDialogueChoicePayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    dialogue_node_id: str = Field(min_length=1)
    choice_id: str = Field(min_length=1, max_length=128)


class SetFlagPlaybackEffect(PlaybackEffectOwner):
    operation: Literal["set_flag"]
    payload: PlaybackFlagPayload


class ClearFlagPlaybackEffect(PlaybackEffectOwner):
    operation: Literal["clear_flag"]
    payload: PlaybackFlagPayload


class AddInventoryPlaybackEffect(PlaybackEffectOwner):
    operation: Literal["add_inventory"]
    payload: PlaybackInventoryPayload


class RemoveInventoryPlaybackEffect(PlaybackEffectOwner):
    operation: Literal["remove_inventory"]
    payload: PlaybackInventoryPayload


class TransferItemPlaybackEffect(PlaybackEffectOwner):
    """Executable custody transfer with an explicit source precondition."""

    operation: Literal["transfer_item"]
    payload: TransferItemPayload


class SetQuestStatusPlaybackEffect(PlaybackEffectOwner):
    operation: Literal["set_quest_status"]
    payload: PlaybackQuestStatusPayload


class RecordDialogueChoicePlaybackEffect(PlaybackEffectOwner):
    operation: Literal["record_dialogue_choice"]
    payload: PlaybackDialogueChoicePayload


# The operation discriminator is the runtime-owned parser for reviewed effects.
PlaybackTypedEffect = Annotated[
    SetFlagPlaybackEffect
    | ClearFlagPlaybackEffect
    | AddInventoryPlaybackEffect
    | RemoveInventoryPlaybackEffect
    | TransferItemPlaybackEffect
    | SetQuestStatusPlaybackEffect
    | RecordDialogueChoicePlaybackEffect,
    Field(discriminator="operation"),
]


class ReviewedPlaybackEffectAdapter(BaseModel):
    """Explicit reviewed mapping from specialized authored data to one effect."""

    model_config = ConfigDict(extra="forbid")

    adapter_version: Literal[1] = 1
    source_kind: Literal["Outcome", "Quest", "Dialogue"]
    source_node_id: str = Field(min_length=1)
    effect: PlaybackTypedEffect

    @model_validator(mode="after")
    def validate_specialized_mapping(self) -> "ReviewedPlaybackEffectAdapter":
        if self.source_kind == "Quest":
            if not isinstance(self.effect, SetQuestStatusPlaybackEffect):
                raise ValueError("Quest effect adapter requires set_quest_status")
            if self.effect.payload.quest_node_id != self.source_node_id:
                raise ValueError("Quest effect adapter must target its source node")
        if self.source_kind == "Dialogue":
            if not isinstance(self.effect, RecordDialogueChoicePlaybackEffect):
                raise ValueError("Dialogue effect adapter requires record_dialogue_choice")
            if self.effect.payload.dialogue_node_id != self.source_node_id:
                raise ValueError("Dialogue effect adapter must target its source node")
        return self


class PlaybackCondition(BaseModel):
    """Versioned source consumed only by the runtime condition evaluator."""

    model_config = ConfigDict(extra="forbid")

    condition_version: Literal[1, 2] = 1
    expression: str = Field(min_length=1, max_length=2048)


class PlaybackConditionResult(BaseModel):
    """Deterministic explanation tree produced by the safe runtime evaluator."""

    model_config = ConfigDict(extra="forbid")

    condition_result_version: Literal[1] = 1
    expression: str
    status: PlaybackConditionStatus
    value: bool | None = None
    message: str = Field(min_length=1)
    diagnostic_code: PlaybackConditionDiagnosticCode | None = None
    children: list["PlaybackConditionResult"] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_status_value(self) -> "PlaybackConditionResult":
        if self.status == "invalid" and self.value is not None:
            raise ValueError("invalid condition result cannot have a boolean value")
        if self.status != "invalid" and self.value is None:
            raise ValueError("valid condition result requires a boolean value")
        if self.status == "invalid" and self.diagnostic_code is None:
            raise ValueError("invalid condition result requires a diagnostic code")
        if self.status != "invalid" and self.diagnostic_code is not None:
            raise ValueError("valid condition result cannot have a diagnostic code")
        return self


class PlaybackFact(BaseModel):
    """Read-only deterministic diagnostic; Phase 4 decides Issue conversion."""

    model_config = ConfigDict(extra="forbid")

    fact_version: Literal[1] = 1
    code: PlaybackFactCode
    level: PlaybackFactLevel
    message: str = Field(min_length=1)
    action: str = Field(min_length=1)
    flow_id: str | None = Field(default=None, min_length=1)
    node_id: str | None = Field(default=None, min_length=1)
    transition_id: str | None = Field(default=None, min_length=1)
    effect_id: str | None = Field(default=None, min_length=1)
    invocation_id: str | None = Field(default=None, min_length=1)
    exit_id: str | None = Field(default=None, min_length=1)
    item_node_id: str | None = Field(default=None, min_length=1)
    holder_kind: str | None = Field(default=None, min_length=1)
    holder_node_id: str | None = Field(default=None, min_length=1)


class PlaybackState(BaseModel):
    """Versioned transient state; authored project records never store it."""

    model_config = ConfigDict(extra="forbid")

    state_version: Literal[1] = 1
    flags: dict[str, bool] = Field(default_factory=dict)
    inventory_node_ids: list[str] = Field(default_factory=list)
    item_holders: dict[str, StateHolderRef] = Field(default_factory=dict)
    quest_states: dict[str, QuestPlaybackStatus] = Field(default_factory=dict)
    dialogue_choice_ids: dict[str, list[str]] = Field(default_factory=dict)
    visited_node_ids: list[str] = Field(default_factory=list)
    applied_effect_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_unique_history(self) -> "PlaybackState":
        for values, label in (
            (self.inventory_node_ids, "inventory node ids"),
            (self.visited_node_ids, "visited node ids"),
            (self.applied_effect_ids, "applied effect ids"),
        ):
            if len(values) != len(set(values)):
                raise ValueError(f"playback {label} must be unique")
        if any(len(values) != len(set(values)) for values in self.dialogue_choice_ids.values()):
            raise ValueError("playback dialogue choice ids must be unique per dialogue")
        if any(not item_id.strip() for item_id in self.item_holders):
            raise ValueError("playback Item holder ids cannot be empty")
        return self


PlaybackStateChangeValue = bool | str | list[str] | StateHolderRef | None


class PlaybackStateChange(BaseModel):
    """One visible effect-owned value change stored in application and trace."""

    model_config = ConfigDict(extra="forbid")

    state_change_version: Literal[1] = 1
    effect_id: str = Field(min_length=1)
    authored_effect_id: str | None = Field(default=None, min_length=1)
    operation: PlaybackEffectOperation
    path: str = Field(min_length=1)
    before: PlaybackStateChangeValue = None
    after: PlaybackStateChangeValue = None
    explanation: str = Field(min_length=1)


class PlaybackEffectApplication(BaseModel):
    """Atomic application boundary returned by the runtime effect service."""

    model_config = ConfigDict(extra="forbid")

    application_version: Literal[1] = 1
    success: bool
    state_before: PlaybackState
    state_after: PlaybackState
    applied_effect_ids: list[str] = Field(default_factory=list)
    changes: list[PlaybackStateChange] = Field(default_factory=list)
    facts: list[PlaybackFact] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_atomic_boundary(self) -> "PlaybackEffectApplication":
        if len(self.applied_effect_ids) != len(set(self.applied_effect_ids)):
            raise ValueError("application effect ids must be unique")
        if self.applied_effect_ids != [change.effect_id for change in self.changes]:
            raise ValueError("application effect ids must match ordered state changes")
        has_errors = any(fact.level == "error" for fact in self.facts)
        if self.success and has_errors:
            raise ValueError("successful effect application cannot contain error facts")
        if not self.success:
            if not has_errors:
                raise ValueError("failed effect application requires an error fact")
            if self.applied_effect_ids or self.changes:
                raise ValueError("failed effect application cannot contain partial changes")
            if self.state_before != self.state_after:
                raise ValueError("failed effect application must preserve state")
        return self


class PlaybackChoice(BaseModel):
    """One transition choice presented from the current playback step."""

    model_config = ConfigDict(extra="forbid")

    choice_version: Literal[1] = 1
    transition_id: str = Field(min_length=1)
    source_node_id: str = Field(min_length=1)
    target_node_id: str = Field(min_length=1)
    kind: FlowTransitionKind
    label: str = ""
    condition: str = ""
    priority: int = Field(ge=0)
    is_default: bool = False
    eligible: bool
    disabled_reason: str | None = None
    condition_result: PlaybackConditionResult | None = None
    effect_ids: list[str] = Field(default_factory=list)
    operation: Literal["transition", "call"] = "transition"
    target_flow_id: str | None = Field(default=None, min_length=1)


class PlaybackDialogueLine(BaseModel):
    """One spoken line reached by deterministic Dialogue traversal."""

    model_config = ConfigDict(extra="forbid")

    line_version: Literal[1] = 1
    element_id: str = Field(min_length=1)
    speaker_node_id: str = Field(min_length=1)
    text: str = Field(min_length=1)


class PlaybackDialogueSelection(BaseModel):
    """One player reply retained in the visible Dialogue transcript."""

    model_config = ConfigDict(extra="forbid")

    selection_version: Literal[1] = 1
    choice_element_id: str = Field(min_length=1)
    option_id: str = Field(min_length=1)
    text: str = Field(min_length=1)


PlaybackDialogueTurn = PlaybackDialogueLine | PlaybackDialogueSelection


class PlaybackDialogueOption(BaseModel):
    """One currently available authored reply."""

    model_config = ConfigDict(extra="forbid")

    option_version: Literal[1] = 1
    choice_element_id: str = Field(min_length=1)
    option_id: str = Field(min_length=1)
    text: str = Field(min_length=1)
    condition: str = ""
    eligible: bool
    disabled_reason: str | None = None
    condition_result: PlaybackConditionResult | None = None


class PlaybackDialogueStep(BaseModel):
    """Current internal Dialogue projection, independent of Story Flow exits."""

    model_config = ConfigDict(extra="forbid")

    dialogue_step_version: Literal[1] = 1
    dialogue_node_id: str = Field(min_length=1)
    prompt: str = ""
    turns: list[PlaybackDialogueTurn] = Field(default_factory=list)
    options: list[PlaybackDialogueOption] = Field(default_factory=list)
    complete: bool = False
    outcome_element_id: str | None = Field(default=None, min_length=1)


class PlaybackDialoguePath(BaseModel):
    """Ephemeral cursor inputs used to replay one Dialogue path exactly."""

    model_config = ConfigDict(extra="forbid")

    path_version: Literal[1] = 1
    dialogue_node_id: str = Field(min_length=1)
    option_ids: list[str] = Field(default_factory=list)


class PlaybackStep(BaseModel):
    """Type-neutral authored slide plus deterministic outgoing choices."""

    model_config = ConfigDict(extra="forbid")

    step_version: Literal[1] = 1
    node_id: str = Field(min_length=1)
    node_kind: str = Field(min_length=1)
    title: str = Field(min_length=1)
    summary: str = ""
    dialogue: PlaybackDialogueStep | None = None
    choices: list[PlaybackChoice] = Field(default_factory=list)
    facts: list[PlaybackFact] = Field(default_factory=list)


class PlaybackCallFrame(BaseModel):
    """Transient caller context restored by a named callee exit."""

    model_config = ConfigDict(extra="forbid")

    frame_version: Literal[1] = 1
    invocation_id: str = Field(min_length=1)
    caller_flow_id: str = Field(min_length=1)
    caller_source_node_id: str = Field(min_length=1)
    callee_flow_id: str = Field(min_length=1)
    exit_bindings: list[FlowExitBinding] = Field(default_factory=list)


class PlaybackTerminalExit(BaseModel):
    """Named result returned when a flow is played without a caller."""

    model_config = ConfigDict(extra="forbid")

    result_version: Literal[1] = 1
    exit_id: str = Field(min_length=1)
    flow_id: str = Field(min_length=1)
    key: str = Field(min_length=1)
    label: str = ""
    source_node_id: str = Field(min_length=1)


class PlaybackTraceEvent(BaseModel):
    """One composed-flow operation inside a single reversible command boundary."""

    model_config = ConfigDict(extra="forbid")

    event_version: Literal[1] = 1
    operation: PlaybackTraceOperation
    flow_id: str = Field(min_length=1)
    node_id: str = Field(min_length=1)
    invocation_id: str | None = Field(default=None, min_length=1)
    exit_id: str | None = Field(default=None, min_length=1)
    message: str = Field(min_length=1)


class PlaybackTraceEntry(BaseModel):
    """Append-only state boundary used by deterministic backtracking."""

    model_config = ConfigDict(extra="forbid")

    trace_version: Literal[1] = 1
    sequence: int = Field(ge=0)
    node_id: str = Field(min_length=1)
    transition_id: str | None = Field(default=None, min_length=1)
    dialogue_option_id: str | None = Field(default=None, min_length=1)
    dialogue_path_before: PlaybackDialoguePath | None = None
    dialogue_path_after: PlaybackDialoguePath | None = None
    condition_results: list[PlaybackConditionResult] = Field(default_factory=list)
    applied_effect_ids: list[str] = Field(default_factory=list)
    state_changes: list[PlaybackStateChange] = Field(default_factory=list)
    state_before: PlaybackState
    state_after: PlaybackState
    timestamp: datetime
    events: list[PlaybackTraceEvent] = Field(default_factory=list)
    flow_id_before: str | None = Field(default=None, min_length=1)
    flow_id_after: str | None = Field(default=None, min_length=1)
    call_stack_before: list[PlaybackCallFrame] = Field(default_factory=list)
    call_stack_after: list[PlaybackCallFrame] = Field(default_factory=list)
    terminal_exit_before: PlaybackTerminalExit | None = None
    terminal_exit_after: PlaybackTerminalExit | None = None

    @model_validator(mode="after")
    def validate_effect_changes(self) -> "PlaybackTraceEntry":
        if self.applied_effect_ids != [change.effect_id for change in self.state_changes]:
            raise ValueError("trace effect ids must match ordered state changes")
        return self


class PlaybackDefinition(BaseModel):
    """Immutable, self-contained input consumed by deterministic traversal."""

    model_config = ConfigDict(extra="forbid")

    definition_version: Literal[1] = 1
    project_id: str = Field(min_length=1)
    flow_snapshot: StoryFlowSnapshot
    flow_snapshots: list[StoryFlowSnapshot] = Field(default_factory=list)
    composition: ComposableFlowGraph | None = None
    canonical_nodes: list[PlaybackCanonicalNode]
    dialogue_documents: dict[str, DialogueDocument] = Field(default_factory=dict)
    quest_documents: dict[str, QuestDocument] = Field(default_factory=dict)
    typed_effect_definitions: list[PlaybackTypedEffect] = Field(default_factory=list)
    initial_state: PlaybackState = Field(default_factory=PlaybackState)
    source_revision: str = Field(min_length=1, max_length=128)

    @model_validator(mode="after")
    def validate_definition_ownership(self) -> "PlaybackDefinition":
        flow = self.flow_snapshot.flow
        if flow.project_id != self.project_id:
            raise ValueError("playback flow belongs to another project")
        snapshots = self.flow_snapshots or [self.flow_snapshot]
        if not any(snapshot.flow.id == flow.id for snapshot in snapshots):
            raise ValueError("playback snapshots must include the root flow")
        if len({snapshot.flow.id for snapshot in snapshots}) != len(snapshots):
            raise ValueError("playback flow snapshot ids must be unique")
        member_ids = {membership.node_id for snapshot in snapshots for membership in snapshot.nodes}
        node_ids = [node.id for node in self.canonical_nodes]
        if len(node_ids) != len(set(node_ids)):
            raise ValueError("playback canonical node ids must be unique")
        if not member_ids.issubset(node_ids):
            raise ValueError("playback canonical nodes must include every flow member")
        nodes = {node.id: node for node in self.canonical_nodes}
        if any(node.project_id != self.project_id for node in self.canonical_nodes):
            raise ValueError("playback canonical node belongs to another project")
        self._validate_documents(self.dialogue_documents, nodes, "Dialogue")
        self._validate_documents(self.quest_documents, nodes, "Quest")
        effect_ids: set[str] = set()
        transition_ids = {transition.id for snapshot in snapshots for transition in snapshot.transitions}
        invocation_ids = {item.id for item in self.composition.invocations} if self.composition else set()
        exit_ids = {item.id for item in self.composition.exits} if self.composition else set()
        memberships_by_flow = {
            snapshot.flow.id: {membership.node_id for membership in snapshot.nodes}
            for snapshot in snapshots
        }
        for effect in self.typed_effect_definitions:
            if effect.id in effect_ids:
                raise ValueError("duplicate playback effect id")
            effect_ids.add(effect.id)
            if effect.project_id != self.project_id or effect.flow_id not in memberships_by_flow:
                raise ValueError("playback effect has stale project or flow ownership")
            if effect.owner_node_id is not None and effect.owner_node_id not in memberships_by_flow[effect.flow_id]:
                raise ValueError("playback effect node owner is not a flow member")
            temporal_edge_ids = transition_ids | invocation_ids | exit_ids
            if effect.owner_transition_id is not None and effect.owner_transition_id not in temporal_edge_ids:
                raise ValueError("playback effect transition owner does not exist")
            if effect.owner_kind is not None:
                valid_owner = self._valid_effect_owner(
                    effect,
                    memberships_by_flow,
                    transition_ids,
                    invocation_ids,
                    exit_ids,
                )
                if not valid_owner:
                    raise ValueError("playback effect temporal owner does not exist")
        return self

    def _valid_effect_owner(
        self,
        effect: PlaybackTypedEffect,
        memberships_by_flow: dict[str, set[str]],
        transition_ids: set[str],
        invocation_ids: set[str],
        exit_ids: set[str],
    ) -> bool:
        """Validate exact temporal and document-local owner identity."""

        if effect.owner_kind == "node_entry":
            return effect.owner_id in memberships_by_flow[effect.flow_id]
        if effect.owner_kind == "flow_transition":
            return effect.owner_id in transition_ids
        if effect.owner_kind == "flow_invocation":
            return effect.owner_id in invocation_ids
        if effect.owner_kind == "flow_exit":
            return effect.owner_id in exit_ids
        if effect.owner_kind in {"dialogue_element", "dialogue_option"}:
            document = self.dialogue_documents.get(effect.context_node_id or "")
            if document is None:
                return False
            element_ids = {element.id for element in document.elements}
            option_ids = {
                option.id
                for element in document.elements
                if isinstance(element, DialogueChoiceElement)
                for option in element.options
            }
            return effect.owner_id in (element_ids if effect.owner_kind == "dialogue_element" else option_ids)
        document = self.quest_documents.get(effect.context_node_id or "")
        if document is None:
            return False
        branch_ids = {branch.id for stage in document.stages for branch in stage.branches}
        if effect.owner_id not in branch_ids:
            return False
        if effect.owner_kind == "quest_outcome":
            return any(branch.id == effect.owner_id and branch.target_stage_id is None for stage in document.stages for branch in stage.branches)
        return effect.owner_kind == "quest_branch"

    @staticmethod
    def _validate_documents(
        documents: dict[str, DialogueDocument] | dict[str, QuestDocument],
        nodes: dict[str, PlaybackCanonicalNode],
        expected_kind: str,
    ) -> None:
        for node_id in documents:
            if node_id not in nodes or nodes[node_id].type != expected_kind:
                raise ValueError(f"playback {expected_kind} document has a stale owner")


class PlaybackPreparation(BaseModel):
    """All-or-nothing definition build result; invalid input yields facts only."""

    model_config = ConfigDict(extra="forbid")

    preparation_version: Literal[1] = 1
    project_id: str = Field(min_length=1)
    flow_id: str | None = Field(default=None, min_length=1)
    definition: PlaybackDefinition | None = None
    facts: list[PlaybackFact] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_all_or_nothing(self) -> "PlaybackPreparation":
        has_errors = any(fact.level == "error" for fact in self.facts)
        if has_errors and self.definition is not None:
            raise ValueError("invalid playback preparation cannot contain a partial definition")
        if self.definition is None and not has_errors:
            raise ValueError("playback preparation without a definition requires an error fact")
        return self


class PlaybackSession(BaseModel):
    """Ephemeral traversal state returned by later playback commands."""

    model_config = ConfigDict(extra="forbid")

    session_version: Literal[1] = 1
    id: str = Field(min_length=1)
    project_id: str = Field(min_length=1)
    flow_id: str = Field(min_length=1)
    current_flow_id: str | None = Field(default=None, min_length=1)
    source_revision: str = Field(min_length=1)
    visit_threshold: int = Field(default=3, ge=1, le=1000)
    status: PlaybackSessionStatus
    current_node_id: str | None = Field(default=None, min_length=1)
    state: PlaybackState
    dialogue_path: PlaybackDialoguePath | None = None
    step: PlaybackStep | None = None
    trace: list[PlaybackTraceEntry] = Field(default_factory=list)
    facts: list[PlaybackFact] = Field(default_factory=list)
    call_stack: list[PlaybackCallFrame] = Field(default_factory=list)
    terminal_exit: PlaybackTerminalExit | None = None

    @model_validator(mode="after")
    def default_current_flow(self) -> "PlaybackSession":
        if self.current_flow_id is None:
            self.current_flow_id = self.flow_id
        return self

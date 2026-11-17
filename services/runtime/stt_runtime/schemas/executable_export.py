"""Target-neutral executable narrative contracts shared by Yarn and Ink."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import Field, model_validator

from .export import (
    EXPORT_MAX_DIAGNOSTICS,
    EXPORT_MAX_RECORDS,
    ExportContractModel,
    ExportDiagnosticV1,
    ExportFlowInitialStateV1,
    ExportNarrativeEffectV1,
    ExportOwnerV1,
    ExportSourceIdentityV1,
)

_SYMBOL_PATTERN = r"^[A-Za-z_][A-Za-z0-9_]{0,159}$"


class ExecutableConditionLiteralV1(ExportContractModel):
    condition_version: Literal[1] = 1
    kind: Literal["literal"]
    value_type: Literal["boolean", "number", "string", "null"]
    value: bool | int | float | str | None

    @model_validator(mode="after")
    def validate_literal_type(self) -> "ExecutableConditionLiteralV1":
        matches = {
            "boolean": isinstance(self.value, bool),
            "number": isinstance(self.value, (int, float)) and not isinstance(self.value, bool),
            "string": isinstance(self.value, str),
            "null": self.value is None,
        }
        if not matches[self.value_type]:
            raise ValueError("executable condition literal type does not match its value")
        return self


class ExecutableConditionStateV1(ExportContractModel):
    condition_version: Literal[1] = 1
    kind: Literal["state"]
    path: list[str] = Field(min_length=2, max_length=4)


class ExecutableConditionUnaryV1(ExportContractModel):
    condition_version: Literal[1] = 1
    kind: Literal["unary"]
    operator: Literal["not"]
    operand: "ExecutableConditionNodeV1"


class ExecutableConditionBinaryV1(ExportContractModel):
    condition_version: Literal[1] = 1
    kind: Literal["binary"]
    operator: Literal["and", "or", "eq", "ne", "lt", "lte", "gt", "gte", "in", "not_in"]
    left: "ExecutableConditionNodeV1"
    right: "ExecutableConditionNodeV1"


ExecutableConditionNodeV1 = Annotated[
    ExecutableConditionLiteralV1
    | ExecutableConditionStateV1
    | ExecutableConditionUnaryV1
    | ExecutableConditionBinaryV1,
    Field(discriminator="kind"),
]


class ExecutableSpeakerV1(ExportContractModel):
    speaker_version: Literal[1] = 1
    node_id: str
    symbol: str = Field(pattern=_SYMBOL_PATTERN)
    display_name: str


class ExecutableLineV1(ExportContractModel):
    line_version: Literal[1] = 1
    id: str
    symbol: str = Field(pattern=_SYMBOL_PATTERN)
    speaker_symbol: str | None = Field(default=None, pattern=_SYMBOL_PATTERN)
    text: str
    next_symbol: str | None = Field(default=None, pattern=_SYMBOL_PATTERN)
    operation_ids: list[str] = Field(default_factory=list)


class ExecutableChoiceOptionV1(ExportContractModel):
    option_version: Literal[1] = 1
    id: str
    symbol: str = Field(pattern=_SYMBOL_PATTERN)
    text: str
    condition: ExecutableConditionNodeV1 | None = None
    next_symbol: str | None = Field(default=None, pattern=_SYMBOL_PATTERN)
    operation_ids: list[str] = Field(default_factory=list)


class ExecutableChoiceV1(ExportContractModel):
    choice_version: Literal[1] = 1
    id: str
    symbol: str = Field(pattern=_SYMBOL_PATTERN)
    prompt: str = ""
    operation_ids: list[str] = Field(default_factory=list)
    options: list[ExecutableChoiceOptionV1] = Field(default_factory=list)


class ExecutableDialogueV1(ExportContractModel):
    dialogue_version: Literal[1] = 1
    node_id: str
    symbol: str = Field(pattern=_SYMBOL_PATTERN)
    entry_symbol: str | None = Field(default=None, pattern=_SYMBOL_PATTERN)
    lines: list[ExecutableLineV1] = Field(default_factory=list)
    choices: list[ExecutableChoiceV1] = Field(default_factory=list)


class ExecutableQuestBranchV1(ExportContractModel):
    branch_version: Literal[1] = 1
    id: str
    symbol: str = Field(pattern=_SYMBOL_PATTERN)
    label: str
    condition: ExecutableConditionNodeV1 | None = None
    target_stage_symbol: str | None = Field(default=None, pattern=_SYMBOL_PATTERN)
    operation_ids: list[str] = Field(default_factory=list)


class ExecutableQuestStageV1(ExportContractModel):
    stage_version: Literal[1] = 1
    id: str
    symbol: str = Field(pattern=_SYMBOL_PATTERN)
    title: str
    description: str = ""
    branches: list[ExecutableQuestBranchV1] = Field(default_factory=list)


class ExecutableQuestV1(ExportContractModel):
    quest_version: Literal[1] = 1
    node_id: str
    symbol: str = Field(pattern=_SYMBOL_PATTERN)
    objective: str = ""
    entry_stage_symbol: str | None = Field(default=None, pattern=_SYMBOL_PATTERN)
    stages: list[ExecutableQuestStageV1] = Field(default_factory=list)


class ExecutableReturnBindingV1(ExportContractModel):
    binding_version: Literal[1] = 1
    exit_symbol: str = Field(pattern=_SYMBOL_PATTERN)
    target_step_symbol: str = Field(pattern=_SYMBOL_PATTERN)


class ExecutableRouteV1(ExportContractModel):
    route_version: Literal[1] = 1
    id: str
    symbol: str = Field(pattern=_SYMBOL_PATTERN)
    kind: Literal["jump", "call"]
    label: str = ""
    priority: int = Field(ge=0)
    is_default: bool = False
    condition: ExecutableConditionNodeV1 | None = None
    target_symbol: str = Field(pattern=_SYMBOL_PATTERN)
    return_bindings: list[ExecutableReturnBindingV1] = Field(default_factory=list)
    operation_ids: list[str] = Field(default_factory=list)
    dialogue_element_id: str | None = None
    quest_branch_id: str | None = None


class ExecutableReturnV1(ExportContractModel):
    return_version: Literal[1] = 1
    id: str
    symbol: str = Field(pattern=_SYMBOL_PATTERN)
    key: str
    label: str = ""
    source_step_symbol: str = Field(pattern=_SYMBOL_PATTERN)
    operation_ids: list[str] = Field(default_factory=list)


class ExecutableStepV1(ExportContractModel):
    step_version: Literal[1] = 1
    node_id: str
    symbol: str = Field(pattern=_SYMBOL_PATTERN)
    node_kind: str
    title: str
    text: str = ""
    dialogue_symbol: str | None = Field(default=None, pattern=_SYMBOL_PATTERN)
    quest_symbol: str | None = Field(default=None, pattern=_SYMBOL_PATTERN)
    operation_ids: list[str] = Field(default_factory=list)
    routes: list[ExecutableRouteV1] = Field(default_factory=list)


class ExecutableFlowV1(ExportContractModel):
    flow_version: Literal[1] = 1
    id: str
    symbol: str = Field(pattern=_SYMBOL_PATTERN)
    name: str
    is_root: bool
    entry_step_symbol: str = Field(pattern=_SYMBOL_PATTERN)
    steps: list[ExecutableStepV1] = Field(default_factory=list)
    returns: list[ExecutableReturnV1] = Field(default_factory=list)


class ExecutableOperationV1(ExportContractModel):
    operation_version: Literal[1] = 1
    id: str
    symbol: str = Field(pattern=_SYMBOL_PATTERN)
    effect_id: str
    execution: Literal["native", "host"]
    host_binding_id: str | None = None
    owner_kind: Literal[
        "node_entry", "flow_transition", "dialogue_element", "dialogue_option",
        "quest_branch", "quest_outcome", "flow_invocation", "flow_exit",
    ]
    owner_id: str
    context_node_id: str | None = None
    application_order: int = Field(ge=0)
    effect: ExportNarrativeEffectV1

    @model_validator(mode="after")
    def validate_execution_mode(self) -> "ExecutableOperationV1":
        if (self.execution == "host") != (self.host_binding_id is not None):
            raise ValueError("host execution requires exactly one host binding")
        return self


class ExecutableHostBindingV1(ExportContractModel):
    binding_version: Literal[1] = 1
    id: str
    namespace: str = Field(pattern=r"^[a-z][a-z0-9_.-]{0,63}$")
    name: str = Field(pattern=r"^[a-z][a-z0-9_.-]{0,127}$")
    operation: Literal["transfer_item"]
    parameter_names: list[str] = Field(default_factory=list)
    result_type: Literal["void"] = "void"


class ExecutableSourceMapEntryV1(ExportContractModel):
    source_map_version: Literal[1] = 1
    symbol: str = Field(pattern=_SYMBOL_PATTERN)
    owner: ExportOwnerV1


class ExecutableNarrativeProjectionV1(ExportContractModel):
    """Pure source-language-independent execution model for source adapters."""

    executable_version: Literal[1] = 1
    source: ExportSourceIdentityV1
    speakers: list[ExecutableSpeakerV1] = Field(default_factory=list)
    flows: list[ExecutableFlowV1] = Field(default_factory=list)
    dialogues: list[ExecutableDialogueV1] = Field(default_factory=list)
    quests: list[ExecutableQuestV1] = Field(default_factory=list)
    initial_states: list[ExportFlowInitialStateV1] = Field(default_factory=list)
    operations: list[ExecutableOperationV1] = Field(default_factory=list)
    host_bindings: list[ExecutableHostBindingV1] = Field(default_factory=list)
    source_map: list[ExecutableSourceMapEntryV1] = Field(default_factory=list)
    diagnostics: list[ExportDiagnosticV1] = Field(
        default_factory=list, max_length=EXPORT_MAX_DIAGNOSTICS
    )

    @model_validator(mode="after")
    def validate_stable_identity(self) -> "ExecutableNarrativeProjectionV1":
        records: list[Any] = [
            *self.speakers, *self.flows, *self.dialogues, *self.quests,
            *self.initial_states, *self.operations, *self.host_bindings,
            *self.source_map, *self.diagnostics,
        ]
        for flow in self.flows:
            records.extend([*flow.steps, *flow.returns])
            records.extend(route for step in flow.steps for route in step.routes)
        for dialogue in self.dialogues:
            records.extend([*dialogue.lines, *dialogue.choices])
            records.extend(option for choice in dialogue.choices for option in choice.options)
        for quest in self.quests:
            records.extend(quest.stages)
            records.extend(branch for stage in quest.stages for branch in stage.branches)
        if len(records) > EXPORT_MAX_RECORDS:
            raise ValueError("executable projection exceeds record limit")
        mapped_symbols = [entry.symbol for entry in self.source_map]
        if len(mapped_symbols) != len(set(mapped_symbols)):
            raise ValueError("executable source map symbols must be unique")
        generated_symbols = [
            *(item.symbol for item in self.speakers),
            *(item.symbol for item in self.flows),
            *(item.symbol for flow in self.flows for item in flow.steps),
            *(route.symbol for flow in self.flows for step in flow.steps for route in step.routes),
            *(item.symbol for flow in self.flows for item in flow.returns),
            *(item.symbol for item in self.dialogues),
            *(item.symbol for dialogue in self.dialogues for item in dialogue.lines),
            *(item.symbol for dialogue in self.dialogues for item in dialogue.choices),
            *(
                option.symbol
                for dialogue in self.dialogues
                for choice in dialogue.choices
                for option in choice.options
            ),
            *(item.symbol for item in self.quests),
            *(item.symbol for quest in self.quests for item in quest.stages),
            *(item.symbol for quest in self.quests for stage in quest.stages for item in stage.branches),
            *(item.symbol for item in self.operations),
        ]
        if len(generated_symbols) != len(set(generated_symbols)):
            raise ValueError("executable generated symbols must be unique")
        if not set(generated_symbols).issubset(mapped_symbols):
            raise ValueError("every executable generated symbol requires a source map owner")
        operation_ids = [item.id for item in self.operations]
        if len(operation_ids) != len(set(operation_ids)):
            raise ValueError("executable operation ids must be unique")
        return self


ExecutableConditionUnaryV1.model_rebuild()
ExecutableConditionBinaryV1.model_rebuild()

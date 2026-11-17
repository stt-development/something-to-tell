from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


NarrativeStateNodeKind = Literal[
    "Character",
    "Quest",
    "Scene",
    "Lore",
    "Location",
    "Dialogue",
    "Faction",
    "Item",
    "Event",
    "Condition",
    "Consequence",
]
StateHolderKind = Literal["character", "location", "faction", "player", "party", "unowned"]
QuestStateStatus = Literal["inactive", "active", "completed", "failed"]
EffectRepeatPolicy = Literal["once", "per_visit"]
EffectOwnerKind = Literal[
    "node_entry",
    "flow_transition",
    "dialogue_element",
    "dialogue_option",
    "quest_branch",
    "quest_outcome",
    "flow_invocation",
    "flow_exit",
]

_NODE_HOLDER_TYPES: dict[str, NarrativeStateNodeKind] = {
    "character": "Character",
    "location": "Location",
    "faction": "Faction",
}
_CONTEXTUAL_OWNER_TYPES: dict[str, NarrativeStateNodeKind] = {
    "dialogue_element": "Dialogue",
    "dialogue_option": "Dialogue",
    "quest_branch": "Quest",
    "quest_outcome": "Quest",
}


class NarrativeStateCanonicalNodeRef(BaseModel):
    """Minimal project-owned canonical node identity needed by state validation."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    project_id: str = Field(min_length=1)
    type: NarrativeStateNodeKind


class NarrativeStateFlowRef(BaseModel):
    """Minimal project-owned Story Flow identity used by one initial state."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    project_id: str = Field(min_length=1)


class StateHolderRef(BaseModel):
    """One exclusive custody holder; only canonical holder kinds carry a node id."""

    model_config = ConfigDict(extra="forbid")

    holder_version: Literal[1] = 1
    kind: StateHolderKind
    node_id: str | None = Field(default=None, min_length=1)

    @model_validator(mode="after")
    def validate_shape(self) -> "StateHolderRef":
        requires_node = self.kind in _NODE_HOLDER_TYPES
        if requires_node and self.node_id is None:
            raise ValueError(f"{self.kind} holder requires a canonical node id")
        if not requires_node and self.node_id is not None:
            raise ValueError(f"{self.kind} holder cannot reference a canonical node")
        return self


class ItemCustody(BaseModel):
    """Initial ownership of exactly one canonical Item inside one root Flow."""

    model_config = ConfigDict(extra="forbid")

    custody_version: Literal[1] = 1
    item_node_id: str = Field(min_length=1)
    holder: StateHolderRef


class FlowInitialState(BaseModel):
    """Authored root state for one Flow; invoked flows inherit caller state."""

    model_config = ConfigDict(extra="forbid")

    state_version: Literal[1] = 1
    project_id: str = Field(min_length=1)
    flow_id: str = Field(min_length=1)
    flags: dict[str, bool] = Field(default_factory=dict)
    item_custody: list[ItemCustody] = Field(default_factory=list)
    quest_statuses: dict[str, QuestStateStatus] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_unique_state_keys(self) -> "FlowInitialState":
        if any(not key.strip() for key in self.flags):
            raise ValueError("initial state flag names cannot be empty")
        item_ids = [record.item_node_id for record in self.item_custody]
        if len(item_ids) != len(set(item_ids)):
            raise ValueError("initial state may assign an Item only once")
        if any(not node_id.strip() for node_id in self.quest_statuses):
            raise ValueError("initial state Quest ids cannot be empty")
        return self


class TransferItemPayload(BaseModel):
    """Explicit custody precondition and destination for one atomic Item transfer."""

    model_config = ConfigDict(extra="forbid")

    item_node_id: str = Field(min_length=1)
    from_holder: StateHolderRef
    to_holder: StateHolderRef

    @model_validator(mode="after")
    def validate_distinct_holders(self) -> "TransferItemPayload":
        if self.from_holder == self.to_holder:
            raise ValueError("transfer_item source and destination holders must differ")
        return self


class FlagEffectPayload(BaseModel):
    """Flag key shared by set and clear operations."""

    model_config = ConfigDict(extra="forbid")

    flag: str = Field(min_length=1, max_length=128)


class QuestStatusEffectPayload(BaseModel):
    """One canonical Quest state assignment."""

    model_config = ConfigDict(extra="forbid")

    quest_node_id: str = Field(min_length=1)
    status: QuestStateStatus


class DialogueChoiceEffectPayload(BaseModel):
    """Stable Dialogue choice identity recorded by an authored temporal effect."""

    model_config = ConfigDict(extra="forbid")

    dialogue_node_id: str = Field(min_length=1)
    choice_id: str = Field(min_length=1, max_length=128)


class NarrativeEffectDefinitionBase(BaseModel):
    """Project-owned fields shared by every Phase 3.11 effect definition."""

    model_config = ConfigDict(extra="forbid")

    effect_version: Literal[1] = 1
    id: str = Field(min_length=1, max_length=128)
    project_id: str = Field(min_length=1)
    repeat_policy: EffectRepeatPolicy = "once"
    explanation: str = Field(min_length=1)


class TransferItemEffect(NarrativeEffectDefinitionBase):
    operation: Literal["transfer_item"]
    payload: TransferItemPayload


class SetFlagEffect(NarrativeEffectDefinitionBase):
    operation: Literal["set_flag"]
    payload: FlagEffectPayload


class ClearFlagEffect(NarrativeEffectDefinitionBase):
    operation: Literal["clear_flag"]
    payload: FlagEffectPayload


class SetQuestStatusEffect(NarrativeEffectDefinitionBase):
    operation: Literal["set_quest_status"]
    payload: QuestStatusEffectPayload


class RecordDialogueChoiceEffect(NarrativeEffectDefinitionBase):
    operation: Literal["record_dialogue_choice"]
    payload: DialogueChoiceEffectPayload


# The discriminator is the runtime-owned parser for authored Phase 3.11 effects.
NarrativeEffectDefinition = Annotated[
    TransferItemEffect
    | SetFlagEffect
    | ClearFlagEffect
    | SetQuestStatusEffect
    | RecordDialogueChoiceEffect,
    Field(discriminator="operation"),
]


class NarrativeEffectOwnerRef(BaseModel):
    """Stable temporal owner; specialized ids are scoped by their canonical node."""

    model_config = ConfigDict(extra="forbid")

    owner_version: Literal[1] = 1
    owner_kind: EffectOwnerKind
    owner_id: str = Field(min_length=1)
    context_node_id: str | None = Field(default=None, min_length=1)

    @model_validator(mode="after")
    def validate_context_shape(self) -> "NarrativeEffectOwnerRef":
        contextual = self.owner_kind in _CONTEXTUAL_OWNER_TYPES
        if contextual and self.context_node_id is None:
            raise ValueError(f"{self.owner_kind} owner requires its canonical context node")
        if not contextual and self.context_node_id is not None:
            raise ValueError(f"{self.owner_kind} owner cannot carry a context node")
        return self


class NarrativeEffectOwnerRecordRef(BaseModel):
    """Project-scoped evidence that a stable effect owner currently exists."""

    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1)
    owner: NarrativeEffectOwnerRef


class NarrativeEffectBinding(BaseModel):
    """Ordered association between one reusable effect and one temporal owner."""

    model_config = ConfigDict(extra="forbid")

    binding_version: Literal[1] = 1
    id: str = Field(min_length=1, max_length=128)
    project_id: str = Field(min_length=1)
    effect_id: str = Field(min_length=1)
    owner: NarrativeEffectOwnerRef
    application_order: int = Field(ge=0)


class NarrativeStateContract(BaseModel):
    """Runtime validation boundary for authored state records before persistence."""

    model_config = ConfigDict(extra="forbid")

    contract_version: Literal[1] = 1
    project_id: str = Field(min_length=1)
    canonical_nodes: list[NarrativeStateCanonicalNodeRef] = Field(default_factory=list)
    flows: list[NarrativeStateFlowRef] = Field(default_factory=list)
    owners: list[NarrativeEffectOwnerRecordRef] = Field(default_factory=list)
    initial_states: list[FlowInitialState] = Field(default_factory=list)
    effects: list[NarrativeEffectDefinition] = Field(default_factory=list)
    bindings: list[NarrativeEffectBinding] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_contract(self) -> "NarrativeStateContract":
        self._require_owned_unique("canonical node", self.canonical_nodes)
        self._require_owned_unique("Flow", self.flows)
        self._require_owned_unique("effect", self.effects)
        self._require_owned_unique("binding", self.bindings)

        nodes = {node.id: node for node in self.canonical_nodes}
        flow_ids = {flow.id for flow in self.flows}
        owner_keys: set[tuple[str, str | None, str]] = set()
        for record in self.owners:
            self._require_project(record.project_id, "effect owner")
            key = self._owner_key(record.owner)
            if key in owner_keys:
                raise ValueError("effect owner references must be unique")
            owner_keys.add(key)
            self._validate_owner_context(record.owner, nodes)

        initial_flow_ids: set[str] = set()
        for state in self.initial_states:
            self._require_project(state.project_id, "initial state")
            if state.flow_id not in flow_ids:
                raise ValueError("initial state references a missing Flow")
            if state.flow_id in initial_flow_ids:
                raise ValueError("one Flow may have only one initial state")
            initial_flow_ids.add(state.flow_id)
            for custody in state.item_custody:
                self._require_node_type(custody.item_node_id, "Item", nodes, "custody Item")
                self._validate_holder(custody.holder, nodes)
            for quest_node_id in state.quest_statuses:
                self._require_node_type(quest_node_id, "Quest", nodes, "initial Quest")

        effects = {effect.id: effect for effect in self.effects}
        for effect in self.effects:
            self._validate_effect(effect, nodes)

        orders: set[tuple[tuple[str, str | None, str], int]] = set()
        for binding in self.bindings:
            if binding.effect_id not in effects:
                raise ValueError("effect binding references a missing effect")
            key = self._owner_key(binding.owner)
            if key not in owner_keys:
                raise ValueError("effect binding references a missing owner")
            ordered_key = (key, binding.application_order)
            if ordered_key in orders:
                raise ValueError("effect application order must be unique per owner")
            orders.add(ordered_key)
        return self

    def _validate_effect(
        self,
        effect: NarrativeEffectDefinition,
        nodes: dict[str, NarrativeStateCanonicalNodeRef],
    ) -> None:
        if isinstance(effect, TransferItemEffect):
            self._require_node_type(effect.payload.item_node_id, "Item", nodes, "transfer Item")
            self._validate_holder(effect.payload.from_holder, nodes)
            self._validate_holder(effect.payload.to_holder, nodes)
        elif isinstance(effect, SetQuestStatusEffect):
            self._require_node_type(effect.payload.quest_node_id, "Quest", nodes, "effect Quest")
        elif isinstance(effect, RecordDialogueChoiceEffect):
            self._require_node_type(
                effect.payload.dialogue_node_id,
                "Dialogue",
                nodes,
                "effect Dialogue",
            )

    def _validate_holder(
        self,
        holder: StateHolderRef,
        nodes: dict[str, NarrativeStateCanonicalNodeRef],
    ) -> None:
        expected_type = _NODE_HOLDER_TYPES.get(holder.kind)
        if expected_type is not None:
            self._require_node_type(holder.node_id, expected_type, nodes, f"{holder.kind} holder")

    def _validate_owner_context(
        self,
        owner: NarrativeEffectOwnerRef,
        nodes: dict[str, NarrativeStateCanonicalNodeRef],
    ) -> None:
        if owner.owner_kind == "node_entry":
            if owner.owner_id not in nodes:
                raise ValueError("node entry owner references a missing canonical node")
            return
        expected_type = _CONTEXTUAL_OWNER_TYPES.get(owner.owner_kind)
        if expected_type is not None:
            self._require_node_type(
                owner.context_node_id,
                expected_type,
                nodes,
                f"{owner.owner_kind} context",
            )

    def _require_owned_unique(self, label: str, records: list[object]) -> None:
        ids: set[str] = set()
        for record in records:
            project_id = getattr(record, "project_id")
            record_id = getattr(record, "id")
            self._require_project(project_id, label)
            if record_id in ids:
                raise ValueError(f"{label} ids must be unique")
            ids.add(record_id)

    def _require_project(self, project_id: str, label: str) -> None:
        if project_id != self.project_id:
            raise ValueError(f"{label} belongs to another project")

    @staticmethod
    def _require_node_type(
        node_id: str | None,
        expected_type: NarrativeStateNodeKind,
        nodes: dict[str, NarrativeStateCanonicalNodeRef],
        label: str,
    ) -> None:
        node = nodes.get(node_id or "")
        if node is None:
            raise ValueError(f"{label} references a missing canonical node")
        if node.type != expected_type:
            raise ValueError(f"{label} must reference a {expected_type} node")

    @staticmethod
    def _owner_key(owner: NarrativeEffectOwnerRef) -> tuple[str, str | None, str]:
        return (owner.owner_kind, owner.context_node_id, owner.owner_id)

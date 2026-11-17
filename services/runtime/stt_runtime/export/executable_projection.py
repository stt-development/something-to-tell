"""Pure pipeline-to-executable projection shared by source-language adapters."""

from __future__ import annotations

from collections import defaultdict
from decimal import Decimal, InvalidOperation
from hashlib import sha256
import json
import math
import re
from typing import Any

from lark import Token, Tree
from lark.exceptions import UnexpectedInput

from ..playback.condition_language import (
    is_supported_playback_state_path,
    parse_playback_condition,
)
from ..schemas.dialogue import DialogueChoiceElement, DialogueLineElement
from ..schemas.executable_export import (
    ExecutableChoiceOptionV1,
    ExecutableChoiceV1,
    ExecutableConditionBinaryV1,
    ExecutableConditionLiteralV1,
    ExecutableConditionNodeV1,
    ExecutableConditionStateV1,
    ExecutableConditionUnaryV1,
    ExecutableDialogueV1,
    ExecutableFlowV1,
    ExecutableHostBindingV1,
    ExecutableLineV1,
    ExecutableNarrativeProjectionV1,
    ExecutableOperationV1,
    ExecutableQuestBranchV1,
    ExecutableQuestStageV1,
    ExecutableQuestV1,
    ExecutableReturnBindingV1,
    ExecutableReturnV1,
    ExecutableRouteV1,
    ExecutableSourceMapEntryV1,
    ExecutableSpeakerV1,
    ExecutableStepV1,
)
from ..schemas.export import (
    ExportDiagnosticV1,
    ExportNarrativeEffectBindingV1,
    ExportOwnerV1,
    ExportProjectionV1,
)

_COMPARISON_OPERATORS = {
    "==": "eq", "!=": "ne", "<": "lt", "<=": "lte", ">": "gt", ">=": "gte",
}
_HOST_TRANSFER_ID = "host.stt.transfer_item.v1"


class _ConditionLoweringError(ValueError):
    pass


class _SymbolTable:
    """Allocate deterministic collision-resistant symbols and exact owners."""

    def __init__(self) -> None:
        self._symbols: dict[str, str] = {}
        self._source_map: dict[str, ExecutableSourceMapEntryV1] = {}

    def get(self, identity: str, prefix: str, owner: ExportOwnerV1) -> str:
        existing = self._symbols.get(identity)
        if existing is not None:
            return existing
        slug = re.sub(r"[^A-Za-z0-9_]+", "_", identity).strip("_").lower()
        digest = sha256(identity.encode("utf-8")).hexdigest()[:10]
        symbol = f"{prefix}_{slug[:120]}_{digest}"
        self._symbols[identity] = symbol
        self._source_map[symbol] = ExecutableSourceMapEntryV1(
            symbol=symbol,
            owner=owner,
        )
        return symbol

    def entries(self) -> list[ExecutableSourceMapEntryV1]:
        return [self._source_map[key] for key in sorted(self._source_map)]


class ExecutableProjectionService:
    """Lower the allowlisted pipeline model without repository or target syntax."""

    def build(self, projection: ExportProjectionV1) -> ExecutableNarrativeProjectionV1:
        diagnostics = list(projection.diagnostics)
        symbols = _SymbolTable()
        nodes = {item.id: item for item in projection.nodes}
        flows = {item.id: item for item in projection.story_flows.definitions}
        dialogues = {item.node_id: item for item in projection.dialogues}
        quests = {item.node_id: item for item in projection.quests}
        self._diagnose_call_cycles(projection, diagnostics)

        operations, operation_ids = self._operations(projection, symbols, diagnostics)
        executable_dialogues, speaker_ids = self._dialogues(
            projection, symbols, operation_ids, diagnostics
        )
        executable_quests = self._quests(
            projection, symbols, operation_ids, diagnostics
        )
        speakers = self._speakers(speaker_ids, nodes, symbols, diagnostics)
        executable_flows = self._flows(
            projection,
            flows,
            nodes,
            dialogues,
            quests,
            symbols,
            operation_ids,
            diagnostics,
        )
        host_bindings = []
        if any(item.execution == "host" for item in operations):
            host_bindings.append(ExecutableHostBindingV1(
                id=_HOST_TRANSFER_ID,
                namespace="stt",
                name="transfer_item",
                operation="transfer_item",
                parameter_names=["item_node_id", "from_holder", "to_holder"],
            ))

        return ExecutableNarrativeProjectionV1(
            source=projection.manifest.source,
            speakers=speakers,
            flows=executable_flows,
            dialogues=executable_dialogues,
            quests=executable_quests,
            initial_states=sorted(
                projection.narrative_state.initial_states,
                key=lambda item: item.id,
            ),
            operations=operations,
            host_bindings=host_bindings,
            source_map=symbols.entries(),
            diagnostics=self._stable_diagnostics(diagnostics),
        )

    def _flows(
        self,
        projection: ExportProjectionV1,
        flow_by_id: dict[str, Any],
        nodes: dict[str, Any],
        dialogues: dict[str, Any],
        quests: dict[str, Any],
        symbols: _SymbolTable,
        operation_ids: dict[tuple[str, str, str | None], list[str]],
        diagnostics: list[ExportDiagnosticV1],
    ) -> list[ExecutableFlowV1]:
        memberships: dict[str, list[Any]] = defaultdict(list)
        for item in projection.story_flows.memberships:
            memberships[item.flow_id].append(item)
        transitions: dict[tuple[str, str], list[Any]] = defaultdict(list)
        for item in projection.story_flows.transitions:
            transitions[(item.flow_id, item.source_node_id)].append(item)
        invocations: dict[tuple[str, str], list[Any]] = defaultdict(list)
        for item in projection.story_flows.invocations:
            invocations[(item.source_flow_id, item.source_node_id)].append(item)
        exits: dict[str, list[Any]] = defaultdict(list)
        for item in projection.story_flows.exits:
            exits[item.flow_id].append(item)
        bindings: dict[str, list[Any]] = defaultdict(list)
        for item in projection.story_flows.exit_bindings:
            bindings[item.invocation_id].append(item)

        requested_roots = set(projection.manifest.story_flow_ids)
        result: list[ExecutableFlowV1] = []
        for flow in sorted(flow_by_id.values(), key=lambda item: item.id):
            members = sorted(
                memberships.get(flow.id, []),
                key=lambda item: (item.presentation_order, item.id),
            )
            member_ids = {item.node_id for item in members}
            if flow.entry_node_id is None or flow.entry_node_id not in member_ids:
                self._diagnose(
                    diagnostics, "missing-entry", "story_flow", flow.id,
                    {"flow_id": flow.id},
                )
                continue
            flow_symbol = symbols.get(
                f"flow:{flow.id}", "flow", self._owner("story_flow", flow.id)
            )
            steps = [
                self._step(
                    flow.id, member.node_id, nodes, dialogues, quests,
                    transitions, invocations, bindings, flow_by_id, projection,
                    symbols, operation_ids, diagnostics,
                )
                for member in members
                if member.node_id in nodes
            ]
            missing_nodes = member_ids - nodes.keys()
            for node_id in sorted(missing_nodes):
                self._diagnose(
                    diagnostics, "missing-reference", "node", node_id,
                    {"flow_id": flow.id, "reference": "membership"},
                )
            returns = [
                ExecutableReturnV1(
                    id=item.id,
                    symbol=symbols.get(
                        f"return:{item.id}", "return", self._owner("flow_exit", item.id)
                    ),
                    key=item.key,
                    label=item.label,
                    source_step_symbol=self._step_symbol(symbols, flow.id, item.source_node_id),
                    operation_ids=self._owner_operations(
                        operation_ids, "flow_exit", item.id, None
                    ),
                )
                for item in sorted(exits.get(flow.id, []), key=lambda candidate: candidate.id)
                if item.source_node_id in member_ids
            ]
            result.append(ExecutableFlowV1(
                id=flow.id,
                symbol=flow_symbol,
                name=flow.name,
                is_root=(
                    flow.id in requested_roots
                    if projection.manifest.scope == "story_flows"
                    else flow.kind in {"main", "standalone"}
                ),
                entry_step_symbol=self._step_symbol(symbols, flow.id, flow.entry_node_id),
                steps=steps,
                returns=returns,
            ))
        return result

    def _step(
        self,
        flow_id: str,
        node_id: str,
        nodes: dict[str, Any],
        dialogues: dict[str, Any],
        quests: dict[str, Any],
        transitions: dict[tuple[str, str], list[Any]],
        invocations: dict[tuple[str, str], list[Any]],
        bindings: dict[str, list[Any]],
        flow_by_id: dict[str, Any],
        projection: ExportProjectionV1,
        symbols: _SymbolTable,
        operation_ids: dict[tuple[str, str, str | None], list[str]],
        diagnostics: list[ExportDiagnosticV1],
    ) -> ExecutableStepV1:
        node = nodes[node_id]
        route_items = [
            *(('jump', item) for item in transitions.get((flow_id, node_id), [])),
            *(('call', item) for item in invocations.get((flow_id, node_id), [])),
        ]
        route_items.sort(key=lambda pair: (pair[1].priority, pair[1].id))
        routes = [
            self._route(
                kind, item, flow_id, bindings, flow_by_id, projection,
                symbols, operation_ids, diagnostics,
            )
            for kind, item in route_items
        ]
        text = node.body or node.summary or node.title
        return ExecutableStepV1(
            node_id=node_id,
            symbol=self._step_symbol(symbols, flow_id, node_id),
            node_kind=node.type,
            title=node.title,
            text=text,
            dialogue_symbol=(
                self._dialogue_symbol(symbols, node_id) if node_id in dialogues else None
            ),
            quest_symbol=self._quest_symbol(symbols, node_id) if node_id in quests else None,
            operation_ids=self._owner_operations(
                operation_ids, "node_entry", node_id, None
            ),
            routes=routes,
        )

    def _route(
        self,
        kind: str,
        item: Any,
        flow_id: str,
        bindings: dict[str, list[Any]],
        flow_by_id: dict[str, Any],
        projection: ExportProjectionV1,
        symbols: _SymbolTable,
        operation_ids: dict[tuple[str, str, str | None], list[str]],
        diagnostics: list[ExportDiagnosticV1],
    ) -> ExecutableRouteV1:
        owner_kind = "flow_transition" if kind == "jump" else "flow_invocation"
        owner = self._owner(owner_kind, item.id)
        if kind == "jump":
            target = self._step_symbol(symbols, flow_id, item.target_node_id)
            return_bindings: list[ExecutableReturnBindingV1] = []
        else:
            target_flow = flow_by_id.get(item.target_flow_id)
            if target_flow is None:
                self._diagnose(
                    diagnostics, "missing-reference", owner_kind, item.id,
                    {"reference": item.target_flow_id},
                )
                target = symbols.get(
                    f"flow:{item.target_flow_id}", "flow", self._owner("story_flow", item.target_flow_id)
                )
            else:
                target = symbols.get(
                    f"flow:{target_flow.id}", "flow", self._owner("story_flow", target_flow.id)
                )
            exits = {candidate.id: candidate for candidate in projection.story_flows.exits}
            return_bindings = [
                ExecutableReturnBindingV1(
                    exit_symbol=symbols.get(
                        f"return:{binding.exit_id}", "return",
                        self._owner("flow_exit", binding.exit_id),
                    ),
                    target_step_symbol=self._step_symbol(
                        symbols, flow_id, binding.target_node_id
                    ),
                )
                for binding in sorted(bindings.get(item.id, []), key=lambda value: value.id)
                if binding.exit_id in exits
            ]
        specialized_operations: list[str] = []
        # Playback applies branch/outcome effects before the transition itself.
        quest_branch_id = getattr(item, "quest_branch_id", None)
        if quest_branch_id:
            specialized_operations.extend(self._owner_operations(
                operation_ids, "quest_branch", quest_branch_id, item.source_node_id
            ))
            quest = next((
                aggregate for aggregate in projection.quests
                if aggregate.node_id == item.source_node_id
            ), None)
            if quest and any(
                branch.id == quest_branch_id and branch.target_stage_id is None
                for stage in quest.document.stages for branch in stage.branches
            ):
                specialized_operations.extend(self._owner_operations(
                    operation_ids, "quest_outcome", quest_branch_id, item.source_node_id
                ))
        return ExecutableRouteV1(
            id=item.id,
            symbol=symbols.get(f"route:{item.id}", "route", owner),
            kind=kind,
            label=item.label,
            priority=item.priority,
            is_default=item.is_default,
            condition=self._condition(item.condition, owner, diagnostics),
            target_symbol=target,
            return_bindings=return_bindings,
            operation_ids=[
                *specialized_operations,
                *self._owner_operations(operation_ids, owner_kind, item.id, None),
            ],
            dialogue_element_id=getattr(item, "dialogue_element_id", None),
            quest_branch_id=quest_branch_id,
        )

    def _dialogues(
        self,
        projection: ExportProjectionV1,
        symbols: _SymbolTable,
        operation_ids: dict[tuple[str, str, str | None], list[str]],
        diagnostics: list[ExportDiagnosticV1],
    ) -> tuple[list[ExecutableDialogueV1], set[str]]:
        result: list[ExecutableDialogueV1] = []
        speakers: set[str] = set()
        for aggregate in sorted(projection.dialogues, key=lambda item: item.node_id):
            document = aggregate.document
            lines: list[ExecutableLineV1] = []
            choices: list[ExecutableChoiceV1] = []
            for element in document.elements:
                if isinstance(element, DialogueLineElement):
                    speakers.add(element.speaker_node_id)
                    lines.append(ExecutableLineV1(
                        id=element.id,
                        symbol=self._dialogue_element_symbol(
                            symbols, aggregate.node_id, element.id
                        ),
                        speaker_symbol=self._speaker_symbol(
                            symbols, element.speaker_node_id
                        ),
                        text=element.text,
                        next_symbol=(
                            self._dialogue_element_symbol(
                                symbols, aggregate.node_id, element.next_element_id
                            ) if element.next_element_id else None
                        ),
                        operation_ids=self._owner_operations(
                            operation_ids, "dialogue_element", element.id,
                            aggregate.node_id,
                        ),
                    ))
                elif isinstance(element, DialogueChoiceElement):
                    choices.append(ExecutableChoiceV1(
                        id=element.id,
                        symbol=self._dialogue_element_symbol(
                            symbols, aggregate.node_id, element.id
                        ),
                        prompt=element.prompt,
                        operation_ids=self._owner_operations(
                            operation_ids, "dialogue_element", element.id,
                            aggregate.node_id,
                        ),
                        options=[
                            ExecutableChoiceOptionV1(
                                id=option.id,
                                symbol=symbols.get(
                                    f"dialogue-option:{aggregate.node_id}:{option.id}",
                                    "option",
                                    self._owner("dialogue_option", option.id, aggregate.node_id),
                                ),
                                text=option.text,
                                condition=self._condition(
                                    option.condition,
                                    self._owner("dialogue_option", option.id, aggregate.node_id),
                                    diagnostics,
                                ),
                                next_symbol=(
                                    self._dialogue_element_symbol(
                                        symbols, aggregate.node_id, option.next_element_id
                                    ) if option.next_element_id else None
                                ),
                                operation_ids=self._owner_operations(
                                    operation_ids, "dialogue_option", option.id,
                                    aggregate.node_id,
                                ),
                            )
                            for option in element.options
                        ],
                    ))
            result.append(ExecutableDialogueV1(
                node_id=aggregate.node_id,
                symbol=self._dialogue_symbol(symbols, aggregate.node_id),
                entry_symbol=(
                    self._dialogue_element_symbol(
                        symbols, aggregate.node_id, document.entry_element_id
                    ) if document.entry_element_id else None
                ),
                lines=lines,
                choices=choices,
            ))
        return result, speakers

    def _quests(
        self,
        projection: ExportProjectionV1,
        symbols: _SymbolTable,
        operation_ids: dict[tuple[str, str, str | None], list[str]],
        diagnostics: list[ExportDiagnosticV1],
    ) -> list[ExecutableQuestV1]:
        result: list[ExecutableQuestV1] = []
        for aggregate in sorted(projection.quests, key=lambda item: item.node_id):
            stages = [
                ExecutableQuestStageV1(
                    id=stage.id,
                    symbol=self._quest_stage_symbol(symbols, aggregate.node_id, stage.id),
                    title=stage.title,
                    description=stage.description,
                    branches=[
                        ExecutableQuestBranchV1(
                            id=branch.id,
                            symbol=symbols.get(
                                f"quest-branch:{aggregate.node_id}:{branch.id}",
                                "branch",
                                self._owner("quest_branch", branch.id, aggregate.node_id),
                            ),
                            label=branch.label,
                            condition=self._condition(
                                branch.condition,
                                self._owner("quest_branch", branch.id, aggregate.node_id),
                                diagnostics,
                            ),
                            target_stage_symbol=(
                                self._quest_stage_symbol(
                                    symbols, aggregate.node_id, branch.target_stage_id
                                ) if branch.target_stage_id else None
                            ),
                            operation_ids=self._owner_operations(
                                operation_ids,
                                "quest_branch" if branch.target_stage_id else "quest_outcome",
                                branch.id,
                                aggregate.node_id,
                            ),
                        )
                        for branch in stage.branches
                    ],
                )
                for stage in aggregate.document.stages
            ]
            result.append(ExecutableQuestV1(
                node_id=aggregate.node_id,
                symbol=self._quest_symbol(symbols, aggregate.node_id),
                objective=aggregate.document.objective,
                entry_stage_symbol=(
                    self._quest_stage_symbol(
                        symbols, aggregate.node_id, aggregate.document.entry_stage_id
                    ) if aggregate.document.entry_stage_id else None
                ),
                stages=stages,
            ))
        return result

    def _operations(
        self,
        projection: ExportProjectionV1,
        symbols: _SymbolTable,
        diagnostics: list[ExportDiagnosticV1],
    ) -> tuple[
        list[ExecutableOperationV1],
        dict[tuple[str, str, str | None], list[str]],
    ]:
        effects = {item.id: item for item in projection.narrative_state.effects}
        bound_effect_ids: set[str] = set()
        operation_ids: dict[tuple[str, str, str | None], list[str]] = defaultdict(list)
        result: list[ExecutableOperationV1] = []
        for binding in sorted(
            projection.narrative_state.bindings,
            key=lambda item: (item.owner_kind, item.owner_id, item.application_order, item.id),
        ):
            effect = effects.get(binding.effect_id)
            if effect is None:
                self._diagnose(
                    diagnostics, "missing-reference", "narrative_effect",
                    binding.effect_id, {"reference": binding.id},
                )
                continue
            host = effect.operation == "transfer_item"
            operation = ExecutableOperationV1(
                id=binding.id,
                symbol=symbols.get(
                    f"operation:{binding.id}", "operation",
                    self._owner("narrative_effect", effect.id),
                ),
                effect_id=effect.id,
                execution="host" if host else "native",
                host_binding_id=_HOST_TRANSFER_ID if host else None,
                owner_kind=binding.owner_kind,
                owner_id=binding.owner_id,
                context_node_id=binding.context_node_id,
                application_order=binding.application_order,
                effect=effect,
            )
            result.append(operation)
            bound_effect_ids.add(effect.id)
            operation_ids[
                (binding.owner_kind, binding.owner_id, binding.context_node_id)
            ].append(operation.id)
        for effect_id in sorted(effects.keys() - bound_effect_ids):
            self._diagnose(
                diagnostics, "unbound-effect", "narrative_effect", effect_id,
                {"effect_id": effect_id},
            )
        return result, operation_ids

    def _condition(
        self,
        expression: str,
        owner: ExportOwnerV1,
        diagnostics: list[ExportDiagnosticV1],
    ) -> ExecutableConditionNodeV1 | None:
        if not expression.strip():
            return None
        try:
            tree = parse_playback_condition(expression)
            condition = self._lower_condition(tree)
            if self._condition_type(condition) != "boolean":
                raise _ConditionLoweringError("condition does not resolve to boolean")
            return condition
        except (UnexpectedInput, _ConditionLoweringError, InvalidOperation) as error:
            self._diagnose(
                diagnostics, "invalid-condition", owner.kind, owner.id,
                {"reason": str(error), "context_id": owner.context_id or ""},
                context_id=owner.context_id,
            )
            return None

    def _lower_condition(self, node: Tree | Token) -> ExecutableConditionNodeV1:
        if isinstance(node, Token):
            raise _ConditionLoweringError("unexpected condition token")
        kind = str(node.data)
        if kind == "grouped":
            return self._lower_condition(node.children[0])
        if kind == "path":
            parts = [str(item) for item in node.children]
            path = ".".join(parts)
            if not is_supported_playback_state_path(path):
                raise _ConditionLoweringError(f"unsupported state path: {path}")
            return ExecutableConditionStateV1(kind="state", path=parts)
        if kind in {"true_literal", "false_literal", "null_literal"}:
            value = {"true_literal": True, "false_literal": False, "null_literal": None}[kind]
            value_type = "boolean" if value is not None else "null"
            return ExecutableConditionLiteralV1(
                kind="literal", value_type=value_type, value=value
            )
        if kind == "string_literal":
            return ExecutableConditionLiteralV1(
                kind="literal", value_type="string",
                value=json.loads(str(node.children[0])),
            )
        if kind == "number_literal":
            decimal = Decimal(str(node.children[0]))
            value: int | float = int(decimal) if decimal == decimal.to_integral() else float(decimal)
            if isinstance(value, float) and not math.isfinite(value):
                raise _ConditionLoweringError("numeric literal is not finite")
            return ExecutableConditionLiteralV1(
                kind="literal", value_type="number", value=value
            )
        if kind == "boolean_not":
            return ExecutableConditionUnaryV1(
                kind="unary", operator="not",
                operand=self._lower_condition(node.children[1]),
            )
        if kind in {"boolean_and", "boolean_or"}:
            return ExecutableConditionBinaryV1(
                kind="binary",
                operator="and" if kind == "boolean_and" else "or",
                left=self._lower_condition(node.children[0]),
                right=self._lower_condition(node.children[2]),
            )
        if kind == "comparison":
            operator = _COMPARISON_OPERATORS.get(str(node.children[1]))
            if operator is None:
                raise _ConditionLoweringError(
                    f"unsupported comparison operator: {node.children[1]}"
                )
            return ExecutableConditionBinaryV1(
                kind="binary", operator=operator,
                left=self._lower_condition(node.children[0]),
                right=self._lower_condition(node.children[2]),
            )
        if kind in {"in_operator", "not_in"}:
            right_index = 3 if kind == "not_in" else 2
            return ExecutableConditionBinaryV1(
                kind="binary", operator="not_in" if kind == "not_in" else "in",
                left=self._lower_condition(node.children[0]),
                right=self._lower_condition(node.children[right_index]),
            )
        if kind == "function_call":
            raise _ConditionLoweringError(
                f"unsupported condition function: {node.children[0]}"
            )
        raise _ConditionLoweringError(f"unsupported condition node: {kind}")

    def _condition_type(self, node: ExecutableConditionNodeV1) -> str:
        if isinstance(node, ExecutableConditionLiteralV1):
            return node.value_type
        if isinstance(node, ExecutableConditionStateV1):
            namespace = node.path[0]
            if namespace in {"flags", "inventory", "visited"}:
                return "boolean"
            if namespace == "dialogue":
                return "string_list"
            return "string_or_null" if namespace == "items" else "string"
        if isinstance(node, ExecutableConditionUnaryV1):
            if self._condition_type(node.operand) != "boolean":
                raise _ConditionLoweringError("not operand is not boolean")
            return "boolean"
        if node.operator in {"and", "or"}:
            if {self._condition_type(node.left), self._condition_type(node.right)} != {"boolean"}:
                raise _ConditionLoweringError("boolean operands are not boolean")
        if node.operator in {"in", "not_in"}:
            if self._condition_type(node.left) != "string" or self._condition_type(node.right) != "string_list":
                raise _ConditionLoweringError("membership operands are incompatible")
        if node.operator in {"lt", "lte", "gt", "gte"}:
            left = self._condition_type(node.left)
            right = self._condition_type(node.right)
            if left != right or left not in {"number", "string"}:
                raise _ConditionLoweringError("ordered comparison operands are incompatible")
        return "boolean"

    def _diagnose_call_cycles(
        self,
        projection: ExportProjectionV1,
        diagnostics: list[ExportDiagnosticV1],
    ) -> None:
        outgoing: dict[str, list[Any]] = defaultdict(list)
        for invocation in projection.story_flows.invocations:
            outgoing[invocation.source_flow_id].append(invocation)
        visited: set[str] = set()
        active: set[str] = set()

        def visit(flow_id: str) -> None:
            if flow_id in visited:
                return
            active.add(flow_id)
            for invocation in sorted(outgoing.get(flow_id, []), key=lambda item: item.id):
                if invocation.target_flow_id in active:
                    self._diagnose(
                        diagnostics, "recursive-call", "flow_invocation", invocation.id,
                        {"source_flow_id": flow_id, "target_flow_id": invocation.target_flow_id},
                    )
                else:
                    visit(invocation.target_flow_id)
            active.remove(flow_id)
            visited.add(flow_id)

        for flow in sorted(projection.story_flows.definitions, key=lambda item: item.id):
            visit(flow.id)

    @staticmethod
    def _speakers(
        speaker_ids: set[str],
        nodes: dict[str, Any],
        symbols: _SymbolTable,
        diagnostics: list[ExportDiagnosticV1],
    ) -> list[ExecutableSpeakerV1]:
        result: list[ExecutableSpeakerV1] = []
        for node_id in sorted(speaker_ids):
            node = nodes.get(node_id)
            if node is None:
                ExecutableProjectionService._diagnose(
                    diagnostics, "missing-reference", "node", node_id,
                    {"reference": "dialogue_speaker"},
                )
                continue
            result.append(ExecutableSpeakerV1(
                node_id=node_id,
                symbol=ExecutableProjectionService._speaker_symbol(symbols, node_id),
                display_name=node.title,
            ))
        return result

    @staticmethod
    def _owner_operations(
        operation_ids: dict[tuple[str, str, str | None], list[str]],
        kind: str,
        identifier: str,
        context_id: str | None,
    ) -> list[str]:
        return list(operation_ids.get((kind, identifier, context_id), []))

    @staticmethod
    def _owner(kind: str, identifier: str, context_id: str | None = None) -> ExportOwnerV1:
        return ExportOwnerV1(kind=kind, id=identifier, context_id=context_id)

    @staticmethod
    def _step_symbol(symbols: _SymbolTable, flow_id: str, node_id: str) -> str:
        return symbols.get(
            f"step:{flow_id}:{node_id}", "step",
            ExecutableProjectionService._owner("node", node_id),
        )

    @staticmethod
    def _speaker_symbol(symbols: _SymbolTable, node_id: str) -> str:
        return symbols.get(
            f"speaker:{node_id}", "speaker",
            ExecutableProjectionService._owner("node", node_id),
        )

    @staticmethod
    def _dialogue_symbol(symbols: _SymbolTable, node_id: str) -> str:
        return symbols.get(
            f"dialogue:{node_id}", "dialogue",
            ExecutableProjectionService._owner("dialogue", node_id),
        )

    @staticmethod
    def _dialogue_element_symbol(
        symbols: _SymbolTable, node_id: str, element_id: str
    ) -> str:
        return symbols.get(
            f"dialogue-element:{node_id}:{element_id}", "dialogue_element",
            ExecutableProjectionService._owner(
                "dialogue_element", element_id, node_id
            ),
        )

    @staticmethod
    def _quest_symbol(symbols: _SymbolTable, node_id: str) -> str:
        return symbols.get(
            f"quest:{node_id}", "quest",
            ExecutableProjectionService._owner("quest", node_id),
        )

    @staticmethod
    def _quest_stage_symbol(
        symbols: _SymbolTable, node_id: str, stage_id: str
    ) -> str:
        return symbols.get(
            f"quest-stage:{node_id}:{stage_id}", "quest_stage",
            ExecutableProjectionService._owner("quest_stage", stage_id, node_id),
        )

    @staticmethod
    def _diagnose(
        diagnostics: list[ExportDiagnosticV1],
        code: str,
        owner_kind: str,
        owner_id: str,
        parameters: dict[str, Any],
        *,
        context_id: str | None = None,
    ) -> None:
        diagnostics.append(ExportDiagnosticV1(
            code=f"export.executable.{code}",
            severity="error",
            message_key=f"export.diagnostic.executable-{code}",
            owner=ExecutableProjectionService._owner(
                owner_kind, owner_id, context_id
            ),
            parameters=parameters,
        ))

    @staticmethod
    def _stable_diagnostics(
        diagnostics: list[ExportDiagnosticV1],
    ) -> list[ExportDiagnosticV1]:
        return sorted(
            diagnostics,
            key=lambda item: (
                item.severity,
                item.code,
                item.owner.kind if item.owner else "",
                item.owner.id if item.owner else "",
            ),
        )

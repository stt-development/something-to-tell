"""Ink-specific state/condition lowering over the shared executable AST."""

from hashlib import sha256
import json
import re

from ..schemas.executable_export import (
    ExecutableConditionBinaryV1, ExecutableConditionLiteralV1,
    ExecutableConditionStateV1, ExecutableConditionUnaryV1,
)


def variable(path: list[str]) -> str:
    """Collision-resistant legal Ink identifier for an exact state path."""
    identity = json.dumps(path, ensure_ascii=False, separators=(",", ":"))
    readable = re.sub(r"[^a-zA-Z0-9_]+", "_", "_".join(path)).lower()[:70]
    return f"stt_{readable}_{sha256(identity.encode()).hexdigest()[:16]}"


def literal(value: object) -> str:
    """Encode only supported scalar values, never coercing null into a string."""
    if value is None:
        raise ValueError("Ink cannot represent nullable Playback values")
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


def condition(node) -> str:
    if node is None:
        return "true"
    if isinstance(node, ExecutableConditionLiteralV1):
        return literal(node.value)
    if isinstance(node, ExecutableConditionStateV1):
        return variable(node.path)
    if isinstance(node, ExecutableConditionUnaryV1):
        return f"not ({condition(node.operand)})"
    operators = {
        "and": "and", "or": "or", "eq": "==", "ne": "!=", "lt": "<",
        "lte": "<=", "gt": ">", "gte": ">=",
    }
    return f"({condition(node.left)} {operators[node.operator]} {condition(node.right)})"


def condition_nodes(node):
    """Visit every AST node for supported-type validation and declarations."""
    yield node
    if isinstance(node, ExecutableConditionUnaryV1):
        yield from condition_nodes(node.operand)
    elif isinstance(node, ExecutableConditionBinaryV1):
        yield from condition_nodes(node.left)
        yield from condition_nodes(node.right)


def owned_conditions(executable):
    """Retain the exact owner symbol when validating nested conditions."""
    for flow in executable.flows:
        for step in flow.steps:
            for route in step.routes:
                yield route.symbol, route.condition
    for dialogue in executable.dialogues:
        for choice in dialogue.choices:
            for option in choice.options:
                yield option.symbol, option.condition
    for quest in executable.quests:
        for stage in quest.stages:
            for branch in stage.branches:
                yield branch.symbol, branch.condition


def initial_values(state) -> dict[str, object]:
    values = {variable(["flags", key]): value for key, value in state.flags.items()}
    for item in state.item_custody:
        root = ["items", item.item_node_id, "holder"]
        values[variable([*root, "kind"])] = item.holder.kind
        values[variable([*root, "node_id"])] = item.holder.node_id or ""
        values[variable(["inventory", item.item_node_id])] = item.holder.kind in {"player", "party"}
    values.update({
        variable(["quests", key, "status"]): value
        for key, value in state.quest_statuses.items()
    })
    return values


def once_variable(effect_id: str) -> str:
    # Playback repeat-once identity belongs to the effect, across all bindings.
    return variable(["once", effect_id])


def state_variables(executable) -> dict[str, object]:
    """Declare defaults once; selected-root initial state is assigned at entry."""
    values: dict[str, object] = {
        "stt_return_key": "", "stt_dialogue_outcome": "", "stt_dialogue_option": "",
    }
    for state in executable.initial_states:
        for key, value in initial_values(state).items():
            values[key] = False if isinstance(value, bool) else ""
    for flow in executable.flows:
        for step in flow.steps:
            values[variable(["visited", step.node_id])] = False
    for operation in executable.operations:
        effect = operation.effect
        if effect.repeat_policy == "once":
            values[once_variable(effect.id)] = False
        payload = effect.payload
        if effect.operation in {"set_flag", "clear_flag"}:
            values[variable(["flags", payload.flag])] = False
        elif effect.operation == "set_quest_status":
            values[variable(["quests", payload.quest_node_id, "status"])] = "inactive"
        elif effect.operation == "transfer_item":
            root = ["items", payload.item_node_id, "holder"]
            values[variable([*root, "kind"])] = "unowned"
            values[variable([*root, "node_id"])] = ""
            values[variable(["inventory", payload.item_node_id])] = False
    for _, expression in owned_conditions(executable):
        for node in condition_nodes(expression):
            if isinstance(node, ExecutableConditionStateV1):
                values.setdefault(variable(node.path), False if node.path[0] in {
                    "flags", "inventory", "visited"
                } else "")
    return values

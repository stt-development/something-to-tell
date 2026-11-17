import json
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Mapping, Protocol

from lark import Token, Tree
from lark.exceptions import UnexpectedInput
from pydantic import ValidationError

from ..schemas.playback import (
    PlaybackCondition,
    PlaybackConditionDiagnosticCode,
    PlaybackConditionResult,
    PlaybackState,
)
from .condition_language import (
    is_supported_playback_state_path,
    parse_playback_condition,
)
_SUPPORTED_COMPARISON_OPERATORS = frozenset({"==", "!=", "<", "<=", ">", ">="})


class ConditionEvaluator(Protocol):
    """Runtime-owned boundary used by later traversal services."""

    def evaluate(
        self,
        condition: PlaybackCondition | Mapping[str, Any],
        state: PlaybackState,
    ) -> PlaybackConditionResult: ...


@dataclass(frozen=True)
class _EvaluatedNode:
    expression: str
    value: Any = None
    result: PlaybackConditionResult | None = None
    diagnostic_code: PlaybackConditionDiagnosticCode | None = None
    diagnostic_message: str | None = None
    value_description: str = "Expression"


class LarkConditionEvaluator:
    """Safe Condition Language v2 evaluator backed by a maintained parser."""

    def evaluate(
        self,
        condition: PlaybackCondition | Mapping[str, Any],
        state: PlaybackState,
    ) -> PlaybackConditionResult:
        parsed_condition = self._parse_contract(condition)
        if isinstance(parsed_condition, PlaybackConditionResult):
            return parsed_condition

        expression = parsed_condition.expression.strip()
        if not expression:
            return _invalid(
                expression,
                "malformed_condition",
                "Condition expression must not be blank.",
            )
        try:
            tree = parse_playback_condition(expression)
        except UnexpectedInput as error:
            return _invalid(
                expression,
                "malformed_condition",
                f"Condition syntax is invalid at line {error.line}, column {error.column}.",
            )

        evaluated = self._evaluate_tree(tree, expression, state)
        return self._as_condition_result(evaluated)

    @staticmethod
    def _parse_contract(
        condition: PlaybackCondition | Mapping[str, Any],
    ) -> PlaybackCondition | PlaybackConditionResult:
        if isinstance(condition, PlaybackCondition):
            return condition
        raw_expression = condition.get("expression")
        expression = raw_expression if isinstance(raw_expression, str) else "<invalid>"
        if condition.get("condition_version", 1) not in {1, 2}:
            return _invalid(
                expression,
                "unsupported_version",
                f"Unsupported condition version: {condition.get('condition_version')!r}.",
            )
        try:
            return PlaybackCondition.model_validate(condition)
        except ValidationError:
            return _invalid(
                expression,
                "malformed_condition",
                "Condition contract is malformed.",
            )

    def _evaluate_tree(
        self,
        tree: Tree | Token,
        source: str,
        state: PlaybackState,
    ) -> _EvaluatedNode:
        if isinstance(tree, Token):
            raise TypeError("condition evaluator received an unexpected token root")

        expression = _source_for(tree, source)
        handler = getattr(self, f"_evaluate_{tree.data}", None)
        if handler is None:
            return _EvaluatedNode(
                expression=expression,
                diagnostic_code="malformed_condition",
                diagnostic_message=f"Unsupported condition syntax node: {tree.data}.",
            )
        return handler(tree, expression, source, state)

    def _evaluate_boolean_or(
        self,
        tree: Tree,
        expression: str,
        source: str,
        state: PlaybackState,
    ) -> _EvaluatedNode:
        return self._evaluate_boolean_pair(tree, expression, source, state, "OR")

    def _evaluate_boolean_and(
        self,
        tree: Tree,
        expression: str,
        source: str,
        state: PlaybackState,
    ) -> _EvaluatedNode:
        return self._evaluate_boolean_pair(tree, expression, source, state, "AND")

    def _evaluate_boolean_pair(
        self,
        tree: Tree,
        expression: str,
        source: str,
        state: PlaybackState,
        operator: str,
    ) -> _EvaluatedNode:
        left = self._as_condition_result(self._evaluate_tree(tree.children[0], source, state))
        right = self._as_condition_result(self._evaluate_tree(tree.children[2], source, state))
        children = [left, right]
        invalid_child = next((child for child in children if child.status == "invalid"), None)
        if invalid_child is not None:
            return _EvaluatedNode(
                expression=expression,
                result=_invalid(
                    expression,
                    invalid_child.diagnostic_code or "malformed_condition",
                    f"{operator} condition is invalid because a child condition is invalid.",
                    children,
                ),
            )
        value = bool(left.value or right.value) if operator == "OR" else bool(left.value and right.value)
        return _EvaluatedNode(
            expression=expression,
            result=_valid(
                expression,
                value,
                f"{operator} condition evaluated to {_boolean_word(value)}.",
                children,
            ),
        )

    def _evaluate_boolean_not(
        self,
        tree: Tree,
        expression: str,
        source: str,
        state: PlaybackState,
    ) -> _EvaluatedNode:
        child = self._as_condition_result(self._evaluate_tree(tree.children[1], source, state))
        if child.status == "invalid":
            return _EvaluatedNode(
                expression=expression,
                result=_invalid(
                    expression,
                    child.diagnostic_code or "malformed_condition",
                    "NOT condition is invalid because its child condition is invalid.",
                    [child],
                ),
            )
        value = not child.value
        return _EvaluatedNode(
            expression=expression,
            result=_valid(
                expression,
                value,
                f"NOT condition evaluated to {_boolean_word(value)}.",
                [child],
            ),
        )

    def _evaluate_grouped(
        self,
        tree: Tree,
        expression: str,
        source: str,
        state: PlaybackState,
    ) -> _EvaluatedNode:
        child = self._as_condition_result(self._evaluate_tree(tree.children[0], source, state))
        if child.status == "invalid":
            result = _invalid(
                expression,
                child.diagnostic_code or "malformed_condition",
                "Grouped condition is invalid.",
                [child],
            )
        else:
            result = _valid(
                expression,
                bool(child.value),
                f"Grouped condition evaluated to {_boolean_word(bool(child.value))}.",
                [child],
            )
        return _EvaluatedNode(expression=expression, result=result)

    def _evaluate_comparison(
        self,
        tree: Tree,
        expression: str,
        source: str,
        state: PlaybackState,
    ) -> _EvaluatedNode:
        left = self._evaluate_tree(tree.children[0], source, state)
        operator = str(tree.children[1])
        right = self._evaluate_tree(tree.children[2], source, state)
        invalid_operand = _first_invalid_operand(left, right)
        if invalid_operand is not None:
            diagnostic_code, diagnostic_message = _invalid_details(invalid_operand)
            return _EvaluatedNode(
                expression=expression,
                result=_invalid(
                    expression,
                    diagnostic_code,
                    diagnostic_message,
                ),
            )
        if operator not in _SUPPORTED_COMPARISON_OPERATORS:
            return _EvaluatedNode(
                expression=expression,
                result=_invalid(
                    expression,
                    "unsupported_condition_operator",
                    f"Unsupported condition operator: {operator}.",
                ),
            )
        try:
            value = _compare_values(_resolved_value(left), operator, _resolved_value(right))
        except TypeError:
            return _EvaluatedNode(
                expression=expression,
                result=_invalid(
                    expression,
                    "condition_type_mismatch",
                    f"Operator {operator} cannot compare these operand types.",
                ),
            )
        return _EvaluatedNode(
            expression=expression,
            result=_valid(
                expression,
                value,
                f"Comparison {operator} evaluated to {_boolean_word(value)}.",
            ),
        )

    def _evaluate_in_operator(
        self,
        tree: Tree,
        expression: str,
        source: str,
        state: PlaybackState,
    ) -> _EvaluatedNode:
        return self._evaluate_membership(tree, expression, source, state, negate=False)

    def _evaluate_not_in(
        self,
        tree: Tree,
        expression: str,
        source: str,
        state: PlaybackState,
    ) -> _EvaluatedNode:
        return self._evaluate_membership(tree, expression, source, state, negate=True)

    def _evaluate_membership(
        self,
        tree: Tree,
        expression: str,
        source: str,
        state: PlaybackState,
        *,
        negate: bool,
    ) -> _EvaluatedNode:
        left_index, right_index = (0, 3) if negate else (0, 2)
        left = self._evaluate_tree(tree.children[left_index], source, state)
        right = self._evaluate_tree(tree.children[right_index], source, state)
        invalid_operand = _first_invalid_operand(left, right)
        if invalid_operand is not None:
            diagnostic_code, diagnostic_message = _invalid_details(invalid_operand)
            return _EvaluatedNode(
                expression=expression,
                result=_invalid(
                    expression,
                    diagnostic_code,
                    diagnostic_message,
                ),
            )
        left_value = _resolved_value(left)
        right_value = _resolved_value(right)
        if not isinstance(left_value, str) or not isinstance(right_value, tuple):
            return _EvaluatedNode(
                expression=expression,
                result=_invalid(
                    expression,
                    "condition_type_mismatch",
                    "Membership requires a string and a Dialogue choices path.",
                ),
            )
        value = left_value in right_value
        if negate:
            value = not value
        operator = "not in" if negate else "in"
        return _EvaluatedNode(
            expression=expression,
            result=_valid(
                expression,
                value,
                f"Membership {operator} evaluated to {_boolean_word(value)}.",
            ),
        )

    def _evaluate_path(
        self,
        tree: Tree,
        expression: str,
        source: str,
        state: PlaybackState,
    ) -> _EvaluatedNode:
        del source
        parts = [str(part) for part in tree.children]
        namespace = parts[0]
        if namespace == "flags" and len(parts) == 2:
            value: Any = state.flags.get(parts[1], False)
        elif namespace == "inventory" and len(parts) == 2:
            holder = state.item_holders.get(parts[1])
            value = holder.kind in {"player", "party"} if holder is not None else parts[1] in state.inventory_node_ids
        elif namespace == "items" and len(parts) == 4 and parts[2] == "holder":
            holder = state.item_holders.get(parts[1])
            if holder is None:
                return _unknown_path(expression)
            if parts[3] == "kind":
                value = holder.kind
            elif parts[3] == "node_id":
                value = holder.node_id
            else:
                return _unknown_path(expression)
        elif namespace == "visited" and len(parts) == 2:
            value = parts[1] in state.visited_node_ids
        elif namespace == "quests" and len(parts) == 3 and parts[2] == "status":
            if parts[1] not in state.quest_states:
                return _unknown_path(expression)
            value = state.quest_states[parts[1]]
        elif namespace == "dialogue" and len(parts) == 3 and parts[2] == "choices":
            if parts[1] not in state.dialogue_choice_ids:
                return _unknown_path(expression)
            value = tuple(state.dialogue_choice_ids[parts[1]])
        else:
            return _unknown_path(expression)
        return _EvaluatedNode(
            expression=expression,
            value=value,
            value_description=f"State path {expression}",
        )

    def _evaluate_function_call(
        self,
        tree: Tree,
        expression: str,
        source: str,
        state: PlaybackState,
    ) -> _EvaluatedNode:
        del source, state
        return _EvaluatedNode(
            expression=expression,
            diagnostic_code="unsupported_condition_function",
            diagnostic_message=f"Condition functions are not supported: {tree.children[0]}.",
        )

    @staticmethod
    def _evaluate_true_literal(
        tree: Tree,
        expression: str,
        source: str,
        state: PlaybackState,
    ) -> _EvaluatedNode:
        del tree, source, state
        return _EvaluatedNode(expression=expression, value=True, value_description="Boolean literal")

    @staticmethod
    def _evaluate_false_literal(
        tree: Tree,
        expression: str,
        source: str,
        state: PlaybackState,
    ) -> _EvaluatedNode:
        del tree, source, state
        return _EvaluatedNode(expression=expression, value=False, value_description="Boolean literal")

    @staticmethod
    def _evaluate_null_literal(
        tree: Tree,
        expression: str,
        source: str,
        state: PlaybackState,
    ) -> _EvaluatedNode:
        del tree, source, state
        return _EvaluatedNode(expression=expression, value=None, value_description="Null literal")

    @staticmethod
    def _evaluate_string_literal(
        tree: Tree,
        expression: str,
        source: str,
        state: PlaybackState,
    ) -> _EvaluatedNode:
        del source, state
        return _EvaluatedNode(
            expression=expression,
            value=json.loads(str(tree.children[0])),
            value_description="String literal",
        )

    @staticmethod
    def _evaluate_number_literal(
        tree: Tree,
        expression: str,
        source: str,
        state: PlaybackState,
    ) -> _EvaluatedNode:
        del source, state
        try:
            value = Decimal(str(tree.children[0]))
        except InvalidOperation:
            return _EvaluatedNode(
                expression=expression,
                diagnostic_code="malformed_condition",
                diagnostic_message="Numeric condition literal is malformed.",
            )
        return _EvaluatedNode(expression=expression, value=value, value_description="Number literal")

    @staticmethod
    def _as_condition_result(node: _EvaluatedNode) -> PlaybackConditionResult:
        if node.result is not None:
            return node.result
        if node.diagnostic_code is not None:
            return _invalid(
                node.expression,
                node.diagnostic_code,
                node.diagnostic_message or "Condition is invalid.",
            )
        if not isinstance(node.value, bool):
            return _invalid(
                node.expression,
                "condition_type_mismatch",
                "A condition must resolve to a boolean value.",
            )
        return _valid(
            node.expression,
            node.value,
            f"{node.value_description} resolved to {_boolean_word(node.value)}.",
        )


_DEFAULT_EVALUATOR: ConditionEvaluator = LarkConditionEvaluator()


def evaluate_playback_condition(
    condition: PlaybackCondition | Mapping[str, Any],
    state: PlaybackState,
) -> PlaybackConditionResult:
    """Evaluate one versioned condition through the runtime-owned adapter."""

    return _DEFAULT_EVALUATOR.evaluate(condition, state)


def extract_condition_state_paths(expression: str) -> tuple[str, ...]:
    """Return supported authored state reads without evaluating transient state."""

    try:
        tree = parse_playback_condition(expression)
    except UnexpectedInput:
        return ()
    paths = sorted(
        (
            (subtree.meta.start_pos, ".".join(str(part) for part in subtree.children))
            for subtree in tree.iter_subtrees_topdown()
            if subtree.data == "path"
        ),
        key=lambda item: (item[0], item[1]),
    )
    return tuple(
        dict.fromkeys(
            path for _, path in paths if is_supported_playback_state_path(path)
        )
    )


def _source_for(tree: Tree, source: str) -> str:
    return source[tree.meta.start_pos : tree.meta.end_pos].strip()


def _unknown_path(expression: str) -> _EvaluatedNode:
    return _EvaluatedNode(
        expression=expression,
        diagnostic_code="unknown_condition_path",
        diagnostic_message=f"Unknown playback state path: {expression}.",
    )


def _first_invalid_operand(*nodes: _EvaluatedNode) -> _EvaluatedNode | None:
    return next(
        (
            node
            for node in nodes
            if node.diagnostic_code is not None
            or (node.result is not None and node.result.status == "invalid")
        ),
        None,
    )


def _invalid_details(
    node: _EvaluatedNode,
) -> tuple[PlaybackConditionDiagnosticCode, str]:
    if node.diagnostic_code is not None:
        return node.diagnostic_code, node.diagnostic_message or "Condition operand is invalid."
    if node.result is not None and node.result.status == "invalid":
        return (
            node.result.diagnostic_code or "malformed_condition",
            node.result.message,
        )
    return "malformed_condition", "Condition operand is invalid."


def _resolved_value(node: _EvaluatedNode) -> Any:
    return node.result.value if node.result is not None else node.value


def _compare_values(left: Any, operator: str, right: Any) -> bool:
    if operator == "==":
        return type(left) is type(right) and left == right
    if operator == "!=":
        return type(left) is not type(right) or left != right
    same_ordered_type = (
        isinstance(left, Decimal)
        and isinstance(right, Decimal)
        or isinstance(left, str)
        and isinstance(right, str)
    )
    if not same_ordered_type:
        raise TypeError("ordered comparison requires matching number or string operands")
    if operator == "<":
        return left < right
    if operator == "<=":
        return left <= right
    if operator == ">":
        return left > right
    if operator == ">=":
        return left >= right
    raise TypeError("unsupported comparison operator")


def _valid(
    expression: str,
    value: bool,
    message: str,
    children: list[PlaybackConditionResult] | None = None,
) -> PlaybackConditionResult:
    return PlaybackConditionResult(
        expression=expression,
        status="true" if value else "false",
        value=value,
        message=message,
        children=children or [],
    )


def _invalid(
    expression: str,
    diagnostic_code: PlaybackConditionDiagnosticCode,
    message: str,
    children: list[PlaybackConditionResult] | None = None,
) -> PlaybackConditionResult:
    return PlaybackConditionResult(
        expression=expression,
        status="invalid",
        message=message,
        diagnostic_code=diagnostic_code,
        children=children or [],
    )


def _boolean_word(value: bool) -> str:
    return "true" if value else "false"

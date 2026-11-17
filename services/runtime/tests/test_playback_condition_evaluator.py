from copy import deepcopy

import pytest

from services.runtime.stt_runtime.playback.condition_evaluator import (
    LarkConditionEvaluator,
    evaluate_playback_condition,
    extract_condition_state_paths,
)
from services.runtime.stt_runtime.schemas.playback import PlaybackCondition, PlaybackState
from services.runtime.stt_runtime.schemas.narrative_state import StateHolderRef


def _state() -> PlaybackState:
    return PlaybackState(
        flags={"route_open": True, "alarm": False},
        inventory_node_ids=["item-citadel-key"],
        item_holders={
            "item-citadel-key": StateHolderRef(kind="party"),
            "item-ledger": StateHolderRef(kind="character", node_id="character-mara"),
        },
        quest_states={"quest-citadel": "active"},
        dialogue_choice_ids={"dialogue-gate": ["ask_passage", "show_key"]},
        visited_node_ids=["scene-citadel-gate"],
    )


def _evaluate(expression: str):
    return evaluate_playback_condition(
        PlaybackCondition(expression=expression),
        _state(),
    )


def test_state_path_extraction_reuses_supported_condition_language_shapes() -> None:
    expression = (
        'items.item-ledger.holder.node_id == "character-mara" '
        "and flags.route_open and flags.route_open"
    )

    assert extract_condition_state_paths(expression) == (
        "items.item-ledger.holder.node_id",
        "flags.route_open",
    )
    assert extract_condition_state_paths("ledger acquired") == ()
    assert extract_condition_state_paths("counters.reputation > 3") == ()


@pytest.mark.parametrize(
    ("expression", "expected"),
    [
        ("true == true", True),
        ("true != false", True),
        ("1 < 2", True),
        ("2 <= 2", True),
        ('"citadel" > "bridge"', True),
        ('"gate" >= "gate"', True),
        ('"show_key" in dialogue.dialogue-gate.choices', True),
        ('"refuse" not in dialogue.dialogue-gate.choices', True),
    ],
)
def test_evaluator_supports_every_comparison_and_membership_operator(
    expression: str,
    expected: bool,
) -> None:
    result = _evaluate(expression)

    assert result.value is expected
    assert result.status == ("true" if expected else "false")
    assert result.diagnostic_code is None


def test_evaluator_respects_boolean_precedence_and_builds_explanation_tree() -> None:
    result = _evaluate("false or true and false")

    assert result.status == "false"
    assert [child.expression for child in result.children] == ["false", "true and false"]
    assert result.children[1].message == "AND condition evaluated to false."
    assert [child.value for child in result.children[1].children] == [True, False]


def test_evaluator_supports_nested_groups_and_unary_not() -> None:
    result = _evaluate("(false or flags.route_open) and not flags.alarm")

    assert result.status == "true"
    assert result.children[0].expression == "(false or flags.route_open)"
    assert result.children[0].children[0].children[1].expression == "flags.route_open"
    assert result.children[1].expression == "not flags.alarm"


def test_grouped_operands_preserve_values_and_invalid_diagnostics() -> None:
    valid = _evaluate("(flags.route_open) == true")
    invalid = _evaluate('(quests.quest-missing.status) == "active"')

    assert valid.status == "true"
    assert invalid.status == "invalid"
    assert invalid.diagnostic_code == "unknown_condition_path"
    assert invalid.message == "Grouped condition is invalid."


@pytest.mark.parametrize(
    ("expression", "expected"),
    [
        ("flags.route_open", True),
        ("flags.unset_flag", False),
        ("inventory.item-citadel-key", True),
        ("inventory.item-missing", False),
        ("visited.scene-citadel-gate", True),
        ("visited.scene-unvisited", False),
        ('quests.quest-citadel.status == "active"', True),
        ('"show_key" in dialogue.dialogue-gate.choices', True),
    ],
)
def test_evaluator_reads_every_documented_state_namespace(
    expression: str,
    expected: bool,
) -> None:
    result = _evaluate(expression)

    assert result.value is expected
    assert result.status == ("true" if expected else "false")


@pytest.mark.parametrize(
    ("expression", "expected"),
    [
        ('items.item-ledger.holder.kind == "character"', True),
        ('items.item-ledger.holder.node_id == "character-mara"', True),
        ('items.item-citadel-key.holder.node_id == null', True),
        ("inventory.item-citadel-key", True),
        ("inventory.item-ledger", False),
    ],
)
def test_condition_language_v2_reads_custody_and_compatible_inventory(
    expression: str,
    expected: bool,
) -> None:
    result = evaluate_playback_condition(
        {"condition_version": 2, "expression": expression},
        _state(),
    )

    assert result.value is expected
    assert result.status == ("true" if expected else "false")


@pytest.mark.parametrize(
    "expression",
    [
        'quests.quest-missing.status == "active"',
        '"choice" in dialogue.dialogue-missing.choices',
        "unknown.route_open",
        "quests.quest-citadel.progress",
    ],
)
def test_evaluator_returns_stable_unknown_path_diagnostics(expression: str) -> None:
    result = _evaluate(expression)

    assert result.status == "invalid"
    assert result.value is None
    assert result.diagnostic_code == "unknown_condition_path"
    assert result.message.startswith("Unknown playback state path:")


@pytest.mark.parametrize("operator", ["=", "===", "xor", "&&"])
def test_evaluator_rejects_unknown_operators(operator: str) -> None:
    result = _evaluate(f"flags.route_open {operator} true")

    assert result.status == "invalid"
    assert result.diagnostic_code == "unsupported_condition_operator"
    assert result.message == f"Unsupported condition operator: {operator}."


@pytest.mark.parametrize(
    "expression",
    [
        "len(dialogue.dialogue-gate.choices) > 0",
        '__import__("os")',
        'open("/tmp/playback")',
    ],
)
def test_evaluator_rejects_functions_without_executing_them(expression: str) -> None:
    result = _evaluate(expression)

    assert result.status == "invalid"
    assert result.diagnostic_code == "unsupported_condition_function"
    assert "not supported" in result.message


@pytest.mark.parametrize(
    "expression",
    [
        "",
        "flags.route_open and",
        "[item for item in inventory]",
        '{"$where": "sleep(1)"}',
        "flags.route_open; __import__(\"os\")",
    ],
)
def test_evaluator_returns_stable_malformed_syntax_diagnostics(expression: str) -> None:
    condition = {"condition_version": 1, "expression": expression}
    result = evaluate_playback_condition(condition, _state())

    assert result.status == "invalid"
    assert result.diagnostic_code == "malformed_condition"


def test_evaluator_rejects_unsupported_and_malformed_contracts() -> None:
    unsupported = evaluate_playback_condition(
        {"condition_version": 3, "expression": "true"},
        _state(),
    )
    malformed = evaluate_playback_condition(
        {"condition_version": 1, "expression": 42},
        _state(),
    )

    assert unsupported.diagnostic_code == "unsupported_version"
    assert unsupported.message == "Unsupported condition version: 3."
    assert malformed.diagnostic_code == "malformed_condition"
    assert malformed.expression == "<invalid>"


@pytest.mark.parametrize(
    "expression",
    [
        '"key" in flags.route_open',
        'quests.quest-citadel.status < 1',
        '"truthy"',
        "null",
    ],
)
def test_evaluator_rejects_type_mismatches_without_coercion(expression: str) -> None:
    result = _evaluate(expression)

    assert result.status == "invalid"
    assert result.diagnostic_code == "condition_type_mismatch"


def test_evaluator_does_not_short_circuit_invalid_sibling_conditions() -> None:
    result = _evaluate('true or quests.quest-missing.status == "active"')

    assert result.status == "invalid"
    assert result.diagnostic_code == "unknown_condition_path"
    assert [child.status for child in result.children] == ["true", "invalid"]


def test_evaluator_is_deterministic_and_does_not_mutate_state() -> None:
    state = _state()
    before = deepcopy(state.model_dump(mode="json"))
    condition = PlaybackCondition(
        expression=(
            'flags.route_open and "show_key" in dialogue.dialogue-gate.choices '
            "and inventory.item-citadel-key"
        )
    )
    evaluator = LarkConditionEvaluator()

    first = evaluator.evaluate(condition, state)
    second = evaluator.evaluate(condition, state)

    assert first.model_dump(mode="json") == second.model_dump(mode="json")
    assert state.model_dump(mode="json") == before

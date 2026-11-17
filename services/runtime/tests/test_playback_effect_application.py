from copy import deepcopy
from datetime import UTC, datetime

import pytest
from pydantic import TypeAdapter, ValidationError

from services.runtime.stt_runtime.playback.effect_application import apply_playback_effects
from services.runtime.stt_runtime.schemas.dialogue import (
    DialogueChoiceElement,
    DialogueChoiceOption,
    DialogueDocument,
)
from services.runtime.stt_runtime.schemas.playback import (
    PlaybackCanonicalNode,
    PlaybackDefinition,
    PlaybackEffectApplication,
    PlaybackFact,
    PlaybackState,
    PlaybackStateChange,
    PlaybackTraceEntry,
    PlaybackTypedEffect,
    ReviewedPlaybackEffectAdapter,
)
from services.runtime.stt_runtime.schemas.narrative_state import StateHolderRef
from services.runtime.stt_runtime.schemas.quest import QuestDocument
from services.runtime.stt_runtime.schemas.story_flow import (
    FlowTransition,
    StoryFlow,
    StoryFlowNode,
    StoryFlowSnapshot,
)

NOW = datetime(2026, 7, 27, 12, 0, tzinfo=UTC)
EFFECT_ADAPTER = TypeAdapter(PlaybackTypedEffect)


def _effect(
    effect_id: str,
    operation: str,
    payload: dict[str, object],
    *,
    repeatable: bool = False,
) -> PlaybackTypedEffect:
    return EFFECT_ADAPTER.validate_python({
        "effect_version": 1,
        "id": effect_id,
        "project_id": "project-aurora",
        "flow_id": "flow-main",
        "owner_transition_id": "transition-choice",
        "review_status": "accepted",
        "repeatable": repeatable,
        "explanation": f"Apply {operation}.",
        "operation": operation,
        "payload": payload,
    })


def _definition(
    effects: list[PlaybackTypedEffect],
    *,
    include_quest_document: bool = True,
) -> PlaybackDefinition:
    node_ids = [
        ("character-mara", "Character"),
        ("dialogue-gate", "Dialogue"),
        ("item-citadel-key", "Item"),
        ("quest-citadel", "Quest"),
        ("outcome-gate-open", "Outcome"),
    ]
    flow = StoryFlow(
        id="flow-main",
        project_id="project-aurora",
        name="Citadel Branch",
        kind="main",
        status="active",
        entry_node_id="dialogue-gate",
        created_at=NOW,
        updated_at=NOW,
    )
    snapshot = StoryFlowSnapshot(
        flow=flow,
        nodes=[
            StoryFlowNode(
                id=f"member-{node_id}",
                project_id="project-aurora",
                flow_id=flow.id,
                node_id=node_id,
                presentation_order=index,
                created_at=NOW,
                updated_at=NOW,
            )
            for index, (node_id, _) in enumerate(node_ids)
        ],
        transitions=[
            FlowTransition(
                id="transition-choice",
                project_id="project-aurora",
                flow_id=flow.id,
                source_node_id="dialogue-gate",
                target_node_id="outcome-gate-open",
                priority=0,
                created_at=NOW,
                updated_at=NOW,
            )
        ],
    )
    dialogue = DialogueDocument(
        entry_element_id="choice-gate",
        elements=[
            DialogueChoiceElement(
                id="choice-gate",
                kind="choice",
                prompt="How do you answer?",
                options=[
                    DialogueChoiceOption(id="show_key", text="Show the citadel key."),
                    DialogueChoiceOption(id="leave", text="Leave the gate."),
                ],
            )
        ],
    )
    return PlaybackDefinition(
        project_id="project-aurora",
        flow_snapshot=snapshot,
        canonical_nodes=[
            PlaybackCanonicalNode(
                id=node_id,
                project_id="project-aurora",
                type=node_type,
                title=node_id,
            )
            for node_id, node_type in node_ids
        ],
        dialogue_documents={"dialogue-gate": dialogue},
        quest_documents={"quest-citadel": QuestDocument()} if include_quest_document else {},
        typed_effect_definitions=effects,
        source_revision="revision-effects-1",
    )


@pytest.mark.parametrize(
    ("effect", "state", "path", "before", "after"),
    [
        (
            _effect("effect-set", "set_flag", {"flag": "gate_open"}),
            PlaybackState(),
            "flags.gate_open",
            None,
            True,
        ),
        (
            _effect("effect-clear", "clear_flag", {"flag": "alarm"}),
            PlaybackState(flags={"alarm": True}),
            "flags.alarm",
            True,
            None,
        ),
        (
            _effect("effect-add", "add_inventory", {"node_id": "item-citadel-key"}),
            PlaybackState(),
            "inventory.item-citadel-key",
            False,
            True,
        ),
        (
            _effect("effect-remove", "remove_inventory", {"node_id": "item-citadel-key"}),
            PlaybackState(inventory_node_ids=["item-citadel-key"]),
            "inventory.item-citadel-key",
            True,
            False,
        ),
        (
            _effect(
                "effect-quest",
                "set_quest_status",
                {"quest_node_id": "quest-citadel", "status": "completed"},
            ),
            PlaybackState(quest_states={"quest-citadel": "active"}),
            "quests.quest-citadel.status",
            "active",
            "completed",
        ),
        (
            _effect(
                "effect-dialogue",
                "record_dialogue_choice",
                {"dialogue_node_id": "dialogue-gate", "choice_id": "show_key"},
            ),
            PlaybackState(dialogue_choice_ids={"dialogue-gate": []}),
            "dialogue.dialogue-gate.choices",
            [],
            ["show_key"],
        ),
    ],
)
def test_application_supports_every_allowlisted_operation(
    effect: PlaybackTypedEffect,
    state: PlaybackState,
    path: str,
    before: object,
    after: object,
) -> None:
    result = apply_playback_effects(_definition([effect]), state, [effect.id])

    assert result.success is True
    assert result.applied_effect_ids == [effect.id]
    assert result.changes[0].path == path
    assert result.changes[0].before == before
    assert result.changes[0].after == after
    assert result.state_after.applied_effect_ids == [effect.id]


def test_application_preserves_effect_order_and_produces_trace_ready_changes() -> None:
    set_flag = _effect("effect-set", "set_flag", {"flag": "gate_open"})
    add_item = _effect("effect-add", "add_inventory", {"node_id": "item-citadel-key"})
    definition = _definition([add_item, set_flag])

    result = apply_playback_effects(definition, PlaybackState(), ["effect-set", "effect-add"])
    trace = PlaybackTraceEntry(
        sequence=0,
        node_id="dialogue-gate",
        transition_id="transition-choice",
        applied_effect_ids=result.applied_effect_ids,
        state_changes=result.changes,
        state_before=result.state_before,
        state_after=result.state_after,
        timestamp=NOW,
    )

    assert [change.effect_id for change in result.changes] == ["effect-set", "effect-add"]
    assert trace.state_changes == result.changes
    assert trace.state_before.flags == {}
    assert trace.state_after.flags == {"gate_open": True}


def test_transfer_batch_applies_ordered_custody_and_inventory_compatibility() -> None:
    first = _effect("transfer-player", "transfer_item", {
        "item_node_id": "item-citadel-key",
        "from_holder": {"kind": "unowned"},
        "to_holder": {"kind": "player"},
    })
    second = _effect("transfer-mara", "transfer_item", {
        "item_node_id": "item-citadel-key",
        "from_holder": {"kind": "player"},
        "to_holder": {"kind": "character", "node_id": "character-mara"},
    })

    result = apply_playback_effects(
        _definition([first, second]),
        PlaybackState(item_holders={"item-citadel-key": StateHolderRef(kind="unowned")}),
        [first.id, second.id],
    )

    assert result.success is True
    assert [change.path for change in result.changes] == [
        "items.item-citadel-key.holder",
        "items.item-citadel-key.holder",
    ]
    assert [change.before.kind for change in result.changes] == ["unowned", "player"]
    assert result.state_after.item_holders["item-citadel-key"] == StateHolderRef(
        kind="character", node_id="character-mara"
    )
    assert result.state_after.inventory_node_ids == []


def test_stale_transfer_rejects_the_complete_batch_with_linked_diagnostic() -> None:
    valid = _effect("transfer-player", "transfer_item", {
        "item_node_id": "item-citadel-key",
        "from_holder": {"kind": "unowned"},
        "to_holder": {"kind": "player"},
    })
    stale = _effect("transfer-stale", "transfer_item", {
        "item_node_id": "item-citadel-key",
        "from_holder": {"kind": "unowned"},
        "to_holder": {"kind": "character", "node_id": "character-mara"},
    })
    state = PlaybackState(item_holders={"item-citadel-key": StateHolderRef(kind="unowned")})

    result = apply_playback_effects(_definition([valid, stale]), state, [valid.id, stale.id])

    assert result.success is False
    assert result.state_after == state
    assert result.changes == []
    assert result.facts[0].model_dump(include={"code", "effect_id", "item_node_id", "holder_kind"}) == {
        "code": "stale_item_holder",
        "effect_id": "transfer-stale",
        "item_node_id": "item-citadel-key",
        "holder_kind": "player",
    }


@pytest.mark.parametrize(
    "effect",
    [
        _effect("bad-item", "add_inventory", {"node_id": "outcome-gate-open"}),
        _effect(
            "bad-quest",
            "set_quest_status",
            {"quest_node_id": "quest-citadel", "status": "active"},
        ),
        _effect(
            "bad-dialogue",
            "record_dialogue_choice",
            {"dialogue_node_id": "dialogue-gate", "choice_id": "missing-choice"},
        ),
    ],
)
def test_application_rejects_unknown_or_unplayable_targets(
    effect: PlaybackTypedEffect,
) -> None:
    definition = _definition(
        [effect],
        include_quest_document=effect.id != "bad-quest",
    )
    result = apply_playback_effects(definition, PlaybackState(), [effect.id])

    assert result.success is False
    assert [fact.code for fact in result.facts] == ["malformed_effect"]
    assert result.state_after == result.state_before


def test_application_rejects_unknown_malformed_and_unreviewed_references() -> None:
    accepted = _effect("effect-set", "set_flag", {"flag": "gate_open"})
    definition = _definition([accepted])
    malformed = {
        **accepted.model_dump(mode="python"),
        "payload": {},
    }
    unreviewed = {
        **accepted.model_dump(mode="python"),
        "payload": {"flag": "different_flag"},
    }

    unknown_result = apply_playback_effects(definition, PlaybackState(), ["missing-effect"])
    malformed_result = apply_playback_effects(definition, PlaybackState(), [malformed])
    unreviewed_result = apply_playback_effects(definition, PlaybackState(), [unreviewed])

    assert unknown_result.facts[0].effect_id == "missing-effect"
    assert "malformed typed payload" in malformed_result.facts[0].message
    assert "does not match" in unreviewed_result.facts[0].message
    assert {result.facts[0].code for result in (unknown_result, malformed_result, unreviewed_result)} == {
        "malformed_effect"
    }


@pytest.mark.parametrize(
    "effects",
    [
        [
            _effect("set-flag", "set_flag", {"flag": "gate_open"}),
            _effect("clear-flag", "clear_flag", {"flag": "gate_open"}),
        ],
        [
            _effect("add-item", "add_inventory", {"node_id": "item-citadel-key"}),
            _effect("remove-item", "remove_inventory", {"node_id": "item-citadel-key"}),
        ],
        [
            _effect(
                "start-quest",
                "set_quest_status",
                {"quest_node_id": "quest-citadel", "status": "active"},
            ),
            _effect(
                "fail-quest",
                "set_quest_status",
                {"quest_node_id": "quest-citadel", "status": "failed"},
            ),
        ],
    ],
)
def test_conflicting_scalar_writes_reject_the_complete_batch(
    effects: list[PlaybackTypedEffect],
) -> None:
    state = PlaybackState(flags={"existing": True})
    result = apply_playback_effects(
        _definition(effects),
        state,
        [effect.id for effect in effects],
    )

    assert result.success is False
    assert [fact.code for fact in result.facts] == ["conflicting_effects"]
    assert result.applied_effect_ids == []
    assert result.changes == []
    assert result.state_after == state


def test_duplicate_effect_id_in_one_choice_is_rejected() -> None:
    effect = _effect("effect-set", "set_flag", {"flag": "gate_open"})

    result = apply_playback_effects(
        _definition([effect]),
        PlaybackState(),
        [effect.id, effect.id],
    )

    assert result.success is False
    assert result.facts[0].code == "conflicting_effects"


def test_non_repeatable_effect_blocks_batch_and_repeatable_effect_can_run_again() -> None:
    non_repeatable = _effect("effect-once", "set_flag", {"flag": "gate_open"})
    repeatable = _effect(
        "effect-repeat",
        "record_dialogue_choice",
        {"dialogue_node_id": "dialogue-gate", "choice_id": "show_key"},
        repeatable=True,
    )
    state = PlaybackState(
        dialogue_choice_ids={"dialogue-gate": ["show_key"]},
        applied_effect_ids=["effect-once", "effect-repeat"],
    )
    definition = _definition([non_repeatable, repeatable])

    blocked = apply_playback_effects(definition, state, ["effect-once", "effect-repeat"])
    repeated = apply_playback_effects(definition, state, ["effect-repeat"])

    assert blocked.success is False
    assert blocked.facts[0].code == "repeated_effect"
    assert repeated.success is True
    assert repeated.state_after.applied_effect_ids == ["effect-once", "effect-repeat"]
    assert repeated.changes[0].before == ["show_key"]
    assert repeated.changes[0].after == ["show_key"]


def test_invalid_effect_rolls_back_valid_sibling_and_preserves_inputs() -> None:
    valid = _effect("effect-set", "set_flag", {"flag": "gate_open"})
    invalid = _effect("effect-item", "add_inventory", {"node_id": "outcome-gate-open"})
    definition = _definition([valid, invalid])
    state = PlaybackState(flags={"existing": True})
    definition_before = deepcopy(definition.model_dump(mode="json"))
    state_before = deepcopy(state.model_dump(mode="json"))

    result = apply_playback_effects(definition, state, [valid.id, invalid.id])

    assert result.success is False
    assert result.changes == []
    assert result.state_after.flags == {"existing": True}
    assert definition.model_dump(mode="json") == definition_before
    assert state.model_dump(mode="json") == state_before


def test_successful_application_is_deterministic_and_preserves_inputs() -> None:
    set_flag = _effect("effect-set", "set_flag", {"flag": "gate_open"})
    dialogue = _effect(
        "effect-dialogue",
        "record_dialogue_choice",
        {"dialogue_node_id": "dialogue-gate", "choice_id": "show_key"},
    )
    definition = _definition([set_flag, dialogue])
    state = PlaybackState(dialogue_choice_ids={"dialogue-gate": []})
    definition_before = deepcopy(definition.model_dump(mode="json"))
    state_before = deepcopy(state.model_dump(mode="json"))

    first = apply_playback_effects(definition, state, [set_flag.id, dialogue.id])
    second = apply_playback_effects(definition, state, [set_flag.id, dialogue.id])

    assert first.model_dump(mode="json") == second.model_dump(mode="json")
    assert definition.model_dump(mode="json") == definition_before
    assert state.model_dump(mode="json") == state_before


def test_failure_facts_have_stable_order_independent_of_reference_order() -> None:
    bad_item = _effect("effect-z", "add_inventory", {"node_id": "outcome-gate-open"})
    bad_choice = _effect(
        "effect-a",
        "record_dialogue_choice",
        {"dialogue_node_id": "dialogue-gate", "choice_id": "missing-choice"},
    )
    definition = _definition([bad_item, bad_choice])

    first = apply_playback_effects(definition, PlaybackState(), [bad_item.id, bad_choice.id])
    second = apply_playback_effects(definition, PlaybackState(), [bad_choice.id, bad_item.id])

    assert first.model_dump(mode="json") == second.model_dump(mode="json")
    assert [fact.effect_id for fact in first.facts] == ["effect-a", "effect-z"]


def test_reviewed_specialized_adapters_reject_relationships_and_wrong_mappings() -> None:
    quest_effect = _effect(
        "effect-quest",
        "set_quest_status",
        {"quest_node_id": "quest-citadel", "status": "active"},
    )
    dialogue_effect = _effect(
        "effect-dialogue",
        "record_dialogue_choice",
        {"dialogue_node_id": "dialogue-gate", "choice_id": "show_key"},
    )
    outcome_effect = _effect("effect-outcome", "set_flag", {"flag": "gate_open"})

    outcome = ReviewedPlaybackEffectAdapter(
        source_kind="Outcome",
        source_node_id="outcome-gate-open",
        effect=outcome_effect,
    )
    quest = ReviewedPlaybackEffectAdapter(
        source_kind="Quest",
        source_node_id="quest-citadel",
        effect=quest_effect,
    )
    dialogue = ReviewedPlaybackEffectAdapter(
        source_kind="Dialogue",
        source_node_id="dialogue-gate",
        effect=dialogue_effect,
    )

    assert outcome.effect.id == "effect-outcome"
    assert quest.effect.id == "effect-quest"
    assert dialogue.effect.id == "effect-dialogue"
    with pytest.raises(ValidationError, match="Input should be 'Outcome', 'Quest' or 'Dialogue'"):
        ReviewedPlaybackEffectAdapter.model_validate({
            "source_kind": "Relationship",
            "source_node_id": "relationship-owns",
            "effect": quest_effect,
        })
    with pytest.raises(ValidationError, match="Quest effect adapter requires"):
        ReviewedPlaybackEffectAdapter(
            source_kind="Quest",
            source_node_id="quest-citadel",
            effect=_effect("wrong-operation", "set_flag", {"flag": "quest_active"}),
        )
    with pytest.raises(ValidationError, match="must target its source node"):
        ReviewedPlaybackEffectAdapter(
            source_kind="Dialogue",
            source_node_id="dialogue-other",
            effect=dialogue_effect,
        )


def test_application_contract_rejects_partial_failure_boundaries() -> None:
    state = PlaybackState()
    fact = PlaybackFact(
        code="malformed_effect",
        level="error",
        message="Malformed.",
        action="Repair it.",
        flow_id="flow-main",
    )

    with pytest.raises(ValidationError, match="cannot contain partial changes"):
        PlaybackEffectApplication(
            success=False,
            state_before=state,
            state_after=state,
            applied_effect_ids=["effect-a"],
            changes=[
                PlaybackStateChange(
                    effect_id="effect-a",
                    operation="set_flag",
                    path="flags.ready",
                    before=None,
                    after=True,
                    explanation="Set ready.",
                )
            ],
            facts=[fact],
        )

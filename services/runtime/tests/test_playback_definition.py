from datetime import UTC, datetime

import pytest
from pydantic import TypeAdapter, ValidationError

from services.runtime.stt_runtime.domain.entities import NodeEntity
from services.runtime.stt_runtime.playback.definition_builder import build_playback_definition
from services.runtime.stt_runtime.schemas.dialogue import DialogueDocument
from services.runtime.stt_runtime.schemas.playback import (
    PlaybackChoice,
    PlaybackConditionResult,
    PlaybackDefinition,
    PlaybackFact,
    PlaybackSession,
    PlaybackState,
    PlaybackStateChange,
    PlaybackStep,
    PlaybackTraceEntry,
    PlaybackTypedEffect,
)
from services.runtime.stt_runtime.schemas.quest import QuestDocument
from services.runtime.stt_runtime.schemas.story_flow import (
    FlowTransition,
    StoryFlow,
    StoryFlowNode,
    StoryFlowSnapshot,
)

NOW = datetime(2026, 7, 27, 10, 0, tzinfo=UTC)
EFFECT_ADAPTER = TypeAdapter(PlaybackTypedEffect)


def _flow(entry_node_id: str | None = "dialogue-entry", status: str = "active") -> StoryFlow:
    return StoryFlow(
        id="flow-main",
        project_id="project-aurora",
        name="Main Story",
        kind="main",
        status=status,
        entry_node_id=entry_node_id,
        created_at=NOW,
        updated_at=NOW,
    )


def _member(node_id: str, order: int) -> StoryFlowNode:
    return StoryFlowNode(
        id=f"member-{node_id}",
        project_id="project-aurora",
        flow_id="flow-main",
        node_id=node_id,
        presentation_order=order,
        created_at=NOW,
        updated_at=NOW,
    )


def _snapshot() -> StoryFlowSnapshot:
    return StoryFlowSnapshot(
        flow=_flow(),
        nodes=[
            _member("event-ending", 2),
            _member("quest-route", 1),
            _member("dialogue-entry", 0),
        ],
        transitions=[
            FlowTransition(
                id="transition-ending",
                project_id="project-aurora",
                flow_id="flow-main",
                source_node_id="quest-route",
                target_node_id="event-ending",
                priority=0,
                created_at=NOW,
                updated_at=NOW,
            ),
            FlowTransition(
                id="transition-quest",
                project_id="project-aurora",
                flow_id="flow-main",
                source_node_id="dialogue-entry",
                target_node_id="quest-route",
                priority=0,
                created_at=NOW,
                updated_at=NOW,
            ),
        ],
    )


def _nodes() -> list[NodeEntity]:
    return [
        NodeEntity(
            id="event-ending",
            project_id="project-aurora",
            type="Event",
            title="Departure",
        ),
        NodeEntity(
            id="quest-route",
            project_id="project-aurora",
            type="Quest",
            title="Smuggler Route",
        ),
        NodeEntity(
            id="dialogue-entry",
            project_id="project-aurora",
            type="Dialogue",
            title="Dockmaster Warning",
            metadata={"dialogue_document": {"dialogue_version": 1}},
        ),
    ]


def _effect(effect_id: str = "effect-ledger", **updates: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "effect_version": 1,
        "id": effect_id,
        "project_id": "project-aurora",
        "flow_id": "flow-main",
        "owner_transition_id": "transition-ending",
        "review_status": "accepted",
        "repeatable": False,
        "explanation": "Record that the ledger was presented.",
        "operation": "set_flag",
        "payload": {"flag": "ledger_presented"},
    }
    payload.update(updates)
    return payload


def _build(
    snapshot: StoryFlowSnapshot | dict = None,
    nodes: list[NodeEntity] | None = None,
    effects: list[dict[str, object]] | None = None,
    dialogues: dict[str, object] | None = None,
    quests: dict[str, object] | None = None,
):
    return build_playback_definition(
        snapshot or _snapshot(),
        _nodes() if nodes is None else nodes,
        {"dialogue-entry": DialogueDocument()} if dialogues is None else dialogues,
        {"quest-route": QuestDocument()} if quests is None else quests,
        [_effect()] if effects is None else effects,
        source_revision="revision-aurora-1",
    )


def test_runtime_contracts_reject_invalid_versions_owner_and_state_shapes() -> None:
    with pytest.raises(ValidationError, match="Input should be 1"):
        PlaybackDefinition.model_validate({"definition_version": 2})
    with pytest.raises(ValidationError, match="exactly one node or transition owner"):
        EFFECT_ADAPTER.validate_python({
            **_effect(),
            "owner_node_id": "dialogue-entry",
        })
    with pytest.raises(ValidationError, match="requires a boolean value"):
        PlaybackConditionResult(expression="flags.ready", status="true", message="Ready")
    with pytest.raises(ValidationError, match="inventory node ids must be unique"):
        PlaybackState(inventory_node_ids=["item-a", "item-a"])


@pytest.mark.parametrize(
    ("operation", "payload"),
    [
        ("set_flag", {"flag": "route_open"}),
        ("clear_flag", {"flag": "route_open"}),
        ("add_inventory", {"node_id": "item-ledger"}),
        ("remove_inventory", {"node_id": "item-ledger"}),
        ("set_quest_status", {"quest_node_id": "quest-route", "status": "active"}),
        ("record_dialogue_choice", {"dialogue_node_id": "dialogue-entry", "choice_id": "answer-ledger"}),
    ],
)
def test_typed_effect_contract_parses_every_allowlisted_operation(operation: str, payload: dict) -> None:
    parsed = EFFECT_ADAPTER.validate_python({
        **_effect(),
        "operation": operation,
        "payload": payload,
    })

    assert parsed.operation == operation
    assert parsed.payload.model_dump() == payload


def test_session_step_choice_trace_and_fact_payloads_compose() -> None:
    condition = PlaybackConditionResult(
        expression="flags.ledger_presented",
        status="true",
        value=True,
        message="Ledger was presented.",
    )
    fact = PlaybackFact(
        code="ending_reached",
        level="info",
        message="Departure is an ending.",
        action="Restart or return to authoring.",
        flow_id="flow-main",
        node_id="event-ending",
    )
    before = PlaybackState()
    after = PlaybackState(
        flags={"ledger_presented": True},
        visited_node_ids=["dialogue-entry", "event-ending"],
        applied_effect_ids=["effect-ledger"],
    )
    choice = PlaybackChoice(
        transition_id="transition-ending",
        source_node_id="dialogue-entry",
        target_node_id="event-ending",
        kind="next",
        priority=0,
        eligible=True,
        condition_result=condition,
        effect_ids=["effect-ledger"],
    )
    step = PlaybackStep(
        node_id="event-ending",
        node_kind="Event",
        title="Departure",
        choices=[],
        facts=[fact],
    )
    trace = PlaybackTraceEntry(
        sequence=0,
        node_id="dialogue-entry",
        transition_id=choice.transition_id,
        condition_results=[condition],
        applied_effect_ids=["effect-ledger"],
        state_changes=[
            PlaybackStateChange(
                effect_id="effect-ledger",
                operation="set_flag",
                path="flags.ledger_presented",
                before=None,
                after=True,
                explanation="Record that the ledger was presented.",
            )
        ],
        state_before=before,
        state_after=after,
        timestamp=NOW,
    )
    session = PlaybackSession(
        id="session-a",
        project_id="project-aurora",
        flow_id="flow-main",
        source_revision="revision-aurora-1",
        status="ended",
        current_node_id="event-ending",
        state=after,
        step=step,
        trace=[trace],
        facts=[fact],
    )

    assert session.step is not None and session.step.facts[0].code == "ending_reached"
    assert session.trace[0].state_after.flags == {"ledger_presented": True}


def test_builder_normalizes_complete_definition_without_mutating_inputs() -> None:
    snapshot = _snapshot()
    nodes = _nodes()
    snapshot_before = snapshot.model_dump(mode="json")
    node_metadata_before = nodes[2].metadata.copy()

    first = _build(snapshot=snapshot, nodes=nodes, effects=[_effect("effect-z"), _effect("effect-a")])
    second = _build(snapshot=snapshot, nodes=list(reversed(nodes)), effects=[_effect("effect-a"), _effect("effect-z")])

    assert first.facts == []
    assert first.definition is not None
    assert [node.id for node in first.definition.canonical_nodes] == [
        "dialogue-entry",
        "quest-route",
        "event-ending",
    ]
    assert [effect.id for effect in first.definition.typed_effect_definitions] == ["effect-a", "effect-z"]
    assert first.definition.dialogue_documents["dialogue-entry"].dialogue_version == 1
    assert first.definition.quest_documents["quest-route"].quest_version == 1
    assert first.model_dump(mode="json") == second.model_dump(mode="json")
    assert snapshot.model_dump(mode="json") == snapshot_before
    assert nodes[2].metadata == node_metadata_before


def test_empty_and_invalid_flow_inputs_return_facts_without_partial_definition() -> None:
    empty = StoryFlowSnapshot(flow=_flow(entry_node_id=None, status="draft"))
    empty_result = _build(snapshot=empty, nodes=[], effects=[], dialogues={})
    invalid = _snapshot().model_dump(mode="python")
    invalid["flow"]["entry_node_id"] = "missing-entry"
    invalid["transitions"][0]["source_node_id"] = "missing-source"

    invalid_result = _build(snapshot=invalid)

    assert [fact.code for fact in empty_result.facts] == ["empty_flow"]
    assert empty_result.definition is None
    assert [fact.code for fact in invalid_result.facts] == ["dangling_source", "invalid_entry"]
    assert invalid_result.definition is None


def test_builder_reports_missing_extra_and_cross_project_canonical_nodes() -> None:
    cross_project = NodeEntity(
        id="dialogue-entry",
        project_id="project-other",
        type="Dialogue",
        title="Wrong owner",
    )
    extra = NodeEntity(
        id="world-lore",
        project_id="project-aurora",
        type="Lore",
        title="Outside flow",
    )

    result = _build(nodes=[cross_project, extra], effects=[], dialogues={}, quests={})

    assert [(fact.code, fact.node_id) for fact in result.facts] == [
        ("missing_member", "event-ending"),
        ("missing_member", "quest-route"),
        ("stale_ownership", "dialogue-entry"),
        ("stale_ownership", "world-lore"),
    ]
    assert result.definition is None


def test_builder_reports_duplicate_and_stale_reviewed_effects() -> None:
    duplicate = _build(effects=[_effect(), _effect()])
    stale = _build(effects=[_effect(owner_transition_id="transition-removed")])

    assert [(fact.code, fact.effect_id) for fact in duplicate.facts] == [
        ("duplicate_effect_id", "effect-ledger")
    ]
    assert [(fact.code, fact.effect_id) for fact in stale.facts] == [
        ("stale_ownership", "effect-ledger")
    ]
    assert duplicate.definition is None
    assert stale.definition is None


def test_builder_reports_unsupported_snapshot_document_and_effect_versions() -> None:
    snapshot = _snapshot().model_dump(mode="python")
    snapshot["snapshot_version"] = 2
    unsupported_snapshot = _build(snapshot=snapshot)
    unsupported_documents = _build(
        dialogues={"dialogue-entry": {"dialogue_version": 2}},
        effects=[{**_effect(), "effect_version": 2}],
    )

    assert [fact.code for fact in unsupported_snapshot.facts] == ["unsupported_version"]
    assert [(fact.code, fact.node_id, fact.effect_id) for fact in unsupported_documents.facts] == [
        ("unsupported_version", None, "effect-ledger"),
        ("unsupported_version", "dialogue-entry", None),
    ]

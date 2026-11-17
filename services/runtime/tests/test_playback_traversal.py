from copy import deepcopy
from datetime import UTC, datetime

import pytest
from pydantic import TypeAdapter

from services.runtime.stt_runtime.playback.traversal_service import (
    PlaybackSessionService,
    PlaybackSessionServiceError,
)
from services.runtime.stt_runtime.schemas.playback import (
    PlaybackCanonicalNode,
    PlaybackDefinition,
    PlaybackState,
    PlaybackTypedEffect,
)
from services.runtime.stt_runtime.schemas.playback_api import PlaybackPrepareCommand
from services.runtime.stt_runtime.schemas.composable_story_flow import (
    ComposableFlowGraph,
    FlowExit,
    FlowExitBinding,
    FlowInvocation,
)
from services.runtime.stt_runtime.schemas.dialogue import (
    DialogueChoiceElement,
    DialogueChoiceOption,
    DialogueDocument,
    DialogueLineElement,
)
from services.runtime.stt_runtime.schemas.quest import QuestBranch, QuestDocument, QuestStage
from services.runtime.stt_runtime.schemas.story_flow import (
    FlowTransition,
    StoryFlow,
    StoryFlowNode,
    StoryFlowSnapshot,
)

NOW = datetime(2026, 7, 27, 14, 0, tzinfo=UTC)
EFFECT_ADAPTER = TypeAdapter(PlaybackTypedEffect)


def _transition(
    transition_id: str,
    source: str,
    target: str,
    priority: int,
    *,
    kind: str = "next",
    condition: str = "",
    is_default: bool = False,
) -> FlowTransition:
    return FlowTransition(
        id=transition_id,
        project_id="project-aurora",
        flow_id="flow-main",
        source_node_id=source,
        target_node_id=target,
        kind=kind,
        label=transition_id,
        condition=condition,
        priority=priority,
        is_default=is_default,
        created_at=NOW,
        updated_at=NOW,
    )


def _effect(
    effect_id: str,
    operation: str,
    payload: dict[str, object],
    *,
    owner_node_id: str | None = None,
    owner_transition_id: str | None = None,
    owner_kind: str | None = None,
    owner_id: str | None = None,
    context_node_id: str | None = None,
    application_order: int = 0,
    repeatable: bool = False,
) -> PlaybackTypedEffect:
    return EFFECT_ADAPTER.validate_python({
        "effect_version": 1,
        "id": effect_id,
        "project_id": "project-aurora",
        "flow_id": "flow-main",
        "owner_node_id": owner_node_id,
        "owner_transition_id": owner_transition_id,
        "review_status": "accepted",
        "repeatable": repeatable,
        "explanation": f"Apply {operation}.",
        "owner_kind": owner_kind,
        "owner_id": owner_id,
        "context_node_id": context_node_id,
        "application_order": application_order,
        "operation": operation,
        "payload": payload,
    })


def _definition(
    *,
    node_types: dict[str, str],
    transitions: list[FlowTransition],
    entry: str,
    effects: list[PlaybackTypedEffect] | None = None,
    source_revision: str = "revision-1",
) -> PlaybackDefinition:
    flow = StoryFlow(
        id="flow-main",
        project_id="project-aurora",
        name="Main Story",
        kind="main",
        status="active",
        entry_node_id=entry,
        created_at=NOW,
        updated_at=NOW,
    )
    return PlaybackDefinition(
        project_id="project-aurora",
        flow_snapshot=StoryFlowSnapshot(
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
                for index, node_id in enumerate(node_types)
            ],
            transitions=transitions,
        ),
        canonical_nodes=[
            PlaybackCanonicalNode(
                id=node_id,
                project_id="project-aurora",
                type=node_type,
                title=node_id.replace("-", " ").title(),
                summary=f"Summary for {node_id}.",
            )
            for node_id, node_type in node_types.items()
        ],
        typed_effect_definitions=effects or [],
        source_revision=source_revision,
    )


def _service(session_id: str = "session-1") -> PlaybackSessionService:
    return PlaybackSessionService(
        clock=lambda: NOW,
        id_factory=lambda: session_id,
    )


def _branch_definition(*, source_revision: str = "revision-1") -> PlaybackDefinition:
    return _definition(
        node_types={
            "event-entry": "Event",
            "event-route-a": "Event",
            "event-route-b": "Event",
            "event-ending": "Event",
        },
        transitions=[
            _transition(
                "transition-a",
                "event-entry",
                "event-route-a",
                0,
                kind="branch",
                condition="flags.route_a",
            ),
            _transition(
                "transition-default",
                "event-entry",
                "event-route-b",
                1,
                kind="branch",
                is_default=True,
            ),
            _transition("transition-a-end", "event-route-a", "event-ending", 0),
            _transition("transition-b-end", "event-route-b", "event-ending", 0),
        ],
        entry="event-entry",
        source_revision=source_revision,
    )


def _composed_definition(*, include_nested_binding: bool = True, root_flow_id: str = "flow-main") -> PlaybackDefinition:
    """Build a two-level call graph whose exits cascade back to Main."""

    root = _definition(
        node_types={"root-start": "Event", "root-ending": "Outcome", "item-key": "Item"},
        transitions=[],
        entry="root-start",
    ).flow_snapshot
    side = StoryFlowSnapshot(
        flow=StoryFlow(id="flow-side", project_id="project-aurora", name="Side", kind="side", status="active", entry_node_id="side-entry", created_at=NOW, updated_at=NOW),
        nodes=[
            StoryFlowNode(id="side-entry-member", project_id="project-aurora", flow_id="flow-side", node_id="side-entry", presentation_order=0, created_at=NOW, updated_at=NOW),
            StoryFlowNode(id="side-exit-member", project_id="project-aurora", flow_id="flow-side", node_id="side-exit", presentation_order=1, created_at=NOW, updated_at=NOW),
        ],
    )
    nested = StoryFlowSnapshot(
        flow=StoryFlow(id="flow-nested", project_id="project-aurora", name="Nested", kind="side", status="active", entry_node_id="nested-exit", created_at=NOW, updated_at=NOW),
        nodes=[StoryFlowNode(id="nested-exit-member", project_id="project-aurora", flow_id="flow-nested", node_id="nested-exit", presentation_order=0, created_at=NOW, updated_at=NOW)],
    )
    root_call = FlowInvocation(id="call-root-side", project_id="project-aurora", source_flow_id="flow-main", source_node_id="root-start", target_flow_id="flow-side", label="Enter side", priority=0, created_at=NOW, updated_at=NOW)
    nested_call = FlowInvocation(id="call-side-nested", project_id="project-aurora", source_flow_id="flow-side", source_node_id="side-entry", target_flow_id="flow-nested", label="Enter nested", priority=0, created_at=NOW, updated_at=NOW)
    nested_exit = FlowExit(id="exit-nested", project_id="project-aurora", flow_id="flow-nested", key="nested_success", label="Nested complete", source_node_id="nested-exit", created_at=NOW, updated_at=NOW)
    side_exit = FlowExit(id="exit-side", project_id="project-aurora", flow_id="flow-side", key="success", label="Side complete", source_node_id="side-exit", created_at=NOW, updated_at=NOW)
    bindings = [FlowExitBinding(id="binding-side-root", project_id="project-aurora", invocation_id=root_call.id, exit_id=side_exit.id, target_node_id="root-ending", created_at=NOW, updated_at=NOW)]
    if include_nested_binding:
        bindings.append(FlowExitBinding(id="binding-nested-side", project_id="project-aurora", invocation_id=nested_call.id, exit_id=nested_exit.id, target_node_id="side-exit", created_at=NOW, updated_at=NOW))
    composition = ComposableFlowGraph(project_id="project-aurora", flows=[root.flow, side.flow, nested.flow], memberships=[*root.nodes, *side.nodes, *nested.nodes], transitions=[], invocations=[root_call, nested_call], exits=[nested_exit, side_exit], bindings=bindings)
    nested_effect = _effect("effect-nested", "set_flag", {"flag": "nested_done"}, owner_node_id="nested-exit").model_copy(update={"flow_id": "flow-nested"})
    return_effect = _effect("effect-return", "add_inventory", {"node_id": "item-key"}, owner_node_id="root-ending")
    snapshots = [root, side, nested]
    selected = next(snapshot for snapshot in snapshots if snapshot.flow.id == root_flow_id)
    return PlaybackDefinition(
        project_id="project-aurora",
        flow_snapshot=selected,
        flow_snapshots=snapshots,
        composition=composition,
        canonical_nodes=[
            PlaybackCanonicalNode(id=node_id, project_id="project-aurora", type=node_type, title=node_id, summary="")
            for node_id, node_type in {"root-start": "Event", "root-ending": "Outcome", "item-key": "Item", "side-entry": "Quest", "side-exit": "Event", "nested-exit": "Event"}.items()
        ],
        typed_effect_definitions=[nested_effect, return_effect],
        source_revision="composed-revision",
    )


def test_prepare_command_builds_definition_or_stable_facts() -> None:
    definition = _branch_definition()
    command = PlaybackPrepareCommand(
        snapshot=definition.flow_snapshot.model_dump(mode="python"),
        canonical_nodes=definition.canonical_nodes,
        source_revision=definition.source_revision,
    )
    invalid_snapshot = definition.flow_snapshot.model_dump(mode="python")
    invalid_snapshot["flow"]["entry_node_id"] = "missing"
    invalid = command.model_copy(update={"snapshot": invalid_snapshot})
    service = _service()

    prepared = service.prepare(command)
    rejected = service.prepare(invalid)

    assert prepared.definition is not None
    assert prepared.definition.source_revision == "revision-1"
    assert rejected.definition is None
    assert [fact.code for fact in rejected.facts] == ["invalid_entry"]


def test_nested_calls_apply_effects_return_and_restore_stack_on_back_restart() -> None:
    service = _service()
    definition = _composed_definition()
    started = service.start(definition)

    entered_side = service.choose(started.id, "call-root-side", source_revision=definition.source_revision)
    returned = service.choose(started.id, "call-side-nested", source_revision=definition.source_revision)

    assert entered_side.current_flow_id == "flow-side"
    assert [frame.invocation_id for frame in entered_side.call_stack] == ["call-root-side"]
    assert returned.current_flow_id == "flow-main"
    assert returned.current_node_id == "root-ending"
    assert returned.call_stack == []
    assert returned.status == "ended"
    assert returned.state.flags == {"nested_done": True}
    assert returned.state.inventory_node_ids == ["item-key"]
    assert [event.operation for event in returned.trace[-1].events] == ["call", "exit", "return", "exit", "return"]

    backed = service.back(started.id, source_revision=definition.source_revision)
    assert backed.current_flow_id == "flow-side"
    assert backed.current_node_id == "side-entry"
    assert [frame.invocation_id for frame in backed.call_stack] == ["call-root-side"]
    assert backed.state.flags == {}
    assert backed.state.inventory_node_ids == []

    restarted = service.restart(started.id, definition)
    assert restarted.current_flow_id == "flow-main"
    assert restarted.current_node_id == "root-start"
    assert restarted.call_stack == []
    assert restarted.trace == []


def test_nested_call_return_back_and_restart_preserve_exact_custody_boundaries() -> None:
    service = _service()
    definition = _composed_definition()
    transfer = _effect(
        "effect-transfer-key",
        "transfer_item",
        {
            "item_node_id": "item-key",
            "from_holder": {"kind": "unowned"},
            "to_holder": {"kind": "party"},
        },
        owner_transition_id="exit-nested",
        owner_kind="flow_exit",
        owner_id="exit-nested",
    ).model_copy(update={"flow_id": "flow-nested", "authored_effect_id": "authored-transfer-key"})
    definition = definition.model_copy(update={
        "typed_effect_definitions": [definition.typed_effect_definitions[0], transfer],
    })
    started = service.start(definition)

    service.choose(started.id, "call-root-side", source_revision=definition.source_revision)
    returned = service.choose(started.id, "call-side-nested", source_revision=definition.source_revision)

    assert returned.current_flow_id == "flow-main"
    assert returned.state.item_holders["item-key"].kind == "party"
    assert returned.state.inventory_node_ids == ["item-key"]
    assert returned.trace[-1].state_before.item_holders == {}
    assert returned.trace[-1].state_after.item_holders["item-key"].kind == "party"
    assert any(change.path == "items.item-key.holder" for change in returned.trace[-1].state_changes)
    custody_change = next(change for change in returned.trace[-1].state_changes if change.path == "items.item-key.holder")
    assert custody_change.authored_effect_id == "authored-transfer-key"

    backed = service.back(started.id, source_revision=definition.source_revision)
    assert backed.current_flow_id == "flow-side"
    assert backed.state.item_holders == {}
    assert backed.state.inventory_node_ids == []

    restarted = service.restart(started.id, definition)
    assert restarted.current_flow_id == "flow-main"
    assert restarted.state.item_holders == {}
    assert restarted.trace == []


def test_completed_dialogue_outcome_can_take_its_node_level_flow_call() -> None:
    """A specialized Dialogue outcome may call a flow instead of owning a transition."""

    root = _definition(
        node_types={"dialogue-root": "Dialogue", "root-unused": "Event", "root-return": "Outcome"},
        transitions=[],
        entry="dialogue-root",
    ).flow_snapshot
    unrelated = FlowTransition(
        id="transition-other-outcome",
        project_id="project-aurora",
        flow_id="flow-main",
        source_node_id="dialogue-root",
        target_node_id="root-unused",
        kind="next",
        label="Other outcome",
        priority=0,
        metadata={"dialogue_element_id": "other-outcome"},
        created_at=NOW,
        updated_at=NOW,
    )
    root = root.model_copy(update={"transitions": [unrelated]})
    side = StoryFlowSnapshot(
        flow=StoryFlow(id="flow-side", project_id="project-aurora", name="Dialogue side", kind="side", status="active", entry_node_id="side-exit", created_at=NOW, updated_at=NOW),
        nodes=[StoryFlowNode(id="member-side-exit", project_id="project-aurora", flow_id="flow-side", node_id="side-exit", presentation_order=0, created_at=NOW, updated_at=NOW)],
    )
    invocation = FlowInvocation(id="call-dialogue-side", project_id="project-aurora", source_flow_id="flow-main", source_node_id="dialogue-root", target_flow_id="flow-side", label="Enter dialogue outcome", priority=1, is_default=True, created_at=NOW, updated_at=NOW)
    flow_exit = FlowExit(id="exit-dialogue-side", project_id="project-aurora", flow_id="flow-side", key="success", label="Dialogue outcome complete", source_node_id="side-exit", created_at=NOW, updated_at=NOW)
    binding = FlowExitBinding(id="binding-dialogue-side", project_id="project-aurora", invocation_id=invocation.id, exit_id=flow_exit.id, target_node_id="root-return", created_at=NOW, updated_at=NOW)
    definition = PlaybackDefinition(
        project_id="project-aurora",
        flow_snapshot=root,
        flow_snapshots=[root, side],
        composition=ComposableFlowGraph(project_id="project-aurora", flows=[root.flow, side.flow], memberships=[*root.nodes, *side.nodes], transitions=[unrelated], invocations=[invocation], exits=[flow_exit], bindings=[binding]),
        canonical_nodes=[
            PlaybackCanonicalNode(id=node_id, project_id="project-aurora", type=node_type, title=node_id)
            for node_id, node_type in {"dialogue-root": "Dialogue", "root-unused": "Event", "root-return": "Outcome", "side-exit": "Event"}.items()
        ],
        dialogue_documents={
            "dialogue-root": DialogueDocument(
                entry_element_id="choice-root",
                elements=[DialogueChoiceElement(id="choice-root", kind="choice", prompt="Choose", options=[DialogueChoiceOption(id="call-outcome", text="Take side outcome")])],
            )
        },
        source_revision="dialogue-call-revision",
    )
    service = _service()

    started = service.start(definition)
    completed_dialogue = service.choose(
        started.id,
        None,
        dialogue_option_id="call-outcome",
        source_revision=definition.source_revision,
    )

    assert completed_dialogue.status == "active"
    assert [(choice.transition_id, choice.eligible) for choice in completed_dialogue.step.choices] == [
        ("call-dialogue-side", True)
    ]
    returned = service.choose(started.id, "call-dialogue-side", source_revision=definition.source_revision)
    assert returned.current_node_id == "root-return"
    assert [event.operation for event in returned.trace[-1].events] == ["call", "exit", "return"]


def test_dialogue_option_and_terminal_element_apply_one_reversible_effect_boundary() -> None:
    option_effect = _effect(
        "binding-option",
        "set_flag",
        {"flag": "ledger_presented"},
        owner_node_id="dialogue-root",
        owner_kind="dialogue_option",
        owner_id="answer-ledger",
        context_node_id="dialogue-root",
        application_order=0,
    )
    outcome_effect = _effect(
        "binding-outcome",
        "transfer_item",
        {
            "item_node_id": "item-ledger",
            "from_holder": {"kind": "character", "node_id": "character-ilya"},
            "to_holder": {"kind": "character", "node_id": "character-mara"},
        },
        owner_node_id="dialogue-root",
        owner_kind="dialogue_element",
        owner_id="line-concedes",
        context_node_id="dialogue-root",
        application_order=0,
    )
    definition = _definition(
        node_types={
            "dialogue-root": "Dialogue",
            "outcome-end": "Outcome",
            "item-ledger": "Item",
            "character-ilya": "Character",
            "character-mara": "Character",
        },
        transitions=[_transition("transition-finish", "dialogue-root", "outcome-end", 0)],
        entry="dialogue-root",
        effects=[],
    ).model_copy(update={
        "typed_effect_definitions": [option_effect, outcome_effect],
        "dialogue_documents": {
            "dialogue-root": DialogueDocument(
                entry_element_id="choice-root",
                participants=["character-ilya"],
                elements=[
                    DialogueChoiceElement(id="choice-root", kind="choice", options=[DialogueChoiceOption(id="answer-ledger", text="Present ledger", next_element_id="line-concedes")]),
                    DialogueLineElement(id="line-concedes", kind="line", speaker_node_id="character-ilya", text="Accepted."),
                ],
            )
        },
        "initial_state": PlaybackState(item_holders={"item-ledger": {"kind": "character", "node_id": "character-ilya"}}),
    })
    definition = PlaybackDefinition.model_validate(definition.model_dump())
    service = _service()
    started = service.start(definition)

    completed = service.choose(started.id, None, dialogue_option_id="answer-ledger", source_revision=definition.source_revision)

    assert completed.state.flags == {"ledger_presented": True}
    assert completed.state.item_holders["item-ledger"].node_id == "character-mara"
    assert completed.trace[-1].applied_effect_ids == ["binding-option", "binding-outcome"]
    assert [change.path for change in completed.trace[-1].state_changes] == [
        "flags.ledger_presented",
        "items.item-ledger.holder",
    ]
    backed = service.back(started.id, source_revision=definition.source_revision)
    assert backed.state.flags == {}
    assert backed.state.item_holders["item-ledger"].node_id == "character-ilya"
    assert backed.dialogue_path.option_ids == []


def test_terminal_quest_branch_applies_outcome_and_reward_before_transition() -> None:
    complete = _effect(
        "binding-quest-complete",
        "set_quest_status",
        {"quest_node_id": "quest-route", "status": "completed"},
        owner_node_id="quest-route",
        owner_kind="quest_outcome",
        owner_id="branch-success",
        context_node_id="quest-route",
        application_order=0,
    )
    reward = _effect(
        "binding-quest-reward",
        "transfer_item",
        {
            "item_node_id": "item-ledger",
            "from_holder": {"kind": "character", "node_id": "character-mara"},
            "to_holder": {"kind": "party"},
        },
        owner_node_id="quest-route",
        owner_kind="quest_outcome",
        owner_id="branch-success",
        context_node_id="quest-route",
        application_order=1,
    )
    transition = _transition("transition-quest", "quest-route", "event-run", 0).model_copy(
        update={"metadata": {"quest_branch_id": "branch-success"}}
    )
    definition = _definition(
        node_types={"quest-route": "Quest", "event-run": "Event", "item-ledger": "Item", "character-mara": "Character"},
        transitions=[transition],
        entry="quest-route",
        effects=[],
    ).model_copy(update={
        "typed_effect_definitions": [reward, complete],
        "quest_documents": {
            "quest-route": QuestDocument(
                entry_stage_id="stage-route",
                stages=[QuestStage(id="stage-route", title="Route", branches=[QuestBranch(id="branch-success", label="Run", target_stage_id=None)])],
            )
        },
        "initial_state": PlaybackState(
            item_holders={"item-ledger": {"kind": "character", "node_id": "character-mara"}},
            quest_states={"quest-route": "active"},
        ),
    })
    definition = PlaybackDefinition.model_validate(definition.model_dump())
    service = _service()
    started = service.start(definition)

    chosen = service.choose(started.id, "transition-quest", source_revision=definition.source_revision)

    assert chosen.state.quest_states["quest-route"] == "completed"
    assert chosen.state.item_holders["item-ledger"].kind == "party"
    assert chosen.trace[-1].applied_effect_ids == ["binding-quest-complete", "binding-quest-reward"]


def test_direct_side_flow_reports_its_named_terminal_exit() -> None:
    service = _service()
    definition = _composed_definition(root_flow_id="flow-nested")

    started = service.start(definition)

    assert started.status == "ended"
    assert started.current_flow_id == "flow-nested"
    assert started.terminal_exit is not None
    assert (started.terminal_exit.key, started.terminal_exit.label) == ("nested_success", "Nested complete")


def test_missing_nested_exit_binding_blocks_at_the_callee_source() -> None:
    service = _service()
    definition = _composed_definition(include_nested_binding=False)
    started = service.start(definition)
    service.choose(started.id, "call-root-side", source_revision=definition.source_revision)

    blocked = service.choose(started.id, "call-side-nested", source_revision=definition.source_revision)

    assert blocked.status == "blocked"
    assert blocked.current_flow_id == "flow-nested"
    assert blocked.current_node_id == "nested-exit"
    assert [frame.invocation_id for frame in blocked.call_stack] == ["call-root-side", "call-side-nested"]
    assert [fact.code for fact in blocked.facts] == ["ending_reached", "missing_exit_binding"]
    assert [event.operation for event in blocked.trace[-1].events] == ["call", "exit"]


def test_start_evaluates_conditioned_choices_and_default_fallback() -> None:
    service = _service()

    conditioned = service.start(
        _branch_definition(),
        initial_state=PlaybackState(flags={"route_a": True}),
    )
    fallback_service = _service("session-2")
    fallback = fallback_service.start(_branch_definition())

    assert conditioned.status == "active"
    assert [(choice.transition_id, choice.eligible) for choice in conditioned.step.choices] == [
        ("transition-a", True),
        ("transition-default", False),
    ]
    assert fallback.step.choices[0].eligible is False
    assert fallback.step.choices[1].eligible is True


def test_choose_applies_transition_and_target_effects_in_one_trace_boundary() -> None:
    transition_effect = _effect(
        "effect-transition",
        "set_flag",
        {"flag": "gate_open"},
        owner_transition_id="transition-open",
    )
    target_effect = _effect(
        "effect-target",
        "add_inventory",
        {"node_id": "item-key"},
        owner_node_id="outcome-open",
    )
    definition = _definition(
        node_types={
            "event-entry": "Event",
            "outcome-open": "Outcome",
            "item-key": "Item",
        },
        transitions=[
            _transition("transition-open", "event-entry", "outcome-open", 0),
        ],
        entry="event-entry",
        effects=[target_effect, transition_effect],
    )
    service = _service()
    started = service.start(definition)

    chosen = service.choose(
        started.id,
        "transition-open",
        source_revision="revision-1",
    )

    assert chosen.status == "ended"
    assert chosen.current_node_id == "outcome-open"
    assert chosen.state.flags == {"gate_open": True}
    assert chosen.state.inventory_node_ids == ["item-key"]
    assert chosen.trace[0].applied_effect_ids == ["effect-transition", "effect-target"]
    assert [change.path for change in chosen.trace[0].state_changes] == [
        "flags.gate_open",
        "inventory.item-key",
    ]
    assert chosen.facts[0].code == "ending_reached"


def test_entry_node_effect_runs_on_start_and_restart() -> None:
    entry_effect = _effect(
        "effect-entry",
        "set_flag",
        {"flag": "entered"},
        owner_node_id="event-entry",
    )
    definition = _definition(
        node_types={"event-entry": "Event"},
        transitions=[],
        entry="event-entry",
        effects=[entry_effect],
    )
    service = _service()

    started = service.start(definition)
    restarted = service.restart(started.id, definition)

    assert started.state.flags == {"entered": True}
    assert started.state.applied_effect_ids == ["effect-entry"]
    assert restarted.state.flags == {"entered": True}
    assert restarted.trace == []


def test_back_restores_boundary_and_new_choice_discards_abandoned_branch() -> None:
    definition = _definition(
        node_types={
            "event-entry": "Event",
            "event-route-a": "Event",
            "event-route-b": "Event",
            "event-ending": "Event",
        },
        transitions=[
            _transition("transition-a", "event-entry", "event-route-a", 0, kind="optional"),
            _transition("transition-b", "event-entry", "event-route-b", 1, kind="optional"),
            _transition("transition-a-end", "event-route-a", "event-ending", 0),
        ],
        entry="event-entry",
    )
    service = _service()
    started = service.start(definition)
    route_a = service.choose(
        started.id,
        "transition-a",
        source_revision="revision-1",
    )
    ended = service.choose(
        route_a.id,
        "transition-a-end",
        source_revision="revision-1",
    )

    back_to_a = service.back(ended.id, source_revision="revision-1")
    back_to_entry = service.back(back_to_a.id, source_revision="revision-1")
    route_b = service.choose(
        back_to_entry.id,
        "transition-b",
        source_revision="revision-1",
    )

    assert back_to_a.current_node_id == "event-route-a"
    assert len(back_to_a.trace) == 1
    assert back_to_entry.current_node_id == "event-entry"
    assert back_to_entry.trace == []
    assert route_b.current_node_id == "event-route-b"
    assert [entry.transition_id for entry in route_b.trace] == ["transition-b"]


def test_back_response_mutation_does_not_change_internal_session() -> None:
    service = _service()
    started = service.start(_branch_definition())
    started.state.flags["external"] = True

    inspected = service.inspect(started.id, "revision-1")

    assert inspected.state.flags == {}


def test_cycle_requires_explicit_threshold_override() -> None:
    definition = _definition(
        node_types={"event-a": "Event", "event-b": "Event"},
        transitions=[
            _transition("transition-ab", "event-a", "event-b", 0),
            _transition("transition-ba", "event-b", "event-a", 0, kind="return"),
        ],
        entry="event-a",
    )
    service = _service()
    started = service.start(definition, visit_threshold=1)
    at_b = service.choose(started.id, "transition-ab", source_revision="revision-1")

    blocked = service.choose(at_b.id, "transition-ba", source_revision="revision-1")
    continued = service.choose(
        at_b.id,
        "transition-ba",
        source_revision="revision-1",
        allow_visit_threshold=True,
    )

    assert blocked.status == "blocked"
    assert blocked.current_node_id == "event-b"
    assert blocked.facts[-1].code == "visit_threshold"
    assert continued.status == "active"
    assert continued.current_node_id == "event-a"
    assert len(continued.trace) == 2


def test_invalid_conditions_without_default_block_with_stable_facts() -> None:
    definition = _definition(
        node_types={"event-entry": "Event", "event-ending": "Event"},
        transitions=[
            _transition(
                "transition-invalid",
                "event-entry",
                "event-ending",
                0,
                kind="branch",
                condition="unknown.path",
            )
        ],
        entry="event-entry",
    )

    session = _service().start(definition)

    assert session.status == "blocked"
    assert session.step.choices[0].eligible is False
    assert [fact.code for fact in session.facts] == [
        "missing_default_branch",
        "no_eligible_transition",
        "unknown_condition_path",
    ]


def test_multiple_unconditional_transitions_are_ordered_and_reported() -> None:
    definition = _definition(
        node_types={"event-entry": "Event", "event-a": "Event", "event-b": "Event"},
        transitions=[
            _transition("transition-b", "event-entry", "event-b", 1, kind="optional"),
            _transition("transition-a", "event-entry", "event-a", 0),
        ],
        entry="event-entry",
    )

    session = _service().start(definition)

    assert [choice.transition_id for choice in session.step.choices] == [
        "transition-a",
        "transition-b",
    ]
    assert all(choice.eligible for choice in session.step.choices)
    assert session.facts[0].code == "multiple_unconditional_transitions"


def test_stale_revision_blocks_commands_until_restart_with_fresh_definition() -> None:
    service = _service()
    started = service.start(_branch_definition())

    stale = service.inspect(started.id, "revision-2")
    still_stale = service.choose(
        started.id,
        "transition-default",
        source_revision="revision-1",
    )
    with pytest.raises(PlaybackSessionServiceError) as old_restart:
        service.restart(started.id, _branch_definition(source_revision="revision-1"))
    restarted = service.restart(
        started.id,
        _branch_definition(source_revision="revision-2"),
    )

    assert stale.status == "blocked"
    assert stale.facts[-1].code == "stale_source_revision"
    assert still_stale.current_node_id == "event-entry"
    assert still_stale.trace == []
    assert old_restart.value.code == "playback_restart_stale_definition"
    assert restarted.status == "active"
    assert restarted.source_revision == "revision-2"
    assert all(fact.code != "stale_source_revision" for fact in restarted.facts)


def test_restart_rejects_another_flow_owner_and_clears_trace() -> None:
    service = _service()
    started = service.start(_branch_definition())
    moved = service.choose(
        started.id,
        "transition-default",
        source_revision="revision-1",
    )
    replacement = _branch_definition(source_revision="revision-2")
    replacement.flow_snapshot.flow.id = "flow-other"

    with pytest.raises(
        PlaybackSessionServiceError,
        match="same project and Story Flow",
    ):
        service.restart(moved.id, replacement)

    restarted = service.restart(
        moved.id,
        _branch_definition(source_revision="revision-2"),
        visit_threshold=5,
    )
    assert restarted.trace == []
    assert restarted.current_node_id == "event-entry"
    assert restarted.visit_threshold == 5


def test_unknown_choice_back_initial_state_and_closed_session_return_stable_errors() -> None:
    service = _service()
    started = service.start(_branch_definition())

    with pytest.raises(PlaybackSessionServiceError) as choice_error:
        service.choose(started.id, "missing", source_revision="revision-1")
    with pytest.raises(PlaybackSessionServiceError) as back_error:
        service.back(started.id, source_revision="revision-1")
    with pytest.raises(PlaybackSessionServiceError) as ineligible_error:
        service.choose(started.id, "transition-a", source_revision="revision-1")
    service.close(started.id)
    with pytest.raises(PlaybackSessionServiceError) as closed_error:
        service.inspect(started.id, "revision-1")

    assert choice_error.value.code == "playback_choice_not_found"
    assert back_error.value.code == "playback_back_unavailable"
    assert ineligible_error.value.code == "playback_choice_ineligible"
    assert closed_error.value.code == "playback_session_not_found"


def test_ended_session_rejects_further_choices() -> None:
    definition = _definition(
        node_types={"event-ending": "Event"},
        transitions=[],
        entry="event-ending",
    )
    service = _service()
    ended = service.start(definition)

    with pytest.raises(PlaybackSessionServiceError) as error:
        service.choose(ended.id, "missing", source_revision="revision-1")

    assert error.value.code == "playback_session_ended"


def test_start_rejects_invalid_initial_state_targets() -> None:
    definition = _definition(
        node_types={"event-entry": "Event", "item-key": "Item"},
        transitions=[],
        entry="event-entry",
    )

    with pytest.raises(PlaybackSessionServiceError) as error:
        _service().start(
            definition,
            initial_state=PlaybackState(inventory_node_ids=["missing-item"]),
        )

    assert error.value.code == "playback_invalid_initial_state"


def test_effect_failure_blocks_without_partial_traversal() -> None:
    target_effect = _effect(
        "effect-target",
        "add_inventory",
        {"node_id": "outcome-ending"},
        owner_node_id="outcome-ending",
    )
    definition = _definition(
        node_types={"event-entry": "Event", "outcome-ending": "Outcome"},
        transitions=[
            _transition("transition-ending", "event-entry", "outcome-ending", 0),
        ],
        entry="event-entry",
        effects=[target_effect],
    )
    service = _service()
    started = service.start(definition)

    blocked = service.choose(
        started.id,
        "transition-ending",
        source_revision="revision-1",
    )

    assert blocked.status == "blocked"
    assert blocked.current_node_id == "event-entry"
    assert blocked.trace == []
    assert blocked.state == started.state
    assert blocked.facts[-1].code == "malformed_effect"


def test_repeated_runs_are_deterministic_and_do_not_mutate_definition() -> None:
    definition = _branch_definition()
    before = deepcopy(definition.model_dump(mode="json"))

    first_service = _service()
    second_service = _service()
    first = first_service.start(definition)
    second = second_service.start(definition)
    first = first_service.choose(first.id, "transition-default", source_revision="revision-1")
    second = second_service.choose(second.id, "transition-default", source_revision="revision-1")

    assert first.model_dump(mode="json") == second.model_dump(mode="json")
    assert definition.model_dump(mode="json") == before

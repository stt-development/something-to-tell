"""Executable IR determinism and Playback parity tests for Phase 8."""

from copy import deepcopy
from pathlib import Path

import pytest
from pydantic import ValidationError

from services.runtime.stt_runtime.export.executable_projection import (
    ExecutableProjectionService,
)
from services.runtime.stt_runtime.export.projection import ExportProjectionService
from services.runtime.stt_runtime.playback.traversal_service import PlaybackSessionService
from services.runtime.stt_runtime.project_fixture import load_project_fixture
from services.runtime.stt_runtime.schemas.export import ExportOptionsV1
from services.runtime.stt_runtime.schemas.executable_export import (
    ExecutableConditionBinaryV1,
    ExecutableConditionLiteralV1,
    ExecutableConditionStateV1,
    ExecutableNarrativeProjectionV1,
)
from services.runtime.stt_runtime.schemas.playback import (
    PlaybackCanonicalNode,
    PlaybackState,
)
from services.runtime.stt_runtime.schemas.playback_api import PlaybackPrepareCommand
from services.runtime.stt_runtime.schemas.project_document import create_project_document

FIXTURE_PATH = Path(__file__).parents[3] / "fixtures" / "projects" / "project-aurora.v1.json"


def _source():
    fixture = load_project_fixture(FIXTURE_PATH)
    document = create_project_document(**fixture.model_dump(
        mode="python",
        exclude={"fixture_version", "slug", "playback_effects", "expected_validation"},
    ))
    projection = ExportProjectionService().build(
        document,
        ExportOptionsV1(
            format="json",
            scope="story_flows",
            story_flow_ids=["flow-main-story"],
            engine_tag_target="generic",
        ),
    ).projection
    return fixture, document, projection


def _flow(executable, flow_id: str):
    return next(item for item in executable.flows if item.id == flow_id)


def _step(executable, flow_id: str, node_id: str):
    return next(item for item in _flow(executable, flow_id).steps if item.node_id == node_id)


def test_aurora_lowering_is_deterministic_explicit_and_does_not_mutate_source() -> None:
    _, _, projection = _source()
    before = deepcopy(projection.model_dump(mode="json"))
    service = ExecutableProjectionService()

    first = service.build(projection)
    second = service.build(projection)

    assert first == second
    assert projection.model_dump(mode="json") == before
    assert [item.id for item in first.flows] == [
        "flow-main-story", "flow-smuggler-route", "flow-z-blockade-outcome"
    ]
    assert [item.id for item in first.flows if item.is_root] == ["flow-main-story"]

    dialogue_step = _step(first, "flow-main-story", "node-dock-dialogue")
    assert [route.id for route in dialogue_step.routes] == [
        "flow-transition-dialogue-inspection",
        "flow-invocation-dialogue-smuggler-route",
    ]
    call = dialogue_step.routes[1]
    assert dialogue_step.routes[0].dialogue_element_id == "line-ilya-concedes"
    assert call.kind == "call"
    assert len(call.return_bindings) == 1
    assert call.return_bindings[0].exit_symbol == _flow(
        first, "flow-z-blockade-outcome"
    ).returns[0].symbol
    assert call.return_bindings[0].target_step_symbol == _step(
        first, "flow-main-story", "node-route-consequence"
    ).symbol

    dialogue = first.dialogues[0]
    assert [line.id for line in dialogue.lines] == [
        "line-dockmaster-warning", "line-mara-challenge",
        "line-ilya-concedes", "line-mara-orders-run",
    ]
    assert [option.id for option in dialogue.choices[0].options] == [
        "answer-show-ledger", "answer-run-blockade"
    ]
    condition = dialogue.choices[0].options[0].condition
    assert isinstance(condition, ExecutableConditionBinaryV1)
    assert condition.operator == "eq"
    assert isinstance(condition.left, ExecutableConditionStateV1)
    assert condition.left.path == ["items", "node-sealed-ledger", "holder", "node_id"]

    # The raw authored expression cannot leak into generated target source.
    dumped = first.model_dump_json()
    assert "items.node-sealed-ledger.holder.node_id" not in dumped
    assert "relationships" not in type(first).model_fields
    assert "placements" not in dumped
    assert len(first.source_map) == len({item.symbol for item in first.source_map})


def test_aurora_effects_preserve_order_and_require_explicit_transfer_host_binding() -> None:
    _, _, projection = _source()
    executable = ExecutableProjectionService().build(projection)

    assert [item.id for item in executable.operations] == [
        "binding-01-dialogue-ledger-to-mara",
        "binding-04-exit-ledger-to-player",
        "binding-02-quest-complete",
        "binding-03-quest-reward",
    ]
    by_id = {item.id: item for item in executable.operations}
    assert by_id["binding-02-quest-complete"].execution == "native"
    assert by_id["binding-02-quest-complete"].effect.operation == "set_quest_status"
    assert by_id["binding-03-quest-reward"].application_order == 1
    assert by_id["binding-03-quest-reward"].effect == next(
        item for item in projection.narrative_state.effects
        if item.id == "effect-03-quest-reward-to-party"
    )
    transfers = [item for item in executable.operations if item.effect.operation == "transfer_item"]
    assert all(item.execution == "host" for item in transfers)
    assert {item.host_binding_id for item in transfers} == {"host.stt.transfer_item.v1"}
    assert [item.id for item in executable.host_bindings] == ["host.stt.transfer_item.v1"]

    quest = executable.quests[0]
    blockade = next(
        branch for stage in quest.stages for branch in stage.branches
        if branch.id == "branch-blockade-route"
    )
    assert blockade.operation_ids == [
        "binding-02-quest-complete", "binding-03-quest-reward"
    ]
    quest_route = next(route for route in _step(
        executable, "flow-smuggler-route", "node-smuggler-route"
    ).routes if route.id == "flow-transition-quest-blockade")
    assert quest_route.quest_branch_id == "branch-blockade-route"
    assert quest_route.operation_ids == blockade.operation_ids
    success_return = next(
        item for item in _flow(executable, "flow-smuggler-route").returns
        if item.id == "flow-exit-smuggler-success"
    )
    assert success_return.operation_ids == ["binding-04-exit-ledger-to-player"]


def test_invalid_conditions_are_blocking_and_never_become_partial_ast() -> None:
    _, _, projection = _source()
    executable = ExecutableProjectionService().build(projection)
    invalid = [
        item for item in executable.diagnostics
        if item.code == "export.executable.invalid-condition"
    ]

    # Aurora intentionally retains two legacy Quest conditions for Canon repair.
    assert [item.owner.id for item in invalid if item.owner] == [
        "branch-legal-route", "branch-present-ledger"
    ]
    assert all(item.severity == "error" for item in invalid)
    branch_by_id = {
        branch.id: branch
        for quest in executable.quests
        for stage in quest.stages
        for branch in stage.branches
    }
    assert branch_by_id["branch-present-ledger"].condition is None
    assert branch_by_id["branch-legal-route"].condition is None


def test_executable_contract_rejects_mismatched_literals_hosts_and_source_maps() -> None:
    _, _, projection = _source()
    executable = ExecutableProjectionService().build(projection)

    with pytest.raises(ValidationError, match="literal type"):
        ExecutableConditionLiteralV1(
            kind="literal", value_type="boolean", value="true"
        )

    payload = executable.model_dump(mode="python")
    payload["operations"][0]["host_binding_id"] = None
    with pytest.raises(ValidationError, match="host execution"):
        ExecutableNarrativeProjectionV1.model_validate(payload)

    payload = executable.model_dump(mode="python")
    payload["source_map"].append(payload["source_map"][0])
    with pytest.raises(ValidationError, match="source map symbols"):
        ExecutableNarrativeProjectionV1.model_validate(payload)


def test_missing_entries_and_recursive_calls_are_blocking_diagnostics() -> None:
    _, _, projection = _source()
    flow = projection.story_flows.definitions[0]
    invocation = projection.story_flows.invocations[0]
    story_flows = projection.story_flows.model_copy(update={
        "definitions": [
            flow.model_copy(update={"entry_node_id": None}),
            *projection.story_flows.definitions[1:],
        ],
        "invocations": [
            invocation.model_copy(update={"target_flow_id": invocation.source_flow_id}),
            *projection.story_flows.invocations[1:],
        ],
    })

    executable = ExecutableProjectionService().build(
        projection.model_copy(update={"story_flows": story_flows})
    )
    codes = {item.code for item in executable.diagnostics}
    assert "export.executable.missing-entry" in codes
    assert "export.executable.recursive-call" in codes
    assert all(
        item.severity == "error"
        for item in executable.diagnostics
        if item.code.startswith("export.executable.")
    )


def test_unbound_effect_is_blocking_instead_of_disappearing() -> None:
    _, _, projection = _source()
    state = projection.narrative_state.model_copy(update={
        "bindings": projection.narrative_state.bindings[1:],
    })

    executable = ExecutableProjectionService().build(
        projection.model_copy(update={"narrative_state": state})
    )
    diagnostic = next(
        item for item in executable.diagnostics
        if item.code == "export.executable.unbound-effect"
    )
    assert diagnostic.owner is not None
    assert diagnostic.owner.id == "effect-01-ledger-ilya-to-mara"
    assert all(
        item.effect_id != diagnostic.owner.id for item in executable.operations
    )


def test_aurora_golden_playback_matches_dialogue_call_return_and_state_change() -> None:
    fixture, document, projection = _source()
    executable = ExecutableProjectionService().build(projection)
    snapshots = []
    for flow in document.story_flows:
        source_invocations = [
            item for item in document.flow_invocations if item.source_flow_id == flow.id
        ]
        invocation_ids = {item.id for item in source_invocations}
        snapshots.append({
            "flow": flow.model_dump(mode="python", exclude={"normalized_name"}),
            "nodes": [
                item.model_dump(mode="python") for item in document.story_flow_nodes
                if item.flow_id == flow.id
            ],
            "transitions": [
                item.model_dump(mode="python") for item in document.flow_transitions
                if item.flow_id == flow.id
            ],
            "invocations": [item.model_dump(mode="python") for item in source_invocations],
            "exits": [
                item.model_dump(mode="python") for item in document.flow_exits
                if item.flow_id == flow.id
            ],
            "bindings": [
                item.model_dump(mode="python") for item in document.flow_exit_bindings
                if item.invocation_id in invocation_ids
            ],
        })
    member_ids = {item.node_id for item in document.story_flow_nodes}
    member_ids |= {"node-dockmaster"}
    nodes = {item.id: item for item in document.nodes}
    initial = next(
        item for item in document.flow_initial_states if item.flow_id == "flow-main-story"
    )
    command = PlaybackPrepareCommand(
        snapshot=next(item for item in snapshots if item["flow"]["id"] == "flow-main-story"),
        snapshots=snapshots,
        canonical_nodes=[
            PlaybackCanonicalNode(
                id=nodes[node_id].id,
                project_id=nodes[node_id].project_id,
                type=nodes[node_id].type,
                title=nodes[node_id].title,
                summary=nodes[node_id].summary,
                body=nodes[node_id].body,
                status=nodes[node_id].status,
                metadata=nodes[node_id].metadata,
            )
            for node_id in sorted(member_ids)
        ],
        dialogue_documents={item.node_id: item.document for item in document.dialogues},
        quest_documents={item.node_id: item.document for item in document.quests},
        typed_effects=[item.model_dump(mode="python") for item in fixture.playback_effects],
        initial_state=PlaybackState(
            item_holders={item.item_node_id: item.holder for item in initial.item_custody},
            quest_states=initial.quest_statuses,
        ),
        source_revision=document.checksum,
    )
    service = PlaybackSessionService(id_factory=lambda: "aurora-executable-parity")
    prepared = service.prepare(command)
    assert prepared.definition is not None, prepared.facts
    session = service.start(prepared.definition)

    assert session.current_node_id == "node-opening"
    assert [item.transition_id for item in session.step.choices] == [
        route.id for route in _step(executable, "flow-main-story", "node-opening").routes
    ]
    session = service.choose(
        session.id,
        "flow-transition-opening-dialogue",
        source_revision=document.checksum,
    )
    assert session.current_node_id == "node-dock-dialogue"
    assert session.state.inventory_node_ids == ["node-sealed-ledger"]
    assert [item.option_id for item in session.step.dialogue.options] == [
        option.id for option in executable.dialogues[0].choices[0].options
    ]
    session = service.choose(
        session.id,
        None,
        dialogue_option_id="answer-run-blockade",
        source_revision=document.checksum,
    )
    authored_routes = _step(
        executable, "flow-main-story", "node-dock-dialogue"
    ).routes
    assert [route.id for route in authored_routes] == [
        "flow-transition-dialogue-inspection",
        "flow-invocation-dialogue-smuggler-route",
    ]
    assert [item.transition_id for item in session.step.choices] == [
        "flow-invocation-dialogue-smuggler-route"
    ]
    session = service.choose(
        session.id,
        "flow-invocation-dialogue-smuggler-route",
        source_revision=document.checksum,
    )
    assert session.current_node_id == "node-route-consequence"
    assert [event.operation for event in session.trace[-1].events] == [
        "call", "exit", "return"
    ]

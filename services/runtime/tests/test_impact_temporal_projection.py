from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path

import pytest

from services.runtime.stt_runtime.impact import ProjectDependencyProjector
from services.runtime.stt_runtime.project_fixture import import_project_fixture
from services.runtime.stt_runtime.schemas.impact_analysis import ImpactDependency
from services.runtime.stt_runtime.schemas.project_document import (
    ProjectDocument,
    ProjectNarrativeEffectBindingRecord,
    ProjectNarrativeEffectRecord,
    create_project_document,
)

FIXTURE = Path(__file__).parents[3] / "fixtures" / "projects" / "project-aurora.v1.json"
NOW = datetime(2026, 8, 26, 10, 0, tzinfo=UTC)


@pytest.fixture(scope="module")
def aurora(tmp_path_factory: pytest.TempPathFactory) -> ProjectDocument:
    project_path = tmp_path_factory.mktemp("impact-temporal") / "ProjectAurora.narrative"
    return import_project_fixture(FIXTURE, project_path).document


def _matching(
    dependencies: tuple[ImpactDependency, ...],
    *,
    kind: str,
    source_contains: str | None = None,
    target_contains: str | None = None,
) -> list[ImpactDependency]:
    return [
        item
        for item in dependencies
        if item.kind == kind
        and (source_contains is None or source_contains in item.source.owner_id)
        and (target_contains is None or target_contains in item.target.owner_id)
    ]


def _rebuild(document: ProjectDocument, **updates: object) -> ProjectDocument:
    payload = document.model_dump(mode="python", exclude={"checksum"})
    payload.update(updates)
    return create_project_document(**payload)


def _with_transition_condition(
    document: ProjectDocument,
    transition_id: str,
    condition: str,
) -> ProjectDocument:
    transitions = [
        item.model_copy(update={"condition": condition, "kind": "branch"})
        if item.id == transition_id
        else item
        for item in document.flow_transitions
    ]
    return _rebuild(document, flow_transitions=transitions)


def test_aurora_projects_persisted_state_and_playback_inputs_immutably(
    aurora: ProjectDocument,
) -> None:
    before = deepcopy(aurora.model_dump(mode="json"))
    index = ProjectDependencyProjector().project(aurora)

    assert _matching(
        index.dependencies,
        kind="temporal.initial-state-owner",
        source_contains="flow-main-story",
        target_contains="state-main-ledger",
    )
    assert _matching(
        index.dependencies,
        kind="temporal.initial-value-reference",
        source_contains="node-sealed-ledger",
        target_contains="items.node-sealed-ledger.holder.node_id",
    )
    binding_owner = _matching(
        index.dependencies,
        kind="temporal.binding-owner",
        source_contains="line-ilya-concedes",
        target_contains="binding-01-dialogue-ledger-to-mara",
    )
    reachable_flows = _matching(
        index.dependencies,
        kind="playback.reachable-flow",
        target_contains="flow-main-story",
    )
    preparation_facts = _matching(
        index.dependencies,
        kind="playback.preparation-fact",
        source_contains="flow-main-story",
    )

    assert binding_owner[0].source.context_id == "node-dock-dialogue"
    assert {item.source.owner_id for item in reachable_flows} == {
        "flow-smuggler-route",
        "flow-z-blockade-outcome",
    }
    assert preparation_facts
    assert all(item.target.owner_type == "playback_fact" for item in preparation_facts)
    assert not {
        "playback_session",
        "playback_state",
        "playback_trace",
    }.intersection(item.owner_type for item in index.resources)
    assert aurora.model_dump(mode="json") == before


def test_reachable_effect_writes_feed_exact_state_reads_without_semantic_inference(
    aurora: ProjectDocument,
) -> None:
    index = ProjectDependencyProjector().project(aurora)

    writer_read = _matching(
        index.dependencies,
        kind="temporal.writer-read",
        source_contains="binding-01-dialogue-ledger-to-mara",
        target_contains="flow-transition-dialogue-inspection",
    )

    assert [item.propagation for item in writer_read] == ["conditional"]
    assert writer_read[0].message_parameters["path"] == (
        "items.node-sealed-ledger.holder.node_id"
    )
    assert not any(
        item.domain == "temporal" and item.source.owner_id == "edge-guild-ledger"
        for item in index.dependencies
    )
    assert not any(
        item.target.owner_type == "state_read"
        and "branch-present-ledger" in item.target.owner_id
        for item in index.dependencies
    )


def test_conflicting_root_custody_values_remain_in_their_playback_scope(
    aurora: ProjectDocument,
) -> None:
    document = _with_transition_condition(
        aurora,
        "flow-transition-blockade-failure",
        'items.node-sealed-ledger.holder.node_id == "node-hero"',
    )
    index = ProjectDependencyProjector().project(document)

    main_to_main = _matching(
        index.dependencies,
        kind="temporal.initial-value-read",
        source_contains="state-main-ledger",
        target_contains="flow-main-story:flow:flow-smuggler-route",
    )
    side_to_side = _matching(
        index.dependencies,
        kind="temporal.initial-value-read",
        source_contains="state-side-ledger",
        target_contains="flow-smuggler-route:flow:flow-smuggler-route",
    )
    main_to_side_root = _matching(
        index.dependencies,
        kind="temporal.initial-value-read",
        source_contains="state-main-ledger",
        target_contains="flow-smuggler-route:flow:flow-smuggler-route",
    )
    side_to_main_root = _matching(
        index.dependencies,
        kind="temporal.initial-value-read",
        source_contains="state-side-ledger",
        target_contains="flow-main-story:flow:flow-smuggler-route",
    )

    assert len(main_to_main) == len(side_to_side) == 1
    assert main_to_side_root == []
    assert side_to_main_root == []


def test_branch_local_writer_reaches_only_downstream_condition(
    aurora: ProjectDocument,
) -> None:
    conditioned = _with_transition_condition(
        aurora,
        "flow-transition-quest-abandoned",
        "flags.route_open",
    )
    effects = [
        *conditioned.narrative_effects,
        ProjectNarrativeEffectRecord(
            id="effect-reachable-flag",
            project_id=conditioned.manifest.project_id,
            operation="set_flag",
            payload={"flag": "route_open"},
            repeat_policy="once",
            explanation="Open the route before evaluating its branches.",
            created_at=NOW,
            updated_at=NOW,
        ),
        ProjectNarrativeEffectRecord(
            id="effect-terminal-flag",
            project_id=conditioned.manifest.project_id,
            operation="clear_flag",
            payload={"flag": "route_open"},
            repeat_policy="once",
            explanation="Close the route only after the failure terminal.",
            created_at=NOW,
            updated_at=NOW,
        ),
    ]
    bindings = [
        *conditioned.narrative_effect_bindings,
        ProjectNarrativeEffectBindingRecord(
            id="binding-reachable-flag",
            project_id=conditioned.manifest.project_id,
            effect_id="effect-reachable-flag",
            owner_kind="node_entry",
            owner_id="node-smuggler-route",
            application_order=0,
            created_at=NOW,
            updated_at=NOW,
        ),
        ProjectNarrativeEffectBindingRecord(
            id="binding-terminal-flag",
            project_id=conditioned.manifest.project_id,
            effect_id="effect-terminal-flag",
            owner_kind="node_entry",
            owner_id="node-route-compromised",
            application_order=0,
            created_at=NOW,
            updated_at=NOW,
        ),
    ]
    document = _rebuild(
        conditioned,
        narrative_effects=effects,
        narrative_effect_bindings=bindings,
    )
    index = ProjectDependencyProjector().project(document)

    assert _matching(
        index.dependencies,
        kind="temporal.writer-read",
        source_contains="binding-reachable-flag",
        target_contains="flow-transition-quest-abandoned",
    )
    assert not _matching(
        index.dependencies,
        kind="temporal.writer-read",
        source_contains="binding-terminal-flag",
        target_contains="flow-transition-quest-abandoned",
    )


def test_named_exit_writer_reaches_caller_only_after_matching_return(
    aurora: ProjectDocument,
) -> None:
    conditioned = _with_transition_condition(
        aurora,
        "flow-transition-dialogue-inspection",
        "flags.returned_from_side_flow",
    )
    effect = ProjectNarrativeEffectRecord(
        id="effect-returned-flag",
        project_id=conditioned.manifest.project_id,
        operation="set_flag",
        payload={"flag": "returned_from_side_flow"},
        repeat_policy="once",
        explanation="Record the abandoned side-flow return.",
        created_at=NOW,
        updated_at=NOW,
    )
    binding = ProjectNarrativeEffectBindingRecord(
        id="binding-returned-flag",
        project_id=conditioned.manifest.project_id,
        effect_id=effect.id,
        owner_kind="flow_exit",
        owner_id="flow-exit-smuggler-abandoned",
        application_order=0,
        created_at=NOW,
        updated_at=NOW,
    )
    document = _rebuild(
        conditioned,
        narrative_effects=[*conditioned.narrative_effects, effect],
        narrative_effect_bindings=[*conditioned.narrative_effect_bindings, binding],
    )
    index = ProjectDependencyProjector().project(document)

    main_return = _matching(
        index.dependencies,
        kind="temporal.writer-read",
        source_contains="flow-main-story:binding-returned-flag",
        target_contains="flow-main-story:flow:flow-main-story",
    )
    side_root_return = _matching(
        index.dependencies,
        kind="temporal.writer-read",
        source_contains="flow-smuggler-route:binding-returned-flag",
    )

    assert len(main_return) == 1
    assert side_root_return == []


def test_playback_implicit_visited_and_dialogue_choice_writes_are_scoped(
    aurora: ProjectDocument,
) -> None:
    with_visit = _with_transition_condition(
        aurora,
        "flow-transition-opening-dialogue",
        "visited.node-opening",
    )
    document = _with_transition_condition(
        with_visit,
        "flow-transition-dialogue-inspection",
        '"answer-show-ledger" in dialogue.node-dock-dialogue.choices',
    )
    index = ProjectDependencyProjector().project(document)

    visited = _matching(
        index.dependencies,
        kind="playback.visited-read",
        source_contains="visited:flow-main-story:node-opening",
        target_contains="flow-transition-opening-dialogue",
    )
    dialogue = _matching(
        index.dependencies,
        kind="playback.dialogue-choice-read",
        source_contains="dialogue:node-dock-dialogue:answer-show-ledger",
        target_contains="flow-transition-dialogue-inspection",
    )

    assert [item.propagation for item in visited] == ["conditional"]
    assert [item.propagation for item in dialogue] == ["conditional"]

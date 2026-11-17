from datetime import UTC, datetime
from pathlib import Path

import pytest

from services.runtime.stt_runtime.impact import ProjectDependencyProjector
from services.runtime.stt_runtime.project_fixture import import_project_fixture
from services.runtime.stt_runtime.schemas.impact_analysis import ImpactDependency
from services.runtime.stt_runtime.schemas.project_document import (
    ProjectDocument,
    ProjectEdgeRecord,
    create_project_document,
)

FIXTURE = Path(__file__).parents[3] / "fixtures" / "projects" / "project-aurora.v1.json"
NOW = datetime(2026, 8, 25, 12, 0, tzinfo=UTC)


@pytest.fixture(scope="module")
def aurora(tmp_path_factory: pytest.TempPathFactory) -> ProjectDocument:
    project_path = tmp_path_factory.mktemp("impact-narrative") / "ProjectAurora.narrative"
    return import_project_fixture(FIXTURE, project_path).document


def _matching(
    dependencies: tuple[ImpactDependency, ...],
    *,
    kind: str,
    source_id: str | None = None,
    target_id: str | None = None,
) -> list[ImpactDependency]:
    return [
        item
        for item in dependencies
        if item.kind == kind
        and (source_id is None or item.source.owner_id == source_id)
        and (target_id is None or item.target.owner_id == target_id)
    ]


def _rebuild(document: ProjectDocument, **updates: object) -> ProjectDocument:
    payload = document.model_dump(mode="python", exclude={"checksum"})
    payload.update(updates)
    return create_project_document(**payload)


def test_story_flow_calls_returns_boundaries_and_cycles_are_indexed(
    aurora: ProjectDocument,
) -> None:
    index = ProjectDependencyProjector().project(aurora)

    entry = _matching(
        index.dependencies,
        kind="flow.entry-member",
        source_id="flow-main-story:member:node-opening",
        target_id="node-opening",
    )
    next_step = _matching(
        index.dependencies,
        kind="flow.transition-reachability",
        source_id="flow-transition-opening-dialogue",
        target_id="flow-main-story:member:node-dock-dialogue",
    )
    branch = _matching(
        index.dependencies,
        kind="flow.transition-reachability",
        source_id="flow-transition-dialogue-inspection",
    )
    default_call = _matching(
        index.dependencies,
        kind="flow.invocation-reachability",
        source_id="flow-invocation-dialogue-smuggler-route",
        target_id="flow-z-blockade-outcome",
    )
    optional_call = _matching(
        index.dependencies,
        kind="flow.invocation-reachability",
        source_id="flow-invocation-inspection-smuggler-route",
        target_id="flow-smuggler-route",
    )
    returned = _matching(
        index.dependencies,
        kind="flow.binding-reachability",
        source_id="flow-binding-smuggler-success-main",
        target_id="flow-main-story:member:node-route-consequence",
    )
    cycle_forward = _matching(
        index.dependencies,
        kind="flow.transition-reachability",
        source_id="flow-transition-quest-blockade",
    )
    cycle_back = _matching(
        index.dependencies,
        kind="flow.transition-reachability",
        source_id="flow-transition-blockade-cycle",
    )
    boundary_entry = _matching(
        index.dependencies,
        kind="flow.boundary-entry-reachability",
        source_id="flow-main-story:boundary:node-opening",
    )
    boundary_exit = _matching(
        index.dependencies,
        kind="flow.boundary-exit-reachability",
        source_id="flow-main-story:boundary:node-opening",
    )

    assert [item.propagation for item in entry] == ["required"]
    assert [item.propagation for item in next_step] == ["required"]
    assert [item.propagation for item in branch] == ["conditional"]
    assert [item.propagation for item in default_call] == ["required"]
    assert [item.propagation for item in optional_call] == ["conditional"]
    assert [item.propagation for item in returned] == ["required"]
    assert len(cycle_forward) == len(cycle_back) == 1
    assert [item.propagation for item in boundary_entry] == ["required"]
    assert [item.propagation for item in boundary_exit] == ["conditional"]
    assert {
        item.owner_id
        for item in index.resources
        if item.owner_type == "flow_terminal"
        and item.context_id == "flow-main-story"
    } == {"node-route-consequence", "node-sealed-ledger"}


def test_dialogue_nested_owners_options_and_external_outcomes_are_preserved(
    aurora: ProjectDocument,
) -> None:
    index = ProjectDependencyProjector().project(aurora)

    participant = next(
        item
        for item in index.resources
        if item.owner_type == "dialogue_participant"
        and item.owner_id == "node-dockmaster"
    )
    option = next(
        item
        for item in index.resources
        if item.owner_type == "dialogue_option"
        and item.owner_id == "answer-run-blockade"
    )
    line_next = _matching(
        index.dependencies,
        kind="dialogue.next-element",
        source_id="line-dockmaster-warning",
        target_id="line-mara-challenge",
    )
    option_next = _matching(
        index.dependencies,
        kind="dialogue.next-element",
        source_id="answer-run-blockade",
        target_id="line-mara-orders-run",
    )
    outcome = _matching(
        index.dependencies,
        kind="dialogue.external-outcome",
        source_id="line-mara-orders-run",
        target_id="edge-dialogue-blockade",
    )
    target = _matching(
        index.dependencies,
        kind="dialogue.outcome-target",
        source_id="edge-dialogue-blockade",
        target_id="node-mara-runs-blockade",
    )

    assert (participant.context_type, participant.context_id) == (
        "node",
        "node-dock-dialogue",
    )
    assert (option.context_type, option.context_id) == (
        "dialogue_element",
        "choice-mara-response",
    )
    assert [item.propagation for item in line_next] == ["required"]
    assert [item.propagation for item in option_next] == ["conditional"]
    assert [item.propagation for item in outcome] == ["required"]
    assert [item.propagation for item in target] == ["conditional"]
    assert _matching(
        index.dependencies,
        kind="dialogue.outcome-invocation",
        source_id="line-mara-orders-run",
        target_id="flow-invocation-dialogue-smuggler-route",
    )
    assert _matching(
        index.dependencies,
        kind="dialogue.outcome-transition",
        source_id="line-ilya-concedes",
        target_id="flow-transition-dialogue-inspection",
    )
    assert not _matching(
        index.dependencies,
        kind="dialogue.next-element",
        source_id="line-ilya-concedes",
    )


def test_quest_order_branches_and_shared_external_outcomes_are_preserved(
    aurora: ProjectDocument,
) -> None:
    shared_outcome = ProjectEdgeRecord(
        id="edge-quest-blockade-shared-outcome",
        project_id=aurora.manifest.project_id,
        source_node_id="node-smuggler-route",
        target_node_id="node-route-consequence",
        type="leads_to",
        label="also rejoins the harbor route",
        metadata={
            "quest_stage_id": "stage-choose-route",
            "quest_branch_id": "branch-blockade-route",
        },
        created_at=NOW,
        updated_at=NOW,
    )
    document = _rebuild(
        aurora,
        edges=sorted([*aurora.edges, shared_outcome], key=lambda item: item.id),
    )
    index = ProjectDependencyProjector().project(document)

    requirement = _matching(
        index.dependencies,
        kind="quest.requirement-node",
        source_id="node-ledger-condition",
        target_id="node-ledger-condition",
    )
    reward = _matching(
        index.dependencies,
        kind="quest.reward-node",
        source_id="node-sealed-ledger",
        target_id="node-sealed-ledger",
    )
    branch_target = _matching(
        index.dependencies,
        kind="quest.branch-reachability",
        source_id="branch-present-ledger",
        target_id="stage-choose-route",
    )
    shared_targets = _matching(
        index.dependencies,
        kind="quest.outcome-target",
        target_id="node-route-consequence",
    )

    assert requirement[0].message_parameters == {"order": 0}
    assert reward[0].message_parameters == {"order": 0}
    assert [item.propagation for item in branch_target] == ["conditional"]
    assert {item.source.owner_id for item in shared_targets} == {
        "edge-quest-blockade-shared-outcome",
        "edge-quest-legal-route",
    }
    assert _matching(
        index.dependencies,
        kind="quest.outcome-transition",
        source_id="branch-blockade-route",
        target_id="flow-transition-quest-blockade",
    )
    assert not _matching(
        index.dependencies,
        kind="quest.branch-reachability",
        source_id="branch-legal-route",
    )


def test_dialogue_cycle_projects_once_without_inventing_breakage(
    aurora: ProjectDocument,
) -> None:
    payload = aurora.model_dump(mode="python", exclude={"checksum"})
    dialogue = payload["dialogues"][0]["document"]
    terminal = next(
        element
        for element in dialogue["elements"]
        if element["id"] == "line-ilya-concedes"
    )
    terminal["next_element_id"] = "choice-mara-response"
    document = create_project_document(**payload)

    index = ProjectDependencyProjector().project(document)
    closing_link = _matching(
        index.dependencies,
        kind="dialogue.next-element",
        source_id="line-ilya-concedes",
        target_id="choice-mara-response",
    )

    assert len(closing_link) == 1
    assert len(index.dependencies) == len(
        {dependency.stable_key() for dependency in index.dependencies}
    )

from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from services.runtime.stt_runtime.schemas.story_flow import (
    FlowIntegrityFact,
    FlowTransition,
    SceneFlowBoundary,
    StoryFlow,
    StoryFlowDeletionImpact,
    StoryFlowIntegrityReport,
    StoryFlowNode,
    StoryFlowSnapshot,
)
from services.runtime.stt_runtime.schemas.story_flow_api import StoryFlowBootstrapCreate

NOW = datetime(2026, 7, 22, 10, 0, tzinfo=UTC)


def test_empty_project_bootstrap_accepts_only_scene_or_event() -> None:
    payload = {
        "project_id": "project-aurora",
        "node": {"type": "Event", "title": "Opening event"},
        "position": {"x": 160, "y": 120},
        "size": {"width": 260, "height": 156},
    }

    assert StoryFlowBootstrapCreate.model_validate(payload).flow_name == "Main Story"
    with pytest.raises(ValidationError, match="must be Scene or Event"):
        StoryFlowBootstrapCreate.model_validate({
            **payload,
            "node": {"type": "Lore", "title": "World fact"},
        })


def flow(*, entry_node_id: str | None = "event-entry", status: str = "active") -> StoryFlow:
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


def member(node_id: str, order: int, **updates: object) -> StoryFlowNode:
    payload: dict[str, object] = {
        "id": f"membership-{node_id}",
        "project_id": "project-aurora",
        "flow_id": "flow-main",
        "node_id": node_id,
        "presentation_order": order,
        "created_at": NOW,
        "updated_at": NOW,
    }
    payload.update(updates)
    return StoryFlowNode.model_validate(payload)


def transition(
    transition_id: str,
    source: str,
    target: str,
    priority: int,
    **updates: object,
) -> FlowTransition:
    payload: dict[str, object] = {
        "id": transition_id,
        "project_id": "project-aurora",
        "flow_id": "flow-main",
        "source_node_id": source,
        "target_node_id": target,
        "priority": priority,
        "created_at": NOW,
        "updated_at": NOW,
    }
    payload.update(updates)
    return FlowTransition.model_validate(payload)


def valid_snapshot() -> StoryFlowSnapshot:
    return StoryFlowSnapshot(
        flow=flow(),
        nodes=[
            member("event-entry", 0),
            member("scene-dock", 1),
            member("dialogue-warning", 2),
            member("event-departure", 3),
        ],
        transitions=[
            transition("transition-enter", "event-entry", "scene-dock", 0),
            transition("transition-dialogue", "scene-dock", "dialogue-warning", 0),
            transition(
                "transition-departure",
                "dialogue-warning",
                "event-departure",
                0,
                kind="branch",
                condition="ledger_acquired",
            ),
        ],
        scene_boundaries=[
            SceneFlowBoundary(
                id="boundary-dock",
                project_id="project-aurora",
                flow_id="flow-main",
                scene_node_id="scene-dock",
                entry_node_id="dialogue-warning",
                exit_node_ids=["event-departure"],
                created_at=NOW,
                updated_at=NOW,
            )
        ],
        scene_children={"scene-dock": ["dialogue-warning", "event-departure"]},
    )


def test_snapshot_accepts_owned_members_transitions_and_scene_boundary() -> None:
    snapshot = valid_snapshot()

    assert snapshot.snapshot_version == 1
    assert snapshot.flow.kind == "main"
    assert snapshot.transitions[2].kind == "branch"
    assert snapshot.scene_boundaries[0].entry_node_id == "dialogue-warning"


def test_empty_draft_is_valid_and_active_flow_requires_members_and_entry() -> None:
    empty = StoryFlowSnapshot(flow=flow(entry_node_id=None, status="draft"))
    assert empty.nodes == []

    with pytest.raises(ValidationError, match="active flow requires at least one member"):
        StoryFlowSnapshot(flow=flow(entry_node_id=None, status="active"))
    with pytest.raises(ValidationError, match="active non-empty flow requires an entry node"):
        StoryFlowSnapshot(flow=flow(entry_node_id=None, status="active"), nodes=[member("event-entry", 0)])
    with pytest.raises(ValidationError, match="entry node must be a member"):
        StoryFlowSnapshot(flow=flow(entry_node_id="missing", status="draft"), nodes=[member("event-entry", 0)])


@pytest.mark.parametrize(
    ("replacement", "message"),
    [
        ({"project_id": "project-other"}, "belongs to another project"),
        ({"flow_id": "flow-other"}, "belongs to another flow"),
    ],
)
def test_snapshot_rejects_cross_owner_membership(replacement: dict[str, object], message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        StoryFlowSnapshot(flow=flow(entry_node_id=None, status="draft"), nodes=[member("event-entry", 0, **replacement)])


def test_snapshot_rejects_duplicate_membership_and_presentation_order() -> None:
    with pytest.raises(ValidationError, match="duplicate flow membership id"):
        StoryFlowSnapshot(
            flow=flow(status="draft"),
            nodes=[member("event-entry", 0), member("event-other", 1, id="membership-event-entry")],
        )
    with pytest.raises(ValidationError, match="duplicate flow membership for node"):
        StoryFlowSnapshot(
            flow=flow(status="draft"),
            nodes=[member("event-entry", 0), member("event-entry", 1, id="membership-copy")],
        )
    with pytest.raises(ValidationError, match="duplicate flow presentation order"):
        StoryFlowSnapshot(
            flow=flow(status="draft"),
            nodes=[member("event-entry", 0), member("event-other", 0)],
        )


def test_transition_contract_rejects_self_conditioned_default_and_empty_branch() -> None:
    with pytest.raises(ValidationError, match="endpoints must be distinct"):
        transition("self", "event-entry", "event-entry", 0)
    with pytest.raises(ValidationError, match="default flow transition cannot have a condition"):
        transition("default", "event-entry", "event-other", 0, is_default=True, condition="flag")
    with pytest.raises(ValidationError, match="non-default branch transition requires a condition"):
        transition("branch", "event-entry", "event-other", 0, kind="branch")


def test_snapshot_rejects_dangling_endpoints_priorities_and_multiple_defaults() -> None:
    memberships = [member("event-entry", 0), member("event-a", 1), member("event-b", 2)]
    with pytest.raises(ValidationError, match="endpoints must be members"):
        StoryFlowSnapshot(
            flow=flow(status="draft"),
            nodes=memberships,
            transitions=[transition("dangling", "event-entry", "missing", 0)],
        )
    with pytest.raises(ValidationError, match="duplicate transition priority"):
        StoryFlowSnapshot(
            flow=flow(status="draft"),
            nodes=memberships,
            transitions=[
                transition("first", "event-entry", "event-a", 0),
                transition("second", "event-entry", "event-b", 0),
            ],
        )
    with pytest.raises(ValidationError, match="multiple default transitions"):
        StoryFlowSnapshot(
            flow=flow(status="draft"),
            nodes=memberships,
            transitions=[
                transition("first", "event-entry", "event-a", 0, is_default=True),
                transition("second", "event-entry", "event-b", 1, is_default=True),
            ],
        )


def test_snapshot_rejects_transition_owner_and_duplicate_id() -> None:
    memberships = [member("event-entry", 0), member("event-a", 1), member("event-b", 2)]
    with pytest.raises(ValidationError, match="belongs to another project"):
        StoryFlowSnapshot(
            flow=flow(status="draft"),
            nodes=memberships,
            transitions=[transition("external", "event-entry", "event-a", 0, project_id="project-other")],
        )
    with pytest.raises(ValidationError, match="duplicate flow transition id"):
        StoryFlowSnapshot(
            flow=flow(status="draft"),
            nodes=memberships,
            transitions=[
                transition("same", "event-entry", "event-a", 0),
                transition("same", "event-a", "event-b", 0),
            ],
        )


def test_scene_boundary_requires_owned_flow_members_and_canonical_children() -> None:
    snapshot = valid_snapshot()
    invalid = snapshot.scene_boundaries[0].model_copy(update={"entry_node_id": "event-entry"})

    with pytest.raises(ValidationError, match="canonical Scene children"):
        StoryFlowSnapshot(
            flow=snapshot.flow,
            nodes=snapshot.nodes,
            transitions=snapshot.transitions,
            scene_boundaries=[invalid],
            scene_children=snapshot.scene_children,
        )
    with pytest.raises(ValidationError, match="exit node ids must be unique"):
        SceneFlowBoundary(
            id="duplicate-exit",
            project_id="project-aurora",
            flow_id="flow-main",
            scene_node_id="scene-dock",
            entry_node_id="dialogue-warning",
            exit_node_ids=["event-departure", "event-departure"],
            created_at=NOW,
            updated_at=NOW,
        )
    with pytest.raises(ValidationError, match="scene child projection missing"):
        StoryFlowSnapshot(
            flow=snapshot.flow,
            nodes=snapshot.nodes,
            transitions=snapshot.transitions,
            scene_boundaries=snapshot.scene_boundaries,
        )
    with pytest.raises(ValidationError, match="duplicate scene flow boundary"):
        StoryFlowSnapshot(
            flow=snapshot.flow,
            nodes=snapshot.nodes,
            transitions=snapshot.transitions,
            scene_boundaries=[snapshot.scene_boundaries[0], snapshot.scene_boundaries[0].model_copy(update={"id": "boundary-copy"})],
            scene_children=snapshot.scene_children,
        )


def test_deletion_impact_never_claims_canonical_node_deletion() -> None:
    impact = StoryFlowDeletionImpact(
        flow_id="flow-main",
        membership_count=4,
        transition_count=3,
        scene_boundary_count=1,
    )

    assert impact.canonical_nodes_deleted is False


def test_integrity_payload_remains_read_only_fact_data() -> None:
    report = StoryFlowIntegrityReport(
        project_id="project-aurora",
        flow_id="flow-main",
        facts=[
            FlowIntegrityFact(
                code="unreachable_member",
                level="warning",
                message="Draft event is unreachable.",
                action="Connect it or remove it from Main Story.",
                flow_id="flow-main",
                node_id="event-draft",
            )
        ],
    )

    assert report.facts[0].code == "unreachable_member"
    assert report.model_dump(mode="json")["facts"][0]["transition_id"] is None

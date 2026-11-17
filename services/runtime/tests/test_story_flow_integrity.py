from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker

from services.runtime.stt_runtime.domain.entities import (
    EdgeEntity,
    FlowTransitionEntity,
    NodeEntity,
    SceneFlowBoundaryEntity,
    StoryFlowEntity,
    StoryFlowNodeEntity,
    VisualPlacementEntity,
)
from services.runtime.stt_runtime.story_flow.integrity_service import analyze_authoring_integrity
from services.runtime.tests.test_story_flow_api import (
    add_member,
    create_flow,
    create_node,
    create_project,
    make_app,
    make_engine,
    set_entry,
)


def _node(node_id: str, kind: str = "Event", project_id: str = "project-a") -> NodeEntity:
    return NodeEntity(id=node_id, project_id=project_id, type=kind, title=node_id)


def _member(member_id: str, node_id: str, order: int = 0, project_id: str = "project-a") -> StoryFlowNodeEntity:
    return StoryFlowNodeEntity(
        id=member_id,
        project_id=project_id,
        flow_id="flow-a",
        node_id=node_id,
        presentation_order=order,
    )


def _transition(
    transition_id: str,
    source: str,
    target: str,
    priority: int,
    **updates: object,
) -> FlowTransitionEntity:
    return FlowTransitionEntity(
        id=transition_id,
        project_id=str(updates.pop("project_id", "project-a")),
        flow_id=str(updates.pop("flow_id", "flow-a")),
        source_node_id=source,
        target_node_id=target,
        priority=priority,
        **updates,
    )


def _placement(
    placement_id: str,
    canonical_node_id: str,
    container_node_id: str | None,
) -> VisualPlacementEntity:
    return VisualPlacementEntity(
        id=placement_id,
        project_id="project-a",
        canonical_node_id=canonical_node_id,
        container_node_id=container_node_id,
        scope_key=container_node_id or "__root__",
        x=0,
        y=0,
        width=260,
        height=156,
    )


def test_analyzer_reports_every_flow_fact_with_stable_owners() -> None:
    flow = StoryFlowEntity(
        id="flow-a",
        project_id="project-a",
        name="Broken route",
        normalized_name="broken route",
        entry_node_id="entry",
    )
    nodes = [_node("entry"), _node("branch"), _node("ending"), _node("unreachable"), _node("scene", "Scene"), _node("child")]
    memberships = [
        _member("member-entry", "entry", 0),
        _member("member-entry-copy", "entry", 1),
        _member("member-branch", "branch", 2),
        _member("member-ending", "ending", 3),
        _member("member-unreachable", "unreachable", 4),
        _member("member-scene", "scene", 5),
        _member("member-child", "child", 6),
        _member("member-cross-project", "foreign", 7, "project-b"),
    ]
    transitions = [
        _transition("transition-entry-a", "entry", "branch", 0, kind="branch"),
        _transition("transition-entry-b", "entry", "ending", 0, is_default=True, condition="always"),
        _transition("transition-entry-c", "entry", "ending", 2, is_default=True),
        _transition("transition-cycle", "branch", "entry", 0),
        _transition("transition-dangling", "branch", "outside", 1),
        _transition("transition-cross", "branch", "ending", 2, project_id="project-b"),
    ]
    boundaries = [
        SceneFlowBoundaryEntity(
            id="boundary-invalid",
            project_id="project-a",
            flow_id="flow-a",
            scene_node_id="scene",
            entry_node_id="child",
            exit_node_ids=["outside", "outside"],
        )
    ]

    report = analyze_authoring_integrity(flow, nodes, memberships, transitions, boundaries, [], [])

    codes = {fact.code for fact in report.facts}
    assert {
        "unreachable_member",
        "dangling_transition_endpoint",
        "cross_project_reference",
        "duplicate_membership",
        "duplicate_transition_priority",
        "multiple_default_branches",
        "conditioned_default_branch",
        "branch_without_condition",
        "invalid_scene_boundary",
        "cycle",
        "ending",
    }.issubset(codes)
    assert any(fact.transition_id == "transition-dangling" for fact in report.facts)
    assert any(fact.scene_node_id == "scene" for fact in report.facts)
    assert all(fact.flow_id == "flow-a" and fact.action for fact in report.facts)


def test_analyzer_reports_entry_and_no_ending_variants() -> None:
    missing = StoryFlowEntity(id="flow-a", project_id="project-a", name="Missing", normalized_name="missing")
    invalid = StoryFlowEntity(
        id="flow-a",
        project_id="project-a",
        name="Invalid",
        normalized_name="invalid",
        entry_node_id="outside",
    )
    cycle = StoryFlowEntity(
        id="flow-a",
        project_id="project-a",
        name="Loop",
        normalized_name="loop",
        entry_node_id="a",
    )
    members = [_member("member-a", "a", 0), _member("member-b", "b", 1)]
    transitions = [_transition("a-b", "a", "b", 0), _transition("b-a", "b", "a", 0)]

    assert {fact.code for fact in analyze_authoring_integrity(missing, [], [], [], [], [], []).facts} == {"missing_entry"}
    assert "invalid_entry" in {fact.code for fact in analyze_authoring_integrity(invalid, [], [], [], [], [], []).facts}
    loop_codes = {fact.code for fact in analyze_authoring_integrity(cycle, [_node("a"), _node("b")], members, transitions, [], [], []).facts}
    assert {"cycle", "no_ending"}.issubset(loop_codes)
    assert next(fact for fact in analyze_authoring_integrity(cycle, [_node("a"), _node("b")], members, transitions, [], [], []).facts if fact.code == "cycle").level == "info"


def test_analyzer_reports_composition_corruption_but_allows_cross_container_reuse() -> None:
    flow = StoryFlowEntity(id="flow-a", project_id="project-a", name="Composition", normalized_name="composition")
    nodes = [
        _node("scene", "Scene"),
        _node("location-a", "Location"),
        _node("location-b", "Location"),
        _node("reused", "Item"),
        _node("event", "Event"),
    ]
    placements = [
        _placement("missing-node", "deleted", None),
        _placement("missing-container", "event", "deleted-container"),
        _placement("invalid-child", "scene", "location-a"),
        _placement("duplicate-a", "event", "scene"),
        _placement("duplicate-b", "event", "scene"),
        _placement("cycle-a", "location-a", "location-b"),
        _placement("cycle-b", "location-b", "location-a"),
        _placement("reuse-scene", "reused", "scene"),
        _placement("reuse-location", "reused", "location-a"),
    ]
    relationships = [
        EdgeEntity(
            id="contains-stale",
            project_id="project-a",
            source_node_id="scene",
            target_node_id="location-a",
            type="contains",
        ),
        EdgeEntity(
            id="contains-valid",
            project_id="project-a",
            source_node_id="location-a",
            target_node_id="reused",
            type="contains",
        ),
    ]

    report = analyze_authoring_integrity(flow, nodes, [], [], [], placements, relationships)

    codes = {fact.code for fact in report.facts}
    assert {
        "dangling_placement",
        "missing_canonical_node",
        "invalid_child_kind",
        "duplicate_placement",
        "containment_cycle",
        "stale_membership",
    }.issubset(codes)
    reuse_duplicates = [
        fact for fact in report.facts
        if fact.code == "duplicate_placement" and fact.node_id == "reused"
    ]
    assert reuse_duplicates == []
    invalid = next(fact for fact in report.facts if fact.code == "invalid_child_kind")
    assert invalid.container_node_id == "location-a"
    assert any(fact.relationship_id == "contains-stale" for fact in report.facts)


def test_fact_order_is_independent_of_repository_order() -> None:
    flow = StoryFlowEntity(id="flow-a", project_id="project-a", name="Stable", normalized_name="stable", entry_node_id="a")
    nodes = [_node("a"), _node("b"), _node("c")]
    memberships = [_member("member-a", "a", 0), _member("member-b", "b", 1), _member("member-c", "c", 2)]
    transitions = [_transition("transition-a-b", "a", "b", 0)]

    first = analyze_authoring_integrity(flow, nodes, memberships, transitions, [], [], [])
    second = analyze_authoring_integrity(flow, list(reversed(nodes)), list(reversed(memberships)), list(reversed(transitions)), [], [], [])

    assert first.model_dump(mode="json") == second.model_dump(mode="json")


def test_integrity_endpoint_is_read_only_and_stable_after_restart(tmp_path: Path) -> None:
    database_path = tmp_path / "integrity.sqlite3"
    engine = make_engine(f"sqlite:///{database_path}")
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with TestClient(make_app(factory)) as client:
        project = create_project(client, "Integrity")
        entry = create_node(client, project["id"], "Event", "Entry")
        ending = create_node(client, project["id"], "Event", "Ending")
        flow = create_flow(client, project["id"])
        add_member(client, flow["id"], project["id"], entry["id"])
        add_member(client, flow["id"], project["id"], ending["id"])
        set_entry(client, flow["id"], project["id"], entry["id"])
        issues_before = client.get(f"/api/issues?project_id={project['id']}").json()
        first = client.get(f"/api/story-flows/{flow['id']}/integrity")
        assert first.status_code == 200
        assert {fact["code"] for fact in first.json()["facts"]} == {"ending", "unreachable_member"}
        assert client.get(f"/api/issues?project_id={project['id']}").json() == issues_before

    restarted_engine = make_engine(f"sqlite:///{database_path}")
    restarted_factory = sessionmaker(bind=restarted_engine, expire_on_commit=False)
    with TestClient(make_app(restarted_factory)) as restarted:
        second = restarted.get(f"/api/story-flows/{flow['id']}/integrity")

    assert second.status_code == 200
    assert second.json() == first.json()

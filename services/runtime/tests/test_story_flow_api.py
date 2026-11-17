from collections.abc import Generator
from pathlib import Path
import sqlite3

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from services.runtime.stt_runtime.api.dependencies import get_uow
from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.db.base import Base, import_model_metadata
from services.runtime.stt_runtime.domain.entities import (
    NodeEntity,
    ProjectEntity,
    StoryFlowEntity,
    StoryFlowNodeEntity,
)
from services.runtime.stt_runtime.repositories.sqlite import SqlAlchemyUnitOfWork
from services.runtime.stt_runtime.schemas.story_flow_api import ContinueNewNode, StoryFlowBootstrapCreate
from services.runtime.stt_runtime.story_flow.service import StoryFlowService


def make_engine(url: str, *, static_pool: bool = False) -> Engine:
    engine = create_engine(
        url,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool if static_pool else None,
    )

    @event.listens_for(engine, "connect")
    def enable_foreign_keys(connection: sqlite3.Connection, _: object) -> None:
        connection.execute("PRAGMA foreign_keys=ON")

    import_model_metadata()
    Base.metadata.create_all(engine)
    return engine


def make_app(factory: sessionmaker[Session]) -> FastAPI:
    app = create_app()

    def override_uow() -> Generator[SqlAlchemyUnitOfWork, None, None]:
        with SqlAlchemyUnitOfWork(factory) as uow:
            yield uow

    app.dependency_overrides[get_uow] = override_uow
    return app


@pytest.fixture
def client() -> Generator[TestClient, None, None]:
    engine = make_engine("sqlite://", static_pool=True)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)
    app = make_app(factory)
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


def create_project(client: TestClient, name: str = "Project Aurora") -> dict:
    response = client.post(
        "/api/projects",
        json={
            "name": name,
            "path": f"/tmp/{name.replace(' ', '')}.narrative",
            "format_version": 1,
        },
    )
    assert response.status_code == 201
    return response.json()


def create_node(client: TestClient, project_id: str, node_type: str, title: str) -> dict:
    response = client.post(
        "/api/nodes",
        json={"project_id": project_id, "type": node_type, "title": title},
    )
    assert response.status_code == 201
    return response.json()


def create_flow(client: TestClient, project_id: str, name: str = "Main Story") -> dict:
    response = client.post(
        "/api/story-flows",
        json={"project_id": project_id, "name": name, "kind": "main"},
    )
    assert response.status_code == 201
    return response.json()


def add_member(client: TestClient, flow_id: str, project_id: str, node_id: str, order: int | None = None) -> dict:
    payload = {"project_id": project_id, "node_id": node_id}
    if order is not None:
        payload["presentation_order"] = order
    response = client.post(f"/api/story-flows/{flow_id}/nodes", json=payload)
    assert response.status_code == 201
    return response.json()


def set_entry(client: TestClient, flow_id: str, project_id: str, node_id: str) -> dict:
    response = client.post(
        f"/api/story-flows/{flow_id}/entry",
        json={"project_id": project_id, "node_id": node_id},
    )
    assert response.status_code == 200
    return response.json()


def transition_payload(
    project_id: str,
    source_node_id: str,
    target_node_id: str,
    *,
    priority: int = 0,
    **updates: object,
) -> dict:
    payload = {
        "project_id": project_id,
        "source_node_id": source_node_id,
        "target_node_id": target_node_id,
        "priority": priority,
    }
    payload.update(updates)
    return payload


def test_story_flow_lifecycle_membership_entry_and_archive(client: TestClient) -> None:
    project = create_project(client)
    entry = create_node(client, project["id"], "Event", "Arrival")
    flow = create_flow(client, project["id"])

    snapshot = add_member(client, flow["id"], project["id"], entry["id"])
    assert snapshot["nodes"][0]["node_id"] == entry["id"]
    assert snapshot["nodes"][0]["created_at"]

    snapshot = set_entry(client, flow["id"], project["id"], entry["id"])
    activated = client.put(
        f"/api/story-flows/{flow['id']}",
        json={
            "project_id": project["id"],
            "name": "Main Story",
            "description": "Primary playable order.",
            "kind": "main",
            "status": "active",
        },
    )
    archived = client.post(
        f"/api/story-flows/{flow['id']}/archive",
        json={"project_id": project["id"]},
    )

    assert snapshot["flow"]["entry_node_id"] == entry["id"]
    assert activated.status_code == 200
    assert activated.json()["flow"]["status"] == "active"
    assert archived.json()["status"] == "archived"
    assert client.get(f"/api/story-flows?project_id={project['id']}").json()[0]["name"] == "Main Story"
    assert client.get(f"/api/story-flows/{flow['id']}").json()["flow"]["description"] == "Primary playable order."


def test_empty_project_bootstrap_creates_placed_entry_and_active_main_flow(client: TestClient) -> None:
    project = create_project(client, "Empty Aurora")

    response = client.post(
        "/api/story-flows/bootstrap",
        json={
            "project_id": project["id"],
            "flow_description": "Primary playable order.",
            "node": {
                "type": "Scene",
                "title": "Opening Scene",
                "summary": "The first authored scene.",
            },
            "position": {"x": 160, "y": 120},
            "size": {"width": 520, "height": 360},
        },
    )

    assert response.status_code == 201
    result = response.json()
    assert result["snapshot"]["flow"]["name"] == "Main Story"
    assert result["snapshot"]["flow"]["status"] == "active"
    assert result["snapshot"]["flow"]["entry_node_id"] == result["node"]["id"]
    assert result["membership"]["node_id"] == result["node"]["id"]
    assert result["placement"]["canonical_node_id"] == result["node"]["id"]
    assert result["placement"]["size"] == {"width": 520.0, "height": 360.0}
    assert client.get(f"/api/nodes?project_id={project['id']}").json()[0]["type"] == "Scene"


def test_transition_crud_and_atomic_continuations(client: TestClient) -> None:
    project = create_project(client)
    source = create_node(client, project["id"], "Event", "Arrival")
    existing = create_node(client, project["id"], "Scene", "Dock")
    later = create_node(client, project["id"], "Event", "Departure")
    flow = create_flow(client, project["id"])
    for node in (source, existing, later):
        add_member(client, flow["id"], project["id"], node["id"])
    set_entry(client, flow["id"], project["id"], source["id"])

    created = client.post(
        f"/api/story-flows/{flow['id']}/transitions",
        json=transition_payload(project["id"], source["id"], existing["id"]),
    )
    assert created.status_code == 201
    assert created.json()["transition_version"] == 1
    transition_id = created.json()["id"]

    updated = client.put(
        f"/api/story-flows/{flow['id']}/transitions/{transition_id}",
        json=transition_payload(
            project["id"],
            source["id"],
            existing["id"],
            kind="branch",
            is_default=True,
            label="Enter the dock",
        ),
    )
    continued_existing = client.post(
        f"/api/story-flows/{flow['id']}/continue-existing",
        json={
            "project_id": project["id"],
            "source_node_id": existing["id"],
            "target_node_id": later["id"],
            "transition": {"kind": "next", "priority": 0},
        },
    )
    continued_new = client.post(
        f"/api/story-flows/{flow['id']}/continue-new",
        json={
            "project_id": project["id"],
            "source_node_id": later["id"],
            "node": {"type": "Consequence", "title": "Harbor secured"},
            "transition": {"kind": "next", "priority": 0},
        },
    )

    assert updated.status_code == 200
    assert updated.json()["is_default"] is True
    assert continued_existing.status_code == 201
    assert continued_existing.json()["membership"]["node_id"] == later["id"]
    assert continued_new.status_code == 201
    assert continued_new.json()["node"]["type"] == "Consequence"
    assert len(continued_new.json()["snapshot"]["nodes"]) == 4
    assert client.delete(f"/api/story-flows/{flow['id']}/transitions/{transition_id}").status_code == 204


def test_first_membership_atomically_becomes_flow_entry(client: TestClient) -> None:
    project = create_project(client)
    node = create_node(client, project["id"], "Event", "Citadel opening")
    flow = create_flow(client, project["id"])

    snapshot = client.post(
        f"/api/story-flows/{flow['id']}/nodes",
        json={"project_id": project["id"], "node_id": node["id"], "metadata": {}},
    )

    assert snapshot.status_code == 201
    assert snapshot.json()["flow"]["entry_node_id"] == node["id"]
    assert snapshot.json()["nodes"][0]["node_id"] == node["id"]


def test_specialized_outcome_continuation_atomically_adds_both_endpoints(client: TestClient) -> None:
    project = create_project(client)
    dialogue = create_node(client, project["id"], "Dialogue", "Gate choice")
    outcome = create_node(client, project["id"], "Event", "Gate opens")
    flow = create_flow(client, project["id"])

    response = client.post(
        f"/api/story-flows/{flow['id']}/continue-existing",
        json={
            "project_id": project["id"],
            "source_node_id": dialogue["id"],
            "target_node_id": outcome["id"],
            "transition": {
                "kind": "branch",
                "label": "Guard agrees",
                "condition": "trust >= 2",
                "priority": 0,
                "metadata": {
                    "semantic_edge_id": "edge-dialogue-gate",
                    "dialogue_element_id": "answer-agree",
                },
            },
        },
    )

    assert response.status_code == 201
    body = response.json()
    assert [item["node_id"] for item in body["snapshot"]["nodes"]] == [dialogue["id"], outcome["id"]]
    assert body["snapshot"]["flow"]["entry_node_id"] == dialogue["id"]
    assert body["transition"]["metadata"]["semantic_edge_id"] == "edge-dialogue-gate"

    revised_outcome = create_node(client, project["id"], "Event", "Side gate opens")
    revised = client.post(
        f"/api/story-flows/{flow['id']}/continue-existing",
        json={
            "project_id": project["id"],
            "source_node_id": dialogue["id"],
            "target_node_id": revised_outcome["id"],
            "transition": {
                "kind": "optional",
                "label": "Use the side gate",
                "priority": 0,
                "metadata": {
                    "semantic_edge_id": "edge-dialogue-gate",
                    "dialogue_element_id": "answer-agree",
                },
            },
        },
    )
    assert revised.status_code == 201
    assert revised.json()["transition"]["id"] == body["transition"]["id"]
    assert revised.json()["transition"]["target_node_id"] == revised_outcome["id"]
    assert len(revised.json()["snapshot"]["transitions"]) == 1


def test_reorders_outgoing_transitions_atomically_with_stable_ids(client: TestClient) -> None:
    project = create_project(client)
    source = create_node(client, project["id"], "Dialogue", "Customs choice")
    targets = [
        create_node(client, project["id"], "Event", title)
        for title in ("Present papers", "Run blockade", "Offer bribe")
    ]
    flow = create_flow(client, project["id"])
    for node in [source, *targets]:
        add_member(client, flow["id"], project["id"], node["id"])
    transitions = [
        client.post(
            f"/api/story-flows/{flow['id']}/transitions",
            json=transition_payload(project["id"], source["id"], target["id"], priority=index),
        ).json()
        for index, target in enumerate(targets)
    ]
    ordered_ids = [transitions[2]["id"], transitions[0]["id"], transitions[1]["id"]]

    reordered = client.put(
        f"/api/story-flows/{flow['id']}/nodes/{source['id']}/transition-order",
        json={
            "project_id": project["id"],
            "source_node_id": source["id"],
            "transition_ids": ordered_ids,
        },
    )
    invalid = client.put(
        f"/api/story-flows/{flow['id']}/nodes/{source['id']}/transition-order",
        json={
            "project_id": project["id"],
            "source_node_id": source["id"],
            "transition_ids": ordered_ids[:-1],
        },
    )

    assert reordered.status_code == 200
    outgoing = sorted(reordered.json()["transitions"], key=lambda item: item["priority"])
    assert [item["id"] for item in outgoing] == ordered_ids
    assert invalid.status_code == 409
    assert invalid.json()["detail"]["code"] == "story_flow_transition_order_invalid"


def test_scene_boundary_and_confirmed_impacts_preserve_nodes(client: TestClient) -> None:
    project = create_project(client)
    scene = create_node(client, project["id"], "Scene", "Opening Dock")
    entry = create_node(client, project["id"], "Event", "Arrival")
    exit_node = create_node(client, project["id"], "Event", "Departure")
    flow = create_flow(client, project["id"])
    for node in (scene, entry, exit_node):
        add_member(client, flow["id"], project["id"], node["id"])
    set_entry(client, flow["id"], project["id"], entry["id"])

    for node, container in ((scene, None), (entry, scene["id"]), (exit_node, scene["id"])):
        placement = client.post(
            "/api/compositions/placements",
            json={
                "project_id": project["id"],
                "container_node_id": container,
                "canonical_node_id": node["id"],
                "position": {"x": 40, "y": 40},
                "size": {"width": 260, "height": 156},
                "is_primary": True,
            },
        )
        assert placement.status_code == 201

    transition = client.post(
        f"/api/story-flows/{flow['id']}/transitions",
        json=transition_payload(project["id"], entry["id"], exit_node["id"]),
    ).json()
    boundary = client.put(
        f"/api/story-flows/{flow['id']}/scenes/{scene['id']}/boundary",
        json={
            "project_id": project["id"],
            "entry_node_id": entry["id"],
            "exit_node_ids": [exit_node["id"]],
        },
    )
    deleted_boundary = client.delete(
        f"/api/story-flows/{flow['id']}/scenes/{scene['id']}/boundary",
    )
    recreated_boundary = client.put(
        f"/api/story-flows/{flow['id']}/scenes/{scene['id']}/boundary",
        json={
            "project_id": project["id"],
            "entry_node_id": entry["id"],
            "exit_node_ids": [exit_node["id"]],
        },
    )
    impact = client.get(f"/api/story-flows/{flow['id']}/nodes/{entry['id']}/impact")

    assert boundary.status_code == 200
    assert deleted_boundary.status_code == 204
    assert recreated_boundary.status_code == 200
    assert impact.json()["transition_ids"] == [transition["id"]]
    assert len(impact.json()["scene_boundary_ids"]) == 1
    assert impact.json()["removes_entry"] is True
    assert client.delete(f"/api/story-flows/{flow['id']}/nodes/{entry['id']}").status_code == 409

    removed = client.delete(
        f"/api/story-flows/{flow['id']}/nodes/{entry['id']}?confirmed=true",
    )
    assert removed.status_code == 200
    assert removed.json()["flow"]["status"] == "draft"
    assert removed.json()["transitions"] == []
    assert removed.json()["scene_boundaries"] == []
    assert client.get(f"/api/nodes/{entry['id']}").status_code == 200

    flow_impact = client.get(f"/api/story-flows/{flow['id']}/impact").json()
    assert flow_impact["membership_count"] == 2
    assert flow_impact["canonical_nodes_deleted"] is False
    assert client.delete(f"/api/story-flows/{flow['id']}").status_code == 409
    assert client.delete(f"/api/story-flows/{flow['id']}?confirmed=true").status_code == 204
    assert client.get(f"/api/nodes/{scene['id']}").status_code == 200


def test_story_flow_api_returns_every_required_stable_error(client: TestClient) -> None:
    first = create_project(client, "First")
    second = create_project(client, "Second")
    source = create_node(client, first["id"], "Event", "Source")
    target = create_node(client, first["id"], "Event", "Target")
    alternate = create_node(client, first["id"], "Event", "Alternate")
    non_member = create_node(client, first["id"], "Event", "Outside flow")
    external = create_node(client, second["id"], "Event", "External")
    flow = create_flow(client, first["id"])
    for node in (source, target, alternate):
        add_member(client, flow["id"], first["id"], node["id"])

    assert client.get("/api/story-flows/missing").json()["detail"]["code"] == "story_flow_not_found"

    duplicate = client.post(
        f"/api/story-flows/{flow['id']}/nodes",
        json={"project_id": first["id"], "node_id": source["id"]},
    )
    cross_project = client.post(
        f"/api/story-flows/{flow['id']}/nodes",
        json={"project_id": first["id"], "node_id": external["id"]},
    )
    invalid_entry = client.post(
        f"/api/story-flows/{flow['id']}/entry",
        json={"project_id": first["id"], "node_id": non_member["id"]},
    )
    stale_endpoint = client.post(
        f"/api/story-flows/{flow['id']}/transitions",
        json=transition_payload(first["id"], source["id"], "missing"),
    )
    first_default = client.post(
        f"/api/story-flows/{flow['id']}/transitions",
        json=transition_payload(first["id"], source["id"], target["id"], is_default=True),
    )
    second_default = client.post(
        f"/api/story-flows/{flow['id']}/transitions",
        json=transition_payload(first["id"], source["id"], alternate["id"], priority=1, is_default=True),
    )

    assert duplicate.json()["detail"]["code"] == "story_flow_duplicate_membership"
    assert cross_project.json()["detail"]["code"] == "story_flow_cross_project"
    assert invalid_entry.json()["detail"]["code"] == "story_flow_invalid_entry"
    assert stale_endpoint.json()["detail"]["code"] == "story_flow_stale_endpoint"
    assert first_default.status_code == 201
    assert second_default.json()["detail"]["code"] == "story_flow_invalid_default"

    reserved = client.post(
        "/api/edges",
        json={
            "project_id": first["id"],
            "source_node_id": source["id"],
            "target_node_id": target["id"],
            "type": "flow_transition",
        },
    )
    scoped_reserved = client.post(
        "/api/edges",
        json={
            "project_id": first["id"],
            "source_node_id": source["id"],
            "target_node_id": target["id"],
            "type": "leads_to",
            "metadata": {"semantic_scope": "story_flow"},
        },
    )
    assert reserved.json()["detail"]["code"] == "reserved_story_flow_edge"
    assert scoped_reserved.json()["detail"]["code"] == "reserved_story_flow_edge"


def test_story_flow_api_survives_runtime_restart(tmp_path: Path) -> None:
    database_path = tmp_path / "runtime-restart.sqlite"
    first_engine = make_engine(f"sqlite:///{database_path}")
    first_factory = sessionmaker(bind=first_engine, expire_on_commit=False)
    first_app = make_app(first_factory)

    with TestClient(first_app) as first_client:
        project = create_project(first_client)
        node = create_node(first_client, project["id"], "Event", "Persistent entry")
        flow = create_flow(first_client, project["id"])
        add_member(first_client, flow["id"], project["id"], node["id"])
        set_entry(first_client, flow["id"], project["id"], node["id"])
    first_engine.dispose()

    restarted_engine = make_engine(f"sqlite:///{database_path}")
    restarted_factory = sessionmaker(bind=restarted_engine, expire_on_commit=False)
    with TestClient(make_app(restarted_factory)) as restarted_client:
        snapshot = restarted_client.get(f"/api/story-flows/{flow['id']}")

    assert snapshot.status_code == 200
    assert snapshot.json()["flow"]["entry_node_id"] == node["id"]
    assert snapshot.json()["nodes"][0]["node_id"] == node["id"]


def test_continue_new_rolls_back_node_and_membership_when_transition_write_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = make_engine("sqlite://", static_pool=True)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with SqlAlchemyUnitOfWork(factory) as uow:
        uow.projects.add(
            ProjectEntity(
                id="project-rollback",
                name="Rollback",
                path="/tmp/Rollback.narrative",
                format_version=1,
            )
        )
        uow.nodes.add(
            NodeEntity(
                id="source",
                project_id="project-rollback",
                type="Event",
                title="Source",
            )
        )
        uow.story_flows.add(
            StoryFlowEntity(
                id="flow-rollback",
                project_id="project-rollback",
                name="Main Story",
                normalized_name="main story",
                entry_node_id="source",
            )
        )
        uow.story_flow_nodes.add(
            StoryFlowNodeEntity(
                id="membership-source",
                project_id="project-rollback",
                flow_id="flow-rollback",
                node_id="source",
                presentation_order=0,
            )
        )
        uow.commit()

    with SqlAlchemyUnitOfWork(factory) as uow:
        def fail_transition(_: object) -> None:
            raise RuntimeError("simulated transition persistence failure")

        monkeypatch.setattr(uow.flow_transitions, "add", fail_transition)
        payload = ContinueNewNode.model_validate(
            {
                "project_id": "project-rollback",
                "source_node_id": "source",
                "node": {"type": "Event", "title": "Must roll back"},
                "transition": {"priority": 0},
            }
        )
        with pytest.raises(RuntimeError, match="simulated transition"):
            StoryFlowService().continue_new(uow, "flow-rollback", payload)

    with SqlAlchemyUnitOfWork(factory) as uow:
        assert [node.id for node in uow.nodes.list(project_id="project-rollback")] == ["source"]
        assert [
            membership.node_id
            for membership in uow.story_flow_nodes.list(
                project_id="project-rollback",
                flow_id="flow-rollback",
            )
        ] == ["source"]
        assert uow.flow_transitions.list(project_id="project-rollback", flow_id="flow-rollback") == []


def test_empty_project_bootstrap_rolls_back_every_record_when_membership_write_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = make_engine("sqlite://", static_pool=True)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with SqlAlchemyUnitOfWork(factory) as uow:
        uow.projects.add(
            ProjectEntity(
                id="project-bootstrap-rollback",
                name="Bootstrap rollback",
                path="/tmp/BootstrapRollback.narrative",
                format_version=1,
            )
        )
        uow.commit()

    with SqlAlchemyUnitOfWork(factory) as uow:
        def fail_membership(_: object) -> None:
            raise RuntimeError("simulated bootstrap membership failure")

        monkeypatch.setattr(uow.story_flow_nodes, "add", fail_membership)
        payload = StoryFlowBootstrapCreate.model_validate({
            "project_id": "project-bootstrap-rollback",
            "node": {"type": "Event", "title": "Must roll back"},
            "position": {"x": 160, "y": 120},
            "size": {"width": 260, "height": 156},
        })
        with pytest.raises(RuntimeError, match="simulated bootstrap membership"):
            StoryFlowService().bootstrap(uow, payload)

    with SqlAlchemyUnitOfWork(factory) as uow:
        project_id = "project-bootstrap-rollback"
        assert uow.nodes.list(project_id=project_id) == []
        assert uow.visual_placements.list(project_id=project_id) == []
        assert uow.story_flows.list(project_id=project_id) == []
        assert uow.story_flow_nodes.list(project_id=project_id) == []

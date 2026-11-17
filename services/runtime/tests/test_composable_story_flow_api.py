from collections.abc import Generator
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from services.runtime.stt_runtime.api.dependencies import get_uow
from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.repositories.sqlite import SqlAlchemyUnitOfWork
from services.runtime.stt_runtime.schemas.composable_story_flow_api import OutcomeSideFlowCreate
from services.runtime.stt_runtime.story_flow.composable_service import ComposableStoryFlowService
from services.runtime.tests.test_story_flow_api import (
    add_member,
    create_flow,
    create_node,
    create_project,
    make_engine,
    set_entry,
    transition_payload,
)


@pytest.fixture
def client_factory() -> Generator[tuple[TestClient, sessionmaker[Session]], None, None]:
    """Phase 3.10 API tests share one in-memory storage authority per test."""

    engine = make_engine("sqlite://", static_pool=True)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)
    app: FastAPI = create_app()

    def override_uow() -> Generator[SqlAlchemyUnitOfWork, None, None]:
        with SqlAlchemyUnitOfWork(factory) as uow:
            yield uow

    app.dependency_overrides[get_uow] = override_uow
    with TestClient(app) as client:
        yield client, factory


def _flow_with_nodes(
    client: TestClient, project_id: str, name: str, *titles: str
) -> tuple[dict, list[dict]]:
    flow = create_flow(client, project_id, name)
    nodes = [create_node(client, project_id, "Event", title) for title in titles]
    for index, node in enumerate(nodes):
        add_member(client, flow["id"], project_id, node["id"], index)
    set_entry(client, flow["id"], project_id, nodes[0]["id"])
    return flow, nodes


def _invocation_payload(project_id: str, source: dict, source_node: dict, target: dict) -> dict:
    return {
        "project_id": project_id,
        "expected_revision": 0,
        "source_flow_id": source["id"],
        "source_node_id": source_node["id"],
        "target_flow_id": target["id"],
        "label": "Enter side story",
        "priority": 0,
    }


def _specialized_outcome_call(client: TestClient) -> dict[str, dict]:
    """Create one persisted Dialogue outcome with a call and mapped return."""

    project = create_project(client)
    main = create_flow(client, project["id"], "Main")
    dialogue = create_node(client, project["id"], "Dialogue", "Choose route")
    continuation = create_node(client, project["id"], "Event", "Resume main story")
    outcome = create_node(client, project["id"], "Event", "Run blockade")
    add_member(client, main["id"], project["id"], dialogue["id"], 0)
    add_member(client, main["id"], project["id"], continuation["id"], 1)
    set_entry(client, main["id"], project["id"], dialogue["id"])
    old_side = create_flow(client, project["id"], "Old outcome")
    add_member(client, old_side["id"], project["id"], outcome["id"], 0)
    set_entry(client, old_side["id"], project["id"], outcome["id"])
    invocation = client.post(
        "/api/flow-composition/invocations",
        json=_invocation_payload(project["id"], main, dialogue, old_side),
    ).json()
    flow_exit = client.post(
        "/api/flow-composition/exits",
        json={
            "project_id": project["id"],
            "flow_id": old_side["id"],
            "key": "completed",
            "source_node_id": outcome["id"],
        },
    ).json()
    binding = client.post(
        "/api/flow-composition/bindings",
        json={
            "project_id": project["id"],
            "invocation_id": invocation["id"],
            "exit_id": flow_exit["id"],
            "target_node_id": continuation["id"],
        },
    ).json()
    edge_response = client.post(
        "/api/edges",
        json={
            "project_id": project["id"],
            "source_node_id": dialogue["id"],
            "target_node_id": outcome["id"],
            "type": "leads_to",
            "label": "Run the blockade",
            "metadata": {
                "dialogue_element_id": "answer-run-blockade",
                "outcome_flow_composition": {
                    "invocation_id": invocation["id"],
                    "source_flow_id": main["id"],
                    "target_flow_id": old_side["id"],
                },
            },
        },
    )
    assert edge_response.status_code == 201
    return {
        "binding": binding,
        "continuation": continuation,
        "dialogue": dialogue,
        "edge": edge_response.json(),
        "invocation": invocation,
        "main": main,
        "old_side": old_side,
        "outcome": outcome,
        "project": project,
    }


def test_crud_preserves_draft_then_resolves_story_and_playback_graph(client_factory) -> None:
    client, _ = client_factory
    project = create_project(client)
    main, main_nodes = _flow_with_nodes(client, project["id"], "Main", "Call", "Continue")
    side, side_nodes = _flow_with_nodes(client, project["id"], "Side", "Side ending")

    invocation = client.post(
        "/api/flow-composition/invocations",
        json=_invocation_payload(project["id"], main, main_nodes[0], side),
    )
    assert invocation.status_code == 201

    draft = client.get(
        f"/api/flow-composition/projects/{project['id']}/flows/{main['id']}/integrity"
    ).json()
    assert draft["executable"] is False
    assert {fact["code"] for fact in draft["facts"]} == {
        "composable_flow_called_without_reachable_exit"
    }

    flow_exit = client.post(
        "/api/flow-composition/exits",
        json={
            "project_id": project["id"],
            "expected_revision": 0,
            "flow_id": side["id"],
            "key": "success",
            "label": "Succeeded",
            "source_node_id": side_nodes[0]["id"],
        },
    )
    assert flow_exit.status_code == 201
    binding = client.post(
        "/api/flow-composition/bindings",
        json={
            "project_id": project["id"],
            "expected_revision": 0,
            "invocation_id": invocation.json()["id"],
            "exit_id": flow_exit.json()["id"],
            "target_node_id": main_nodes[1]["id"],
        },
    )
    assert binding.status_code == 201

    snapshot = client.get(f"/api/flow-composition/projects/{project['id']}").json()
    assert [item["id"] for item in snapshot["invocations"]] == [invocation.json()["id"]]
    for consumer in ("story", "playback"):
        projection = client.get(
            f"/api/flow-composition/projects/{project['id']}/flows/{main['id']}/{consumer}"
        )
        assert projection.status_code == 200
        assert projection.json()["consumer"] == consumer
        assert {item["id"] for item in projection.json()["graph"]["flows"]} == {
            main["id"],
            side["id"],
        }

    updated_invocation = client.put(
        f"/api/flow-composition/invocations/{invocation.json()['id']}",
        json={
            **_invocation_payload(project["id"], main, main_nodes[0], side),
            "label": "Updated call",
        },
    )
    assert updated_invocation.json()["label"] == "Updated call"
    updated_exit = client.put(
        f"/api/flow-composition/exits/{flow_exit.json()['id']}",
        json={
            "project_id": project["id"],
            "flow_id": side["id"],
            "key": "success",
            "label": "Updated exit",
            "source_node_id": side_nodes[0]["id"],
        },
    )
    assert updated_exit.json()["label"] == "Updated exit"
    updated_binding = client.put(
        f"/api/flow-composition/bindings/{binding.json()['id']}",
        json={
            "project_id": project["id"],
            "invocation_id": invocation.json()["id"],
            "exit_id": flow_exit.json()["id"],
            "target_node_id": main_nodes[1]["id"],
        },
    )
    assert updated_binding.status_code == 200

    command = {"project_id": project["id"], "expected_revision": 0}
    assert client.request(
        "DELETE", f"/api/flow-composition/bindings/{binding.json()['id']}", json=command
    ).status_code == 204
    assert client.request(
        "DELETE", f"/api/flow-composition/exits/{flow_exit.json()['id']}", json=command
    ).status_code == 204
    assert client.request(
        "DELETE", f"/api/flow-composition/invocations/{invocation.json()['id']}", json=command
    ).status_code == 204
    deleted_snapshot = client.get(f"/api/flow-composition/projects/{project['id']}").json()
    assert deleted_snapshot["invocations"] == []
    assert deleted_snapshot["exits"] == []
    assert deleted_snapshot["bindings"] == []


def test_atomically_replaces_specialized_outcome_with_new_side_flow(client_factory) -> None:
    client, _ = client_factory
    seeded = _specialized_outcome_call(client)

    response = client.post(
        "/api/flow-composition/outcomes/new-side-flow",
        json={
            "project_id": seeded["project"]["id"],
            "edge_id": seeded["edge"]["id"],
            "source_flow_id": seeded["main"]["id"],
            "name": "Replacement outcome",
            "description": "One atomic side flow.",
            "label": "Take the replacement route",
            "condition": "route.available",
            "priority": 0,
            "is_default": False,
        },
    )

    assert response.status_code == 201, response.text
    result = response.json()
    assert result["target_flow"]["flow"]["name"] == "Replacement outcome"
    assert result["target_flow"]["flow"]["entry_node_id"] == seeded["outcome"]["id"]
    assert result["target_flow"]["flow"]["status"] == "active"
    assert [item["node_id"] for item in result["target_flow"]["nodes"]] == [
        seeded["outcome"]["id"]
    ]
    association = result["edge"]["metadata"]["outcome_flow_composition"]
    assert association == {
        "invocation_id": result["invocation"]["id"],
        "source_flow_id": seeded["main"]["id"],
        "target_flow_id": result["target_flow"]["flow"]["id"],
    }
    snapshot = client.get(
        f"/api/flow-composition/projects/{seeded['project']['id']}"
    ).json()
    assert [item["id"] for item in snapshot["invocations"]] == [
        result["invocation"]["id"]
    ]
    assert snapshot["bindings"] == []


def test_outcome_side_flow_failure_rolls_back_every_flushed_record(
    client_factory, monkeypatch
) -> None:
    client, factory = client_factory
    seeded = _specialized_outcome_call(client)
    payload = OutcomeSideFlowCreate(
        project_id=seeded["project"]["id"],
        edge_id=seeded["edge"]["id"],
        source_flow_id=seeded["main"]["id"],
        name="Must roll back",
        label="Broken replacement",
        priority=0,
    )

    with SqlAlchemyUnitOfWork(factory) as uow:
        def fail_edge_update(_: object) -> None:
            raise RuntimeError("simulated outcome association failure")

        monkeypatch.setattr(uow.edges, "update", fail_edge_update)
        with pytest.raises(RuntimeError, match="simulated outcome association failure"):
            ComposableStoryFlowService().create_outcome_side_flow(uow, payload)

    flows = client.get(
        f"/api/story-flows?project_id={seeded['project']['id']}"
    ).json()
    assert {item["name"] for item in flows} == {"Main", "Old outcome"}
    snapshot = client.get(
        f"/api/flow-composition/projects/{seeded['project']['id']}"
    ).json()
    assert [item["id"] for item in snapshot["invocations"]] == [
        seeded["invocation"]["id"]
    ]
    assert [item["id"] for item in snapshot["bindings"]] == [seeded["binding"]["id"]]
    edge = client.get(f"/api/edges/{seeded['edge']['id']}").json()
    assert edge["metadata"]["outcome_flow_composition"]["invocation_id"] == seeded[
        "invocation"
    ]["id"]


def test_commands_reject_malformed_references_ambiguous_routes_and_cycles(client_factory) -> None:
    client, _ = client_factory
    project = create_project(client)
    first, first_nodes = _flow_with_nodes(client, project["id"], "First", "A", "A2")
    second, second_nodes = _flow_with_nodes(client, project["id"], "Second", "B")

    transition = client.post(
        f"/api/story-flows/{first['id']}/transitions",
        json=transition_payload(project["id"], first_nodes[0]["id"], first_nodes[1]["id"]),
    )
    assert transition.status_code == 201
    ambiguous = client.post(
        "/api/flow-composition/invocations",
        json=_invocation_payload(project["id"], first, first_nodes[0], second),
    )
    assert ambiguous.status_code == 409
    assert ambiguous.json()["detail"]["code"] == "composable_flow_ambiguous_routes"

    valid_payload = _invocation_payload(project["id"], first, first_nodes[1], second)
    valid = client.post("/api/flow-composition/invocations", json=valid_payload)
    assert valid.status_code == 201
    reverse = client.post(
        "/api/flow-composition/invocations",
        json=_invocation_payload(project["id"], second, second_nodes[0], first),
    )
    assert reverse.status_code == 409
    assert reverse.json()["detail"]["code"] == "composable_flow_call_cycle"

    malformed = client.post(
        "/api/flow-composition/bindings",
        json={
            "project_id": project["id"],
            "invocation_id": valid.json()["id"],
            "exit_id": "deleted-exit",
            "target_node_id": first_nodes[0]["id"],
        },
    )
    assert malformed.status_code == 404
    assert malformed.json()["detail"]["code"] == "composable_flow_exit_not_found"


def test_deletion_requires_review_and_rolls_back_impacted_bindings(client_factory, monkeypatch) -> None:
    client, factory = client_factory
    project = create_project(client)
    main, main_nodes = _flow_with_nodes(client, project["id"], "Main", "Call", "Return")
    side, side_nodes = _flow_with_nodes(client, project["id"], "Side", "Exit")
    invocation = client.post(
        "/api/flow-composition/invocations",
        json=_invocation_payload(project["id"], main, main_nodes[0], side),
    ).json()
    flow_exit = client.post(
        "/api/flow-composition/exits",
        json={
            "project_id": project["id"],
            "flow_id": side["id"],
            "key": "done",
            "source_node_id": side_nodes[0]["id"],
        },
    ).json()
    binding = client.post(
        "/api/flow-composition/bindings",
        json={
            "project_id": project["id"],
            "invocation_id": invocation["id"],
            "exit_id": flow_exit["id"],
            "target_node_id": main_nodes[1]["id"],
        },
    ).json()

    impact = client.get(
        f"/api/flow-composition/invocations/{invocation['id']}/impact"
    ).json()
    assert impact["binding_ids"] == [binding["id"]]
    flow_impact = client.get(f"/api/story-flows/{side['id']}/impact").json()
    assert flow_impact["invocation_ids"] == [invocation["id"]]
    assert flow_impact["exit_ids"] == [flow_exit["id"]]
    node_impact = client.get(
        f"/api/flow-composition/projects/{project['id']}/nodes/{main_nodes[1]['id']}/impact"
    ).json()
    assert node_impact["binding_ids"] == [binding["id"]]
    unreviewed = client.request(
        "DELETE",
        f"/api/flow-composition/invocations/{invocation['id']}",
        json={"project_id": project["id"], "expected_revision": 0},
    )
    assert unreviewed.status_code == 409
    assert unreviewed.json()["detail"]["code"] == "composable_flow_delete_impact_review_required"

    with SqlAlchemyUnitOfWork(factory) as uow:
        original = uow.flow_invocations.delete

        def fail_after_binding_delete(_: str) -> None:
            raise RuntimeError("simulated invocation delete failure")

        monkeypatch.setattr(uow.flow_invocations, "delete", fail_after_binding_delete)
        from services.runtime.stt_runtime.story_flow.composable_service import ComposableStoryFlowService

        with pytest.raises(RuntimeError, match="simulated"):
            ComposableStoryFlowService().delete_invocation(
                uow, invocation["id"], impact_reviewed=True
            )
        monkeypatch.setattr(uow.flow_invocations, "delete", original)

    snapshot = client.get(f"/api/flow-composition/projects/{project['id']}").json()
    assert [item["id"] for item in snapshot["bindings"]] == [binding["id"]]
    assert [item["id"] for item in snapshot["invocations"]] == [invocation["id"]]


def test_session_revision_guard_rejects_stale_composition_command(client_factory, tmp_path: Path) -> None:
    client, _ = client_factory
    created = client.post(
        "/api/project-sessions/create",
        json={"path": str(tmp_path / "Revision.narrative"), "name": "Revision"},
    ).json()
    session_id = created["session"]["session_id"]
    saved = client.post(
        f"/api/project-sessions/{session_id}/save",
        json={"expected_revision": 0, "reason": "manual"},
    )
    assert saved.json()["session"]["saved_revision"] == 1

    response = client.post(
        "/api/flow-composition/invocations",
        headers={"X-Project-Session-Id": session_id},
        json={
            "project_id": created["document"]["manifest"]["project_id"],
            "expected_revision": 0,
            "source_flow_id": "missing",
            "source_node_id": "missing",
            "target_flow_id": "missing",
            "priority": 0,
        },
    )
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "composable_flow_revision_stale"

import pytest
from fastapi.testclient import TestClient

from services.runtime.tests.test_crud_api import client, create_project
from services.runtime.tests.test_dialogue_api import branching_document, create_typed_node
from services.runtime.stt_runtime.repositories.sqlite import SqlAlchemyEdgeRepository


def dialogue_fixture(client: TestClient) -> tuple[dict, dict, dict]:
    project = create_project(client)
    keeper = create_typed_node(client, project["id"], "Character", "Keeper")
    mara = create_typed_node(client, project["id"], "Character", "Mara")
    dialogue = create_typed_node(client, project["id"], "Dialogue", "Door negotiation")
    document = branching_document(keeper["id"], mara["id"])
    assert client.put(f"/api/dialogues/{dialogue['id']}", json=document).status_code == 200
    return project, dialogue, document


def test_creates_transition_to_existing_target_with_origin_metadata(client: TestClient) -> None:
    project, dialogue, _ = dialogue_fixture(client)
    target = create_typed_node(client, project["id"], "Event", "Door opens")

    response = client.post(
        "/api/dialogue-transitions",
        json={
            "dialogue_node_id": dialogue["id"],
            "dialogue_element_id": "answer-seal",
            "target_node_id": target["id"],
            "relationship_type": "unlocks",
            "label": "keeper opens the door",
        },
    )

    assert response.status_code == 201
    transition = response.json()
    assert transition["target_node"]["id"] == target["id"]
    assert transition["edge"]["source_node_id"] == dialogue["id"]
    assert transition["edge"]["metadata"]["dialogue_element_id"] == "answer-seal"


def test_atomically_persists_current_dialogue_new_event_and_transition(client: TestClient) -> None:
    project, dialogue, document = dialogue_fixture(client)
    document["elements"].append(
        {
            "id": "line-force-door",
            "kind": "line",
            "speaker_node_id": document["participants"][1],
            "text": "Stand back. I will open it.",
            "next_element_id": None,
        }
    )

    response = client.post(
        "/api/dialogue-transitions",
        json={
            "dialogue_node_id": dialogue["id"],
            "dialogue_element_id": "line-force-door",
            "dialogue_document": document,
            "new_target": {"type": "Event", "title": "Mara forces the door", "summary": "Mara breaks the lock."},
            "relationship_type": "leads_to",
            "label": "forces the door",
        },
    )

    assert response.status_code == 201
    created = response.json()
    assert created["target_node"]["type"] == "Event"
    assert created["edge"]["target_node_id"] == created["target_node"]["id"]
    assert client.get(f"/api/dialogues/{dialogue['id']}").json() == document
    assert len(client.get(f"/api/nodes?project_id={project['id']}").json()) == 4


def test_rejects_stale_origin_without_creating_target_or_edge(client: TestClient) -> None:
    project, dialogue, _ = dialogue_fixture(client)
    before_nodes = client.get(f"/api/nodes?project_id={project['id']}").json()

    response = client.post(
        "/api/dialogue-transitions",
        json={
            "dialogue_node_id": dialogue["id"],
            "dialogue_element_id": "missing-answer",
            "new_target": {"type": "Event", "title": "Orphan event"},
            "label": "invalid",
        },
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "dialogue_origin_not_found"
    assert client.get(f"/api/nodes?project_id={project['id']}").json() == before_nodes
    assert client.get(f"/api/edges?project_id={project['id']}").json() == []


def test_updates_transition_target_semantics_and_origin(client: TestClient) -> None:
    project, dialogue, _ = dialogue_fixture(client)
    first = create_typed_node(client, project["id"], "Event", "Door opens")
    second = create_typed_node(client, project["id"], "Quest", "Escape route")
    created = client.post(
        "/api/dialogue-transitions",
        json={
            "dialogue_node_id": dialogue["id"],
            "dialogue_element_id": "answer-seal",
            "target_node_id": first["id"],
            "label": "opens",
        },
    ).json()

    response = client.put(
        f"/api/dialogue-transitions/{created['edge']['id']}",
        json={
            "dialogue_element_id": "line-door",
            "target_node_id": second["id"],
            "relationship_type": "unlocks",
            "label": "unlocks escape route",
            "outcome_flow_composition": {
                "invocation_id": "invocation-dialogue",
                "source_flow_id": "flow-main",
                "target_flow_id": "flow-side",
            },
        },
    )

    assert response.status_code == 200
    edge = response.json()["edge"]
    assert edge["target_node_id"] == second["id"]
    assert edge["type"] == "unlocks"
    assert edge["metadata"]["dialogue_element_id"] == "line-door"
    assert edge["metadata"]["outcome_flow_composition"]["invocation_id"] == "invocation-dialogue"

    cleared = client.put(
        f"/api/dialogue-transitions/{created['edge']['id']}",
        json={
            "dialogue_element_id": "line-door",
            "target_node_id": second["id"],
            "relationship_type": "unlocks",
            "label": "unlocks escape route",
            "outcome_flow_composition": None,
        },
    )
    assert "outcome_flow_composition" not in cleared.json()["edge"]["metadata"]


def test_rejects_cross_project_target_and_non_transition_update(client: TestClient) -> None:
    project, dialogue, _ = dialogue_fixture(client)
    other_project = create_project(client)
    external = create_typed_node(client, other_project["id"], "Event", "External")
    local = create_typed_node(client, project["id"], "Event", "Local")

    cross_project = client.post(
        "/api/dialogue-transitions",
        json={
            "dialogue_node_id": dialogue["id"],
            "dialogue_element_id": "line-door",
            "target_node_id": external["id"],
            "label": "invalid",
        },
    )
    generic_edge = client.post(
        "/api/edges",
        json={
            "project_id": project["id"],
            "source_node_id": dialogue["id"],
            "target_node_id": local["id"],
            "type": "leads_to",
        },
    ).json()
    wrong_update = client.put(
        f"/api/dialogue-transitions/{generic_edge['id']}",
        json={
            "dialogue_element_id": "line-door",
            "target_node_id": local["id"],
            "relationship_type": "leads_to",
            "label": "invalid",
        },
    )

    assert cross_project.status_code == 409
    assert cross_project.json()["detail"]["code"] == "dialogue_cross_project_transition"
    assert wrong_update.status_code == 409
    assert wrong_update.json()["detail"]["code"] == "edge_is_not_dialogue_transition"


def test_rejects_document_update_that_would_orphan_transition(client: TestClient) -> None:
    project, dialogue, document = dialogue_fixture(client)
    target = create_typed_node(client, project["id"], "Event", "Door opens")
    created = client.post(
        "/api/dialogue-transitions",
        json={
            "dialogue_node_id": dialogue["id"],
            "dialogue_element_id": "answer-seal",
            "target_node_id": target["id"],
            "label": "opens",
        },
    ).json()
    document["elements"][1]["options"] = []

    response = client.put(f"/api/dialogues/{dialogue['id']}", json=document)

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "dialogue_transition_origin_stale"
    assert client.get(f"/api/edges/{created['edge']['id']}").status_code == 200


def test_rolls_back_new_target_when_edge_insertion_fails(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    project, dialogue, _ = dialogue_fixture(client)
    before_nodes = client.get(f"/api/nodes?project_id={project['id']}").json()

    def fail_edge_insert(self: SqlAlchemyEdgeRepository, edge: object) -> None:
        raise RuntimeError("forced edge insertion failure")

    monkeypatch.setattr(SqlAlchemyEdgeRepository, "add", fail_edge_insert)
    with pytest.raises(RuntimeError, match="forced edge insertion failure"):
        client.post(
            "/api/dialogue-transitions",
            json={
                "dialogue_node_id": dialogue["id"],
                "dialogue_element_id": "line-door",
                "new_target": {"type": "Event", "title": "Rolled back target"},
                "label": "fails",
            },
        )

    assert client.get(f"/api/nodes?project_id={project['id']}").json() == before_nodes


def test_reports_invalid_stored_dialogue_before_transition_creation(client: TestClient) -> None:
    project = create_project(client)
    dialogue = create_typed_node(
        client,
        project["id"],
        "Dialogue",
        "Broken dialogue",
        {"dialogue_document": {"dialogue_version": 1, "entry_element_id": "missing", "participants": [], "elements": []}},
    )
    target = create_typed_node(client, project["id"], "Event", "Target")

    response = client.post(
        "/api/dialogue-transitions",
        json={
            "dialogue_node_id": dialogue["id"],
            "dialogue_element_id": "missing",
            "target_node_id": target["id"],
            "label": "invalid",
        },
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "dialogue_stored_document_invalid"

from fastapi.testclient import TestClient

from services.runtime.tests.test_crud_api import client, create_project


def create_typed_node(client: TestClient, project_id: str, node_type: str, title: str, metadata: dict | None = None) -> dict:
    response = client.post(
        "/api/nodes",
        json={"project_id": project_id, "type": node_type, "title": title, "metadata": metadata or {}},
    )
    assert response.status_code == 201
    return response.json()


def branching_document(first_character_id: str, second_character_id: str) -> dict:
    return {
        "dialogue_version": 1,
        "entry_element_id": "line-door",
        "participants": [first_character_id, second_character_id],
        "elements": [
            {
                "id": "line-door",
                "kind": "line",
                "speaker_node_id": first_character_id,
                "text": "Why should I open the door?",
                "next_element_id": "choice-answer",
            },
            {
                "id": "choice-answer",
                "kind": "choice",
                "prompt": "Choose an answer",
                "options": [
                    {"id": "answer-seal", "text": "Show the seal.", "condition": "seal_acquired", "next_element_id": None}
                ],
            },
        ],
    }


def test_dialogue_api_lazily_persists_empty_document(client: TestClient) -> None:
    project = create_project(client)
    dialogue = create_typed_node(client, project["id"], "Dialogue", "Door negotiation", {"position": {"x": 40, "y": 80}})

    response = client.get(f"/api/dialogues/{dialogue['id']}")

    assert response.status_code == 200
    assert response.json() == {"dialogue_version": 1, "entry_element_id": None, "participants": [], "elements": []}
    stored_node = client.get(f"/api/nodes/{dialogue['id']}").json()
    assert stored_node["metadata"]["position"] == {"x": 40, "y": 80}
    assert stored_node["metadata"]["dialogue_document"] == response.json()


def test_dialogue_api_persists_branching_document_and_preserves_metadata(client: TestClient) -> None:
    project = create_project(client)
    first = create_typed_node(client, project["id"], "Character", "Door keeper")
    second = create_typed_node(client, project["id"], "Character", "Mara")
    dialogue = create_typed_node(client, project["id"], "Dialogue", "Door negotiation", {"tags": ["gate"]})
    document = branching_document(first["id"], second["id"])

    update = client.put(f"/api/dialogues/{dialogue['id']}", json=document)

    assert update.status_code == 200
    assert client.get(f"/api/dialogues/{dialogue['id']}").json() == document
    stored_node = client.get(f"/api/nodes/{dialogue['id']}").json()
    assert stored_node["metadata"]["tags"] == ["gate"]
    assert stored_node["metadata"]["dialogue_document"] == document


def test_dialogue_api_rejects_missing_and_non_dialogue_nodes(client: TestClient) -> None:
    project = create_project(client)
    scene = create_typed_node(client, project["id"], "Scene", "Opening")

    missing = client.get("/api/dialogues/missing")
    wrong_type = client.get(f"/api/dialogues/{scene['id']}")

    assert missing.status_code == 404
    assert missing.json()["detail"]["code"] == "dialogue_node_not_found"
    assert wrong_type.status_code == 409
    assert wrong_type.json()["detail"]["code"] == "node_is_not_dialogue"


def test_dialogue_api_rejects_invalid_participants_without_writing(client: TestClient) -> None:
    first_project = create_project(client)
    second_project = create_project(client)
    dialogue = create_typed_node(client, first_project["id"], "Dialogue", "Door negotiation", {"owner": "author"})
    scene = create_typed_node(client, first_project["id"], "Scene", "Not a character")
    external_character = create_typed_node(client, second_project["id"], "Character", "External")

    missing = client.put(f"/api/dialogues/{dialogue['id']}", json={"participants": ["missing"], "elements": []})
    wrong_type = client.put(f"/api/dialogues/{dialogue['id']}", json={"participants": [scene["id"]], "elements": []})
    cross_project = client.put(f"/api/dialogues/{dialogue['id']}", json={"participants": [external_character["id"]], "elements": []})

    assert missing.json()["detail"]["code"] == "dialogue_participant_not_found"
    assert wrong_type.json()["detail"]["code"] == "dialogue_participant_not_character"
    assert cross_project.json()["detail"]["code"] == "dialogue_cross_project_participant"
    stored = client.get(f"/api/nodes/{dialogue['id']}").json()
    assert stored["metadata"] == {"owner": "author"}


def test_dialogue_api_rejects_malformed_document_without_writing(client: TestClient) -> None:
    project = create_project(client)
    character = create_typed_node(client, project["id"], "Character", "Keeper")
    dialogue = create_typed_node(client, project["id"], "Dialogue", "Door negotiation")
    malformed = branching_document(character["id"], character["id"])
    malformed["entry_element_id"] = "missing"

    response = client.put(f"/api/dialogues/{dialogue['id']}", json=malformed)

    assert response.status_code == 422
    assert response.json()["error"] == "validation_error"
    assert "dialogue_document" not in client.get(f"/api/nodes/{dialogue['id']}").json()["metadata"]


def test_dialogue_api_reports_invalid_stored_document_without_replacing_it(client: TestClient) -> None:
    project = create_project(client)
    invalid_document = {"dialogue_version": 1, "entry_element_id": "missing", "participants": [], "elements": []}
    dialogue = create_typed_node(
        client,
        project["id"],
        "Dialogue",
        "Legacy broken dialogue",
        {"dialogue_document": invalid_document},
    )

    response = client.get(f"/api/dialogues/{dialogue['id']}")

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "dialogue_stored_document_invalid"
    assert client.get(f"/api/nodes/{dialogue['id']}").json()["metadata"]["dialogue_document"] == invalid_document

from fastapi.testclient import TestClient

from services.runtime.tests.test_crud_api import client, create_project


def create_typed_node(client: TestClient, project_id: str, kind: str, title: str) -> dict:
    """Create concise canonical fixtures through the public runtime boundary."""
    response = client.post("/api/nodes", json={"project_id": project_id, "type": kind, "title": title})
    assert response.status_code == 201
    return response.json()


def test_faction_membership_add_list_remove_and_validation(client: TestClient) -> None:
    """Membership operations persist hidden edges and preserve both endpoint nodes."""
    project = create_project(client)
    faction = create_typed_node(client, project["id"], "Faction", "Trade Guild")
    character = create_typed_node(client, project["id"], "Character", "Mara Vale")
    item = create_typed_node(client, project["id"], "Item", "Ledger")

    created = client.post(f"/api/factions/{faction['id']}/members", json={"character_node_id": character["id"]})
    assert created.status_code == 201
    assert created.json()["type"] == "member_of"
    assert created.json()["metadata"] == {"canvas_visibility": "hidden", "semantic_scope": "membership"}
    assert len(client.get(f"/api/factions/{faction['id']}/members").json()) == 1

    assert client.post(f"/api/factions/{faction['id']}/members", json={"character_node_id": character["id"]}).status_code == 409
    assert client.post(f"/api/factions/{faction['id']}/members", json={"character_node_id": item["id"]}).status_code == 409

    removed = client.delete(f"/api/factions/{faction['id']}/members/{character['id']}")
    assert removed.status_code == 204
    assert client.get(f"/api/nodes/{character['id']}").status_code == 200
    assert client.get(f"/api/nodes/{faction['id']}").status_code == 200
    assert client.get(f"/api/factions/{faction['id']}/members").json() == []


def test_faction_membership_rejects_cross_project_character(client: TestClient) -> None:
    """Semantic membership cannot cross project ownership boundaries."""
    first = create_project(client)
    second_response = client.post(
        "/api/projects",
        json={"name": "Other", "path": "/tmp/Other.narrative", "format_version": 1},
    )
    assert second_response.status_code == 201
    faction = create_typed_node(client, first["id"], "Faction", "Trade Guild")
    character = create_typed_node(client, second_response.json()["id"], "Character", "Visitor")

    response = client.post(f"/api/factions/{faction['id']}/members", json={"character_node_id": character["id"]})
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "membership_cross_project"

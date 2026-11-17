from fastapi.testclient import TestClient

from services.runtime.tests.test_crud_api import client, create_project
from services.runtime.tests.test_dialogue_api import create_typed_node


def quest_document(giver_id: str, requirement_id: str, reward_id: str) -> dict:
    """Returns a valid fixture with both internal and externally-owned branches."""
    return {
        "quest_version": 1,
        "objective": "Open a safe route through Glass Harbor.",
        "quest_giver_node_id": giver_id,
        "entry_stage_id": "stage-ledger",
        "prerequisite_node_ids": [requirement_id],
        "reward_node_ids": [reward_id],
        "stages": [
            {
                "id": "stage-ledger",
                "title": "Secure the ledger",
                "description": "Find proof of the forged embargo.",
                "branches": [{"id": "branch-negotiate", "label": "Present the proof", "condition": "ledger_acquired", "target_stage_id": "stage-harbor"}],
            },
            {
                "id": "stage-harbor",
                "title": "Reach the harbor",
                "description": "Choose how to leave.",
                "branches": [{"id": "branch-depart", "label": "Depart safely", "condition": "", "target_stage_id": None}],
            },
        ],
    }


def quest_fixture(client: TestClient) -> tuple[dict, dict, dict]:
    project = create_project(client)
    giver = create_typed_node(client, project["id"], "Character", "Ilya")
    requirement = create_typed_node(client, project["id"], "Condition", "Ledger acquired")
    reward = create_typed_node(client, project["id"], "Item", "Harbor pass")
    quest = create_typed_node(client, project["id"], "Quest", "Smuggler Route")
    document = quest_document(giver["id"], requirement["id"], reward["id"])
    assert client.put(f"/api/quests/{quest['id']}", json=document).status_code == 200
    return project, quest, document


def test_lazily_initializes_legacy_quest_from_title_and_summary(client: TestClient) -> None:
    project = create_project(client)
    quest = client.post(
        "/api/nodes",
        json={"project_id": project["id"], "type": "Quest", "title": "Legacy route", "summary": "Find another way out.", "metadata": {"tags": ["route"]}},
    ).json()

    response = client.get(f"/api/quests/{quest['id']}")

    assert response.status_code == 200
    assert response.json()["objective"] == "Find another way out."
    assert response.json()["entry_stage_id"] == "stage-1"
    stored = client.get(f"/api/nodes/{quest['id']}").json()
    assert stored["metadata"]["tags"] == ["route"]
    assert stored["metadata"]["quest_document"] == response.json()


def test_persists_valid_quest_and_rejects_wrong_reference_kinds(client: TestClient) -> None:
    project, quest, document = quest_fixture(client)
    scene = create_typed_node(client, project["id"], "Scene", "Not a giver")
    invalid = {**document, "quest_giver_node_id": scene["id"]}

    response = client.put(f"/api/quests/{quest['id']}", json=invalid)

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "quest_giver_wrong_type"
    assert client.get(f"/api/quests/{quest['id']}").json() == document


def test_creates_external_transition_with_stage_and_branch_metadata(client: TestClient) -> None:
    project, quest, document = quest_fixture(client)
    event = create_typed_node(client, project["id"], "Event", "Route opens")

    response = client.post(
        "/api/quest-transitions",
        json={
            "quest_node_id": quest["id"],
            "quest_stage_id": "stage-harbor",
            "quest_branch_id": "branch-depart",
            "target_node_id": event["id"],
            "relationship_type": "leads_to",
            "label": "opens route",
        },
    )

    assert response.status_code == 201
    edge = response.json()["edge"]
    assert edge["metadata"] == {"quest_stage_id": "stage-harbor", "quest_branch_id": "branch-depart"}
    assert edge["target_node_id"] == event["id"]
    assert client.get(f"/api/quests/{quest['id']}").json() == document
    duplicate = client.post(
        "/api/quest-transitions",
        json={
            "quest_node_id": quest["id"],
            "quest_stage_id": "stage-harbor",
            "quest_branch_id": "branch-depart",
            "target_node_id": event["id"],
        },
    )
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"]["code"] == "quest_transition_origin_duplicate"


def test_updates_quest_outcome_flow_composition_reference(client: TestClient) -> None:
    project, quest, _ = quest_fixture(client)
    event = create_typed_node(client, project["id"], "Event", "Route opens")
    created = client.post(
        "/api/quest-transitions",
        json={
            "quest_node_id": quest["id"],
            "quest_stage_id": "stage-harbor",
            "quest_branch_id": "branch-depart",
            "target_node_id": event["id"],
        },
    ).json()

    response = client.put(
        f"/api/quest-transitions/{created['edge']['id']}",
        json={
            "quest_stage_id": "stage-harbor",
            "quest_branch_id": "branch-depart",
            "target_node_id": event["id"],
            "outcome_flow_composition": {
                "invocation_id": "invocation-quest",
                "source_flow_id": "flow-main",
                "target_flow_id": "flow-side",
            },
        },
    )

    assert response.status_code == 200
    assert response.json()["edge"]["metadata"]["outcome_flow_composition"] == {
        "invocation_id": "invocation-quest",
        "source_flow_id": "flow-main",
        "target_flow_id": "flow-side",
    }


def test_rejects_unsupported_or_stale_transition_origins(client: TestClient) -> None:
    project, quest, _ = quest_fixture(client)
    character = create_typed_node(client, project["id"], "Character", "Unsupported target")

    unsupported = client.post(
        "/api/quest-transitions",
        json={
            "quest_node_id": quest["id"],
            "quest_stage_id": "stage-harbor",
            "quest_branch_id": "branch-depart",
            "target_node_id": character["id"],
        },
    )
    stale = client.post(
        "/api/quest-transitions",
        json={
            "quest_node_id": quest["id"],
            "quest_stage_id": "stage-harbor",
            "quest_branch_id": "missing",
            "new_target": {"type": "Event", "title": "Must not be created"},
        },
    )

    assert unsupported.status_code == 409
    assert unsupported.json()["detail"]["code"] == "quest_transition_target_kind_invalid"
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "quest_origin_not_found"
    assert all(node["title"] != "Must not be created" for node in client.get(f"/api/nodes?project_id={project['id']}").json())


def test_document_update_rejects_orphaning_an_external_transition(client: TestClient) -> None:
    project, quest, document = quest_fixture(client)
    event = create_typed_node(client, project["id"], "Event", "Route opens")
    created = client.post(
        "/api/quest-transitions",
        json={
            "quest_node_id": quest["id"],
            "quest_stage_id": "stage-harbor",
            "quest_branch_id": "branch-depart",
            "target_node_id": event["id"],
        },
    ).json()
    document["stages"][1]["branches"] = []

    response = client.put(f"/api/quests/{quest['id']}", json=document)

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "quest_transition_origin_stale"
    assert client.get(f"/api/edges/{created['edge']['id']}").status_code == 200

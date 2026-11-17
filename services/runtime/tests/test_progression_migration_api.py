from fastapi.testclient import TestClient

from services.runtime.tests.test_story_flow_api import client, create_flow, create_node, create_project


def create_progression_edge(
    client: TestClient,
    project_id: str,
    source_id: str,
    target_id: str,
    *,
    label: str,
    metadata: dict | None = None,
) -> dict:
    response = client.post(
        "/api/edges",
        json={
            "project_id": project_id,
            "source_node_id": source_id,
            "target_node_id": target_id,
            "type": "leads_to",
            "label": label,
            "condition": "",
            "metadata": metadata or {},
        },
    )
    assert response.status_code == 201
    return response.json()


def test_reports_evidence_and_accepts_dialogue_candidate_atomically(client: TestClient) -> None:
    project = create_project(client)
    source = create_node(client, project["id"], "Dialogue", "Gate choice")
    target = create_node(client, project["id"], "Event", "Gate opens")
    flow = create_flow(client, project["id"])
    edge = create_progression_edge(
        client,
        project["id"],
        source["id"],
        target["id"],
        label="Guard agrees",
        metadata={"dialogue_element_id": "answer-agree"},
    )

    review = client.get("/api/progression-migrations", params={"project_id": project["id"]})
    assert review.status_code == 200
    candidate = review.json()["pending"][0]
    assert candidate["origin_kind"] == "dialogue"
    assert candidate["edge_id"] == edge["id"]
    assert candidate["evidence"] == [
        "Relationship type is leads_to.",
        "Owned by Dialogue origin answer-agree.",
    ]

    accepted = client.post(
        f"/api/progression-migrations/{candidate['fingerprint']}/accept",
        json={
            "project_id": project["id"],
            "flow_id": flow["id"],
            "preserve_relationship": True,
            "kind": "branch",
            "label": "Guard agrees",
            "condition": "trust >= 2",
        },
    )
    assert accepted.status_code == 200
    body = accepted.json()
    assert body["decision"]["status"] == "accepted"
    assert body["decision"]["original_relationship"] == "preserved"
    assert body["snapshot"]["flow"]["entry_node_id"] == source["id"]
    assert [item["node_id"] for item in body["snapshot"]["nodes"]] == [source["id"], target["id"]]
    assert body["transition"]["metadata"]["semantic_edge_id"] == edge["id"]
    assert client.get(f"/api/edges/{edge['id']}").status_code == 200

    repeated = client.get("/api/progression-migrations", params={"project_id": project["id"]}).json()
    assert repeated["pending"] == []
    assert repeated["decisions"][0]["fingerprint"] == candidate["fingerprint"]
    assert client.post(
        f"/api/progression-migrations/{candidate['fingerprint']}/accept",
        json={"project_id": project["id"], "flow_id": flow["id"]},
    ).status_code == 404

    client.put(
        f"/api/edges/{edge['id']}",
        json={
            "project_id": project["id"],
            "source_node_id": source["id"],
            "target_node_id": target["id"],
            "type": "leads_to",
            "label": "Guard opens the gate",
            "condition": "",
            "metadata": {"dialogue_element_id": "answer-agree"},
        },
    )
    changed = client.get("/api/progression-migrations", params={"project_id": project["id"]}).json()["pending"][0]
    revised = client.post(
        f"/api/progression-migrations/{changed['fingerprint']}/accept",
        json={
            "project_id": project["id"],
            "flow_id": flow["id"],
            "kind": "next",
            "label": "Guard opens the gate",
        },
    )
    assert revised.status_code == 200
    assert revised.json()["transition"]["id"] == body["transition"]["id"]
    assert len(revised.json()["snapshot"]["transitions"]) == 1


def test_rejection_is_remembered_until_source_signature_changes(client: TestClient) -> None:
    project = create_project(client)
    source = create_node(client, project["id"], "Quest", "Smuggler route")
    target = create_node(client, project["id"], "Event", "Blockade run")
    edge = create_progression_edge(
        client,
        project["id"],
        source["id"],
        target["id"],
        label="Run blockade",
        metadata={"quest_stage_id": "choose-route", "quest_branch_id": "run"},
    )
    candidate = client.get("/api/progression-migrations", params={"project_id": project["id"]}).json()["pending"][0]

    rejected = client.post(
        f"/api/progression-migrations/{candidate['fingerprint']}/reject",
        json={"project_id": project["id"]},
    )
    assert rejected.status_code == 200
    assert rejected.json()["status"] == "rejected"
    assert client.get("/api/progression-migrations", params={"project_id": project["id"]}).json()["pending"] == []

    update = client.put(
        f"/api/edges/{edge['id']}",
        json={
            "project_id": project["id"],
            "source_node_id": source["id"],
            "target_node_id": target["id"],
            "type": "leads_to",
            "label": "Run the eastern blockade",
            "condition": "",
            "metadata": {"quest_stage_id": "choose-route", "quest_branch_id": "run"},
        },
    )
    assert update.status_code == 200
    changed = client.get("/api/progression-migrations", params={"project_id": project["id"]}).json()
    assert len(changed["pending"]) == 1
    assert changed["pending"][0]["fingerprint"] != candidate["fingerprint"]
    assert changed["decisions"][0]["status"] == "rejected"


def test_accept_can_remove_original_only_after_transition_exists(client: TestClient) -> None:
    project = create_project(client)
    source = create_node(client, project["id"], "Event", "Inspection")
    target = create_node(client, project["id"], "Consequence", "Route reopened")
    flow = create_flow(client, project["id"])
    edge = create_progression_edge(client, project["id"], source["id"], target["id"], label="Reopens route")
    candidate = client.get("/api/progression-migrations", params={"project_id": project["id"]}).json()["pending"][0]

    accepted = client.post(
        f"/api/progression-migrations/{candidate['fingerprint']}/accept",
        json={
            "project_id": project["id"],
            "flow_id": flow["id"],
            "preserve_relationship": False,
            "kind": "next",
        },
    )

    assert accepted.status_code == 200
    assert accepted.json()["decision"]["original_relationship"] == "removed"
    assert len(accepted.json()["snapshot"]["transitions"]) == 1
    assert client.get(f"/api/edges/{edge['id']}").status_code == 404


def test_invalid_conversion_rolls_back_memberships_transition_and_decision(client: TestClient) -> None:
    project = create_project(client)
    source = create_node(client, project["id"], "Event", "Choice")
    target = create_node(client, project["id"], "Event", "Result")
    flow = create_flow(client, project["id"])
    edge = create_progression_edge(client, project["id"], source["id"], target["id"], label="Choose")
    candidate = client.get("/api/progression-migrations", params={"project_id": project["id"]}).json()["pending"][0]

    invalid = client.post(
        f"/api/progression-migrations/{candidate['fingerprint']}/accept",
        json={
            "project_id": project["id"],
            "flow_id": flow["id"],
            "preserve_relationship": False,
            "kind": "branch",
            "condition": "",
        },
    )

    assert invalid.status_code == 409
    snapshot = client.get(f"/api/story-flows/{flow['id']}").json()
    assert snapshot["nodes"] == []
    assert snapshot["transitions"] == []
    review = client.get("/api/progression-migrations", params={"project_id": project["id"]}).json()
    assert [item["fingerprint"] for item in review["pending"]] == [candidate["fingerprint"]]
    assert review["decisions"] == []
    assert client.get(f"/api/edges/{edge['id']}").status_code == 200

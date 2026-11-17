from fastapi.testclient import TestClient

from services.runtime.tests.test_crud_api import client, create_node, create_project
from services.runtime.stt_runtime.analysis.extractor import DeterministicSceneExtractor
from services.runtime.stt_runtime.analysis.graph_builder import GraphPatchBuilder


def test_scene_analysis_api_creates_suggestion_without_mutating_graph(client: TestClient) -> None:
    project = create_project(client)
    mara = create_node(client, project["id"], "Mara Vale")
    client.put(
        f"/api/nodes/{mara['id']}",
        json={
            "project_id": project["id"],
            "type": "Character",
            "title": "Mara Vale",
            "summary": "Old summary.",
        },
    )

    response = client.post(
        "/api/analysis/scenes",
        json={
            "project_id": project["id"],
            "title": "Harbor Inspection",
            "scene_text": "\n".join(
                [
                    "Character: Mara Vale - Smuggler captain carrying the sealed ledger.",
                    "Location: Glass Harbor - Neutral port under embargo patrol.",
                    "Relationship: Mara Vale located_in Glass Harbor - Mara reaches the harbor at dusk.",
                ]
            ),
        },
    )

    assert response.status_code == 201
    payload = response.json()
    assert payload["suggestion_id"]
    assert payload["provider"] == "deterministic"
    assert [operation["op"] for operation in payload["patch"]["operations"]] == ["update_node", "create_node", "create_edge"]
    assert payload["patch"]["operations"][0]["node_id"] == mara["id"]
    assert payload["patch"]["operations"][2]["edge"]["relationship_type"] == "located_in"

    suggestions = client.get(f"/api/suggestions?project_id={project['id']}").json()
    assert len(suggestions) == 1
    assert suggestions[0]["id"] == payload["suggestion_id"]
    assert suggestions[0]["patch"] == payload["patch"]
    assert suggestions[0]["metadata"]["operation_count"] == 3

    nodes = client.get(f"/api/nodes?project_id={project['id']}").json()
    edges = client.get(f"/api/edges?project_id={project['id']}").json()
    assert len(nodes) == 1
    assert nodes[0]["summary"] == "Old summary."
    assert edges == []


def test_scene_analysis_api_returns_noop_suggestion_for_no_applicable_changes(client: TestClient) -> None:
    project = create_project(client)

    response = client.post(
        "/api/analysis/scenes",
        json={"project_id": project["id"], "title": "No-op Scene", "scene_text": "Mood: tense"},
    )

    assert response.status_code == 201
    payload = response.json()
    assert payload["patch"]["operations"] == []
    assert payload["warnings"] == ["No applicable graph changes were found."]
    assert len(client.get(f"/api/suggestions?project_id={project['id']}").json()) == 1


def test_scene_analysis_api_validates_request_body(client: TestClient) -> None:
    response = client.post("/api/analysis/scenes", json={"project_id": "project-id", "scene_text": ""})

    assert response.status_code == 422
    assert response.json()["error"] == "validation_error"
    assert response.json()["detail"][0]["field"] == "body.scene_text"


def test_scene_analysis_api_rejects_missing_project(client: TestClient) -> None:
    response = client.post(
        "/api/analysis/scenes",
        json={"project_id": "missing", "title": "Missing", "scene_text": "Character: Mara Vale"},
    )

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "project_not_found"


def test_scene_analysis_api_maps_provider_unavailability(client: TestClient, monkeypatch) -> None:
    project = create_project(client)

    def unavailable(*_args, **_kwargs):
        raise ConnectionError("offline")

    monkeypatch.setattr(DeterministicSceneExtractor, "extract", unavailable)
    response = client.post(
        "/api/analysis/scenes",
        json={"project_id": project["id"], "title": "Offline", "scene_text": "Character: Mara Vale"},
    )

    assert response.status_code == 503
    assert response.json()["detail"] == {
        "code": "provider_unavailable",
        "message": "The configured analysis provider is unavailable.",
    }


def test_scene_analysis_api_maps_extraction_and_patch_failures(client: TestClient, monkeypatch) -> None:
    project = create_project(client)

    def extraction_failure(*_args, **_kwargs):
        raise RuntimeError("invalid provider output")

    monkeypatch.setattr(DeterministicSceneExtractor, "extract", extraction_failure)
    extraction = client.post(
        "/api/analysis/scenes",
        json={"project_id": project["id"], "title": "Broken", "scene_text": "Character: Mara Vale"},
    )
    assert extraction.status_code == 422
    assert extraction.json()["detail"]["code"] == "extraction_failed"

    monkeypatch.undo()

    def patch_failure(*_args, **_kwargs):
        raise ValueError("invalid patch")

    monkeypatch.setattr(GraphPatchBuilder, "build_patch", patch_failure)
    patch = client.post(
        "/api/analysis/scenes",
        json={"project_id": project["id"], "title": "Broken", "scene_text": "Character: Mara Vale"},
    )
    assert patch.status_code == 422
    assert patch.json()["detail"]["code"] == "patch_validation_failed"


def test_suggestion_approval_applies_patch_and_marks_suggestion_approved(client: TestClient) -> None:
    project = create_project(client)
    analysis = client.post(
        "/api/analysis/scenes",
        json={
            "project_id": project["id"],
            "title": "Harbor Arrival",
            "scene_text": "\n".join(
                [
                    "Character: Mara Vale - Smuggler captain.",
                    "Location: Glass Harbor - Neutral port.",
                    "Relationship: Mara Vale located_in Glass Harbor - Mara reaches the harbor.",
                ]
            ),
        },
    ).json()

    response = client.post(f"/api/suggestions/{analysis['suggestion_id']}/approve")

    assert response.status_code == 200
    assert response.json()["status"] == "approved"
    assert response.json()["metadata"]["applied_operation_count"] == 3
    nodes = client.get(f"/api/nodes?project_id={project['id']}").json()
    edges = client.get(f"/api/edges?project_id={project['id']}").json()
    assert {(node["type"], node["title"], node["status"]) for node in nodes} == {
        ("Character", "Mara Vale", "canon"),
        ("Location", "Glass Harbor", "canon"),
    }
    assert edges[0]["type"] == "located_in"
    assert edges[0]["source_node_id"] != edges[0]["target_node_id"]


def test_suggestion_rejection_preserves_graph_and_marks_suggestion_rejected(client: TestClient) -> None:
    project = create_project(client)
    analysis = client.post(
        "/api/analysis/scenes",
        json={"project_id": project["id"], "title": "Rejected", "scene_text": "Character: Mara Vale"},
    ).json()

    response = client.post(f"/api/suggestions/{analysis['suggestion_id']}/reject")

    assert response.status_code == 200
    assert response.json()["status"] == "rejected"
    assert client.get(f"/api/nodes?project_id={project['id']}").json() == []
    assert client.post(f"/api/suggestions/{analysis['suggestion_id']}/approve").status_code == 409


def test_suggestion_approval_rejects_stale_patch_without_partial_changes(client: TestClient) -> None:
    project = create_project(client)
    suggestion = client.post(
        "/api/suggestions",
        json={
            "project_id": project["id"],
            "title": "Stale patch",
            "patch": {
                "title": "Stale patch",
                "operations": [
                    {"op": "update_node", "node_id": "missing-node", "updates": {"summary": "Changed"}}
                ],
            },
        },
    ).json()

    response = client.post(f"/api/suggestions/{suggestion['id']}/approve")

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "stale_patch"
    assert client.get(f"/api/suggestions/{suggestion['id']}").json()["status"] == "pending"
    assert client.get(f"/api/nodes?project_id={project['id']}").json() == []


def test_operations_can_be_approved_individually_with_dependency_validation(client: TestClient) -> None:
    project = create_project(client)
    analysis = client.post(
        "/api/analysis/scenes",
        json={
            "project_id": project["id"],
            "title": "Operation review",
            "scene_text": "\n".join(
                [
                    "Character: Mara Vale - Smuggler captain.",
                    "Location: Glass Harbor - Neutral port.",
                    "Relationship: Mara Vale located_in Glass Harbor - Mara reaches the harbor.",
                ]
            ),
        },
    ).json()
    suggestion_id = analysis["suggestion_id"]

    dependency_response = client.post(f"/api/suggestions/{suggestion_id}/operations/2/approve")
    assert dependency_response.status_code == 409
    assert dependency_response.json()["detail"]["code"] == "dependency_not_approved"

    first = client.post(f"/api/suggestions/{suggestion_id}/operations/0/approve").json()
    second = client.post(f"/api/suggestions/{suggestion_id}/operations/1/approve").json()
    final = client.post(f"/api/suggestions/{suggestion_id}/operations/2/approve").json()

    assert first["metadata"]["operation_decisions"] == {"0": "approved"}
    assert second["status"] == "pending"
    assert final["status"] == "approved"
    assert final["metadata"]["operation_decisions"] == {"0": "approved", "1": "approved", "2": "approved"}
    assert len(client.get(f"/api/nodes?project_id={project['id']}").json()) == 2
    assert len(client.get(f"/api/edges?project_id={project['id']}").json()) == 1


def test_operations_can_be_mixed_approved_and_rejected(client: TestClient) -> None:
    project = create_project(client)
    analysis = client.post(
        "/api/analysis/scenes",
        json={
            "project_id": project["id"],
            "title": "Mixed review",
            "scene_text": "Character: Mara Vale - Smuggler captain.\nLocation: Glass Harbor - Neutral port.",
        },
    ).json()
    suggestion_id = analysis["suggestion_id"]

    client.post(f"/api/suggestions/{suggestion_id}/operations/0/approve")
    response = client.post(f"/api/suggestions/{suggestion_id}/operations/1/reject")

    assert response.status_code == 200
    assert response.json()["status"] == "reviewed"
    assert response.json()["metadata"]["operation_decisions"] == {"0": "approved", "1": "rejected"}
    nodes = client.get(f"/api/nodes?project_id={project['id']}").json()
    assert [(node["type"], node["title"]) for node in nodes] == [("Character", "Mara Vale")]


def test_reanalysis_omits_operations_that_already_received_a_decision(client: TestClient) -> None:
    project = create_project(client)
    request = {
        "project_id": project["id"],
        "title": "Remembered review",
        "scene_text": "Character: Mara Vale - Smuggler captain.",
    }
    first = client.post("/api/analysis/scenes", json=request).json()

    rejected = client.post(f"/api/suggestions/{first['suggestion_id']}/operations/0/reject")
    second = client.post("/api/analysis/scenes", json=request)

    assert rejected.status_code == 200
    assert second.status_code == 201
    assert second.json()["patch"]["operations"] == []
    assert second.json()["warnings"] == ["1 previously reviewed suggestion(s) were omitted."]

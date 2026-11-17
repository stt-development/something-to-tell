from pathlib import Path

from fastapi.testclient import TestClient

from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.project_fixture import import_project_fixture

FIXTURE = Path(__file__).parents[3] / "fixtures" / "projects" / "project-aurora.v1.json"


def test_style_resolution_api_uses_nested_scene_context_without_mutation(tmp_path: Path) -> None:
    """Aurora proves the HTTP adapter uses the same nested Location resolver."""

    project_path = tmp_path / "Aurora.narrative"
    import_project_fixture(FIXTURE, project_path)
    with TestClient(create_app()) as client:
        opened = client.post(
            "/api/project-sessions/open", json={"path": str(project_path)}
        ).json()
        session_id = opened["session"]["session_id"]
        history_before = client.get(
            f"/api/project-sessions/{session_id}/history"
        ).json()

        response = client.post("/api/style-resolution/resolve", json={
            "session_id": session_id,
            "target_node_id": "node-customs-office",
        })

        assert response.status_code == 200
        assert response.json()["source"] == "scene_override"
        assert response.json()["style_profile_id"] == "style-aurora-test-luna"
        assert response.json()["scene_context"]["scene_node_id"] == "node-opening"
        assert client.get(
            f"/api/project-sessions/{session_id}/history"
        ).json() == history_before


def test_style_resolution_api_returns_redacted_context_error(tmp_path: Path) -> None:
    project_path = tmp_path / "Aurora.narrative"
    import_project_fixture(FIXTURE, project_path)
    with TestClient(create_app()) as client:
        opened = client.post(
            "/api/project-sessions/open", json={"path": str(project_path)}
        ).json()

        response = client.post("/api/style-resolution/resolve", json={
            "session_id": opened["session"]["session_id"],
            "target_node_id": "node-dock-dialogue",
            "context": {
                "scene_node_id": "node-opening",
                "placement_id": "fixture-placement-node-hero",
            },
        })

        assert response.status_code == 409
        assert response.json()["detail"] == {
            "code": "style_placement_target_mismatch",
            "message_key": "style.error.style_placement_target_mismatch",
            "parameters": {
                "placement_id": "fixture-placement-node-hero",
                "target_node_id": "node-dock-dialogue",
            },
        }

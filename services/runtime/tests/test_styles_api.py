from datetime import UTC, datetime
from pathlib import Path

from fastapi.testclient import TestClient

from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.project_fixture import import_project_fixture

FIXTURE = Path(__file__).parents[3] / "fixtures" / "projects" / "project-aurora.v1.json"


def test_style_profile_and_scene_assignment_api_records_authoring_history(tmp_path: Path) -> None:
    """CRUD uses the active project database and the shared reversible history boundary."""

    project_path = tmp_path / "Aurora.narrative"
    import_project_fixture(FIXTURE, project_path)
    with TestClient(create_app()) as client:
        opened = client.post("/api/project-sessions/open", json={"path": str(project_path)}).json()
        session_id = opened["session"]["session_id"]
        project_id = opened["session"]["project_id"]
        headers = {"X-Project-Session-Id": session_id}
        now = datetime(2026, 9, 7, 12, 0, tzinfo=UTC).isoformat()
        profile = {
            "style_profile_version": 1,
            "id": "style-api-test",
            "project_id": project_id,
            "name": "API style",
            "description": "A compact API fixture.",
            "guidance": "Use precise sentences.",
            "traits": {"traits_version": 1, "tone": ["precise"]},
            "positive_examples": ["The ledger closes with a click."],
            "created_at": now,
            "updated_at": now,
        }

        created = client.post("/api/styles/profiles", json=profile, headers=headers)
        assert created.status_code == 201
        assignment = client.put(
            "/api/styles/scene-assignments/node-opening",
            headers=headers,
            json={
                "assignment_version": 1,
                "id": "assignment-api-test",
                "project_id": project_id,
                "scene_node_id": "node-opening",
                "style_profile_id": profile["id"],
                "created_at": now,
                "updated_at": now,
            },
        )
        assert assignment.status_code == 200
        impact = client.get(
            f"/api/styles/profiles/{profile['id']}/deletion-impact",
            params={"project_id": project_id},
            headers=headers,
        )
        assert impact.status_code == 200, impact.json()
        assert impact.json()["scene_node_ids"] == ["node-opening"]

        deleted = client.request(
            "DELETE",
            f"/api/styles/profiles/{profile['id']}",
            headers=headers,
            json={
                "project_id": project_id,
                "default_style_profile_id": "style-aurora-default",
                "replacement_profile_id": "style-aurora-opening",
                "impact_reviewed": True,
            },
        )
        assert deleted.status_code == 200
        snapshot = client.get(f"/api/project-sessions/{session_id}").json()
        assert all(item["id"] != profile["id"] for item in snapshot["document"]["style_profiles"])
        assert snapshot["document"]["manifest"]["settings"]["style_system"]["default_style_profile_id"] == "style-aurora-default"
        assert next(
            item for item in snapshot["document"]["scene_style_assignments"]
            if item["scene_node_id"] == "node-opening"
        )["style_profile_id"] == "style-aurora-opening"
        default_deleted = client.request(
            "DELETE",
            "/api/styles/profiles/style-aurora-default",
            headers=headers,
            json={
                "project_id": project_id,
                "default_style_profile_id": "style-aurora-default",
                "replacement_profile_id": "style-aurora-opening",
                "impact_reviewed": True,
            },
        )
        assert default_deleted.status_code == 200
        assert default_deleted.json()["project"]["document"]["manifest"]["settings"]["style_system"]["default_style_profile_id"] == "style-aurora-opening"
        history = client.get(f"/api/project-sessions/{session_id}/history").json()
        assert history["next_undo"]["label_key"] == "history.command.deleteStyleProfile"

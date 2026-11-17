"""HTTP lifecycle coverage for validated Style recommendation approval."""

import json
from pathlib import Path
from time import sleep

from fastapi.testclient import TestClient

from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.core.config import RuntimeSettings
from services.runtime.stt_runtime.project_fixture import import_project_fixture
from services.runtime.stt_runtime.style_system.rewrite_agent import StyleRewriteAgentResponse
from services.runtime.stt_runtime.style_system.rewrite_coordinator import StyleRewriteCoordinator

FIXTURE = Path(__file__).parents[3] / "fixtures/projects/project-aurora.v1.json"


class _ApiAgent:
    """Return one fact-preserving recommendation without remote network access."""

    def run(self, profile, model_id, context):
        return StyleRewriteAgentResponse(
            rewritten_text="Rain veiled the inspection office inside Glass Harbor.",
            explanation="Concrete weather and shorter syntax apply the selected style.",
            applied_traits=("concrete maritime language",),
        )


def test_style_rewrite_api_runs_previews_and_approves_without_automatic_canon(tmp_path: Path) -> None:
    settings = RuntimeSettings(
        storage_profiles_file=tmp_path / "storage.json",
        storage_master_key_file=tmp_path / "key",
        canon_provider_profiles_file=tmp_path / "providers.enc",
    )
    app = create_app(settings)
    profile = app.state.canon_provider_profiles.add(
        label="Style API Provider",
        provider="openai",
        api_key="private-style-api-key",
    )
    project_path = _configured_aurora(tmp_path, profile.profile_id)
    app.state.style_rewrite_runs.clear_all()
    app.state.style_rewrite_runs = StyleRewriteCoordinator(
        app.state.project_sessions,
        app.state.canon_provider_profiles,
        agent=_ApiAgent(),
    )

    with TestClient(app) as client:
        opened = client.post(
            "/api/project-sessions/open", json={"path": str(project_path)}
        ).json()
        session_id = opened["session"]["session_id"]
        started = client.post("/api/style-rewrites/runs", json={
            "session_id": session_id,
            "target": {"kind": "node_text", "node_id": "node-customs-office"},
            "observed_source_checksum": opened["document"]["checksum"],
            "expected_history_revision": 0,
            "content_consent": True,
        })
        assert started.status_code == 201
        run = _poll(client, session_id, started.json()["run"]["id"])
        recommendation = run["recommendation"]
        assert run["status"] == "completed"
        assert recommendation["validation_status"] == "valid"
        assert len(recommendation["patch"]["operations"]) == 1

        approved = client.post(
            f"/api/style-rewrites/runs/{run['id']}/approve",
            params={"session_id": session_id},
            json={
                "recommendation_id": recommendation["id"],
                "source_checksum": run["source_checksum"],
                "expected_history_revision": run["history_revision"],
            },
        )

        assert approved.status_code == 200
        body = approved.json()
        assert body["canon_check_recommended"] is True
        assert body["run"]["status"] == "stale"
        assert body["result"]["history"]["next_undo"]["label_key"] == (
            "history.command.approveStyleRewrite"
        )
        assert body["result"]["project"]["session"]["save_status"] == "dirty"
        assert body["result"]["project"]["session"]["saved_revision"] == (
            opened["session"]["saved_revision"]
        )


def _poll(client: TestClient, session_id: str, run_id: str) -> dict:
    """Observe the public lifecycle instead of reading coordinator internals."""

    for _ in range(200):
        response = client.get(
            f"/api/style-rewrites/runs/{run_id}", params={"session_id": session_id}
        )
        assert response.status_code == 200
        run = response.json()["run"]
        if run["status"] in {"completed", "failed", "cancelled", "stale"}:
            return run
        sleep(0.01)
    raise AssertionError("style rewrite API run did not complete")


def _configured_aurora(tmp_path: Path, profile_id: str) -> Path:
    """Enable only the Style agent while preserving the canonical fixture graph."""

    payload = json.loads(FIXTURE.read_text())
    payload["manifest"]["settings_version"] = 5
    settings = payload["manifest"]["settings"]
    settings["style_system"].update({
        "agent_mode": "configured",
        "content_policy": "explicit_consent",
    })
    settings["agent_providers"] = {
        "agent_providers_version": 1,
        "default_provider_profile_id": profile_id,
        "agents": {
            "canon_checker": {"provider_source": "project_default", "model_id": None},
            "impact_resolver": {"provider_source": "project_default", "model_id": None},
            "style_rewriter": {"provider_source": "project_default", "model_id": "style-model"},
        },
    }
    source = tmp_path / "configured-aurora.json"
    source.write_text(json.dumps(payload))
    project_path = tmp_path / "Aurora.narrative"
    import_project_fixture(source, project_path)
    return project_path

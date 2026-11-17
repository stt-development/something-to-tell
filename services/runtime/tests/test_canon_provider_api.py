from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.canon.agent import CanonAgentError
from services.runtime.stt_runtime.core.config import RuntimeSettings
from services.runtime.stt_runtime.project_fixture import import_project_fixture
from services.runtime.stt_runtime.schemas.canon_agent import (
    CanonProviderModel,
    CanonProviderModelsResponse,
)

FIXTURE = Path(__file__).parents[3] / "fixtures" / "projects" / "project-aurora.v1.json"


class _CatalogAgent:
    """Returns a provider-owned catalog without external network calls."""

    def list_models(self, profile):
        return CanonProviderModelsResponse(
            profile=profile.summary(),
            models=(CanonProviderModel(id="writer-model", label="writer-model"),),
        )


class _UnavailableAgent:
    def list_models(self, _profile):
        raise CanonAgentError("canon_provider_credentials_invalid")


def _client(tmp_path: Path) -> tuple[TestClient, str]:
    project_path = tmp_path / "Aurora.narrative"
    import_project_fixture(FIXTURE, project_path)
    app = create_app(RuntimeSettings(
        canon_provider_profiles_file=tmp_path / "profiles.enc",
        storage_master_key_file=tmp_path / "credentials.key",
    ))
    client = TestClient(app)
    client.__enter__()
    opened = client.post("/api/project-sessions/open", json={"path": str(project_path)}).json()
    return client, opened["session"]["session_id"]


@pytest.mark.parametrize("provider", ["openai", "google_gemini", "anthropic"])
def test_provider_profile_api_verifies_key_and_returns_only_models(
    tmp_path: Path,
    provider: str,
) -> None:
    client, session_id = _client(tmp_path)
    secret = "sk-api-profile-secret"
    try:
        client.app.state.canon_agent = _CatalogAgent()
        created = client.post("/api/canon-provider-profiles", json={
            "session_id": session_id,
            "label": "Primary",
            "provider": provider,
            "api_key": secret,
        })

        assert created.status_code == 201
        assert created.json()["models"][0]["id"] == "writer-model"
        assert created.json()["models"][0]["capabilities"] == [
            "text_generation",
            "structured_output",
        ]
        assert secret not in created.text
        profile_id = created.json()["profile"]["profile_id"]
        listed = client.get(
            f"/api/canon-provider-profiles?session_id={session_id}"
        ).json()
        assert listed["profiles"] == [created.json()["profile"]]
        models = client.get(
            f"/api/canon-provider-profiles/{profile_id}/models?session_id={session_id}"
        )
        assert models.status_code == 200
        assert secret not in models.text
    finally:
        client.__exit__(None, None, None)


def test_invalid_provider_key_is_not_retained_or_echoed(tmp_path: Path) -> None:
    client, session_id = _client(tmp_path)
    secret = "sk-invalid-profile-secret"
    try:
        client.app.state.canon_agent = _UnavailableAgent()
        response = client.post("/api/canon-provider-profiles", json={
            "session_id": session_id,
            "label": "Invalid",
            "provider": "openai",
            "api_key": secret,
        })

        assert response.status_code == 401
        assert response.json()["detail"]["code"] == "canon_provider_credentials_invalid"
        assert secret not in response.text
        assert client.get(
            f"/api/canon-provider-profiles?session_id={session_id}"
        ).json()["profiles"] == []
    finally:
        client.__exit__(None, None, None)


def test_short_provider_key_is_rejected_without_echoing_input(tmp_path: Path) -> None:
    client, session_id = _client(tmp_path)
    secret = "short"
    try:
        response = client.post("/api/canon-provider-profiles", json={
            "session_id": session_id,
            "label": "Invalid",
            "provider": "openai",
            "api_key": secret,
        })

        assert response.status_code == 401
        assert response.json()["detail"]["code"] == "canon_provider_credentials_invalid"
        assert secret not in response.text
    finally:
        client.__exit__(None, None, None)


def test_provider_profile_can_be_created_before_a_project_session(tmp_path: Path) -> None:
    """Machine-local provider setup must be available from the clean start UI."""

    app = create_app(RuntimeSettings(
        canon_provider_profiles_file=tmp_path / "profiles.enc",
        storage_master_key_file=tmp_path / "credentials.key",
    ))
    secret = "sk-pre-project-profile-secret"
    with TestClient(app) as client:
        client.app.state.canon_agent = _CatalogAgent()
        created = client.post("/api/canon-provider-profiles", json={
            "label": "Startup account",
            "provider": "openai",
            "api_key": secret,
        })

        assert created.status_code == 201
        assert created.json()["models"][0]["id"] == "writer-model"
        assert secret not in created.text
        profile_id = created.json()["profile"]["profile_id"]
        assert client.get("/api/canon-provider-profiles").json()["profiles"] == [
            created.json()["profile"]
        ]
        assert client.get(
            f"/api/canon-provider-profiles/{profile_id}/models"
        ).status_code == 200


def test_provider_profile_can_be_edited_rotated_and_deleted(tmp_path: Path) -> None:
    client, session_id = _client(tmp_path)
    try:
        client.app.state.canon_agent = _CatalogAgent()
        created = client.post("/api/canon-provider-profiles", json={
            "session_id": session_id,
            "label": "Original",
            "provider": "openai",
            "api_key": "sk-original-secret",
        }).json()["profile"]

        renamed = client.put(
            f"/api/canon-provider-profiles/{created['profile_id']}",
            json={
                "session_id": session_id,
                "label": "Renamed",
                "provider": "openai",
                "api_key": None,
            },
        )
        assert renamed.status_code == 200
        assert renamed.json()["profile"]["label"] == "Renamed"

        key_required = client.put(
            f"/api/canon-provider-profiles/{created['profile_id']}",
            json={
                "session_id": session_id,
                "label": "Claude",
                "provider": "anthropic",
                "api_key": None,
            },
        )
        assert key_required.status_code == 400
        assert key_required.json()["detail"]["code"] == "canon_provider_credentials_required"

        rotated_secret = "sk-ant-rotated-secret"
        rotated = client.put(
            f"/api/canon-provider-profiles/{created['profile_id']}",
            json={
                "session_id": session_id,
                "label": "Claude",
                "provider": "anthropic",
                "api_key": rotated_secret,
            },
        )
        assert rotated.status_code == 200
        assert rotated.json()["profile"]["provider"] == "anthropic"
        assert rotated_secret not in rotated.text

        deleted = client.delete(
            f"/api/canon-provider-profiles/{created['profile_id']}?session_id={session_id}"
        )
        assert deleted.status_code == 200
        assert deleted.json() == {"deleted_profile_id": created["profile_id"]}
        assert client.get(
            f"/api/canon-provider-profiles?session_id={session_id}"
        ).json()["profiles"] == []
    finally:
        client.__exit__(None, None, None)

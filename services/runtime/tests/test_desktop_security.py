"""Desktop auth/origins gate requests before domain work; browser dev stays explicit."""

from fastapi.testclient import TestClient
import pytest

from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.core.config import RuntimeSettings

TOKEN = "A" * 43  # Fake test bearer, not a persisted/provider credential.
ORIGIN = "tauri://localhost"


@pytest.fixture
def settings(tmp_path):
    return RuntimeSettings(_env_file=None, storage_profiles_file=tmp_path / "storage.json",
                           storage_master_key_file=tmp_path / "key",
                           canon_provider_profiles_file=tmp_path / "providers.enc")


@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer incorrect"},
    {"Authorization": "Bearer " + TOKEN, "Origin": "https://untrusted.example"},
    [("Authorization", "Bearer " + TOKEN), ("Authorization", "Bearer " + TOKEN)],
])
def test_missing_wrong_or_ambiguous_credentials_cannot_create_project(settings, tmp_path, headers):
    destination = tmp_path / "MustNotExist.narrative"
    with TestClient(create_app(settings, desktop_token=TOKEN)) as client:
        response = client.post("/api/project-sessions/create", headers=headers,
                               json={"path": str(destination), "name": "Must not create"})
        assert response.status_code in (401, 403)
        assert TOKEN not in response.text
        assert not destination.exists()


def test_correct_bearer_and_preflight_work_without_wildcard_origins(settings):
    with TestClient(create_app(settings, desktop_token=TOKEN)) as client:
        assert client.get("/api/health").status_code == 401
        headers = {"Authorization": "Bearer " + TOKEN}
        assert client.get("/api/health", headers=headers).status_code == 200
        response = client.get("/api/health", headers={**headers, "Origin": ORIGIN})
        assert response.status_code == 200
        assert response.headers["access-control-allow-origin"] == ORIGIN
        preflight = client.options("/api/health", headers={"Origin": ORIGIN,
            "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "Authorization"})
        assert preflight.status_code == 200
        assert client.get("/api/health?token=" + TOKEN).status_code == 401
        assert client.options("/api/health", headers={"Origin": "https://bad.example",
            "Access-Control-Request-Method": "GET"}).status_code == 403


def test_development_app_does_not_silently_enable_desktop_auth(settings):
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/health").status_code == 200


def test_invalid_desktop_token_fails_closed(settings):
    with pytest.raises(ValueError, match="desktop_token_invalid"):
        with TestClient(create_app(settings, desktop_token="")):
            pass

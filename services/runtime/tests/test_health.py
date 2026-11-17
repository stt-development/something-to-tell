from fastapi.testclient import TestClient

from services.runtime.stt_runtime.app import create_app


def test_health_endpoint_returns_runtime_status() -> None:
    client = TestClient(create_app())

    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "runtime",
        "version": "0.1.0",
    }


def test_runtime_metadata_uses_engine_name_without_changing_service_identity() -> None:
    application = create_app()
    assert application.title == "Something To Tell Engine Runtime"
    assert application.version == "0.1.0"


def test_browser_dev_origin_can_preflight_runtime_commands() -> None:
    client = TestClient(create_app())

    response = client.options(
        "/api/project-sessions/open",
        headers={
            "Origin": "http://127.0.0.1:1420",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:1420"
    assert "POST" in response.headers["access-control-allow-methods"]

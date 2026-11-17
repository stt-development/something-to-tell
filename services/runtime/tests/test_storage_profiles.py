import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.core.config import RuntimeSettings
from services.runtime.stt_runtime.project_fixture import import_project_fixture
from services.runtime.stt_runtime.storage_profiles import (
    PostgreSqlProfile,
    StorageProfileError,
    StorageProfileRegistry,
)


def test_profile_file_exposes_only_safe_summaries(tmp_path: Path) -> None:
    profile_file = tmp_path / "storage-profiles.json"
    profile_file.write_text(
        json.dumps(
            {
                "profiles": [
                    {
                        "profile_id": "studio-primary",
                        "label": "Studio database",
                        "host": "db.internal",
                        "port": 5432,
                        "database": "narrative",
                        "username": "writer",
                        "password": "never-return-this",
                        "tls_policy": "verify-full",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    registry = StorageProfileRegistry.from_file(profile_file)

    assert [profile.model_dump() for profile in registry.summaries()] == [
        {
            "profile_id": "studio-primary",
            "label": "Studio database",
            "host": "db.internal",
            "port": 5432,
            "database": "narrative",
            "username": "writer",
            "tls_policy": "verify-full",
        }
    ]
    assert "never-return-this" not in repr(registry.resolve("studio-primary"))
    assert "never-return-this" not in str(
        registry.resolve("studio-primary").database_url()
    )


def test_project_profile_is_encrypted_and_round_trips_without_password_exposure(
    tmp_path: Path,
) -> None:
    project_path = tmp_path / "Encrypted.narrative"
    project_path.mkdir()
    key_file = tmp_path / "machine" / "storage.key"
    registry = StorageProfileRegistry(master_key_file=key_file)

    created = registry.add(
        project_path,
        label="Project database",
        host="db.internal",
        port=5432,
        database="story",
        username="writer",
        password="project-only-password",
        tls_policy="verify-full",
    )

    encrypted = (project_path / "storage-profiles.enc").read_bytes()
    assert b"project-only-password" not in encrypted
    assert key_file.read_bytes() not in encrypted
    assert key_file.stat().st_mode & 0o777 == 0o600
    reloaded = StorageProfileRegistry(master_key_file=key_file)
    assert reloaded.summaries(project_path) == [created]
    assert (
        reloaded.resolve(created.profile_id, project_path).password
        == "project-only-password"
    )


def test_profile_registry_rejects_duplicates_and_unknown_ids() -> None:
    profile = PostgreSqlProfile(
        profile_id="duplicate",
        label="Duplicate",
        host="localhost",
        database="narrative",
        username="writer",
        password="secret",
        tls_policy="disable",
    )

    with pytest.raises(StorageProfileError, match="storage_profile_duplicate"):
        StorageProfileRegistry([profile, profile])
    with pytest.raises(StorageProfileError) as caught:
        StorageProfileRegistry().resolve("missing")

    assert caught.value.code == "storage_profile_not_found"
    assert caught.value.profile_id == "missing"


def test_missing_profile_file_is_an_empty_registry(tmp_path: Path) -> None:
    registry = StorageProfileRegistry.from_file(tmp_path / "missing.json")

    assert registry.summaries() == []


def test_profile_api_returns_connection_metadata_but_never_passwords(tmp_path: Path) -> None:
    profile_file = tmp_path / "storage-profiles.json"
    secret = "api-redaction-secret"
    profile_file.write_text(
        json.dumps(
            {
                "profiles": [{
                    "profile_id": "safe-summary",
                    "label": "Safe summary",
                    "host": "private.internal",
                    "database": "narrative",
                    "username": "writer",
                    "password": secret,
                    "tls_policy": "require",
                }]
            }
        ),
        encoding="utf-8",
    )
    client = TestClient(
        create_app(RuntimeSettings(storage_profiles_file=profile_file))
    )

    listed = client.get("/api/storage-profiles")
    missing = client.post(
        "/api/storage-profiles/test",
        json={"profile_id": "missing"},
    )

    assert listed.json() == {
        "profiles": [{
            "profile_id": "safe-summary",
            "label": "Safe summary",
            "host": "private.internal",
            "port": 5432,
            "database": "narrative",
            "username": "writer",
            "tls_policy": "require",
        }]
    }
    assert missing.status_code == 404
    assert missing.json()["detail"]["code"] == "storage_profile_not_found"
    assert secret not in listed.text + missing.text


def test_profile_api_creates_an_encrypted_project_scoped_connection(
    tmp_path: Path,
) -> None:
    fixture = Path(__file__).parents[3] / "fixtures/projects/citadel-branch.v1.json"
    project_path = tmp_path / "Citadel.narrative"
    import_project_fixture(fixture, project_path)
    app = create_app(RuntimeSettings(
        storage_profiles_file=tmp_path / "legacy.json",
        storage_master_key_file=tmp_path / "machine" / "storage.key",
    ))
    # The context manager runs FastAPI lifespan cleanup even when an assertion
    # interrupts this lock-owning project-session workflow.
    with TestClient(app) as client:
        opened = client.post(
            "/api/project-sessions/open",
            json={"path": str(project_path)},
        ).json()

        created = client.post("/api/storage-profiles", json={
            "session_id": opened["session"]["session_id"],
            "label": "Project DB",
            "host": "db.internal",
            "port": 5432,
            "database": "story",
            "username": "writer",
            "password": "api-write-only",
            "tls_policy": "verify-full",
        })
        listed = client.get(
            "/api/storage-profiles",
            params={"session_id": opened["session"]["session_id"]},
        )

        assert created.status_code == 201
        assert listed.json()["profiles"] == [created.json()]
        assert "api-write-only" not in created.text + listed.text
        assert b"api-write-only" not in (
            project_path / "storage-profiles.enc"
        ).read_bytes()

    assert not (project_path / "cache" / "project.lock.json").exists()

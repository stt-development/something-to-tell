import json
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.project_format.service import (
    PROJECT_DIRECTORIES,
    PROJECT_FORMAT_VERSION,
    ProjectFormatError,
    create_project_folder,
    validate_project_folder,
)


def test_create_project_folder_writes_portable_structure(tmp_path: Path) -> None:
    project_path = tmp_path / "MyGame.narrative"

    project = create_project_folder(project_path, "My Game")

    assert project.path == project_path.resolve()
    assert project.name == "My Game"
    assert project.format_version == PROJECT_FORMAT_VERSION
    assert (project_path / "project.sqlite").is_file()
    assert (project_path / "project.config.json").is_file()
    for directory in PROJECT_DIRECTORIES:
        assert (project_path / directory).is_dir()

    with sqlite3.connect(project_path / "project.sqlite") as connection:
        assert connection.execute("pragma database_list").fetchone() is not None

    config = json.loads((project_path / "project.config.json").read_text(encoding="utf-8"))
    assert config["format_version"] == PROJECT_FORMAT_VERSION
    assert config["project_id"] == project.project_id
    assert config["name"] == "My Game"
    assert config["description"] == ""
    assert config["saved_revision"] == 0
    assert config["settings"]["ui_locale"] == "en"
    assert config["settings"]["content_locale"] == "en"
    assert config["settings"]["autosave"] == {
        "enabled": True,
        "interval_seconds": 300,
    }
    assert config["settings"]["storage"] == {
        "connection_profile_id": None,
        "mode": "local_sqlite",
    }


def test_validate_project_folder_reports_missing_entries(tmp_path: Path) -> None:
    project_path = tmp_path / "Broken.narrative"
    project_path.mkdir()
    (project_path / "project.config.json").write_text(
        json.dumps({"format_version": PROJECT_FORMAT_VERSION, "name": "Broken"}),
        encoding="utf-8",
    )

    with pytest.raises(ProjectFormatError) as error:
        validate_project_folder(project_path)

    assert "project.sqlite" in error.value.missing
    assert "assets/" in error.value.missing


def test_project_folder_api_creates_and_validates_project(tmp_path: Path) -> None:
    client = TestClient(create_app())
    project_path = tmp_path / "ApiGame.narrative"

    create_response = client.post(
        "/api/projects/folder",
        json={"path": str(project_path), "name": "API Game"},
    )
    validate_response = client.post(
        "/api/projects/folder/validate",
        json={"path": str(project_path)},
    )

    assert create_response.status_code == 201
    assert create_response.json()["name"] == "API Game"
    assert create_response.json()["project_id"]
    assert create_response.json()["description"] == ""
    assert validate_response.status_code == 200
    assert validate_response.json()["format_version"] == PROJECT_FORMAT_VERSION
    assert validate_response.json()["project_id"] == create_response.json()["project_id"]


def test_project_folder_api_returns_actionable_errors(tmp_path: Path) -> None:
    client = TestClient(create_app())
    project_path = tmp_path / "Missing.narrative"
    project_path.mkdir()

    response = client.post("/api/projects/folder/validate", json={"path": str(project_path)})

    assert response.status_code == 400
    assert response.json()["detail"]["missing"] == [
        "project.sqlite",
        "project.config.json",
        "assets/",
        "exports/",
        "snapshots/",
        "styles/",
        "cache/",
    ]


def test_project_folder_api_does_not_echo_rejected_secret_values(tmp_path: Path) -> None:
    project_path = tmp_path / "Secret.narrative"
    create_project_folder(project_path, "Secret")
    config_path = project_path / "project.config.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    config["plugin"] = {"provider_api_key": "do-not-echo-this-value"}
    config_path.write_text(json.dumps(config), encoding="utf-8")

    response = TestClient(create_app()).post(
        "/api/projects/folder/validate",
        json={"path": str(project_path)},
    )

    assert response.status_code == 400
    assert "provider_api_key" in response.text
    assert "do-not-echo-this-value" not in response.text

import json
from datetime import datetime, timedelta
from pathlib import Path

from fastapi.testclient import TestClient

from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.project_catalog import (
    discover_project_catalog,
    list_project_directories,
)
from services.runtime.stt_runtime.project_format.service import create_project_folder


def test_creates_default_hidden_directory_and_lists_valid_projects(tmp_path: Path) -> None:
    workspace = tmp_path / ".narrative"
    older = create_project_folder(workspace / "Older.narrative", "Older")
    newer = create_project_folder(
        workspace / "Newer.narrative",
        "Newer",
        description="Most recently updated project.",
    )
    config = newer.path / "project.config.json"
    payload = json.loads(config.read_text(encoding="utf-8"))
    # Keep ordering deterministic without making updated_at earlier than a
    # project created later on the same calendar day.
    payload["updated_at"] = (
        datetime.fromisoformat(payload["created_at"]) + timedelta(minutes=1)
    ).isoformat()
    config.write_text(json.dumps(payload), encoding="utf-8")
    (workspace / "Broken.narrative").mkdir()
    (workspace / "NotAProject").mkdir()

    catalog = discover_project_catalog(home_directory=tmp_path)

    assert catalog.directory == str(workspace.resolve())
    assert catalog.is_default is True
    assert [project.name for project in catalog.projects] == ["Newer", "Older"]
    assert catalog.projects[0].description == "Most recently updated project."
    assert catalog.projects[1].project_id == older.project_id


def test_catalog_api_scans_an_explicit_directory_without_creating_projects(
    tmp_path: Path,
) -> None:
    project = create_project_folder(tmp_path / "Listed.narrative", "Listed")

    response = TestClient(create_app()).get(
        "/api/project-sessions/catalog",
        params={"path": str(tmp_path)},
    )

    assert response.status_code == 200
    assert response.json() == {
        "directory": str(tmp_path.resolve()),
        "is_default": False,
        "projects": [{
            "project_id": project.project_id,
            "name": "Listed",
            "description": "",
            "path": str(project.path),
            "format_version": 2,
            "updated_at": response.json()["projects"][0]["updated_at"],
        }],
    }


def test_catalog_api_rejects_a_missing_selected_directory(tmp_path: Path) -> None:
    missing = tmp_path / "missing"

    response = TestClient(create_app()).get(
        "/api/project-sessions/catalog",
        params={"path": str(missing)},
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "project_catalog_invalid"
    assert not missing.exists()


def test_lists_only_immediate_directories_for_lazy_tree_navigation(tmp_path: Path) -> None:
    (tmp_path / "Zulu").mkdir()
    (tmp_path / ".narrative").mkdir()
    (tmp_path / ".cache").mkdir()
    (tmp_path / "notes.txt").write_text("not a directory", encoding="utf-8")

    listing = list_project_directories(tmp_path)

    assert listing.directory == str(tmp_path.resolve())
    assert listing.parent == str(tmp_path.resolve().parent)
    assert [(entry.name, entry.path) for entry in listing.directories] == [
        (".narrative", str((tmp_path / ".narrative").resolve())),
        ("Zulu", str((tmp_path / "Zulu").resolve())),
    ]


def test_directory_api_rejects_a_missing_tree_location(tmp_path: Path) -> None:
    response = TestClient(create_app()).get(
        "/api/project-sessions/directories",
        params={"path": str(tmp_path / "missing")},
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "project_directory_invalid"

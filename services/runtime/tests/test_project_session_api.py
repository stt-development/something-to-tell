import json
import os
from datetime import UTC, datetime
from pathlib import Path
import sqlite3
from threading import Event
from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient
import pytest

from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.project_fixture import import_project_fixture
from services.runtime.stt_runtime.project_format.service import (
    PROJECT_DIRECTORIES,
    create_project_folder,
)
from services.runtime.stt_runtime.project_format.manifest import PROJECT_SETTINGS_VERSION
from services.runtime.stt_runtime.project_session.service import (
    LOCK_FILENAME,
    ProjectSessionError,
)
from services.runtime.stt_runtime.schemas.style_system import SceneStyleAssignmentV1
from services.runtime.stt_runtime.style_system.service import StylePersistenceService
from services.runtime.stt_runtime.project_session import service as project_session_service
from services.runtime.stt_runtime.schemas.engine_tags import (
    EngineTagMutationCommandV1,
    EngineTagOwnerV1,
)
from services.runtime.tests.legacy_database import rewrite_sqlite_checkpoint_at_revision


def test_create_inspect_close_and_restart_project_session(tmp_path: Path) -> None:
    project_path = tmp_path / "Lifecycle.narrative"
    first_session_id: str
    checksum: str

    with TestClient(create_app()) as client:
        created = client.post(
            "/api/project-sessions/create",
            json={
                "path": str(project_path),
                "name": "Lifecycle",
                "description": "A durable lifecycle test.",
            },
        )

        assert created.status_code == 201
        payload = created.json()
        first_session_id = payload["session"]["session_id"]
        checksum = payload["document"]["checksum"]
        assert payload["session"]["lifecycle"] == "open"
        assert payload["session"]["save_status"] == "clean"
        assert payload["document"]["manifest"]["description"] == "A durable lifecycle test."
        assert payload["document"]["nodes"] == []
        assert _lock_path(project_path).is_file()

        inspected = client.get(f"/api/project-sessions/{first_session_id}")
        assert inspected.status_code == 200
        assert inspected.json()["document"]["checksum"] == checksum

        duplicate = client.post(
            "/api/project-sessions/open",
            json={"path": str(project_path)},
        )
        assert duplicate.status_code == 409
        assert _error_code(duplicate) == "project_already_open"

        closed = client.post(f"/api/project-sessions/{first_session_id}/close")
        assert closed.status_code == 200
        assert closed.json()["session"]["lifecycle"] == "closed"
        assert closed.json()["document"]["checksum"] == checksum
        assert not _lock_path(project_path).exists()

        missing = client.get(f"/api/project-sessions/{first_session_id}")
        assert missing.status_code == 404
        assert _error_code(missing) == "project_session_not_found"

    with TestClient(create_app()) as restarted_client:
        reopened = restarted_client.post(
            "/api/project-sessions/open",
            json={"path": str(project_path)},
        )
        assert reopened.status_code == 200
        assert reopened.json()["session"]["session_id"] != first_session_id
        assert reopened.json()["document"]["checksum"] == checksum


def test_runtime_shutdown_releases_unclosed_project_lock(tmp_path: Path) -> None:
    project_path = tmp_path / "Shutdown.narrative"

    with TestClient(create_app()) as client:
        response = client.post(
            "/api/project-sessions/create",
            json={"path": str(project_path), "name": "Shutdown"},
        )
        assert response.status_code == 201
        assert _lock_path(project_path).is_file()

    assert not _lock_path(project_path).exists()


def test_save_as_preserves_portable_content_and_reopens_after_restart(
    tmp_path: Path,
) -> None:
    source = tmp_path / "Source.narrative"
    destination = tmp_path / "nested" / ".." / "Portable.narrative"
    (tmp_path / "nested").mkdir()

    with TestClient(create_app()) as client:
        created = client.post(
            "/api/project-sessions/create",
            json={"path": str(source), "name": "Portable source"},
        ).json()
        session_id = created["session"]["session_id"]
        project_id = created["session"]["project_id"]
        headers = {"X-Project-Session-Id": session_id}
        assert client.post(
            "/api/nodes",
            headers=headers,
            json={
                "project_id": project_id,
                "type": "Event",
                "title": "Portable event",
            },
        ).status_code == 201
        (source / "assets" / "portrait.txt").write_text("asset", encoding="utf-8")
        (source / "styles" / "writer.json").write_text("{}", encoding="utf-8")
        (source / "exports" / "outline.txt").write_text("outline", encoding="utf-8")

        copied = client.post(
            f"/api/project-sessions/{session_id}/save-as",
            json={
                "path": str(destination),
                "expected_revision": 0,
                "identity": "preserve",
            },
        )

        assert copied.status_code == 200
        payload = copied.json()
        normalized_destination = destination.resolve()
        assert payload["destination_path"] == str(normalized_destination)
        assert payload["project_id"] == project_id
        assert payload["saved_revision"] == 1
        assert (normalized_destination / "assets" / "portrait.txt").read_text() == "asset"
        assert (normalized_destination / "styles" / "writer.json").is_file()
        assert (normalized_destination / "exports" / "outline.txt").is_file()
        assert not (normalized_destination / "cache" / LOCK_FILENAME).exists()
        manifest_text = (normalized_destination / "project.config.json").read_text(
            encoding="utf-8"
        )
        assert str(source) not in manifest_text
        assert "password" not in manifest_text.lower()
        duplicate = client.post(
            "/api/project-sessions/open",
            json={"path": str(normalized_destination)},
        )
        assert duplicate.status_code == 409
        assert _error_code(duplicate) == "project_identity_already_open"

    with TestClient(create_app()) as restarted_client:
        reopened = restarted_client.post(
            "/api/project-sessions/open",
            json={"path": str(destination.resolve())},
        )

    assert reopened.status_code == 200
    assert reopened.json()["session"]["project_id"] == project_id
    assert [node["title"] for node in reopened.json()["document"]["nodes"]] == [
        "Portable event"
    ]


def test_save_as_regenerates_identity_and_backs_up_confirmed_destination(
    tmp_path: Path,
) -> None:
    source = tmp_path / "IdentitySource.narrative"
    destination = tmp_path / "IdentityCopy.narrative"

    with TestClient(create_app()) as client:
        created = client.post(
            "/api/project-sessions/create",
            json={"path": str(source), "name": "Identity source"},
        ).json()
        session_id = created["session"]["session_id"]
        source_project_id = created["session"]["project_id"]
        headers = {"X-Project-Session-Id": session_id}
        assert client.post(
            "/api/nodes",
            headers=headers,
            json={
                "project_id": source_project_id,
                "type": "Event",
                "title": "Rebound event",
            },
        ).status_code == 201
        create_project_folder(destination, "Existing destination")
        existing_manifest = (destination / "project.config.json").read_bytes()

        blocked = client.post(
            f"/api/project-sessions/{session_id}/save-as",
            json={
                "path": str(destination),
                "expected_revision": 0,
                "identity": "regenerate",
            },
        )
        assert blocked.status_code == 409
        assert _error_code(blocked) == "project_save_as_destination_exists"
        assert (destination / "project.config.json").read_bytes() == existing_manifest

        copied = client.post(
            f"/api/project-sessions/{session_id}/save-as",
            json={
                "path": str(destination),
                "expected_revision": 1,
                "identity": "regenerate",
                "replace_existing": True,
            },
        )

        assert copied.status_code == 200
        payload = copied.json()
        assert payload["project_id"] != source_project_id
        backup = Path(payload["backup_path"])
        assert backup.is_dir()
        assert (backup / "project.config.json").read_bytes() == existing_manifest
        assert not (destination / "storage-profiles.enc").exists()
        assert client.post(f"/api/project-sessions/{session_id}/close").status_code == 200

        reopened = client.post(
            "/api/project-sessions/open",
            json={"path": str(destination)},
        )

    assert reopened.status_code == 200
    document = reopened.json()["document"]
    assert document["manifest"]["project_id"] == payload["project_id"]
    assert {node["project_id"] for node in document["nodes"]} == {
        payload["project_id"]
    }


def test_save_as_regenerates_complete_fixture_document(tmp_path: Path) -> None:
    source = tmp_path / "Aurora.narrative"
    destination = tmp_path / "AuroraCopy.narrative"
    fixture_path = Path(__file__).parents[3] / "fixtures/projects/project-aurora.v1.json"
    import_project_fixture(fixture_path, source)

    with TestClient(create_app()) as client:
        opened = client.post(
            "/api/project-sessions/open",
            json={"path": str(source)},
        ).json()
        response = client.post(
            f"/api/project-sessions/{opened['session']['session_id']}/save-as",
            json={
                "path": str(destination),
                "expected_revision": opened["session"]["saved_revision"],
                "identity": "regenerate",
            },
        )

    assert response.status_code == 200
    assert response.json()["project_id"] != opened["session"]["project_id"]
    assert destination.is_dir()
    with TestClient(create_app()) as restarted_client:
        reopened = restarted_client.post(
            "/api/project-sessions/open",
            json={"path": str(destination)},
        )
    document = reopened.json()["document"]
    assert len(document["story_flows"]) == 3
    assert len(document["flow_transitions"]) == 8
    assert len(document["flow_invocations"]) == 2
    assert len(document["flow_exits"]) == 4
    assert len(document["flow_exit_bindings"]) == 4
    assert len(document["engine_tag_definitions"]) == 9
    assert len(document["engine_tag_bindings"]) == 9
    assert {item["project_id"] for item in document["engine_tag_definitions"]} == {
        document["manifest"]["project_id"]
    }
    assert {item["owner"]["project_id"] for item in document["engine_tag_bindings"]} == {
        document["manifest"]["project_id"]
    }


def test_save_as_install_failure_restores_existing_destination(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "RollbackSource.narrative"
    destination = tmp_path / "RollbackTarget.narrative"

    with TestClient(create_app()) as client:
        created = client.post(
            "/api/project-sessions/create",
            json={"path": str(source), "name": "Rollback source"},
        ).json()
        session_id = created["session"]["session_id"]
        create_project_folder(destination, "Rollback target")
        original_manifest = (destination / "project.config.json").read_bytes()
        original_replace = Path.replace

        def fail_staging_install(path: Path, target: Path) -> Path:
            if ".save-as-" in path.name and Path(target) == destination:
                raise OSError("injected installation failure")
            return original_replace(path, target)

        monkeypatch.setattr(Path, "replace", fail_staging_install)
        response = client.post(
            f"/api/project-sessions/{session_id}/save-as",
            json={
                "path": str(destination),
                "expected_revision": 0,
                "identity": "preserve",
                "replace_existing": True,
            },
        )

    assert response.status_code == 400
    assert _error_code(response) == "project_save_as_failed"
    assert (destination / "project.config.json").read_bytes() == original_manifest
    assert not list(tmp_path.glob(".*.save-as-*.tmp.narrative"))


def test_save_as_rejects_missing_manifest_asset_before_writing_destination(
    tmp_path: Path,
) -> None:
    source = tmp_path / "MissingAsset.narrative"
    destination = tmp_path / "MissingAssetCopy.narrative"
    create_project_folder(source, "Missing asset")
    config_path = source / "project.config.json"
    manifest = json.loads(config_path.read_text(encoding="utf-8"))
    manifest["asset_paths"] = ["assets/missing.png"]
    config_path.write_text(json.dumps(manifest), encoding="utf-8")

    with TestClient(create_app()) as client:
        opened = client.post(
            "/api/project-sessions/open",
            json={"path": str(source)},
        ).json()
        response = client.post(
            f"/api/project-sessions/{opened['session']['session_id']}/save-as",
            json={
                "path": str(destination),
                "expected_revision": 0,
                "identity": "preserve",
            },
        )

    assert response.status_code == 400
    assert _error_code(response) == "project_save_as_asset_missing"
    assert not destination.exists()


def test_create_and_edit_project_settings_survive_discard_and_restart(
    tmp_path: Path,
) -> None:
    project_path = tmp_path / "Localized.narrative"
    settings = {
        "ui_locale": "ru",
        "content_locale": "ru",
        "autosave": {"enabled": True, "interval_seconds": 600},
        "storage": {"mode": "local_sqlite", "connection_profile_id": None},
        "canon_check": {
            "deterministic_enabled": True,
            "enabled_rules": {"flow.unresolved-condition": False},
            "severity_overrides": {"quest.required-outcome": "critical"},
            "agent_mode": "configured",
            "content_policy": "evidence_only",
            "model_preference": "canon-model-v1",
            "provider_profile_id": "studio-canon",
        },
    }

    with TestClient(create_app()) as client:
        created = client.post(
            "/api/project-sessions/create",
            json={
                "path": str(project_path),
                "name": "Локализованный проект",
                "description": "Исходное описание",
                "settings": settings,
            },
        )
        assert created.status_code == 201
        initial_manifest = created.json()["document"]["manifest"]
        session_id = created.json()["session"]["session_id"]
        project_id = initial_manifest["project_id"]
        created_at = initial_manifest["created_at"]
        headers = {"X-Project-Session-Id": session_id}

        assert client.post(
            "/api/nodes",
            headers=headers,
            json={
                "project_id": project_id,
                "type": "Event",
                "title": "Unsaved event",
            },
        ).status_code == 201
        revised_settings = {
            **settings,
            "ui_locale": "en",
            "autosave": {"enabled": False, "interval_seconds": 900},
        }
        updated = client.put(
            f"/api/project-sessions/{session_id}/settings",
            json={
                "name": "Renamed project",
                "description": "Updated metadata",
                "settings": revised_settings,
            },
        )

        assert updated.status_code == 200
        manifest = updated.json()["document"]["manifest"]
        assert manifest["project_id"] == project_id
        assert manifest["created_at"] == created_at
        assert manifest["name"] == "Renamed project"
        assert manifest["settings"]["ui_locale"] == "en"
        assert updated.json()["session"]["project_path"] == str(project_path)
        assert updated.json()["session"]["save_status"] == "dirty"
        recorded = client.get(
            f"/api/project-sessions/{session_id}/history"
        ).json()
        assert recorded["history_revision"] == 2
        assert recorded["next_undo"]["command_kind"] == "update_project_settings"

        undone = client.post(
            f"/api/project-sessions/{session_id}/history/undo",
            json={"expected_history_revision": 2},
        ).json()
        assert undone["project"]["document"]["manifest"]["name"] == "Локализованный проект"
        assert undone["project"]["session"]["save_status"] == "dirty"
        redone = client.post(
            f"/api/project-sessions/{session_id}/history/redo",
            json={"expected_history_revision": 3},
        ).json()
        assert redone["project"]["document"]["manifest"]["name"] == "Renamed project"
        assert redone["project"]["session"]["save_status"] == "dirty"

        discarded = client.post(f"/api/project-sessions/{session_id}/discard")
        assert discarded.status_code == 200
        assert discarded.json()["document"]["nodes"] == []
        assert discarded.json()["document"]["manifest"]["name"] == "Renamed project"
        assert client.post(f"/api/project-sessions/{session_id}/close").status_code == 200

    with TestClient(create_app()) as restarted_client:
        reopened = restarted_client.post(
            "/api/project-sessions/open",
            json={"path": str(project_path)},
        )

    assert reopened.status_code == 200
    assert reopened.json()["document"]["manifest"]["settings"]["ui_locale"] == "en"
    assert reopened.json()["document"]["manifest"]["settings"]["content_locale"] == "ru"
    assert reopened.json()["document"]["manifest"]["settings"]["autosave"] == {
        "enabled": False,
        "interval_seconds": 900,
    }
    assert reopened.json()["document"]["manifest"]["settings"]["canon_check"] == {
        "canon_check_version": 1,
        "deterministic_enabled": True,
        "enabled_rules": {"flow.unresolved-condition": False},
        "severity_overrides": {"quest.required-outcome": "critical"},
        "agent_mode": "configured",
        "content_policy": "evidence_only",
        "model_preference": "canon-model-v1",
        "provider_profile_id": "studio-canon",
    }


def test_open_atomically_persists_settings_v1_migration(tmp_path: Path) -> None:
    project_path = tmp_path / "LegacySettings.narrative"
    with TestClient(create_app()) as client:
        created = client.post(
            "/api/project-sessions/create",
            json={"path": str(project_path), "name": "Legacy settings"},
        ).json()
        assert client.post(
            f"/api/project-sessions/{created['session']['session_id']}/close"
        ).status_code == 200

    config_path = project_path / "project.config.json"
    manifest = json.loads(config_path.read_text(encoding="utf-8"))
    manifest["settings_version"] = 1
    manifest["settings"].pop("canon_check")
    config_path.write_text(json.dumps(manifest), encoding="utf-8")

    with TestClient(create_app()) as client:
        reopened = client.post(
            "/api/project-sessions/open",
            json={"path": str(project_path)},
        )
        assert reopened.status_code == 200
        assert client.post(
            f"/api/project-sessions/{reopened.json()['session']['session_id']}/close"
        ).status_code == 200

    persisted = json.loads(config_path.read_text(encoding="utf-8"))
    assert persisted["settings_version"] == PROJECT_SETTINGS_VERSION
    assert persisted["settings"]["canon_check"]["agent_mode"] == "disabled"
    assert persisted["settings"]["agent_providers"]["agents"]["impact_resolver"] == {
        "provider_source": "project_default",
        "provider_profile_override_id": None,
        "model_id": None,
    }
    assert persisted["settings"]["impact_resolver"]["agent_mode"] == "disabled"


def test_settings_api_rejects_secret_fields_without_echoing_values(
    tmp_path: Path,
) -> None:
    secret = "must-never-enter-project-or-response"
    project_path = tmp_path / "SecretRejected.narrative"
    with TestClient(create_app()) as client:
        created = client.post(
            "/api/project-sessions/create",
            json={
                "path": str(project_path),
                "name": "Secret rejected",
                "settings": {
                    "canon_check": {
                        "provider_profile_id": "safe-reference",
                        "provider_api_key": secret,
                    }
                },
            },
        )

    assert created.status_code == 422
    assert secret not in created.text
    assert not project_path.exists()


def test_settings_reject_storage_switch_and_failed_publish_keeps_active_values(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_path = tmp_path / "SettingsFailure.narrative"

    with TestClient(create_app()) as client:
        created = client.post(
            "/api/project-sessions/create",
            json={"path": str(project_path), "name": "Stable settings"},
        ).json()
        session_id = created["session"]["session_id"]
        current_settings = created["document"]["manifest"]["settings"]

        migration = client.put(
            f"/api/project-sessions/{session_id}/settings",
            json={
                "name": "Stable settings",
                "description": "",
                "settings": {
                    **current_settings,
                    "storage": {
                        "mode": "postgresql",
                        "connection_profile_id": "studio-primary",
                    },
                },
            },
        )
        assert migration.status_code == 409
        assert _error_code(migration) == "project_storage_migration_required"

        invalid = client.put(
            f"/api/project-sessions/{session_id}/settings",
            json={
                "name": "   ",
                "description": "",
                "settings": current_settings,
            },
        )
        assert invalid.status_code == 422

        def fail_manifest_write(*_args, **_kwargs) -> None:
            raise OSError("injected settings write failure")

        monkeypatch.setattr(
            project_session_service,
            "write_project_manifest",
            fail_manifest_write,
        )
        failed = client.put(
            f"/api/project-sessions/{session_id}/settings",
            json={
                "name": "Must not become active",
                "description": "",
                "settings": current_settings,
            },
        )
        inspected = client.get(f"/api/project-sessions/{session_id}")

    assert failed.status_code == 400
    assert _error_code(failed) == "project_settings_save_failed"
    assert inspected.json()["document"]["manifest"]["name"] == "Stable settings"


def test_session_header_persists_authoring_mutations_across_restart(tmp_path: Path) -> None:
    project_path = tmp_path / "SessionAuthoring.narrative"

    with TestClient(create_app()) as client:
        created = client.post(
            "/api/project-sessions/create",
            json={"path": str(project_path), "name": "Session Authoring"},
        ).json()
        session_id = created["session"]["session_id"]
        project_id = created["session"]["project_id"]
        headers = {"X-Project-Session-Id": session_id}

        node = client.post(
            "/api/nodes",
            headers=headers,
            json={
                "project_id": project_id,
                "type": "Scene",
                "title": "Persisted opening",
                "summary": "Written through the active project session.",
            },
        )

        assert node.status_code == 201
        inspected = client.get(f"/api/project-sessions/{session_id}")
        assert inspected.json()["session"]["save_status"] == "dirty"
        assert [item["title"] for item in inspected.json()["document"]["nodes"]] == [
            "Persisted opening"
        ]
        saved = client.post(
            f"/api/project-sessions/{session_id}/save",
            json={
                "expected_revision": inspected.json()["session"]["saved_revision"],
                "reason": "manual",
            },
        )
        assert saved.status_code == 200
        assert saved.json()["session"]["saved_revision"] == 1
        assert client.post(f"/api/project-sessions/{session_id}/close").status_code == 200

    with TestClient(create_app()) as restarted_client:
        reopened = restarted_client.post(
            "/api/project-sessions/open",
            json={"path": str(project_path)},
        )

    assert reopened.status_code == 200
    assert reopened.json()["document"]["nodes"][0]["summary"] == (
        "Written through the active project session."
    )


def test_session_persists_every_authoring_aggregate_across_restart(tmp_path: Path) -> None:
    """Exercise each durable authoring owner through one active project session."""

    fixture_path = Path(__file__).parents[3] / "fixtures/projects/project-aurora.v1.json"
    project_path = tmp_path / "CompleteAuthoring.narrative"
    import_project_fixture(fixture_path, project_path)

    with TestClient(create_app()) as client:
        opened = client.post("/api/project-sessions/open", json={"path": str(project_path)})
        assert opened.status_code == 200
        initial = opened.json()["document"]
        session_id = opened.json()["session"]["session_id"]
        headers = {"X-Project-Session-Id": session_id}

        node = _record(initial["nodes"], "node-embargo")
        node_payload = _resource_payload(node)
        node_payload["summary"] = "Durably revised embargo."
        assert client.put(
            "/api/nodes/node-embargo", headers=headers, json=node_payload
        ).status_code == 200

        placement = _record(initial["placements"], "fixture-placement-node-embargo")
        assert client.put(
            "/api/compositions/placements/fixture-placement-node-embargo",
            headers=headers,
            json={
                "project_id": "project-aurora",
                "container_node_id": placement["container_node_id"],
                "position": {"x": 48, "y": placement["y"]},
                "size": {"width": placement["width"], "height": placement["height"]},
                "is_primary": placement["is_primary"],
                "presentation_state": placement["presentation_state"],
                "metadata": placement["metadata"],
            },
        ).status_code == 200

        dialogue = _record(initial["dialogues"], "node-dock-dialogue")["document"]
        dialogue["elements"][0]["text"] = "Persisted dialogue revision."
        assert client.put(
            "/api/dialogues/node-dock-dialogue", headers=headers, json=dialogue
        ).status_code == 200

        quest = _record(initial["quests"], "node-smuggler-route")["document"]
        quest["objective"] = "Persist every branch of the route."
        assert client.put(
            "/api/quests/node-smuggler-route", headers=headers, json=quest
        ).status_code == 200

        flow = _record(initial["story_flows"], "flow-main-story")
        assert client.put(
            "/api/story-flows/flow-main-story",
            headers=headers,
            json={
                "project_id": flow["project_id"],
                "name": flow["name"],
                "description": "Persisted primary story order.",
                "kind": flow["kind"],
                "status": flow["status"],
                "metadata": flow["metadata"],
            },
        ).status_code == 200

        issue = _record(initial["issues"], "issue-embargo-detail")
        issue_payload = _resource_payload(issue)
        issue_payload["status"] = "resolved"
        assert client.put(
            "/api/issues/issue-embargo-detail", headers=headers, json=issue_payload
        ).status_code == 200

        assert client.delete(
            "/api/factions/node-trade-guild/members/node-hero", headers=headers
        ).status_code == 204
        membership = client.post(
            "/api/factions/node-trade-guild/members",
            headers=headers,
            json={"character_node_id": "node-hero"},
        )
        assert membership.status_code == 201

        suggestion = client.post(
            "/api/suggestions",
            headers=headers,
            json={
                "project_id": "project-aurora",
                "title": "Persist analysis decision",
                "description": "The rejected decision must survive restart.",
                "patch": {"operations": []},
                "created_by": "test-analysis-agent",
            },
        )
        assert suggestion.status_code == 201
        suggestion_id = suggestion.json()["id"]
        assert client.post(
            f"/api/suggestions/{suggestion_id}/reject", headers=headers
        ).status_code == 200

        inspected = client.get(f"/api/project-sessions/{session_id}")
        assert inspected.json()["session"]["save_status"] == "dirty"
        saved = client.post(
            f"/api/project-sessions/{session_id}/save",
            json={
                "expected_revision": inspected.json()["session"]["saved_revision"],
                "reason": "manual",
            },
        )
        assert saved.status_code == 200
        assert client.post(f"/api/project-sessions/{session_id}/close").status_code == 200

    with TestClient(create_app()) as restarted_client:
        reopened = restarted_client.post(
            "/api/project-sessions/open", json={"path": str(project_path)}
        )
        assert reopened.status_code == 200
        document = reopened.json()["document"]

    assert _record(document["nodes"], "node-embargo")["summary"] == "Durably revised embargo."
    assert _record(document["placements"], "fixture-placement-node-embargo")["x"] == 48
    assert _record(document["dialogues"], "node-dock-dialogue")["document"]["elements"][0][
        "text"
    ] == "Persisted dialogue revision."
    assert _record(document["quests"], "node-smuggler-route")["document"][
        "objective"
    ] == "Persist every branch of the route."
    assert _record(document["story_flows"], "flow-main-story")[
        "description"
    ] == "Persisted primary story order."
    assert _record(document["issues"], "issue-embargo-detail")["status"] == "resolved"
    assert any(
        edge["type"] == "member_of"
        and edge["source_node_id"] == "node-hero"
        and edge["target_node_id"] == "node-trade-guild"
        for edge in document["edges"]
    )
    assert _record(document["suggestions"], suggestion_id)["status"] == "rejected"
    assert document["engine_tags"] == []
    assert len(document["flow_initial_states"]) == 2
    assert len(document["narrative_effects"]) == 4
    assert len(document["narrative_effect_bindings"]) == 4


def test_save_revision_and_discard_restore_last_checkpoint(tmp_path: Path) -> None:
    project_path = tmp_path / "SaveLifecycle.narrative"
    with TestClient(create_app()) as client:
        created = client.post(
            "/api/project-sessions/create",
            json={"path": str(project_path), "name": "Save Lifecycle"},
        ).json()
        session_id = created["session"]["session_id"]
        project_id = created["session"]["project_id"]
        headers = {"X-Project-Session-Id": session_id}

        assert client.post(
            "/api/nodes",
            headers=headers,
            json={"project_id": project_id, "type": "Event", "title": "Draft event"},
        ).status_code == 201
        blocked_close = client.post(f"/api/project-sessions/{session_id}/close")
        assert blocked_close.status_code == 409
        assert _error_code(blocked_close) == "project_unsaved_changes"

        stale = client.post(
            f"/api/project-sessions/{session_id}/save",
            json={"expected_revision": 4, "reason": "manual"},
        )
        assert stale.status_code == 409
        assert _error_code(stale) == "project_save_revision_stale"
        assert client.get(f"/api/project-sessions/{session_id}").json()["session"][
            "save_status"
        ] == "dirty"

        discarded = client.post(f"/api/project-sessions/{session_id}/discard")
        assert discarded.status_code == 200
        assert discarded.json()["session"]["save_status"] == "clean"
        assert discarded.json()["document"]["nodes"] == []
        assert client.post(f"/api/project-sessions/{session_id}/close").status_code == 200


def test_discard_upgrades_a_checkpoint_from_an_older_database_revision(
    tmp_path: Path,
) -> None:
    """A restored snapshot must not downgrade the live repository schema."""

    project_path = tmp_path / "OldCheckpoint.narrative"
    with TestClient(create_app()) as client:
        created = client.post(
            "/api/project-sessions/create",
            json={"path": str(project_path), "name": "Old Checkpoint"},
        ).json()
        session_id = created["session"]["session_id"]
        project_id = created["session"]["project_id"]
        headers = {"X-Project-Session-Id": session_id}
        assert client.post(
            "/api/nodes",
            headers=headers,
            json={"project_id": project_id, "type": "Event", "title": "Saved event"},
        ).status_code == 201
        saved = client.post(
            f"/api/project-sessions/{session_id}/save",
            json={"expected_revision": 0, "reason": "manual"},
        ).json()
        checkpoint_database = (
            project_path / "snapshots" / "revision-00000001" / "project.sqlite"
        )
        rewrite_sqlite_checkpoint_at_revision(checkpoint_database, "20260803_0004")

        assert client.post(
            "/api/nodes",
            headers=headers,
            json={"project_id": project_id, "type": "Event", "title": "Unsaved event"},
        ).status_code == 201
        discarded = client.post(f"/api/project-sessions/{session_id}/discard")

        assert discarded.status_code == 200, discarded.text
        assert discarded.json()["session"]["saved_revision"] == saved["session"][
            "saved_revision"
        ]
        assert [node["title"] for node in discarded.json()["document"]["nodes"]] == [
            "Saved event"
        ]
        with sqlite3.connect(project_path / "project.sqlite") as connection:
            assert connection.execute("select version_num from alembic_version").fetchone() == (
                "20261022_0012",
            )
            tables = {
                row[0]
                for row in connection.execute(
                    "select name from sqlite_master where type = 'table'"
                )
            }
        assert {
            "flow_initial_states",
            "narrative_effects",
            "narrative_effect_bindings",
            "impact_resolution_decisions",
            "style_profiles",
            "scene_style_assignments",
            "agent_memories",
        }.issubset(tables)


def test_confirmed_page_exit_saves_dirty_state_and_releases_lock(tmp_path: Path) -> None:
    project_path = tmp_path / "PageExit.narrative"
    app = create_app()
    with TestClient(app) as client:
        created = client.post(
            "/api/project-sessions/create",
            json={"path": str(project_path), "name": "Page Exit"},
        ).json()
        session_id = created["session"]["session_id"]
        headers = {"X-Project-Session-Id": session_id}
        assert client.post(
            "/api/nodes",
            headers=headers,
            json={
                "project_id": created["session"]["project_id"],
                "type": "Event",
                "title": "Saved on exit",
            },
        ).status_code == 201

        exited = client.post(
            f"/api/project-sessions/{session_id}/exit",
            json={"expected_revision": 0},
        )
        assert exited.status_code == 200
        assert exited.json()["lifecycle"] == "closed"
        assert exited.json()["saved_revision"] == 1
        assert not (project_path / "cache" / "project.lock.json").exists()

        reopened = client.post(
            "/api/project-sessions/open",
            json={"path": str(project_path)},
        )
        assert reopened.status_code == 200
        assert [node["title"] for node in reopened.json()["document"]["nodes"]] == [
            "Saved on exit"
        ]
        reopened_session_id = reopened.json()["session"]["session_id"]
        assert client.post(
            f"/api/project-sessions/{reopened_session_id}/exit",
            json={"expected_revision": 1},
        ).status_code == 200


def test_confirmed_page_exit_rejects_stale_revision_without_releasing_lock(
    tmp_path: Path,
) -> None:
    project_path = tmp_path / "StalePageExit.narrative"
    with TestClient(create_app()) as client:
        created = client.post(
            "/api/project-sessions/create",
            json={"path": str(project_path), "name": "Stale Page Exit"},
        ).json()
        session_id = created["session"]["session_id"]

        stale = client.post(
            f"/api/project-sessions/{session_id}/exit",
            json={"expected_revision": 4},
        )
        assert stale.status_code == 409
        assert _error_code(stale) == "project_save_revision_stale"
        assert (project_path / "cache" / "project.lock.json").exists()
        assert client.post(f"/api/project-sessions/{session_id}/close").status_code == 200


def test_dirty_shutdown_requires_explicit_recovery_choice(tmp_path: Path) -> None:
    project_path = tmp_path / "Recovery.narrative"
    app = create_app()
    with TestClient(app) as client:
        created = client.post(
            "/api/project-sessions/create",
            json={"path": str(project_path), "name": "Recovery"},
        ).json()
        session_id = created["session"]["session_id"]
        headers = {"X-Project-Session-Id": session_id}
        assert client.post(
            "/api/nodes",
            headers=headers,
            json={
                "project_id": created["session"]["project_id"],
                "type": "Event",
                "title": "Recovered draft",
            },
        ).status_code == 201
        scene = client.post(
            "/api/nodes",
            headers=headers,
            json={
                "project_id": created["session"]["project_id"],
                "type": "Scene",
                "title": "Recovered scene",
            },
        ).json()
        style_service = StylePersistenceService()
        profile = style_service.new_profile(
            profile_id="style-recovery",
            project_id=created["session"]["project_id"],
            name="Recovery style",
            guidance="Preserve this unsaved profile.",
            now=datetime(2026, 9, 4, 12, 0, tzinfo=UTC),
        )
        # Simulate a style authoring command that was checkpointed but never saved.
        with app.state.project_sessions.authoring_unit_of_work(
            session_id,
            command_kind="create_style_profile",
            label_key="history.command.createStyleProfile",
        ) as uow:
            style_service.create_profile(uow, profile)
            style_service.upsert_scene_assignment(
                uow,
                SceneStyleAssignmentV1(
                    id="assignment-recovery",
                    project_id=created["session"]["project_id"],
                    scene_node_id=scene["id"],
                    style_profile_id=profile.id,
                    created_at=datetime(2026, 9, 4, 12, 0, tzinfo=UTC),
                    updated_at=datetime(2026, 9, 4, 12, 0, tzinfo=UTC),
                ),
            )
        current = app.state.project_sessions.inspect(session_id)
        history = app.state.project_sessions.inspect_history(session_id)
        tagged = app.state.project_sessions.apply_engine_tag_command(
            session_id,
            EngineTagMutationCommandV1(
                command_id="recovery-engine-tag",
                action="create_and_bind",
                expected_source_checksum=current.document.checksum,
                expected_history_revision=history.history_revision,
                key="Scene.Recovered",
                owner=EngineTagOwnerV1(
                    kind="node",
                    project_id=created["session"]["project_id"],
                    node_id=scene["id"],
                ),
            ),
        )
        recovered_definition_id = next(
            item.id for item in tagged.catalog.definitions if item.key == "Scene.Recovered"
        )
        dirty_document = app.state.project_sessions.inspect(session_id).document
        assert [item.id for item in dirty_document.style_profiles] == [profile.id]
        assert [item.id for item in dirty_document.scene_style_assignments] == [
            "assignment-recovery"
        ]
        assert len(dirty_document.engine_tag_definitions) == 3
        assert recovered_definition_id in {
            item.id for item in dirty_document.engine_tag_definitions
        }

    with TestClient(create_app()) as restarted:
        blocked = restarted.post(
            "/api/project-sessions/open",
            json={"path": str(project_path)},
        )
        assert blocked.status_code == 409
        assert _error_code(blocked) == "project_recovery_required"

        recovered = restarted.post(
            "/api/project-sessions/open",
            json={"path": str(project_path), "recovery_mode": "recover"},
        )
        assert recovered.status_code == 200
        assert recovered.json()["session"]["save_status"] == "dirty"
        assert "Recovered draft" in {
            node["title"] for node in recovered.json()["document"]["nodes"]
        }
        assert recovered.json()["document"]["style_profiles"][0]["id"] == "style-recovery"
        assert (
            recovered.json()["document"]["scene_style_assignments"][0]["id"]
            == "assignment-recovery"
        )
        recovered_document = recovered.json()["document"]
        assert recovered_definition_id in {
            item["id"] for item in recovered_document["engine_tag_definitions"]
        }
        recovered_binding = next(
            item
            for item in recovered_document["engine_tag_bindings"]
            if item["definition_id"] == recovered_definition_id
        )
        assert recovered_binding["owner"]["node_id"] == scene["id"]
        recovered_session_id = recovered.json()["session"]["session_id"]
        assert restarted.post(
            f"/api/project-sessions/{recovered_session_id}/discard"
        ).status_code == 200
        assert restarted.post(
            f"/api/project-sessions/{recovered_session_id}/close"
        ).status_code == 200


def test_save_failure_retains_revision_and_reports_error(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_path = tmp_path / "SaveFailure.narrative"
    app = create_app()
    with TestClient(app) as client:
        created = client.post(
            "/api/project-sessions/create",
            json={"path": str(project_path), "name": "Save Failure"},
        ).json()
        session_id = created["session"]["session_id"]
        app.state.project_sessions.mark_dirty(session_id)

        def fail_manifest_write(*_: object) -> None:
            raise OSError("injected manifest failure")

        monkeypatch.setattr(
            "services.runtime.stt_runtime.project_session.service.write_project_manifest",
            fail_manifest_write,
        )
        failed = client.post(
            f"/api/project-sessions/{session_id}/save",
            json={"expected_revision": 0, "reason": "manual"},
        )

        assert failed.status_code == 400
        assert _error_code(failed) == "project_save_failed"
        inspected = client.get(f"/api/project-sessions/{session_id}").json()["session"]
        assert inspected["saved_revision"] == 0
        assert inspected["save_status"] == "error"
        assert inspected["save_error"] == "project_save_failed"


def test_only_one_save_can_run_and_checkpoints_are_bounded(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_path = tmp_path / "ConcurrentSave.narrative"
    registry = create_app().state.project_sessions
    created = registry.create(project_path, "Concurrent Save")
    session_id = created.session.session_id
    entered = Event()
    release = Event()
    original_stage = registry._stage_checkpoint

    def blocking_stage(active, manifest):
        entered.set()
        assert release.wait(timeout=5)
        return original_stage(active, manifest)

    monkeypatch.setattr(registry, "_stage_checkpoint", blocking_stage)
    registry.mark_dirty(session_id)
    with ThreadPoolExecutor(max_workers=1) as executor:
        first = executor.submit(
            registry.save,
            session_id,
            expected_revision=0,
            reason="manual",
        )
        assert entered.wait(timeout=5)
        with pytest.raises(ProjectSessionError) as concurrent:
            registry.save(
                session_id,
                expected_revision=0,
                reason="autosave",
            )
        assert concurrent.value.code == "project_save_in_progress"
        release.set()
        assert first.result().session.saved_revision == 1

    monkeypatch.setattr(registry, "_stage_checkpoint", original_stage)
    for expected_revision in range(1, 5):
        registry.mark_dirty(session_id)
        registry.save(
            session_id,
            expected_revision=expected_revision,
            reason="manual",
        )
    checkpoints = list((project_path / "snapshots").glob("revision-*"))
    assert len(checkpoints) == 3
    registry.close(session_id)


def test_session_uow_can_exit_on_a_different_fastapi_worker_thread(
    tmp_path: Path,
) -> None:
    """Regress FastAPI's cross-thread sync-generator dependency cleanup."""

    project_path = tmp_path / "CrossThreadUow.narrative"
    registry = create_app().state.project_sessions
    created = registry.create(project_path, "Cross Thread UoW")
    session_id = created.session.session_id
    manager = registry.unit_of_work(session_id, mark_dirty=True)
    entered = Event()
    release_enter_worker = Event()

    def enter_and_hold_worker() -> None:
        manager.__enter__()
        entered.set()
        assert release_enter_worker.wait(timeout=5)

    with ThreadPoolExecutor(max_workers=2) as executor:
        enter_future = executor.submit(enter_and_hold_worker)
        assert entered.wait(timeout=5)
        exit_future = executor.submit(manager.__exit__, None, None, None)
        assert exit_future.result(timeout=5) is False
        release_enter_worker.set()
        enter_future.result(timeout=5)

    assert registry.inspect(session_id).session.save_status == "dirty"
    registry.discard(session_id)
    registry.close(session_id)


def test_close_releases_lock_when_final_document_load_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_path = tmp_path / "CloseFailure.narrative"
    app = create_app()
    with TestClient(app, raise_server_exceptions=False) as client:
        created = client.post(
            "/api/project-sessions/create",
            json={"path": str(project_path), "name": "Close Failure"},
        )
        session_id = created.json()["session"]["session_id"]

        def fail_load(_: object) -> None:
            raise ProjectSessionError("project_document_invalid")

        monkeypatch.setattr(app.state.project_sessions, "_load_document", fail_load)
        response = client.post(f"/api/project-sessions/{session_id}/close")

        assert response.status_code == 400
        assert _error_code(response) == "project_document_invalid"
        assert not _lock_path(project_path).exists()
        assert client.get(f"/api/project-sessions/{session_id}").status_code == 404


def test_second_runtime_cannot_recover_active_project_lock(tmp_path: Path) -> None:
    project_path = tmp_path / "ActiveLock.narrative"

    with TestClient(create_app()) as first_client:
        created = first_client.post(
            "/api/project-sessions/create",
            json={"path": str(project_path), "name": "Active Lock"},
        )
        assert created.status_code == 201

        with TestClient(create_app()) as second_client:
            blocked = second_client.post(
                "/api/project-sessions/open",
                json={"path": str(project_path), "recover_stale_lock": True},
            )

        assert blocked.status_code == 409
        assert _error_code(blocked) == "project_locked"
        assert blocked.json()["detail"]["parameters"]["owner_pid"] == os.getpid()


def test_runtime_can_recover_its_exact_orphaned_session_lock(tmp_path: Path) -> None:
    project_path = tmp_path / "ReloadedRuntime.narrative"
    app = create_app()

    with TestClient(app) as client:
        created = client.post(
            "/api/project-sessions/create",
            json={"path": str(project_path), "name": "Reloaded Runtime"},
        )
        orphaned_session_id = created.json()["session"]["session_id"]
        registry = app.state.project_sessions
        # Model a hot reload that loses the process-local registry while its
        # same-PID lock remains on disk.
        orphaned = registry._sessions.pop(orphaned_session_id)
        registry._paths.pop(project_path.resolve())
        orphaned.engine.dispose()

        recovered = client.post(
            "/api/project-sessions/open",
            json={
                "path": str(project_path),
                "recover_stale_lock": True,
                "recovery_mode": "recover",
                "expected_lock_session_id": orphaned_session_id,
            },
        )

        assert recovered.status_code == 200
        assert recovered.json()["session"]["session_id"] != orphaned_session_id


def test_stale_lock_requires_explicit_recovery(tmp_path: Path) -> None:
    project_path = tmp_path / "StaleLock.narrative"
    with TestClient(create_app()) as client:
        created = client.post(
            "/api/project-sessions/create",
            json={"path": str(project_path), "name": "Stale Lock"},
        )
        session_id = created.json()["session"]["session_id"]
        assert client.post(f"/api/project-sessions/{session_id}/close").status_code == 200

        _write_lock(project_path, pid=99_999_999)
        blocked = client.post(
            "/api/project-sessions/open",
            json={"path": str(project_path)},
        )
        assert blocked.status_code == 409
        assert _error_code(blocked) == "project_lock_stale"

        recovered = client.post(
            "/api/project-sessions/open",
            json={"path": str(project_path), "recover_stale_lock": True},
        )
        assert recovered.status_code == 200
        assert recovered.json()["session"]["lifecycle"] == "open"


def test_invalid_lock_is_never_removed_implicitly(tmp_path: Path) -> None:
    project_path = tmp_path / "InvalidLock.narrative"
    with TestClient(create_app()) as client:
        created = client.post(
            "/api/project-sessions/create",
            json={"path": str(project_path), "name": "Invalid Lock"},
        )
        session_id = created.json()["session"]["session_id"]
        assert client.post(f"/api/project-sessions/{session_id}/close").status_code == 200

        _lock_path(project_path).write_text("{invalid", encoding="utf-8")
        response = client.post(
            "/api/project-sessions/open",
            json={"path": str(project_path), "recover_stale_lock": True},
        )

        assert response.status_code == 400
        assert _error_code(response) == "project_lock_invalid"
        assert _lock_path(project_path).read_text(encoding="utf-8") == "{invalid"


def test_open_migrates_v1_manifest_after_backing_up_config_and_database(
    tmp_path: Path,
) -> None:
    project_path = tmp_path / "Legacy.narrative"
    _create_v1_project(project_path)

    with TestClient(create_app()) as client:
        response = client.post(
            "/api/project-sessions/open",
            json={"path": str(project_path)},
        )

        assert response.status_code == 200
        manifest = json.loads(
            (project_path / "project.config.json").read_text(encoding="utf-8")
        )
        assert manifest["format_version"] == 2
        assert manifest["project_id"] == response.json()["session"]["project_id"]
        backups = list((project_path / "snapshots").glob("format-v1-backup-*"))
        assert len(backups) == 1
        backup_manifest = json.loads(
            (backups[0] / "project.config.json").read_text(encoding="utf-8")
        )
        assert backup_manifest["format_version"] == 1
        assert (backups[0] / "project.sqlite").is_file()

        with sqlite3.connect(project_path / "project.sqlite") as connection:
            assert connection.execute("select version_num from alembic_version").fetchone()


def test_failed_v1_migration_restores_original_files_and_releases_lock(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_path = tmp_path / "FailedMigration.narrative"
    _create_v1_project(project_path)
    config_path = project_path / "project.config.json"
    database_path = project_path / "project.sqlite"
    original_config = config_path.read_bytes()
    original_database = database_path.read_bytes()

    def fail_upgrade(*_: object, **__: object) -> None:
        raise RuntimeError("injected migration failure")

    monkeypatch.setattr(
        "services.runtime.stt_runtime.project_session.service.command.upgrade",
        fail_upgrade,
    )
    with TestClient(create_app()) as client:
        response = client.post(
            "/api/project-sessions/open",
            json={"path": str(project_path)},
        )

    assert response.status_code == 400
    assert _error_code(response) == "project_database_migration_failed"
    assert config_path.read_bytes() == original_config
    assert database_path.read_bytes() == original_database
    assert not _lock_path(project_path).exists()


def test_malformed_project_and_database_return_stable_localization_errors(
    tmp_path: Path,
) -> None:
    malformed_config = tmp_path / "MalformedConfig.narrative"
    create_project_folder(malformed_config, "Malformed Config")
    (malformed_config / "project.config.json").write_text("{invalid", encoding="utf-8")

    malformed_database = tmp_path / "MalformedDatabase.narrative"
    create_project_folder(malformed_database, "Malformed Database")
    (malformed_database / "project.sqlite").write_bytes(b"not a sqlite database")

    with TestClient(create_app()) as client:
        config_response = client.post(
            "/api/project-sessions/open",
            json={"path": str(malformed_config)},
        )
        database_response = client.post(
            "/api/project-sessions/open",
            json={"path": str(malformed_database)},
        )

    assert config_response.status_code == 400
    assert _error_code(config_response) == "project_format_invalid"
    assert config_response.json()["detail"]["message_key"] == (
        "project_session.project_format_invalid"
    )
    assert isinstance(config_response.json()["detail"]["parameters"], dict)
    assert database_response.status_code == 400
    assert _error_code(database_response) == "project_database_invalid"


def test_manifest_and_database_project_identity_must_match(tmp_path: Path) -> None:
    project_path = tmp_path / "Identity.narrative"
    with TestClient(create_app()) as client:
        created = client.post(
            "/api/project-sessions/create",
            json={"path": str(project_path), "name": "Identity"},
        )
        session_id = created.json()["session"]["session_id"]
        assert client.post(f"/api/project-sessions/{session_id}/close").status_code == 200

        config_path = project_path / "project.config.json"
        manifest = json.loads(config_path.read_text(encoding="utf-8"))
        manifest["project_id"] = "different-project"
        config_path.write_text(json.dumps(manifest), encoding="utf-8")

        response = client.post(
            "/api/project-sessions/open",
            json={"path": str(project_path)},
        )

    assert response.status_code == 409
    assert _error_code(response) == "project_identity_mismatch"
    assert not _lock_path(project_path).exists()


def _create_v1_project(project_path: Path) -> None:
    project_path.mkdir()
    for directory in PROJECT_DIRECTORIES:
        (project_path / directory).mkdir()
    (project_path / "project.sqlite").touch()
    (project_path / "project.config.json").write_text(
        json.dumps(
            {
                "format_version": 1,
                "name": "Legacy",
                "created_at": "2026-05-27T00:00:00+00:00",
                "updated_at": "2026-05-27T00:00:00+00:00",
            }
        ),
        encoding="utf-8",
    )


def _record(records: list[dict], record_id: str) -> dict:
    """Find regular or specialized project-document records by stable owner id."""

    return next(
        record
        for record in records
        if record.get("id", record.get("node_id")) == record_id
    )


def _resource_payload(record: dict) -> dict:
    """Strip server-owned identity fields from a CRUD update payload."""

    return {
        key: value
        for key, value in record.items()
        if key not in {"id", "created_at", "updated_at"}
    }


def _write_lock(project_path: Path, *, pid: int) -> None:
    _lock_path(project_path).write_text(
        json.dumps(
            {
                "lock_version": 1,
                "session_id": "stale-session",
                "project_id": "stale-project",
                "runtime_instance_id": "stale-runtime",
                "pid": pid,
                "opened_at": "2026-07-28T00:00:00+00:00",
            }
        ),
        encoding="utf-8",
    )


def _lock_path(project_path: Path) -> Path:
    return project_path / "cache" / LOCK_FILENAME


def _error_code(response) -> str:
    return str(response.json()["detail"]["code"])

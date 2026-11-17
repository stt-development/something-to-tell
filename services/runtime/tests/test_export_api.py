"""Runtime route tests for transient plans and non-mutating artifact writes."""

from pathlib import Path

from fastapi.testclient import TestClient

from services.runtime.stt_runtime.app import create_app


def _options(format: str = "json") -> dict[str, object]:
    return {
        "options_version": 1,
        "format": format,
        "scope": "whole_project",
        "story_flow_ids": [],
        "engine_tag_target": format if format in {"ink", "yarn_spinner"} else "generic",
        "preview_max_bytes": 65_536,
    }


def _create(client: TestClient, path: Path) -> dict:
    response = client.post(
        "/api/project-sessions/create",
        json={"path": str(path), "name": "Artifact Safety"},
    )
    assert response.status_code == 201
    return response.json()


def _plan(client: TestClient, session_id: str, format: str = "json") -> dict:
    response = client.post(
        f"/api/exports/{session_id}/plans",
        json={"options": _options(format)},
    )
    assert response.status_code == 200, response.json()
    return response.json()


def _write_payload(plan: dict, destination: Path | None, *, overwrite: bool = False) -> dict:
    return {
        "options": plan["options"],
        "expected_source_checksum": plan["source"]["source_checksum"],
        "expected_plan_fingerprint": plan["plan_fingerprint"],
        "destination_directory": str(destination) if destination else None,
        "overwrite": overwrite,
    }


def test_plan_and_default_write_do_not_save_dirty_or_add_history(tmp_path: Path) -> None:
    project_path = tmp_path / "ArtifactSafety.narrative"
    with TestClient(create_app()) as client:
        created = _create(client, project_path)
        session_id = created["session"]["session_id"]
        before = client.get(f"/api/project-sessions/{session_id}").json()
        history_before = client.get(f"/api/project-sessions/{session_id}/history").json()
        snapshots_before = sorted(path.name for path in (project_path / "snapshots").iterdir())

        plan = _plan(client, session_id)
        assert plan["can_write"] is True
        assert plan["suggested_filename"] == "artifact-safety.json"
        assert plan["preview"]["media_type"] == "application/json"
        assert plan["preview"]["text"].endswith("\n")

        written = client.post(
            f"/api/exports/{session_id}/writes",
            json=_write_payload(plan, None),
        )
        assert written.status_code == 200, written.json()
        artifact = written.json()["artifact"]
        destination = project_path / "exports" / "artifact-safety.json"
        assert artifact["installed_path"] == str(destination)
        assert artifact["bytes_written"] == destination.stat().st_size

        after = client.get(f"/api/project-sessions/{session_id}").json()
        history_after = client.get(f"/api/project-sessions/{session_id}/history").json()
        assert after == before
        assert history_after == history_before
        assert not (project_path / "cache" / "save-recovery.json").exists()
        assert sorted(path.name for path in (project_path / "snapshots").iterdir()) == snapshots_before

        repeated = client.post(
            f"/api/exports/{session_id}/writes",
            json=_write_payload(plan, None, overwrite=True),
        )
        assert repeated.status_code == 409
        assert repeated.json()["detail"]["code"] == "export_plan_stale"


def test_external_destination_conflict_retry_and_source_staleness(tmp_path: Path) -> None:
    project_path = tmp_path / "ExternalExport.narrative"
    destination = tmp_path / "selected"
    destination.mkdir()
    with TestClient(create_app()) as client:
        created = _create(client, project_path)
        session_id = created["session"]["session_id"]
        project_id = created["session"]["project_id"]

        plan = _plan(client, session_id, "yaml")
        target = destination / "artifact-safety.yaml"
        target.write_text("existing\n", encoding="utf-8")
        conflict = client.post(
            f"/api/exports/{session_id}/writes",
            json=_write_payload(plan, destination),
        )
        assert conflict.status_code == 409
        assert conflict.json()["detail"]["code"] == "export_destination_conflict"
        assert target.read_text(encoding="utf-8") == "existing\n"

        replaced = client.post(
            f"/api/exports/{session_id}/writes",
            json=_write_payload(plan, destination, overwrite=True),
        )
        assert replaced.status_code == 200
        assert target.read_text(encoding="utf-8").startswith('"projection_version": 1')

        stale_plan = _plan(client, session_id)
        assert client.post(
            "/api/nodes",
            headers={"X-Project-Session-Id": session_id},
            json={"project_id": project_id, "type": "Event", "title": "Changed"},
        ).status_code == 201
        stale = client.post(
            f"/api/exports/{session_id}/writes",
            json=_write_payload(stale_plan, destination),
        )
        assert stale.status_code == 409
        assert stale.json()["detail"]["code"] == "export_source_stale"
        assert not (destination / "artifact-safety.json").exists()


def test_routes_block_empty_ink_symlink_and_closed_session_plan(
    tmp_path: Path,
) -> None:
    project_path = tmp_path / "HostileExport.narrative"
    outside = tmp_path / "outside"
    outside.mkdir()
    linked = tmp_path / "linked"
    linked.symlink_to(outside, target_is_directory=True)
    with TestClient(create_app()) as client:
        created = _create(client, project_path)
        session_id = created["session"]["session_id"]

        ink = client.post(
            f"/api/exports/{session_id}/plans",
            json={"options": _options("ink") | {"engine_tag_target": "ink"}},
        )
        assert ink.status_code == 200
        assert ink.json()["suggested_filename"] == "artifact-safety.ink"
        assert ink.json()["preview"]["media_type"] == "text/x-ink"
        assert ink.json()["can_write"] is False
        assert any(item["code"] == "export.ink.missing-entry"
                   for item in ink.json()["diagnostics"])

        yarn = client.post(
            f"/api/exports/{session_id}/plans",
            json={
                "options": _options("yarn_spinner")
                | {"engine_tag_target": "yarn_spinner"}
            },
        )
        assert yarn.status_code == 200
        assert yarn.json()["suggested_filename"] == "artifact-safety.yarn"
        assert yarn.json()["preview"]["media_type"] == "text/x-yarnspinner"
        assert yarn.json()["can_write"] is False
        assert any(
            item["code"] == "export.yarn.missing-entry"
            for item in yarn.json()["diagnostics"]
        )

        plan = _plan(client, session_id)
        hostile = client.post(
            f"/api/exports/{session_id}/writes",
            json=_write_payload(plan, linked),
        )
        assert hostile.status_code == 400
        assert hostile.json()["detail"]["code"] == "export_path_invalid"
        assert list(outside.iterdir()) == []

        assert client.post(f"/api/project-sessions/{session_id}/close").status_code == 200
        cleared = client.post(
            f"/api/exports/{session_id}/writes",
            json=_write_payload(plan, outside),
        )
        assert cleared.status_code == 409
        assert cleared.json()["detail"]["code"] == "export_plan_stale"


def test_ink_plan_and_write_export_current_flow_without_saving(tmp_path: Path) -> None:
    with TestClient(create_app()) as client:
        created = _create(client, tmp_path / "Ink.narrative")
        session_id = created["session"]["session_id"]
        project_id = created["session"]["project_id"]
        headers = {"X-Project-Session-Id": session_id}
        node = client.post("/api/nodes", headers=headers, json={
            "project_id": project_id, "type": "Event", "title": "Arrival",
        }).json()
        flow = client.post("/api/story-flows", headers=headers, json={
            "project_id": project_id, "name": "Main Story", "kind": "main",
        }).json()
        assert client.post(f"/api/story-flows/{flow['id']}/nodes", headers=headers,
                           json={"project_id": project_id, "node_id": node["id"]}).status_code == 201
        assert client.post(f"/api/story-flows/{flow['id']}/entry", headers=headers,
                           json={"project_id": project_id, "node_id": node["id"]}).status_code == 200
        checkpoint = client.get("/api/engine-tags/registry", params={"session_id": session_id}).json()
        # Exercise real Ink readiness instead of bypassing missing target aliases.
        for index, definition in enumerate(checkpoint["catalog"]["definitions"]):
            response = client.post("/api/engine-tags/registry/commands", headers=headers, json={
                "command_id": f"ink-alias-{index}", "action": "set_alias",
                "definition_id": definition["id"],
                "alias": {"target": "ink", "external_identifier": f"test_tag_{index}"},
                "expected_source_checksum": checkpoint["source_checksum"],
                "expected_history_revision": checkpoint["history_revision"],
            })
            assert response.status_code == 200, response.json()
            checkpoint = response.json()
        before = client.get(f"/api/project-sessions/{session_id}").json()
        plan = _plan(client, session_id, "ink")
        assert plan["can_write"] is True, plan["diagnostics"]
        assert "Arrival" in plan["preview"]["text"]
        written = client.post(f"/api/exports/{session_id}/writes", json=_write_payload(plan, None))
        assert written.status_code == 200, written.json()
        assert Path(written.json()["artifact"]["installed_path"]).read_text() == plan["preview"]["text"]
        assert client.get(f"/api/project-sessions/{session_id}").json() == before

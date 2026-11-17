"""Manual Agent Memory API tests cover history, review, and explicit Save semantics."""

from datetime import UTC, datetime
from pathlib import Path

from fastapi.testclient import TestClient

from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.schemas.agent_memory import AgentMemoryEntryV1

NOW = datetime(2026, 9, 14, 12, 0, tzinfo=UTC).isoformat()


def test_manual_memory_lifecycle_is_history_owned_and_delete_is_reviewed(
    tmp_path: Path,
) -> None:
    with TestClient(create_app()) as client:
        created = client.post(
            "/api/project-sessions/create",
            json={"path": str(tmp_path / "MemoryUI.narrative"), "name": "Memory UI"},
        ).json()
        session_id = created["session"]["session_id"]
        project_id = created["session"]["project_id"]
        headers = {"X-Project-Session-Id": session_id}

        listed = client.get(
            "/api/agent-memory",
            params={"session_id": session_id},
        ).json()
        assert listed["catalog"]["entries"] == []

        first = _entry(project_id, "memory-canon", "canon_checker")
        created_memory = client.post(
            "/api/agent-memory/commands",
            headers=headers,
            json=_command("create", first, listed),
        )
        assert created_memory.status_code == 200
        first_result = created_memory.json()
        assert first_result["entry"]["instruction"] == first["instruction"]
        assert first_result["history_revision"] == 1

        current = _list(client, session_id)
        edited = {**current["catalog"]["entries"][0], "instruction": "Preserve the reviewed harbor ownership."}
        updated = client.post(
            "/api/agent-memory/commands",
            headers=headers,
            json=_command("update", edited, current),
        ).json()
        assert updated["entry"]["instruction"] == edited["instruction"]
        assert updated["history_revision"] == 2

        current = _list(client, session_id)
        copy = _entry(project_id, "memory-style-copy", "style_rewriter")
        copy["title"] = "Harbor ownership copy"
        copied = client.post(
            "/api/agent-memory/commands",
            headers=headers,
            json=_command("create", copy, current),
        ).json()
        assert copied["entry"]["agent_id"] == "style_rewriter"

        current = _list(client, session_id)
        archived = client.post(
            "/api/agent-memory/commands",
            headers=headers,
            json=_command("archive", current["catalog"]["entries"][0], current),
        ).json()
        assert archived["entry"]["status"] == "archived"
        current = _list(client, session_id)
        restored = client.post(
            "/api/agent-memory/commands",
            headers=headers,
            json=_command("restore", current["catalog"]["entries"][0], current),
        ).json()
        assert restored["entry"]["status"] == "active"

        current = _list(client, session_id)
        unreviewed = _command("delete", current["catalog"]["entries"][0], current)
        unreviewed["reviewed_impact_fingerprint"] = None
        assert client.post(
            "/api/agent-memory/commands",
            headers=headers,
            json=unreviewed,
        ).status_code == 422
        impact = client.get(
            "/api/agent-memory/memory-canon/deletion-impact",
            params={"session_id": session_id},
        ).json()
        deleted = client.post(
            "/api/agent-memory/commands",
            headers=headers,
            json=_command(
                "delete",
                current["catalog"]["entries"][0],
                current,
                impact["impact_fingerprint"],
            ),
        ).json()
        assert deleted["entry"] is None
        assert [item["id"] for item in _list(client, session_id)["catalog"]["entries"]] == [
            "memory-style-copy"
        ]

        inspected = client.get(f"/api/project-sessions/{session_id}").json()
        assert inspected["session"]["save_status"] == "dirty"
        assert inspected["session"]["saved_revision"] == 0
        history = client.get(f"/api/project-sessions/{session_id}/history").json()
        undone = client.post(
            f"/api/project-sessions/{session_id}/history/undo",
            json={"expected_history_revision": history["history_revision"]},
        ).json()
        assert [item["id"] for item in undone["project"]["document"]["agent_memories"]] == [
            "memory-canon", "memory-style-copy"
        ]
        redone = client.post(
            f"/api/project-sessions/{session_id}/history/redo",
            json={
                "expected_history_revision": undone["history"]["history_revision"]
            },
        ).json()
        assert [
            item["id"]
            for item in redone["project"]["document"]["agent_memories"]
        ] == ["memory-style-copy"]


def test_reviewed_delete_rebases_successors_and_undo_restores_the_chain(
    tmp_path: Path,
) -> None:
    with TestClient(create_app()) as client:
        created = client.post(
            "/api/project-sessions/create",
            json={"path": str(tmp_path / "MemoryChain.narrative"), "name": "Memory Chain"},
        ).json()
        session_id = created["session"]["session_id"]
        project_id = created["session"]["project_id"]
        registry = client.app.state.project_sessions
        first = AgentMemoryEntryV1.model_validate(_entry(
            project_id,
            "memory-first",
            "canon_checker",
        ))
        first_result = registry.accept_agent_memory_candidate(
            session_id,
            entry=first,
            source_checksum=created["document"]["checksum"],
            expected_history_revision=0,
        )
        second = AgentMemoryEntryV1.model_validate({
            **_entry(project_id, "memory-second", "canon_checker"),
            "title": "Revised harbor ownership",
            "supersedes_id": first.id,
        })
        second_result = registry.accept_agent_memory_candidate(
            session_id,
            entry=second,
            source_checksum=first_result.project.document.checksum,
            expected_history_revision=first_result.history.history_revision,
        )

        impact = client.get(
            "/api/agent-memory/memory-first/deletion-impact",
            params={"session_id": session_id},
        ).json()
        assert impact["direct_successor_ids"] == ["memory-second"]
        current = _list(client, session_id)
        deleted = client.post(
            "/api/agent-memory/commands",
            headers={"X-Project-Session-Id": session_id},
            json=_command(
                "delete",
                current["catalog"]["entries"][0],
                current,
                impact["impact_fingerprint"],
            ),
        ).json()
        remaining = _list(client, session_id)["catalog"]["entries"]
        assert [(item["id"], item["supersedes_id"]) for item in remaining] == [
            ("memory-second", None)
        ]

        undone = client.post(
            f"/api/project-sessions/{session_id}/history/undo",
            json={"expected_history_revision": deleted["history_revision"]},
        ).json()
        assert [
            (item["id"], item["supersedes_id"])
            for item in undone["project"]["document"]["agent_memories"]
        ] == [("memory-first", None), ("memory-second", "memory-first")]


def test_resolution_endpoint_is_read_only_and_bound_to_current_history(
    tmp_path: Path,
) -> None:
    with TestClient(create_app()) as client:
        created = client.post(
            "/api/project-sessions/create",
            json={"path": str(tmp_path / "MemoryResolve.narrative"), "name": "Memory Resolve"},
        ).json()
        session_id = created["session"]["session_id"]
        project_id = created["session"]["project_id"]
        listed = _list(client, session_id)
        client.post(
            "/api/agent-memory/commands",
            headers={"X-Project-Session-Id": session_id},
            json=_command(
                "create",
                _entry(project_id, "memory-canon", "canon_checker"),
                listed,
            ),
        ).raise_for_status()
        current = _list(client, session_id)
        payload = {
            "resolution_version": 1,
            "project_id": project_id,
            "agent_id": "canon_checker",
            "namespace": "canon_checker",
            "scope": {"scope_version": 1, "kind": "project"},
            "content_locale": "en",
            "context_scope": {"scope_version": 1, "kind": "project"},
            "source_checksum": current["source_checksum"],
            "history_revision": current["history_revision"],
        }

        resolved = client.post(
            "/api/agent-memory/resolve",
            headers={"X-Project-Session-Id": session_id},
            json=payload,
        )

        assert resolved.status_code == 200
        assert [item["id"] for item in resolved.json()["entries"]] == ["memory-canon"]
        inspected = client.get(f"/api/project-sessions/{session_id}").json()
        assert inspected["session"]["save_status"] == "dirty"
        assert client.get(f"/api/project-sessions/{session_id}/history").json()["history_revision"] == 1

        stale = {**payload, "history_revision": 0}
        rejected = client.post(
            "/api/agent-memory/resolve",
            headers={"X-Project-Session-Id": session_id},
            json=stale,
        )
        assert rejected.status_code == 409
        assert rejected.json()["detail"]["code"] == "agent_memory_resolution_stale"


def _entry(project_id: str, memory_id: str, agent_id: str) -> dict[str, object]:
    """Build one strict project-scoped wire entry for API commands."""

    return {
        "memory_version": 1,
        "id": memory_id,
        "project_id": project_id,
        "agent_id": agent_id,
        "namespace": agent_id,
        "scope": {"scope_version": 1, "kind": "project"},
        "content_locale": "en",
        "title": "Harbor ownership",
        "instruction": "Treat ownership changes as explicit authored events.",
        "rationale": "This keeps later analysis consistent.",
        "status": "active",
        "supersedes_id": None,
        "created_at": NOW,
        "updated_at": NOW,
    }


def _list(client: TestClient, session_id: str) -> dict[str, object]:
    """Reload the authoritative command checksum and history revision."""

    return client.get(
        "/api/agent-memory",
        params={"session_id": session_id},
    ).json()


def _command(
    action: str,
    entry: dict[str, object],
    current: dict[str, object],
    reviewed_impact_fingerprint: str | None = None,
) -> dict[str, object]:
    """Bind a mutation to the exact list projection visible to the author."""

    return {
        "command_version": 1,
        "command_id": f"command-{action}-{entry['id']}",
        "action": action,
        "memory_id": entry["id"],
        "entry": entry if action in {"create", "update"} else None,
        "expected_source_checksum": current["source_checksum"],
        "expected_history_revision": current["history_revision"],
        "reviewed_impact_fingerprint": reviewed_impact_fingerprint,
    }

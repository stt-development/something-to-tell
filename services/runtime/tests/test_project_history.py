from datetime import UTC, datetime, timedelta
from pathlib import Path
import sqlite3

from fastapi.testclient import TestClient
import pytest
from pydantic import ValidationError

from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.project_document.service import ProjectDocumentService
from services.runtime.stt_runtime.project_format.manifest import create_project_manifest
from services.runtime.stt_runtime.project_history.service import (
    ProjectHistoryCoordinator,
    ProjectHistoryError,
)
from services.runtime.stt_runtime.schemas.project_document import (
    ProjectDocument,
    create_project_document,
)
from services.runtime.stt_runtime.schemas.project_history import ProjectHistorySummary

NOW = datetime(2026, 8, 8, 10, 0, tzinfo=UTC)


def test_history_bounds_ten_commands_and_round_trips_retained_entries() -> None:
    history = ProjectHistoryCoordinator()
    current = _empty_document()

    for index in range(11):
        target = _with_node(current, index)
        summary = history.record(
            current,
            target,
            expected_history_revision=index,
            command_id=f"command-{index}",
            command_kind="create_node",
            label_key="history.command.createNode",
            label_parameters={"name": f"Node {index}"},
            created_at=NOW + timedelta(seconds=index),
        )
        current = target

    assert summary.history_revision == 11
    assert summary.capacity == 10
    assert summary.undo_depth == 10
    assert summary.redo_depth == 0
    assert summary.next_undo is not None
    assert summary.next_undo.command_id == "command-10"

    for revision in range(11, 21):
        current, summary = history.undo(
            current,
            expected_history_revision=revision,
            commit=lambda candidate: candidate,
        )
    assert [node.id for node in current.nodes] == ["node-00"]
    assert summary.undo_depth == 0
    assert summary.redo_depth == 10
    with pytest.raises(ProjectHistoryError, match="history_undo_empty"):
        history.undo(
            current,
            expected_history_revision=21,
            commit=lambda candidate: candidate,
        )

    for revision in range(21, 31):
        current, summary = history.redo(
            current,
            expected_history_revision=revision,
            commit=lambda candidate: candidate,
        )
    assert len(current.nodes) == 11
    assert summary.undo_depth == 10
    assert summary.redo_depth == 0


def test_new_command_clears_redo_while_noop_and_failed_commit_leave_history_unchanged() -> None:
    history = ProjectHistoryCoordinator()
    source = _empty_document()
    first = _with_node(source, 0)
    parameters = {"name": "Node 0"}
    history.record(
        source,
        first,
        expected_history_revision=0,
        command_id="command-0",
        command_kind="create_node",
        label_key="history.command.createNode",
        label_parameters=parameters,
    )
    parameters["name"] = "Mutated by caller"
    current, summary = history.undo(
        first,
        expected_history_revision=1,
        commit=lambda candidate: candidate,
    )
    assert summary.next_redo is not None
    assert summary.next_redo.label_parameters == {"name": "Node 0"}

    noop = history.record(
        current,
        current,
        expected_history_revision=2,
        command_id="noop",
        command_kind="noop",
        label_key="history.command.noop",
    )
    assert noop.history_revision == 2
    assert noop.redo_depth == 1

    branch = _with_node(current, 9)
    summary = history.record(
        current,
        branch,
        expected_history_revision=2,
        command_id="command-branch",
        command_kind="create_node",
        label_key="history.command.createNode",
    )
    assert summary.redo_depth == 0
    before_failure = summary

    def fail_commit(_: ProjectDocument) -> ProjectDocument:
        raise RuntimeError("injected commit failure")

    with pytest.raises(ProjectHistoryError, match="history_apply_failed"):
        history.undo(
            branch,
            expected_history_revision=3,
            commit=fail_commit,
        )
    assert history.summary() == before_failure


def test_save_rebase_retains_both_stack_sides_and_clear_is_a_revisioned_barrier() -> None:
    history = ProjectHistoryCoordinator()
    empty = _empty_document()
    first = _with_node(empty, 1)
    second = _with_node(first, 2)
    history.record(empty, first, expected_history_revision=0, command_id="first", command_kind="create_node", label_key="history.command.createNode")
    history.record(first, second, expected_history_revision=1, command_id="second", command_kind="create_node", label_key="history.command.createNode")
    current, _ = history.undo(second, expected_history_revision=2, commit=lambda candidate: candidate)
    saved = _with_saved_manifest(current, revision=1)

    rebased = history.rebased_for_save(current, saved)
    redone, summary = rebased.redo(saved, expected_history_revision=3, commit=lambda candidate: candidate)

    assert [node.id for node in redone.nodes] == ["node-01", "node-02"]
    assert redone.manifest.saved_revision == 1
    assert summary.undo_depth == 2
    cleared = rebased.clear()
    assert cleared.history_revision == 5
    assert cleared.undo_depth == cleared.redo_depth == 0


def test_history_rejects_stale_revisions_duplicate_ids_and_stale_documents() -> None:
    history = ProjectHistoryCoordinator()
    source = _empty_document()
    first = _with_node(source, 0)
    history.record(
        source,
        first,
        expected_history_revision=0,
        command_id="command-0",
        command_kind="create_node",
        label_key="history.command.createNode",
    )

    with pytest.raises(ProjectHistoryError, match="history_revision_stale"):
        history.undo(first, expected_history_revision=0, commit=lambda candidate: candidate)
    with pytest.raises(ProjectHistoryError, match="history_command_duplicate"):
        history.record(
            first,
            _with_node(first, 1),
            expected_history_revision=1,
            command_id="command-0",
            command_kind="create_node",
            label_key="history.command.createNode",
        )
    with pytest.raises(ProjectHistoryError, match="history_document_stale"):
        history.undo(
            _with_node(first, 2),
            expected_history_revision=1,
            commit=lambda candidate: candidate,
        )
    assert history.summary().history_revision == 1
    assert history.summary().undo_depth == 1


def test_history_transport_rejects_unbounded_or_inconsistent_stack_summaries() -> None:
    with pytest.raises(ValidationError, match="bounded capacity"):
        ProjectHistorySummary(
            history_revision=11,
            undo_depth=10,
            redo_depth=1,
            next_undo={
                "command_id": "command",
                "command_kind": "create_node",
                "label_key": "history.command.createNode",
            },
            next_redo={
                "command_id": "command-redo",
                "command_kind": "delete_node",
                "label_key": "history.command.deleteNode",
            },
        )
    with pytest.raises(ValidationError, match="next_undo"):
        ProjectHistorySummary(
            history_revision=0,
            undo_depth=0,
            redo_depth=0,
            next_undo={
                "command_id": "unexpected",
                "command_kind": "create_node",
                "label_key": "history.command.createNode",
            },
        )


def test_history_api_reconciles_sqlite_and_returns_authoritative_state(tmp_path: Path) -> None:
    project_path = tmp_path / "HistoryApi.narrative"
    with TestClient(create_app()) as client:
        created = client.post(
            "/api/project-sessions/create",
            json={"path": str(project_path), "name": "History API"},
        ).json()
        session_id = created["session"]["session_id"]
        project_id = created["session"]["project_id"]
        headers = {"X-Project-Session-Id": session_id}
        assert client.post(
            "/api/nodes",
            headers=headers,
            json={"project_id": project_id, "type": "Event", "title": "Reversible event"},
        ).status_code == 201
        summary = client.get(f"/api/project-sessions/{session_id}/history").json()
        assert summary["undo_depth"] == 1

        inspected = client.get(f"/api/project-sessions/{session_id}/history")
        assert inspected.status_code == 200
        assert inspected.json()["next_undo"]["command_kind"] == "create_node"
        assert "forward_patch" not in inspected.text

        undone = client.post(
            f"/api/project-sessions/{session_id}/history/undo",
            json={"expected_history_revision": 1},
        )
        assert undone.status_code == 200
        assert undone.json()["project"]["document"]["nodes"] == []
        assert undone.json()["project"]["session"]["save_status"] == "clean"
        assert undone.json()["history"]["history_revision"] == 2
        assert undone.json()["history"]["redo_depth"] == 1

        redone = client.post(
            f"/api/project-sessions/{session_id}/history/redo",
            json={"expected_history_revision": 2},
        )
        assert redone.status_code == 200
        assert [node["title"] for node in redone.json()["project"]["document"]["nodes"]] == [
            "Reversible event"
        ]
        assert redone.json()["project"]["session"]["save_status"] == "dirty"
        assert redone.json()["history"]["history_revision"] == 3
        stale = client.post(
            f"/api/project-sessions/{session_id}/history/undo",
            json={"expected_history_revision": 2},
        )
        assert stale.status_code == 409
        assert stale.json()["detail"]["message_key"] == "history.error.history_revision_stale"


def test_history_api_keeps_document_and_stack_after_reconcile_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_path = tmp_path / "HistoryRollback.narrative"
    with TestClient(create_app()) as client:
        created = client.post(
            "/api/project-sessions/create",
            json={"path": str(project_path), "name": "History rollback"},
        ).json()
        session_id = created["session"]["session_id"]
        project_id = created["session"]["project_id"]
        headers = {"X-Project-Session-Id": session_id}
        assert client.post(
            "/api/nodes",
            headers=headers,
            json={"project_id": project_id, "type": "Event", "title": "Keep me"},
        ).status_code == 201
        def fail_reconcile(*_: object, **__: object) -> ProjectDocument:
            raise RuntimeError("injected reconcile failure")

        command_id = client.get(
            f"/api/project-sessions/{session_id}/history"
        ).json()["next_undo"]["command_id"]
        monkeypatch.setattr(ProjectDocumentService, "reconcile", fail_reconcile)
        failed = client.post(
            f"/api/project-sessions/{session_id}/history/undo",
            json={"expected_history_revision": 1},
        )
        assert failed.status_code == 400
        assert failed.json()["detail"]["code"] == "history_apply_failed"
        assert client.get(f"/api/project-sessions/{session_id}/history").json() == {
            "history_version": 1,
            "history_revision": 1,
            "capacity": 10,
            "undo_depth": 1,
            "redo_depth": 0,
            "next_undo": {
                "command_id": command_id,
                "command_kind": "create_node",
                "label_key": "history.command.createNode",
                "label_parameters": {},
            },
            "next_redo": None,
        }
        current = client.get(f"/api/project-sessions/{session_id}").json()["document"]
        assert [node["title"] for node in current["nodes"]] == ["Keep me"]


def test_save_retains_history_and_derives_dirty_state_from_saved_checksum(tmp_path: Path) -> None:
    project_path = tmp_path / "HistorySave.narrative"
    with TestClient(create_app()) as client:
        created = client.post("/api/project-sessions/create", json={"path": str(project_path), "name": "History save"}).json()
        session_id = created["session"]["session_id"]
        headers = {"X-Project-Session-Id": session_id}
        assert client.post("/api/nodes", headers=headers, json={"project_id": created["session"]["project_id"], "type": "Event", "title": "Saved event"}).status_code == 201
        before_save = client.get(f"/api/project-sessions/{session_id}/history").json()

        saved = client.post(f"/api/project-sessions/{session_id}/save", json={"expected_revision": 0, "reason": "manual"})
        assert saved.status_code == 200
        assert client.get(f"/api/project-sessions/{session_id}/history").json() == before_save
        assert "history_revision" not in (project_path / "project.config.json").read_text(
            encoding="utf-8"
        )
        with sqlite3.connect(project_path / "project.db") as connection:
            tables = {
                row[0]
                for row in connection.execute(
                    "select name from sqlite_master where type = 'table'"
                )
            }
        assert not any("history" in table for table in tables)
        undone = client.post(f"/api/project-sessions/{session_id}/history/undo", json={"expected_history_revision": 1}).json()
        assert undone["project"]["document"]["nodes"] == []
        assert undone["project"]["session"]["save_status"] == "dirty"
        assert undone["project"]["session"]["saved_revision"] == 1
        redone = client.post(f"/api/project-sessions/{session_id}/history/redo", json={"expected_history_revision": 2}).json()
        assert [node["title"] for node in redone["project"]["document"]["nodes"]] == ["Saved event"]
        assert redone["project"]["session"]["save_status"] == "clean"
        assert redone["project"]["session"]["saved_revision"] == 1


def test_failed_save_rebase_preserves_history_and_exits_saving(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_path = tmp_path / "HistorySaveFailure.narrative"
    app = create_app()
    with TestClient(app) as client:
        created = client.post(
            "/api/project-sessions/create",
            json={"path": str(project_path), "name": "History save failure"},
        ).json()
        session_id = created["session"]["session_id"]
        headers = {"X-Project-Session-Id": session_id}
        assert client.post(
            "/api/nodes",
            headers=headers,
            json={
                "project_id": created["session"]["project_id"],
                "type": "Event",
                "title": "Retained event",
            },
        ).status_code == 201
        retained = client.get(f"/api/project-sessions/{session_id}/history").json()

        active = app.state.project_sessions._sessions[session_id]
        monkeypatch.setattr(
            active.history,
            "rebased_for_save",
            lambda *_: (_ for _ in ()).throw(ProjectHistoryError("history_record_invalid")),
        )
        failed = client.post(
            f"/api/project-sessions/{session_id}/save",
            json={"expected_revision": 0, "reason": "manual"},
        )

        assert failed.status_code == 400
        assert failed.json()["detail"]["code"] == "project_save_failed"
        inspected = client.get(f"/api/project-sessions/{session_id}").json()
        assert inspected["session"]["save_status"] == "error"
        assert inspected["session"]["saved_revision"] == 0
        assert client.get(f"/api/project-sessions/{session_id}/history").json() == retained


def test_checkpoint_backed_settings_are_reversible_and_checksum_clean(
    tmp_path: Path,
) -> None:
    project_path = tmp_path / "HistorySettings.narrative"
    with TestClient(create_app()) as client:
        created = client.post(
            "/api/project-sessions/create",
            json={"path": str(project_path), "name": "Settings history"},
        ).json()
        session_id = created["session"]["session_id"]
        settings = created["document"]["manifest"]["settings"]

        updated = client.put(
            f"/api/project-sessions/{session_id}/settings",
            json={
                "name": "Settings history revised",
                "description": "Checkpoint-backed metadata",
                "settings": {**settings, "ui_locale": "ru"},
                "expected_history_revision": 0,
            },
        )
        assert updated.status_code == 200
        assert updated.json()["session"]["save_status"] == "clean"
        recorded = client.get(f"/api/project-sessions/{session_id}/history").json()
        assert recorded["next_undo"]["command_kind"] == "update_project_settings"

        undone = client.post(
            f"/api/project-sessions/{session_id}/history/undo",
            json={"expected_history_revision": 1},
        ).json()
        assert undone["project"]["document"]["manifest"]["name"] == "Settings history"
        assert undone["project"]["session"]["save_status"] == "dirty"
        redone = client.post(
            f"/api/project-sessions/{session_id}/history/redo",
            json={"expected_history_revision": 2},
        ).json()
        assert redone["project"]["document"]["checksum"] == updated.json()["document"]["checksum"]
        assert redone["project"]["session"]["save_status"] == "clean"

        stale = client.put(
            f"/api/project-sessions/{session_id}/settings",
            json={
                "name": "Rejected stale settings",
                "description": "",
                "settings": settings,
                "expected_history_revision": 0,
            },
        )
        assert stale.status_code == 409
        assert stale.json()["detail"]["code"] == "history_revision_stale"


def test_successful_lifecycle_barriers_clear_history_only_after_commit(tmp_path: Path) -> None:
    project_path = tmp_path / "HistoryLifecycle.narrative"
    copy_path = tmp_path / "HistoryCopy.narrative"
    with TestClient(create_app()) as client:
        created = client.post("/api/project-sessions/create", json={"path": str(project_path), "name": "History lifecycle"}).json()
        session_id = created["session"]["session_id"]
        project_id = created["session"]["project_id"]
        headers = {"X-Project-Session-Id": session_id}
        assert client.post("/api/nodes", headers=headers, json={"project_id": project_id, "type": "Event", "title": "Discard me"}).status_code == 201
        retained = client.get(f"/api/project-sessions/{session_id}/history").json()

        assert client.post(f"/api/project-sessions/{session_id}/close").status_code == 409
        assert client.post("/api/storage-migrations", json={"session_id": session_id, "expected_revision": 0, "target_mode": "local_sqlite", "target_profile_id": None}).status_code == 409
        assert client.get(f"/api/project-sessions/{session_id}/history").json() == retained

        discarded = client.post(f"/api/project-sessions/{session_id}/discard")
        assert discarded.status_code == 200
        assert client.get(f"/api/project-sessions/{session_id}/history").json()["undo_depth"] == 0

        assert client.post("/api/nodes", headers=headers, json={"project_id": project_id, "type": "Event", "title": "Copy me"}).status_code == 201
        assert client.post(f"/api/project-sessions/{session_id}/save", json={"expected_revision": 0, "reason": "manual"}).status_code == 200
        retained = client.get(f"/api/project-sessions/{session_id}/history").json()
        assert client.post(f"/api/project-sessions/{session_id}/save-as", json={"path": str(project_path), "expected_revision": 1, "identity": "preserve", "replace_existing": False}).status_code == 400
        assert client.get(f"/api/project-sessions/{session_id}/history").json() == retained
        copied = client.post(f"/api/project-sessions/{session_id}/save-as", json={"path": str(copy_path), "expected_revision": 1, "identity": "regenerate", "replace_existing": False})
        assert copied.status_code == 200
        assert client.get(f"/api/project-sessions/{session_id}/history").json()["undo_depth"] == 0
        assert client.post(f"/api/project-sessions/{session_id}/close").status_code == 200

        reopened = client.post("/api/project-sessions/open", json={"path": str(project_path), "recover_stale_lock": False})
        reopened_session_id = reopened.json()["session"]["session_id"]
        assert client.get(f"/api/project-sessions/{reopened_session_id}/history").json()["history_revision"] == 0


def _empty_document() -> ProjectDocument:
    manifest = create_project_manifest(
        project_id="history-project",
        name="History",
        now=NOW,
    )
    return create_project_document(manifest=manifest)


def _with_node(document: ProjectDocument, index: int) -> ProjectDocument:
    payload = document.model_dump(mode="python", exclude={"checksum"})
    node_id = f"node-{index:02d}"
    payload["nodes"].append(
        {
            "id": node_id,
            "project_id": document.manifest.project_id,
            "type": "Event",
            "title": f"Node {index}",
            "summary": "",
            "body": "",
            "status": "draft",
            "metadata": {},
            "created_at": NOW + timedelta(seconds=index),
            "updated_at": NOW + timedelta(seconds=index),
        }
    )
    payload["nodes"].sort(key=lambda node: node["id"])
    return create_project_document(**payload)


def _with_saved_manifest(document: ProjectDocument, revision: int) -> ProjectDocument:
    payload = document.model_dump(mode="python", exclude={"checksum", "manifest"})
    manifest = document.manifest.model_copy(
        update={"saved_revision": revision, "updated_at": NOW + timedelta(minutes=revision)}
    )
    return create_project_document(manifest=manifest, **payload)

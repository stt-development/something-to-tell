import sqlite3
from datetime import UTC, datetime
from pathlib import Path

from fastapi.testclient import TestClient

from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.composition.service import CompositionService
from services.runtime.stt_runtime.domain.entities import (
    AgentMemoryEntity,
    NodeEntity,
    StoryFlowEntity,
    VisualPlacementEntity,
)
from services.runtime.stt_runtime.project_session.service import ProjectSessionRegistry
from services.runtime.stt_runtime.story_flow.service import StoryFlowService

NOW = datetime(2026, 9, 11, 12, 0, tzinfo=UTC)


def _memory(project_id: str, **overrides: object) -> AgentMemoryEntity:
    values: dict[str, object] = {
        "id": "memory-project-canon",
        "project_id": project_id,
        "agent_id": "canon_checker",
        "namespace": "canon_checker",
        "scope": {"scope_version": 1, "kind": "project"},
        "content_locale": "en",
        "title": "Preserve reviewed ownership",
        "instruction": "Treat ownership changes as explicit authored events.",
        "created_at": NOW,
        "updated_at": NOW,
    }
    values.update(overrides)
    return AgentMemoryEntity(**values)  # type: ignore[arg-type]


def test_memory_survives_save_checkpoint_reopen_and_save_as(tmp_path: Path) -> None:
    registry = ProjectSessionRegistry()
    project_path = tmp_path / "MemoryProject.narrative"
    opened = registry.create(project_path, "Memory project")
    session_id = opened.session.session_id
    with registry.authoring_unit_of_work(
        session_id,
        command_kind="seed_agent_memory",
        label_key="history.command.seedAgentMemory",
    ) as uow:
        uow.agent_memories.add(_memory(opened.session.project_id))
        uow.commit()

    dirty = registry.inspect(session_id)
    saved = registry.save(
        session_id,
        expected_revision=dirty.session.saved_revision,
        reason="manual",
    )
    assert [item.id for item in saved.document.agent_memories] == ["memory-project-canon"]
    checkpoint = (
        project_path
        / "snapshots"
        / f"revision-{saved.session.saved_revision:08d}"
        / "project.sqlite"
    )
    with sqlite3.connect(checkpoint) as connection:
        checkpoint_memory = connection.execute(
            "select id, instruction from agent_memories"
        ).fetchone()
    with registry.authoring_unit_of_work(
        session_id,
        command_kind="delete_agent_memory",
        label_key="history.command.deleteAgentMemory",
    ) as uow:
        uow.agent_memories.delete("memory-project-canon")
        uow.commit()
    recovered = registry.discard(session_id)
    assert [item.id for item in recovered.document.agent_memories] == [
        "memory-project-canon"
    ]
    copy_path = tmp_path / "MemoryCopy.narrative"
    registry.save_as(
        session_id,
        destination=copy_path,
        expected_revision=saved.session.saved_revision,
        identity="preserve",
        replace_existing=False,
    )
    assert [
        item.id for item in registry.inspect(session_id).document.agent_memories
    ] == ["memory-project-canon"]
    registry.close(session_id)

    reopened = registry.open(project_path)
    assert reopened.document.agent_memories[0].id == "memory-project-canon"
    registry.close(reopened.session.session_id)
    copied = registry.open(copy_path)
    assert copied.document.agent_memories == reopened.document.agent_memories
    registry.close(copied.session.session_id)

    assert checkpoint_memory == (
        "memory-project-canon",
        "Treat ownership changes as explicit authored events.",
    )
    serialized = checkpoint.read_bytes().decode("latin-1")
    assert "provider_payload" not in serialized
    assert "provider_session_id" not in serialized
    assert "api_key" not in serialized


def test_memory_survives_explicit_dirty_shutdown_recovery(tmp_path: Path) -> None:
    """Recovery restores reviewed memory from working authority before Save."""

    project_path = tmp_path / "MemoryRecovery.narrative"
    app = create_app()
    with TestClient(app) as client:
        created = client.post(
            "/api/project-sessions/create",
            json={"path": str(project_path), "name": "Memory recovery"},
        ).json()
        session_id = created["session"]["session_id"]
        with app.state.project_sessions.authoring_unit_of_work(
            session_id,
            command_kind="seed_agent_memory",
            label_key="history.command.seedAgentMemory",
        ) as uow:
            uow.agent_memories.add(_memory(created["session"]["project_id"]))
            uow.commit()
        assert app.state.project_sessions.inspect(session_id).session.save_status == "dirty"

    with TestClient(create_app()) as restarted:
        blocked = restarted.post(
            "/api/project-sessions/open",
            json={"path": str(project_path)},
        )
        assert blocked.status_code == 409
        assert blocked.json()["detail"]["code"] == "project_recovery_required"

        recovered = restarted.post(
            "/api/project-sessions/open",
            json={"path": str(project_path), "recovery_mode": "recover"},
        )
        assert recovered.status_code == 200
        assert recovered.json()["session"]["save_status"] == "dirty"
        assert [
            item["id"] for item in recovered.json()["document"]["agent_memories"]
        ] == ["memory-project-canon"]
        recovered_session_id = recovered.json()["session"]["session_id"]
        assert restarted.post(
            f"/api/project-sessions/{recovered_session_id}/discard"
        ).status_code == 200
        assert restarted.post(
            f"/api/project-sessions/{recovered_session_id}/close"
        ).status_code == 200


def test_composition_deletion_reports_and_removes_node_owned_memory(tmp_path: Path) -> None:
    registry = ProjectSessionRegistry()
    opened = registry.create(tmp_path / "DeleteScene.narrative", "Delete Scene")
    with registry.unit_of_work(opened.session.session_id) as uow:
        scene = uow.nodes.add(
            NodeEntity(
                id="scene-opening",
                project_id=opened.session.project_id,
                type="Scene",
                title="Opening",
            )
        )
        uow.visual_placements.add(
            VisualPlacementEntity(
                id="placement-opening",
                project_id=opened.session.project_id,
                canonical_node_id=scene.id,
                scope_key="__root__",
                x=0,
                y=0,
                width=400,
                height=300,
                is_primary=True,
            )
        )
        uow.agent_memories.add(
            _memory(
                opened.session.project_id,
                id="memory-scene",
                scope={"scope_version": 1, "kind": "scene", "scene_node_id": scene.id},
            )
        )
        uow.commit()

    with registry.unit_of_work(opened.session.session_id) as uow:
        impact = CompositionService().deletion_impact(uow, "scene-opening")
        assert impact.agent_memory_ids == ["memory-scene"]
        CompositionService().delete_entity(uow, "scene-opening")
    with registry.unit_of_work(opened.session.session_id) as uow:
        assert uow.agent_memories.list(project_id=opened.session.project_id) == []
    registry.close(opened.session.session_id)


def test_story_flow_deletion_reports_and_removes_flow_owned_memory(tmp_path: Path) -> None:
    registry = ProjectSessionRegistry()
    opened = registry.create(tmp_path / "DeleteFlow.narrative", "Delete Flow")
    with registry.unit_of_work(opened.session.session_id) as uow:
        flow = uow.story_flows.add(
            StoryFlowEntity(
                id="flow-side",
                project_id=opened.session.project_id,
                name="Side Flow",
                normalized_name="side flow",
                kind="side",
                status="active",
            )
        )
        uow.agent_memories.add(
            _memory(
                opened.session.project_id,
                id="memory-flow",
                scope={"scope_version": 1, "kind": "story_flow", "flow_id": flow.id},
            )
        )
        uow.commit()

    with registry.unit_of_work(opened.session.session_id) as uow:
        impact = StoryFlowService().deletion_impact(uow, "flow-side")
        assert impact.agent_memory_ids == ["memory-flow"]
        StoryFlowService().delete(uow, "flow-side", confirmed=True)
    with registry.unit_of_work(opened.session.session_id) as uow:
        assert uow.agent_memories.list(project_id=opened.session.project_id) == []
    registry.close(opened.session.session_id)

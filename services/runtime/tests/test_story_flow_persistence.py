from collections.abc import Callable
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
import sqlite3

from alembic import command
from alembic.config import Config
import pytest
from sqlalchemy import Engine, create_engine, event, inspect
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from services.runtime.stt_runtime.db.base import Base, import_model_metadata
from services.runtime.stt_runtime.domain.entities import (
    FlowTransitionEntity,
    NodeEntity,
    ProjectEntity,
    SceneFlowBoundaryEntity,
    StoryFlowEntity,
    StoryFlowNodeEntity,
    VisualPlacementEntity,
)
from services.runtime.stt_runtime.project_format.interchange import (
    export_project_interchange,
    import_project_interchange,
)
from services.runtime.stt_runtime.repositories.interfaces import UnitOfWork
from services.runtime.stt_runtime.repositories.sqlite import SqlAlchemyUnitOfWork
from services.runtime.stt_runtime.schemas.project_interchange import (
    ProjectInterchangeDocument,
    ProjectStoryFlowSection,
)
from services.runtime.stt_runtime.schemas.story_flow import StoryFlow

NOW = datetime(2026, 7, 23, 9, 0, tzinfo=UTC)
FLOW_TABLES = {
    "story_flows",
    "story_flow_nodes",
    "flow_transitions",
    "scene_flow_boundaries",
    "flow_invocations",
    "flow_exits",
    "flow_exit_bindings",
}


def sqlite_engine(url: str) -> Engine:
    engine = create_engine(url)

    @event.listens_for(engine, "connect")
    def enable_foreign_keys(connection: sqlite3.Connection, _: object) -> None:
        connection.execute("PRAGMA foreign_keys=ON")

    return engine


def session_factory(engine: Engine) -> Callable[[], Session]:
    return lambda: Session(engine, expire_on_commit=False)


def create_schema(engine: Engine) -> None:
    import_model_metadata()
    Base.metadata.create_all(engine)


def seed_project(uow: UnitOfWork, project_id: str = "project-aurora") -> tuple[ProjectEntity, list[NodeEntity]]:
    project = uow.projects.add(
        ProjectEntity(
            id=project_id,
            name="Project Aurora",
            path="/tmp/ProjectAurora.narrative",
            format_version=1,
        )
    )
    nodes = [
        uow.nodes.add(NodeEntity(id="scene-dock", project_id=project.id, type="Scene", title="Opening Dock")),
        uow.nodes.add(NodeEntity(id="event-entry", project_id=project.id, type="Event", title="Arrival")),
        uow.nodes.add(NodeEntity(id="event-exit", project_id=project.id, type="Event", title="Departure")),
    ]
    return project, nodes


def add_flow_records(uow: UnitOfWork, project_id: str = "project-aurora") -> StoryFlowEntity:
    flow = uow.story_flows.add(
        StoryFlowEntity(
            id="flow-main",
            project_id=project_id,
            name="Main Story",
            normalized_name="main story",
            kind="main",
            status="active",
            entry_node_id="event-entry",
        )
    )
    for order, node_id in enumerate(("scene-dock", "event-entry", "event-exit")):
        uow.story_flow_nodes.add(
            StoryFlowNodeEntity(
                id=f"membership-{node_id}",
                project_id=project_id,
                flow_id=flow.id,
                node_id=node_id,
                presentation_order=order,
            )
        )
    uow.flow_transitions.add(
        FlowTransitionEntity(
            id="transition-depart",
            project_id=project_id,
            flow_id=flow.id,
            source_node_id="event-entry",
            target_node_id="event-exit",
            priority=0,
            label="Continue",
        )
    )
    uow.scene_flow_boundaries.add(
        SceneFlowBoundaryEntity(
            id="boundary-dock",
            project_id=project_id,
            flow_id=flow.id,
            scene_node_id="scene-dock",
            entry_node_id="event-entry",
            exit_node_ids=["event-exit"],
        )
    )
    return flow


def test_story_flow_repositories_survive_sqlite_restart_and_support_flow_scoping(tmp_path: Path) -> None:
    database_path = tmp_path / "restart.sqlite"
    engine = sqlite_engine(f"sqlite:///{database_path}")
    create_schema(engine)

    with SqlAlchemyUnitOfWork(session_factory(engine)) as uow:
        seed_project(uow)
        flow = add_flow_records(uow)
        uow.commit()
    engine.dispose()

    restarted_engine = sqlite_engine(f"sqlite:///{database_path}")
    with SqlAlchemyUnitOfWork(session_factory(restarted_engine)) as uow:
        protocol_uow: UnitOfWork = uow
        stored = protocol_uow.story_flows.get(flow.id)
        memberships = protocol_uow.story_flow_nodes.list(project_id="project-aurora", flow_id=flow.id)
        transition = protocol_uow.flow_transitions.get("transition-depart")
        boundary = protocol_uow.scene_flow_boundaries.get_for_scene(
            flow_id=flow.id,
            scene_node_id="scene-dock",
        )

        assert stored is not None
        assert stored.created_at.tzinfo == UTC
        assert [item.node_id for item in memberships] == ["scene-dock", "event-entry", "event-exit"]
        assert protocol_uow.story_flow_nodes.get_for_node(flow_id=flow.id, node_id="event-entry") is not None
        assert protocol_uow.flow_transitions.list(project_id="project-aurora", flow_id="missing") == []
        assert transition is not None and transition.label == "Continue"
        assert boundary is not None and boundary.exit_node_ids == ["event-exit"]


def test_complete_main_and_side_authoring_contract_survives_sqlite_restart(tmp_path: Path) -> None:
    """Proves Phase 3.8 receives one durable cross-feature authoring snapshot."""

    database_path = tmp_path / "complete-authoring-restart.sqlite"
    engine = sqlite_engine(f"sqlite:///{database_path}")
    create_schema(engine)
    with SqlAlchemyUnitOfWork(session_factory(engine)) as uow:
        project, _ = seed_project(uow)
        for node_id, kind, title in (
            ("dialogue-dock", "Dialogue", "Dockmaster Warning"),
            ("quest-smuggler", "Quest", "Smuggler Route"),
            ("event-dialogue-outcome", "Event", "Ledger Accepted"),
            ("event-quest-outcome", "Event", "Blockade Run"),
        ):
            uow.nodes.add(NodeEntity(id=node_id, project_id=project.id, type=kind, title=title))
        for order, node_id in enumerate(("dialogue-dock", "event-dialogue-outcome", "event-exit")):
            uow.visual_placements.add(
                VisualPlacementEntity(
                    id=f"placement-{node_id}",
                    project_id=project.id,
                    canonical_node_id=node_id,
                    container_node_id="scene-dock",
                    scope_key="scene-dock",
                    x=40 + order * 180,
                    y=80,
                    width=160,
                    height=120,
                )
            )

        main = uow.story_flows.add(
            StoryFlowEntity(
                id="flow-main-complete",
                project_id=project.id,
                name="Main Story",
                normalized_name="main story",
                kind="main",
                status="active",
                entry_node_id="scene-dock",
            )
        )
        side = uow.story_flows.add(
            StoryFlowEntity(
                id="flow-side-complete",
                project_id=project.id,
                name="Smuggler Route",
                normalized_name="smuggler route",
                kind="side",
                status="active",
                entry_node_id="quest-smuggler",
            )
        )
        memberships = {
            main.id: ("scene-dock", "dialogue-dock", "event-dialogue-outcome", "event-exit"),
            side.id: ("quest-smuggler", "event-quest-outcome", "event-exit"),
        }
        for flow_id, node_ids in memberships.items():
            for order, node_id in enumerate(node_ids):
                uow.story_flow_nodes.add(
                    StoryFlowNodeEntity(
                        id=f"{flow_id}-member-{node_id}",
                        project_id=project.id,
                        flow_id=flow_id,
                        node_id=node_id,
                        presentation_order=order,
                    )
                )
        for transition in (
            FlowTransitionEntity(
                id="main-scene-entry",
                project_id=project.id,
                flow_id=main.id,
                source_node_id="scene-dock",
                target_node_id="dialogue-dock",
                priority=0,
            ),
            FlowTransitionEntity(
                id="main-dialogue-accepted",
                project_id=project.id,
                flow_id=main.id,
                source_node_id="dialogue-dock",
                target_node_id="event-dialogue-outcome",
                priority=0,
                kind="branch",
                condition="ledger_acquired",
                metadata={"dialogue_element_id": "answer-present-ledger"},
            ),
            FlowTransitionEntity(
                id="main-dialogue-default",
                project_id=project.id,
                flow_id=main.id,
                source_node_id="dialogue-dock",
                target_node_id="event-exit",
                priority=1,
                kind="branch",
                is_default=True,
            ),
            FlowTransitionEntity(
                id="main-outcome-ending",
                project_id=project.id,
                flow_id=main.id,
                source_node_id="event-dialogue-outcome",
                target_node_id="event-exit",
                priority=0,
            ),
            FlowTransitionEntity(
                id="side-quest-outcome",
                project_id=project.id,
                flow_id=side.id,
                source_node_id="quest-smuggler",
                target_node_id="event-quest-outcome",
                priority=0,
                kind="optional",
                metadata={"quest_stage_id": "choose-route", "quest_branch_id": "run-blockade"},
            ),
            FlowTransitionEntity(
                id="side-return-ending",
                project_id=project.id,
                flow_id=side.id,
                source_node_id="event-quest-outcome",
                target_node_id="event-exit",
                priority=0,
                kind="return",
            ),
        ):
            uow.flow_transitions.add(transition)
        uow.scene_flow_boundaries.add(
            SceneFlowBoundaryEntity(
                id="boundary-main-dock",
                project_id=project.id,
                flow_id=main.id,
                scene_node_id="scene-dock",
                entry_node_id="dialogue-dock",
                exit_node_ids=["event-dialogue-outcome", "event-exit"],
            )
        )
        uow.commit()
    engine.dispose()

    restarted_engine = sqlite_engine(f"sqlite:///{database_path}")
    with SqlAlchemyUnitOfWork(session_factory(restarted_engine)) as uow:
        flows = sorted(uow.story_flows.list(project_id="project-aurora"), key=lambda item: item.id)
        main_transitions = sorted(
            uow.flow_transitions.list(project_id="project-aurora", flow_id="flow-main-complete"),
            key=lambda item: (item.source_node_id, item.priority),
        )
        side_transitions = sorted(
            uow.flow_transitions.list(project_id="project-aurora", flow_id="flow-side-complete"),
            key=lambda item: (item.source_node_id, item.priority),
        )
        boundary = uow.scene_flow_boundaries.get_for_scene(
            flow_id="flow-main-complete",
            scene_node_id="scene-dock",
        )

        assert [(flow.id, flow.entry_node_id, flow.kind) for flow in flows] == [
            ("flow-main-complete", "scene-dock", "main"),
            ("flow-side-complete", "quest-smuggler", "side"),
        ]
        assert [(item.id, item.priority, item.is_default) for item in main_transitions] == [
            ("main-dialogue-accepted", 0, False),
            ("main-dialogue-default", 1, True),
            ("main-outcome-ending", 0, False),
            ("main-scene-entry", 0, False),
        ]
        assert main_transitions[0].metadata == {"dialogue_element_id": "answer-present-ledger"}
        assert side_transitions[1].metadata == {
            "quest_stage_id": "choose-route",
            "quest_branch_id": "run-blockade",
        }
        assert side_transitions[0].target_node_id == "event-exit"
        assert boundary is not None
        assert boundary.entry_node_id == "dialogue-dock"
        assert boundary.exit_node_ids == ["event-dialogue-outcome", "event-exit"]
        assert {
            (item.container_node_id, item.canonical_node_id)
            for item in uow.visual_placements.list(project_id="project-aurora")
        } == {
            ("scene-dock", "dialogue-dock"),
            ("scene-dock", "event-dialogue-outcome"),
            ("scene-dock", "event-exit"),
        }
        assert {
            item.node_id
            for item in uow.story_flow_nodes.list(project_id="project-aurora", flow_id="flow-side-complete")
        } == {"quest-smuggler", "event-quest-outcome", "event-exit"}


def test_story_flow_repository_update_rollback_and_cascade_preserve_canonical_nodes() -> None:
    engine = sqlite_engine("sqlite:///:memory:")
    create_schema(engine)
    factory = session_factory(engine)

    with SqlAlchemyUnitOfWork(factory) as uow:
        seed_project(uow)
        flow = add_flow_records(uow)
        uow.commit()

    with SqlAlchemyUnitOfWork(factory) as uow:
        updated = uow.story_flows.update(replace(flow, description="Playable order"))
        assert updated.description == "Playable order"
        uow.rollback()

    with SqlAlchemyUnitOfWork(factory) as uow:
        assert uow.story_flows.get(flow.id).description == ""  # type: ignore[union-attr]
        uow.story_flows.delete(flow.id)
        uow.commit()

    with SqlAlchemyUnitOfWork(factory) as uow:
        assert uow.story_flows.list(project_id="project-aurora") == []
        assert uow.story_flow_nodes.list(project_id="project-aurora") == []
        assert uow.flow_transitions.list(project_id="project-aurora") == []
        assert uow.scene_flow_boundaries.list(project_id="project-aurora") == []
        assert len(uow.nodes.list(project_id="project-aurora")) == 3


def test_database_constraints_reject_duplicate_flow_membership() -> None:
    engine = sqlite_engine("sqlite:///:memory:")
    create_schema(engine)
    factory = session_factory(engine)

    with SqlAlchemyUnitOfWork(factory) as uow:
        seed_project(uow)
        flow = add_flow_records(uow)
        uow.commit()

    with pytest.raises(IntegrityError):
        with SqlAlchemyUnitOfWork(factory) as uow:
            uow.story_flow_nodes.add(
                StoryFlowNodeEntity(
                    project_id="project-aurora",
                    flow_id=flow.id,
                    node_id="event-entry",
                    presentation_order=10,
                )
            )


def test_migration_preserves_existing_project_without_inventing_flow_and_downgrades(tmp_path: Path) -> None:
    database_path = tmp_path / "migration.sqlite"
    config = Config("services/runtime/alembic.ini")
    config.set_main_option("sqlalchemy.url", f"sqlite:///{database_path}")
    command.upgrade(config, "20260716_0002")

    with sqlite3.connect(database_path) as connection:
        connection.execute(
            """
            INSERT INTO projects
                (id, name, path, format_version, metadata, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            ("legacy-project", "Legacy", "/tmp/Legacy.narrative", 1, "{}", NOW.isoformat(), NOW.isoformat()),
        )
        connection.execute(
            """
            INSERT INTO nodes
                (id, project_id, type, title, summary, body, status, metadata, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "legacy-node",
                "legacy-project",
                "Lore",
                "Existing lore",
                "",
                "",
                "canon",
                "{}",
                NOW.isoformat(),
                NOW.isoformat(),
            ),
        )
        connection.commit()

    command.upgrade(config, "20260803_0004")
    engine = sqlite_engine(f"sqlite:///{database_path}")
    assert FLOW_TABLES.issubset(inspect(engine).get_table_names())
    with sqlite3.connect(database_path) as connection:
        assert connection.execute("SELECT title FROM nodes WHERE id = 'legacy-node'").fetchone() == ("Existing lore",)
        assert connection.execute("SELECT COUNT(*) FROM story_flows").fetchone() == (0,)

    command.downgrade(config, "20260716_0002")
    assert FLOW_TABLES.isdisjoint(inspect(engine).get_table_names())
    with sqlite3.connect(database_path) as connection:
        assert connection.execute("SELECT title FROM nodes WHERE id = 'legacy-node'").fetchone() == ("Existing lore",)


def test_project_interchange_round_trip_preserves_story_flow_ids_and_timestamps() -> None:
    engine = sqlite_engine("sqlite:///:memory:")
    create_schema(engine)
    factory = session_factory(engine)

    with SqlAlchemyUnitOfWork(factory) as uow:
        seed_project(uow)
        add_flow_records(uow)
        uow.commit()
    with SqlAlchemyUnitOfWork(factory) as uow:
        document = export_project_interchange(uow, "project-aurora")
        exported_created_at = document.story_flows.flows[0].created_at  # type: ignore[union-attr]
        uow.story_flows.delete("flow-main")
        uow.commit()
    with SqlAlchemyUnitOfWork(factory) as uow:
        assert import_project_interchange(uow, document) == 1
    with SqlAlchemyUnitOfWork(factory) as uow:
        restored = export_project_interchange(uow, "project-aurora")

    assert restored.story_flows is not None
    assert restored.story_flows.section_version == 2
    assert restored.story_flows.flows[0].id == "flow-main"
    assert restored.story_flows.flows[0].created_at == exported_created_at
    assert restored.story_flows.transitions[0].id == "transition-depart"
    assert restored.story_flows.scene_boundaries[0].exit_node_ids == ["event-exit"]


def test_interchange_without_story_flow_is_backward_compatible_and_failed_import_rolls_back() -> None:
    engine = sqlite_engine("sqlite:///:memory:")
    create_schema(engine)
    factory = session_factory(engine)

    with SqlAlchemyUnitOfWork(factory) as uow:
        seed_project(uow)
        uow.commit()
    legacy = ProjectInterchangeDocument(project_id="project-aurora")
    with SqlAlchemyUnitOfWork(factory) as uow:
        assert import_project_interchange(uow, legacy) == 0
        assert uow.story_flows.list(project_id="project-aurora") == []

    duplicate_names = ProjectInterchangeDocument(
        project_id="project-aurora",
        story_flows=ProjectStoryFlowSection(
            project_id="project-aurora",
            flows=[
                StoryFlow(
                    id="flow-a",
                    project_id="project-aurora",
                    name="Main Story",
                    created_at=NOW,
                    updated_at=NOW,
                ),
                StoryFlow(
                    id="flow-b",
                    project_id="project-aurora",
                    name=" main   STORY ",
                    created_at=NOW,
                    updated_at=NOW,
                ),
            ],
        ),
    )
    with pytest.raises(IntegrityError):
        with SqlAlchemyUnitOfWork(factory) as uow:
            import_project_interchange(uow, duplicate_names)
    with SqlAlchemyUnitOfWork(factory) as uow:
        assert uow.story_flows.list(project_id="project-aurora") == []

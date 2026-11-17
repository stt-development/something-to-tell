from datetime import UTC, datetime
from pathlib import Path
import sqlite3

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect

from services.runtime.stt_runtime.domain.entities import (
    FlowExitBindingEntity,
    FlowExitEntity,
    FlowInvocationEntity,
    NodeEntity,
    StoryFlowEntity,
    StoryFlowNodeEntity,
)
from services.runtime.stt_runtime.project_format.interchange import (
    export_project_interchange,
    import_project_interchange,
)
from services.runtime.stt_runtime.project_document.service import ProjectDocumentService
from services.runtime.stt_runtime.project_fixture import (
    import_project_fixture,
    load_project_fixture,
)
from services.runtime.stt_runtime.project_session.service import ProjectSessionRegistry
from services.runtime.stt_runtime.repositories.sqlite import SqlAlchemyUnitOfWork
from services.runtime.stt_runtime.schemas.project_interchange import (
    ProjectInterchangeDocument,
    ProjectStoryFlowSection,
)
from services.runtime.stt_runtime.schemas.project_document import create_project_document

NOW = datetime(2026, 8, 3, 12, 0, tzinfo=UTC)
COMPOSABLE_TABLES = {"flow_invocations", "flow_exits", "flow_exit_bindings"}


def _seed_composable_records(uow: SqlAlchemyUnitOfWork, project_id: str) -> None:
    """Own one minimal executable call graph reused by persistence boundaries."""

    for node_id in ("main-start", "main-return", "side-start", "side-success"):
        uow.nodes.add(
            NodeEntity(
                id=node_id,
                project_id=project_id,
                type="Event",
                title=node_id,
                created_at=NOW,
                updated_at=NOW,
            )
        )
    for flow_id, name, entry in (
        ("flow-main", "Main Story", "main-start"),
        ("flow-side", "Side Quest", "side-start"),
    ):
        uow.story_flows.add(
            StoryFlowEntity(
                id=flow_id,
                project_id=project_id,
                name=name,
                normalized_name=name.casefold(),
                status="active",
                entry_node_id=entry,
                created_at=NOW,
                updated_at=NOW,
            )
        )
    for flow_id, node_ids in (
        ("flow-main", ("main-start", "main-return")),
        ("flow-side", ("side-start", "side-success")),
    ):
        for order, node_id in enumerate(node_ids):
            uow.story_flow_nodes.add(
                StoryFlowNodeEntity(
                    id=f"member-{flow_id}-{node_id}",
                    project_id=project_id,
                    flow_id=flow_id,
                    node_id=node_id,
                    presentation_order=order,
                    created_at=NOW,
                    updated_at=NOW,
                )
            )
    uow.flow_invocations.add(
        FlowInvocationEntity(
            id="invocation-side",
            project_id=project_id,
            source_flow_id="flow-main",
            source_node_id="main-start",
            target_flow_id="flow-side",
            label="Enter side quest",
            condition="quest.available",
            priority=0,
            created_at=NOW,
            updated_at=NOW,
        )
    )
    uow.flow_exits.add(
        FlowExitEntity(
            id="exit-side-success",
            project_id=project_id,
            flow_id="flow-side",
            key="success",
            label="Quest complete",
            source_node_id="side-success",
            created_at=NOW,
            updated_at=NOW,
        )
    )
    uow.flow_exit_bindings.add(
        FlowExitBindingEntity(
            id="binding-side-success",
            project_id=project_id,
            invocation_id="invocation-side",
            exit_id="exit-side-success",
            target_node_id="main-return",
            created_at=NOW,
            updated_at=NOW,
        )
    )


def test_composable_records_survive_manual_save_close_and_process_restart(
    tmp_path: Path,
) -> None:
    project_path = tmp_path / "Composable.narrative"
    registry = ProjectSessionRegistry()
    opened = registry.create(project_path, "Composable")
    with registry.unit_of_work(opened.session.session_id, mark_dirty=True) as uow:
        _seed_composable_records(uow, opened.session.project_id)
        uow.commit()

    saved = registry.save(
        opened.session.session_id,
        expected_revision=opened.session.saved_revision,
        reason="manual",
    )
    before = saved.document.model_dump(mode="json")
    registry.close(opened.session.session_id)

    restarted = ProjectSessionRegistry()
    reopened = restarted.open(project_path)
    try:
        assert reopened.document.model_dump(mode="json") == before
        assert reopened.document.flow_invocations[0].id == "invocation-side"
        assert reopened.document.flow_exits[0].key == "success"
        assert reopened.document.flow_exit_bindings[0].target_node_id == "main-return"
    finally:
        restarted.close(reopened.session.session_id)


def test_interchange_v2_round_trip_preserves_calls_and_v1_adds_none(
    tmp_path: Path,
) -> None:
    registry = ProjectSessionRegistry()
    project_path = tmp_path / "Interchange.narrative"
    opened = registry.create(project_path, "Interchange")
    project_id = opened.session.project_id
    with registry.unit_of_work(opened.session.session_id) as uow:
        _seed_composable_records(uow, project_id)
        uow.commit()
        exported = export_project_interchange(uow, project_id)
        for repository in (
            uow.flow_exit_bindings,
            uow.flow_exits,
            uow.flow_invocations,
            uow.scene_flow_boundaries,
            uow.flow_transitions,
            uow.story_flow_nodes,
            uow.story_flows,
        ):
            for record in repository.list(project_id=project_id):
                repository.delete(record.id)
        uow.commit()
    with registry.unit_of_work(opened.session.session_id) as uow:
        assert import_project_interchange(uow, exported) == 2
        restored = export_project_interchange(uow, project_id)
    registry.close(opened.session.session_id)

    assert exported.story_flows is not None
    assert exported.story_flows.section_version == 2
    assert [item.id for item in exported.story_flows.invocations] == ["invocation-side"]
    assert [item.id for item in exported.story_flows.exits] == ["exit-side-success"]
    assert [item.id for item in exported.story_flows.exit_bindings] == [
        "binding-side-success"
    ]
    assert restored.model_dump(mode="json") == exported.model_dump(mode="json")

    # A section authored before Phase 3.10 remains explicit empty composition;
    # import never infers calls from flow names, nodes, or Quest-like content.
    legacy = ProjectInterchangeDocument(
        project_id=project_id,
        story_flows=ProjectStoryFlowSection(section_version=1, project_id=project_id),
    )
    assert legacy.story_flows is not None
    assert legacy.story_flows.invocations == []
    assert legacy.story_flows.exits == []
    assert legacy.story_flows.exit_bindings == []


def test_complete_document_reconcile_rolls_back_composable_records(
    tmp_path: Path,
) -> None:
    registry = ProjectSessionRegistry()
    opened = registry.create(tmp_path / "Rollback.narrative", "Rollback")
    with registry.unit_of_work(opened.session.session_id) as uow:
        _seed_composable_records(uow, opened.session.project_id)
        uow.commit()
    original = registry.inspect(opened.session.session_id).document
    payload = original.model_dump(mode="python", exclude={"checksum"})
    payload["flow_invocations"] = [
        original.flow_invocations[0].model_copy(update={"label": "Must roll back"})
    ]
    changed = create_project_document(**payload)

    with registry.unit_of_work(opened.session.session_id) as uow:
        def fail_commit() -> None:
            raise RuntimeError("injected composable commit failure")

        uow.commit = fail_commit  # type: ignore[method-assign]
        try:
            ProjectDocumentService().reconcile(uow, changed)
        except RuntimeError as error:
            assert str(error) == "injected composable commit failure"
        else:
            raise AssertionError("reconcile should propagate the injected commit failure")

    after_failure = registry.inspect(opened.session.session_id).document
    registry.close(opened.session.session_id)
    assert after_failure.model_dump(mode="json") == original.model_dump(mode="json")


def test_migration_adds_empty_composable_tables_and_downgrades(tmp_path: Path) -> None:
    database_path = tmp_path / "migration.sqlite"
    config = Config("services/runtime/alembic.ini")
    config.set_main_option("sqlalchemy.url", f"sqlite:///{database_path}")
    command.upgrade(config, "20260723_0003")

    with sqlite3.connect(database_path) as connection:
        connection.execute(
            """
            INSERT INTO projects
                (id, name, path, format_version, metadata, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            ("legacy", "Legacy", "/tmp/Legacy.narrative", 2, "{}", NOW.isoformat(), NOW.isoformat()),
        )
        connection.commit()

    command.upgrade(config, "20260803_0004")
    engine = create_engine(f"sqlite:///{database_path}")
    assert COMPOSABLE_TABLES.issubset(inspect(engine).get_table_names())
    with sqlite3.connect(database_path) as connection:
        for table in COMPOSABLE_TABLES:
            assert connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone() == (0,)

    command.downgrade(config, "20260723_0003")
    assert COMPOSABLE_TABLES.isdisjoint(inspect(engine).get_table_names())
    with sqlite3.connect(database_path) as connection:
        assert connection.execute("SELECT name FROM projects WHERE id = 'legacy'").fetchone() == (
            "Legacy",
        )
    engine.dispose()


def test_fixture_import_and_independent_save_as_preserve_composable_records(
    tmp_path: Path,
) -> None:
    source = load_project_fixture(
        Path(__file__).parents[3] / "fixtures/projects/project-aurora.v1.json"
    )
    imported_path = tmp_path / "ImportedAurora.narrative"
    imported = import_project_fixture(
        Path(__file__).parents[3] / "fixtures/projects/project-aurora.v1.json",
        imported_path,
    )

    assert imported.document.flow_invocations == source.flow_invocations
    assert imported.document.flow_exits == source.flow_exits
    assert imported.document.flow_exit_bindings == source.flow_exit_bindings

    registry = ProjectSessionRegistry()
    opened = registry.open(imported_path)
    copy_path = tmp_path / "IndependentAurora.narrative"
    copied = registry.save_as(
        opened.session.session_id,
        destination=copy_path,
        expected_revision=opened.session.saved_revision,
        identity="regenerate",
        replace_existing=False,
    )
    registry.close(opened.session.session_id)

    reopened = registry.open(copy_path)
    try:
        assert copied.project_id != source.manifest.project_id
        assert {item.project_id for item in reopened.document.flow_invocations} == {
            copied.project_id
        }
        assert [item.id for item in reopened.document.flow_invocations] == [
            item.id for item in source.flow_invocations
        ]
        assert [item.id for item in reopened.document.flow_exits] == [
            item.id for item in source.flow_exits
        ]
        assert [item.id for item in reopened.document.flow_exit_bindings] == [
            item.id for item in source.flow_exit_bindings
        ]
    finally:
        registry.close(reopened.session.session_id)

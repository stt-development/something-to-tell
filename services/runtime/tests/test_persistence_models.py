from datetime import UTC, datetime
import json
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, select, text
from sqlalchemy.orm import Session

from services.runtime.stt_runtime.db.base import Base, import_model_metadata
from services.runtime.stt_runtime.db.models import (
    AgentMemory,
    Edge,
    EngineTag,
    EngineTagBinding,
    EngineTagDefinition,
    ImpactResolutionDecision,
    Issue,
    Node,
    Project,
    Suggestion,
    StyleProfile,
    SceneStyleAssignment,
    VisualPlacement,
)

EXPECTED_TABLES = {
    "projects",
    "nodes",
    "edges",
    "issues",
    "suggestions",
    "engine_tags",
    "engine_tag_definitions",
    "engine_tag_bindings",
    "legacy_engine_tags",
    "visual_placements",
    "story_flows",
    "story_flow_nodes",
    "flow_transitions",
    "scene_flow_boundaries",
    "impact_resolution_decisions",
    "style_profiles",
    "scene_style_assignments",
    "agent_memories",
}


def test_model_metadata_contains_phase_1_tables() -> None:
    import_model_metadata()

    assert EXPECTED_TABLES.issubset(Base.metadata.tables)


def test_models_generate_ids_timestamps_and_json_defaults() -> None:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)

    with Session(engine) as session:
        project = Project(name="Test Project", path="/tmp/Test.narrative", format_version=1)
        first_node = Node(project=project, type="Scene", title="Opening")
        second_node = Node(project=project, type="Lore", title="Embargo")
        edge = Edge(project=project, source_node=first_node, target_node=second_node, type="reveals")
        issue = Issue(project=project, node=first_node, title="Continuity warning")
        suggestion = Suggestion(project=project, title="Patch proposal", patch={"operations": []})
        resolution_decision = ImpactResolutionDecision(
            project=project,
            finding_fingerprints=["a" * 64],
            proposal_semantic_fingerprint="b" * 64,
            source_checksum="c" * 64,
            decision="rejected",
            decided_at=datetime(2026, 9, 1, tzinfo=UTC),
        )
        engine_tag = EngineTag(
            project=project,
            target_type="node",
            target_id="node-01",
            engine="unity",
            key="guid",
            value="unity-guid",
        )
        definition = EngineTagDefinition(
            project=project,
            key="Story.MainQuest",
            normalized_key="story.mainquest",
            description="Main quest tag",
            status="active",
            aliases=[{"tag_version": 1, "target": "ink", "external_identifier": "main_quest"}],
        )
        binding = EngineTagBinding(
            project=project,
            definition=definition,
            owner={"kind": "node", "project_id": project.id, "node_id": first_node.id},
            owner_key="kind=node:node_id=node-01:project_id=project",
            value="true",
        )
        memory = AgentMemory(
            project=project,
            agent_id="canon_checker",
            namespace="canon_checker",
            scope={"scope_version": 1, "kind": "project"},
            content_locale="en",
            title="Keep canon",
            instruction="Preserve reviewed facts.",
            status="active",
        )
        session.add_all([
            project,
            first_node,
            second_node,
            edge,
            issue,
            suggestion,
            resolution_decision,
            engine_tag,
            definition,
            binding,
            memory,
        ])
        session.flush()
        first_node_id = first_node.id
        placement = VisualPlacement(
            project=project,
            canonical_node_id=first_node.id,
            scope_key="__root__",
            x=80,
            y=120,
            width=240,
            height=140,
            is_primary=True,
        )

        style_profile = StyleProfile(
            project=project,
            name="Test style",
            guidance="Use concise test prose.",
            traits={"traits_version": 1},
            positive_examples=[],
        )
        scene_assignment = SceneStyleAssignment(
            project=project,
            scene_node_id=first_node.id,
            style_profile=style_profile,
        )

        session.add_all([placement, style_profile, scene_assignment])
        session.commit()

        stored_project = session.scalar(select(Project).where(Project.id == project.id))
        stored_placement = session.scalar(select(VisualPlacement).where(VisualPlacement.id == placement.id))
        stored_decision = session.scalar(
            select(ImpactResolutionDecision).where(
                ImpactResolutionDecision.id == resolution_decision.id
            )
        )
        stored_style = session.scalar(
            select(StyleProfile).where(StyleProfile.id == style_profile.id)
        )
        stored_definition = session.get(EngineTagDefinition, {"project_id": project.id, "id": definition.id})
        stored_binding = session.get(EngineTagBinding, {"project_id": project.id, "id": binding.id})

    assert stored_project is not None
    assert len(stored_project.id) == 36
    assert stored_project.created_at is not None
    assert stored_project.updated_at is not None
    assert stored_project.metadata_ == {}
    assert stored_placement is not None
    assert stored_placement.canonical_node_id == first_node_id
    assert stored_decision is not None
    assert stored_decision.finding_fingerprints == ["a" * 64]
    assert stored_style is not None
    assert stored_style.guidance == "Use concise test prose."
    assert stored_definition is not None
    assert stored_binding is not None


def test_alembic_upgrade_creates_phase_1_tables(tmp_path: Path) -> None:
    database_path = tmp_path / "migration-test.sqlite"
    config = Config("services/runtime/alembic.ini")
    config.set_main_option("sqlalchemy.url", f"sqlite:///{database_path}")

    command.upgrade(config, "head")

    engine = create_engine(f"sqlite:///{database_path}")
    table_names = set(inspect(engine).get_table_names())

    assert EXPECTED_TABLES.issubset(table_names)
    assert "alembic_version" in table_names


def test_engine_tag_migration_quarantines_legacy_rows(tmp_path: Path) -> None:
    database_path = tmp_path / "engine-tag-migration.sqlite"
    config = Config("services/runtime/alembic.ini")
    config.set_main_option("sqlalchemy.url", f"sqlite:///{database_path}")
    command.upgrade(config, "20260911_0008")
    engine = create_engine(f"sqlite:///{database_path}")
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO projects (id, name, path, format_version, metadata, created_at, updated_at) "
                "VALUES ('p', 'P', '/tmp/P.narrative', 2, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            )
        )
        connection.execute(
            text(
                "INSERT INTO engine_tags "
                "(id, project_id, target_type, target_id, engine, key, value, metadata, created_at, updated_at) "
                "VALUES ('legacy', 'p', 'node', 'n', 'unity', 'guid', 'x', :metadata, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            ),
            {"metadata": '{"raw":true}'},
        )
    command.upgrade(config, "head")
    with engine.connect() as connection:
        copied = connection.execute(
            text(
                "SELECT id, project_id, target_type, target_id, engine, key, value, metadata "
                "FROM legacy_engine_tags"
            )
        ).mappings().one()
    copied_data = dict(copied)
    copied_data["metadata"] = json.loads(copied_data["metadata"])
    assert copied_data == {
        "id": "legacy", "project_id": "p", "target_type": "node", "target_id": "n",
        "engine": "unity", "key": "guid", "value": "x", "metadata": {"raw": True},
    }

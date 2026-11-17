import json
from pathlib import Path
import sqlite3

import pytest

from services.runtime.stt_runtime.canon.capabilities import project_repair_capability
from services.runtime.stt_runtime.project_fixture import (
    ProjectFixtureError,
    import_project_fixture,
    load_project_fixture,
    write_project_fixture,
)
from services.runtime.stt_runtime.project_session.service import ProjectSessionRegistry
from services.runtime.stt_runtime.schemas.canon_check import (
    CanonIssueMetadataV2,
    parse_canon_issue_metadata,
)
from services.runtime.stt_runtime.schemas.agent_memory import AgentMemoryEntryV1
from services.runtime.stt_runtime.story_flow.composable_service import ComposableStoryFlowService


FIXTURES = Path(__file__).parents[3] / "fixtures" / "projects"


def test_loads_complete_aurora_and_empty_citadel_source_fixtures() -> None:
    aurora = load_project_fixture(FIXTURES / "project-aurora.v1.json")
    citadel = load_project_fixture(FIXTURES / "citadel-branch.v1.json")

    assert len(aurora.nodes) == aurora.expected_validation.canonical_node_count == 16
    assert len(aurora.dialogues) == 1
    assert len(aurora.quests) == 1
    assert len(aurora.story_flows) == 3
    assert len(aurora.playback_effects) == 2
    assert aurora.engine_tags == []
    assert len(aurora.engine_tag_definitions) == 9
    assert len(aurora.engine_tag_bindings) == 9
    assert aurora.legacy_engine_tags == []
    assert {binding.owner.kind for binding in aurora.engine_tag_bindings} == {
        "node",
        "relationship",
        "dialogue_line",
        "quest_branch",
        "story_flow",
        "flow_transition",
        "flow_invocation",
        "flow_exit",
        "narrative_effect",
    }
    mara_tag = next(
        definition
        for definition in aurora.engine_tag_definitions
        if definition.key == "Character.MaraVale"
    )
    assert {alias.target for alias in mara_tag.aliases} == {
        "unreal", "unity", "ink", "yarn_spinner",
    }
    # Aurora owns both the general and specialized Phase 3.10 call examples.
    assert len(aurora.flow_invocations) == 2
    assert {item.key for item in aurora.flow_exits} == {
        "abandoned",
        "completed",
        "failure",
        "success",
    }
    assert len(aurora.flow_exit_bindings) == 4
    # Production Aurora demonstrates explicit state without inferring its owns edge.
    assert len(aurora.flow_initial_states) == 2
    assert aurora.flow_initial_states[0].item_custody[0].holder.node_id == "node-dockmaster"
    assert len(aurora.narrative_effects) == 4
    assert len(aurora.style_profiles) == 3
    assert aurora.manifest.settings.style_system.default_style_profile_id == (
        "style-aurora-default"
    )
    assert aurora.scene_style_assignments[0].scene_node_id == "node-opening"
    assert len(aurora.agent_memories) == 10
    assert {item.agent_id for item in aurora.agent_memories} == {
        "canon_checker",
        "impact_resolver",
        "style_rewriter",
    }
    assert {item.content_locale for item in aurora.agent_memories} == {"en", "ru"}
    assert {item.scope.kind for item in aurora.agent_memories} == {
        "project",
        "scene",
        "dialogue_field",
    }
    assert [item.owner_kind for item in aurora.narrative_effect_bindings] == [
        "dialogue_element",
        "quest_outcome",
        "quest_outcome",
        "flow_exit",
    ]
    assert citadel.nodes == []
    assert citadel.issues == []
    assert citadel.flow_invocations == []
    assert citadel.flow_exits == []
    assert citadel.flow_exit_bindings == []
    assert citadel.flow_initial_states == []
    assert citadel.narrative_effects == []
    assert citadel.narrative_effect_bindings == []
    assert citadel.style_profiles == []
    assert citadel.scene_style_assignments == []
    assert citadel.agent_memories == []
    assert citadel.engine_tag_definitions == []
    assert citadel.engine_tag_bindings == []
    assert citadel.legacy_engine_tags == []
    assert citadel.manifest.settings.ui_locale == "en"


def test_imports_fixture_into_temporary_project_and_reopens_it(tmp_path: Path) -> None:
    destination = tmp_path / "ProjectAurora.narrative"
    imported = import_project_fixture(
        FIXTURES / "project-aurora.v1.json",
        destination,
    )

    assert imported.path == destination.resolve()
    assert len(imported.document.nodes) == 16
    assert len(imported.document.flow_transitions) == 8
    # Aurora keeps one future diagnostic as a safe navigation-only example;
    # capability projection must remain runtime-owned and checksum-bound.
    seeded_issue = next(
        issue for issue in imported.document.issues if issue.id == "issue-embargo-detail"
    )
    seeded_metadata = parse_canon_issue_metadata(seeded_issue.metadata)
    assert isinstance(seeded_metadata, CanonIssueMetadataV2)
    assert seeded_metadata.diagnostic.fact_code == "graph.trade-law-source"
    assert seeded_metadata.message_key == "canon.issue.integrity.unknown.message"
    assert seeded_metadata.agent_explanation is None
    assert seeded_metadata.agent_recommendation is None
    capability = project_repair_capability(
        seeded_metadata,
        imported.document,
        active=True,
    )
    assert (capability.kind, capability.action, capability.available) == (
        "navigate_only",
        "open_source",
        True,
    )
    assert capability.source_checksum == imported.document.checksum
    checkpoint_database = (
        destination / "snapshots" / "revision-00000001" / "project.sqlite"
    )
    with sqlite3.connect(checkpoint_database) as connection:
        assert connection.execute("select count(*) from flow_transitions").fetchone() == (8,)

    registry = ProjectSessionRegistry()
    reopened = registry.open(destination)
    try:
        assert reopened.document.checksum == imported.document.checksum
        assert reopened.document.manifest.project_id == "project-aurora"
        assert reopened.document.engine_tags == []
        assert len(reopened.document.engine_tag_definitions) == 9
        assert len(reopened.document.engine_tag_bindings) == 9
        assert len(reopened.document.flow_initial_states) == 2
        assert len(reopened.document.narrative_effects) == 4
        assert len(reopened.document.narrative_effect_bindings) == 4
        assert len(reopened.document.style_profiles) == 3
        assert len(reopened.document.scene_style_assignments) == 1
        assert len(reopened.document.agent_memories) == 10
        assert len(reopened.document.flow_invocations) == 2
        assert {item.key for item in reopened.document.flow_exits} >= {
            "abandoned",
            "failure",
            "success",
        }
        with registry.unit_of_work(reopened.session.session_id) as uow:
            projection = ComposableStoryFlowService().projection(
                uow, "project-aurora", "flow-main-story", "story"
            )
        assert [item.id for item in projection.graph.invocations] == [
            "flow-invocation-dialogue-smuggler-route",
            "flow-invocation-inspection-smuggler-route"
        ]
        discarded = registry.discard(reopened.session.session_id)
        assert len(discarded.document.flow_transitions) == 8
    finally:
        registry.close(reopened.session.session_id)


def test_opening_empty_citadel_fixture_does_not_synthesize_engine_tags(
    tmp_path: Path,
) -> None:
    """Opening a project is lifecycle-only and must not author registry records."""

    destination = tmp_path / "CitadelBranch.narrative"
    imported = import_project_fixture(
        FIXTURES / "citadel-branch.v1.json",
        destination,
    )
    assert imported.document.engine_tag_definitions == []
    assert imported.document.engine_tag_bindings == []

    registry = ProjectSessionRegistry()
    reopened = registry.open(destination)
    try:
        assert reopened.document.engine_tag_definitions == []
        assert reopened.document.engine_tag_bindings == []
        assert reopened.document.legacy_engine_tags == []
    finally:
        registry.close(reopened.session.session_id)


def test_writes_fixture_deterministically_and_round_trips_schema(tmp_path: Path) -> None:
    fixture = load_project_fixture(FIXTURES / "project-aurora.v1.json")
    generated = tmp_path / "generated" / "project-aurora.v1.json"

    write_project_fixture(generated, fixture)
    first_render = generated.read_text(encoding="utf-8")
    write_project_fixture(generated, fixture)

    assert generated.read_text(encoding="utf-8") == first_render
    assert load_project_fixture(generated) == fixture
    assert not generated.with_suffix(".json.tmp").exists()


def test_fixture_import_export_preserves_reviewed_memory_without_provider_data(
    tmp_path: Path,
) -> None:
    fixture = load_project_fixture(FIXTURES / "project-aurora.v1.json")
    memory = AgentMemoryEntryV1(
        id="memory-fixture",
        project_id=fixture.manifest.project_id,
        agent_id="impact_resolver",
        namespace="impact_resolver",
        scope={"scope_version": 1, "kind": "project"},
        content_locale="en",
        title="Keep explicit custody",
        instruction="Treat item custody as temporal state, not a relationship edge.",
        created_at=fixture.manifest.updated_at,
        updated_at=fixture.manifest.updated_at,
    )
    portable = fixture.model_copy(
        update={
            "agent_memories": [memory],
            "expected_validation": fixture.expected_validation.model_copy(
                update={"agent_memory_count": 1}
            ),
        }
    )
    source = tmp_path / "aurora-with-memory.json"
    write_project_fixture(source, portable)

    loaded = load_project_fixture(source)
    imported = import_project_fixture(
        source,
        tmp_path / "AuroraWithMemory.narrative",
    )

    assert loaded.agent_memories == [memory]
    assert imported.document.agent_memories == [memory]
    assert "provider" not in json.dumps(memory.model_dump(mode="json"))


def test_example_fixtures_contain_no_provider_secret_or_response_fallback() -> None:
    """Keep sample projects authored-only and independent from remote agents."""

    for path in sorted(FIXTURES.glob("*.json")):
        payload = json.loads(path.read_text(encoding="utf-8"))
        serialized = json.dumps(payload).lower()
        assert "api_key" not in serialized
        assert "provider_response" not in serialized
        assert "impact_resolution_alternatives" not in serialized
        assert not payload.get("suggestions")


def test_rejects_truncated_fixture_before_creating_destination(
    tmp_path: Path,
) -> None:
    payload = json.loads((FIXTURES / "project-aurora.v1.json").read_text())
    payload["nodes"].pop()
    malformed = tmp_path / "truncated.json"
    malformed.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(ProjectFixtureError, match="counts do not match"):
        import_project_fixture(malformed, tmp_path / "Invalid.narrative")
    assert not (tmp_path / "Invalid.narrative").exists()

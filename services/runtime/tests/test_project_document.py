from collections.abc import Callable
from copy import deepcopy
from dataclasses import fields, replace
from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from services.runtime.stt_runtime.db.base import Base, import_model_metadata
from services.runtime.stt_runtime.domain.entities import (
    AgentMemoryEntity,
    EdgeEntity,
    EngineTagEntity,
    FlowExitBindingEntity,
    FlowExitEntity,
    FlowInvocationEntity,
    FlowInitialStateEntity,
    FlowTransitionEntity,
    IssueEntity,
    NodeEntity,
    NarrativeEffectBindingEntity,
    NarrativeEffectEntity,
    ProjectEntity,
    SceneFlowBoundaryEntity,
    SceneStyleAssignmentEntity,
    StyleProfileEntity,
    StoryFlowEntity,
    StoryFlowNodeEntity,
    SuggestionEntity,
    VisualPlacementEntity,
)
from services.runtime.stt_runtime.project_document.service import ProjectDocumentService
from services.runtime.stt_runtime.project_format.manifest import create_project_manifest
from services.runtime.stt_runtime.repositories.sqlite import SqlAlchemyUnitOfWork
from services.runtime.stt_runtime.schemas.project_document import (
    ProjectDocument,
    ProjectEdgeRecord,
    ProjectEngineTagRecord,
    ProjectFlowExitBindingRecord,
    ProjectFlowExitRecord,
    ProjectFlowInvocationRecord,
    ProjectFlowInitialStateRecord,
    ProjectFlowTransitionRecord,
    ProjectIssueRecord,
    ProjectNodeRecord,
    ProjectNarrativeEffectBindingRecord,
    ProjectNarrativeEffectRecord,
    ProjectPlacementRecord,
    ProjectSceneFlowBoundaryRecord,
    ProjectStoryFlowNodeRecord,
    ProjectStoryFlowRecord,
    ProjectSuggestionRecord,
    create_project_document,
    parse_project_document,
    project_document_checksum,
)
from services.runtime.stt_runtime.schemas.agent_memory import AgentMemoryEntryV1
from services.runtime.stt_runtime.schemas.style_system import (
    SceneStyleAssignmentV1,
    StyleProfileV1,
)

NOW = datetime(2026, 7, 28, 12, 0, tzinfo=UTC)
PROJECT_ID = "project-document-test"


def _session_factory(path: Path) -> tuple[Callable[[], Session], object]:
    import_model_metadata()
    engine = create_engine(f"sqlite:///{path}")
    Base.metadata.create_all(engine)
    return (lambda: Session(engine)), engine


def _manifest():
    return create_project_manifest(
        project_id=PROJECT_ID,
        name="Durable Citadel",
        description="Complete project document fixture.",
        now=NOW,
    )


def _seed_complete_project(session_factory: Callable[[], Session], *, path: str) -> None:
    dialogue_document = {
        "dialogue_version": 1,
        "entry_element_id": "line-1",
        "participants": ["character"],
        "elements": [
            {
                "id": "line-1",
                "kind": "line",
                "speaker_node_id": "character",
                "text": "The gate stays closed.",
                "next_element_id": None,
            }
        ],
    }
    quest_document = {
        "quest_version": 1,
        "objective": "Open the gate",
        "quest_giver_node_id": "character",
        "entry_stage_id": "stage-1",
        "prerequisite_node_ids": ["condition"],
        "reward_node_ids": ["item"],
        "stages": [
            {
                "id": "stage-1",
                "title": "Reach the gate",
                "description": "",
                "branches": [{"id": "branch-1", "label": "Proceed"}],
            }
        ],
    }
    nodes = [
        NodeEntity(
            id="quest",
            project_id=PROJECT_ID,
            type="Quest",
            title="Open the Gate",
            metadata={"quest_document": quest_document, "tags": ["main"]},
            created_at=NOW,
            updated_at=NOW,
        ),
        NodeEntity(
            id="dialogue",
            project_id=PROJECT_ID,
            type="Dialogue",
            title="Gatekeeper",
            metadata={"dialogue_document": dialogue_document, "tone": "guarded"},
            created_at=NOW,
            updated_at=NOW,
        ),
        NodeEntity(
            id="scene",
            project_id=PROJECT_ID,
            type="Scene",
            title="Citadel Gate",
            created_at=NOW,
            updated_at=NOW,
        ),
        NodeEntity(
            id="event",
            project_id=PROJECT_ID,
            type="Event",
            title="Gate Opens",
            created_at=NOW,
            updated_at=NOW,
        ),
        NodeEntity(
            id="character",
            project_id=PROJECT_ID,
            type="Character",
            title="Gatekeeper",
            created_at=NOW,
            updated_at=NOW,
        ),
        NodeEntity(
            id="faction",
            project_id=PROJECT_ID,
            type="Faction",
            title="Citadel Guard",
            created_at=NOW,
            updated_at=NOW,
        ),
        NodeEntity(
            id="condition",
            project_id=PROJECT_ID,
            type="Condition",
            title="Has royal seal",
            created_at=NOW,
            updated_at=NOW,
        ),
        NodeEntity(
            id="item",
            project_id=PROJECT_ID,
            type="Item",
            title="Gate Key",
            created_at=NOW,
            updated_at=NOW,
        ),
    ]
    edges = [
        EdgeEntity(
            id="membership-edge",
            project_id=PROJECT_ID,
            source_node_id="character",
            target_node_id="faction",
            type="member_of",
            created_at=NOW,
            updated_at=NOW,
        ),
        EdgeEntity(
            id="outcome-edge",
            project_id=PROJECT_ID,
            source_node_id="dialogue",
            target_node_id="event",
            type="leads_to",
            metadata={"dialogue_element_id": "line-1"},
            created_at=NOW,
            updated_at=NOW,
        ),
    ]
    with SqlAlchemyUnitOfWork(session_factory) as uow:
        uow.projects.add(
            ProjectEntity(
                id=PROJECT_ID,
                name="Durable Citadel",
                path=path,
                format_version=2,
                metadata={"presentation_preferences": {"workspace": "story"}},
                created_at=NOW,
                updated_at=NOW,
            )
        )
        for node in nodes:
            uow.nodes.add(node)
        for edge in edges:
            uow.edges.add(edge)
        uow.issues.add(
            IssueEntity(
                id="issue",
                project_id=PROJECT_ID,
                node_id="dialogue",
                edge_id="outcome-edge",
                title="Check gate outcome",
                severity="warning",
                created_at=NOW,
                updated_at=NOW,
            )
        )
        uow.suggestions.add(
            SuggestionEntity(
                id="decision",
                project_id=PROJECT_ID,
                title="Accepted gate update",
                status="accepted",
                patch={"operations": [{"kind": "update_node", "node_id": "event"}]},
                metadata={"operation_decisions": {"operation-1": "approved"}},
                created_at=NOW,
                updated_at=NOW,
            )
        )
        uow.engine_tags.add(
            EngineTagEntity(
                id="engine-tag",
                project_id=PROJECT_ID,
                target_type="node",
                target_id="event",
                engine="unity",
                key="event_id",
                value="gate-opens",
                created_at=NOW,
                updated_at=NOW,
            )
        )
        uow.visual_placements.add(
            VisualPlacementEntity(
                id="placement",
                project_id=PROJECT_ID,
                canonical_node_id="scene",
                scope_key="__root__",
                x=100,
                y=80,
                width=500,
                height=360,
                is_primary=True,
                created_at=NOW,
                updated_at=NOW,
            )
        )
        uow.style_profiles.add(
            StyleProfileEntity(
                id="style-citadel",
                project_id=PROJECT_ID,
                name="Citadel restraint",
                description="A controlled style for guarded scenes.",
                guidance="Use concise observations and restrained tension.",
                traits={
                    "traits_version": 1,
                    "tone": ["restrained"],
                    "rhythm": ["short sentences"],
                    "pacing": ["deliberate"],
                    "vocabulary": ["concrete"],
                    "dramatic_intensity": "controlled",
                },
                positive_examples=["The gate held. The guard did not blink."],
                created_at=NOW,
                updated_at=NOW,
            )
        )
        uow.scene_style_assignments.add(
            SceneStyleAssignmentEntity(
                id="scene-style-citadel",
                project_id=PROJECT_ID,
                scene_node_id="scene",
                style_profile_id="style-citadel",
                created_at=NOW,
                updated_at=NOW,
            )
        )
        uow.story_flows.add(
            StoryFlowEntity(
                id="main-flow",
                project_id=PROJECT_ID,
                name="Main Story",
                normalized_name="main story",
                kind="main",
                status="active",
                entry_node_id="scene",
                created_at=NOW,
                updated_at=NOW,
            )
        )
        for membership in [
            StoryFlowNodeEntity(
                id="member-scene",
                project_id=PROJECT_ID,
                flow_id="main-flow",
                node_id="scene",
                presentation_order=0,
                created_at=NOW,
                updated_at=NOW,
            ),
            StoryFlowNodeEntity(
                id="member-dialogue",
                project_id=PROJECT_ID,
                flow_id="main-flow",
                node_id="dialogue",
                presentation_order=1,
                created_at=NOW,
                updated_at=NOW,
            ),
            StoryFlowNodeEntity(
                id="member-event",
                project_id=PROJECT_ID,
                flow_id="main-flow",
                node_id="event",
                presentation_order=2,
                created_at=NOW,
                updated_at=NOW,
            ),
        ]:
            uow.story_flow_nodes.add(membership)
        for transition in [
            FlowTransitionEntity(
                id="transition-scene-dialogue",
                project_id=PROJECT_ID,
                flow_id="main-flow",
                source_node_id="scene",
                target_node_id="dialogue",
                priority=0,
                created_at=NOW,
                updated_at=NOW,
            ),
            FlowTransitionEntity(
                id="transition-dialogue-event",
                project_id=PROJECT_ID,
                flow_id="main-flow",
                source_node_id="dialogue",
                target_node_id="event",
                priority=0,
                created_at=NOW,
                updated_at=NOW,
            ),
        ]:
            uow.flow_transitions.add(transition)
        uow.scene_flow_boundaries.add(
            SceneFlowBoundaryEntity(
                id="scene-boundary",
                project_id=PROJECT_ID,
                flow_id="main-flow",
                scene_node_id="scene",
                entry_node_id="dialogue",
                exit_node_ids=["event"],
                created_at=NOW,
                updated_at=NOW,
            )
        )
        uow.agent_memories.add(
            AgentMemoryEntity(
                id="memory-citadel-scene",
                project_id=PROJECT_ID,
                agent_id="canon_checker",
                namespace="canon_checker",
                scope={
                    "scope_version": 1,
                    "kind": "scene",
                    "scene_node_id": "scene",
                },
                content_locale="en",
                title="Preserve the closed gate",
                instruction="Treat the citadel gate as closed until the event occurs.",
                created_at=NOW,
                updated_at=NOW,
            )
        )
        uow.commit()


def test_complete_document_survives_file_backed_restart(tmp_path: Path) -> None:
    database_path = tmp_path / "project.sqlite"
    session_factory, engine = _session_factory(database_path)
    _seed_complete_project(session_factory, path=str(tmp_path / "Project.narrative"))

    with SqlAlchemyUnitOfWork(session_factory) as uow:
        before_restart = ProjectDocumentService().load(uow, _manifest())
    engine.dispose()

    restarted_factory, restarted_engine = _session_factory(database_path)
    with SqlAlchemyUnitOfWork(restarted_factory) as uow:
        after_restart = ProjectDocumentService().load(uow, _manifest())
    restarted_engine.dispose()

    assert after_restart.model_dump(mode="json") == before_restart.model_dump(mode="json")
    assert after_restart.checksum == before_restart.checksum
    assert [node.id for node in after_restart.nodes] == sorted(
        node.id for node in after_restart.nodes
    )
    assert after_restart.dialogues[0].node_id == "dialogue"
    assert after_restart.quests[0].node_id == "quest"
    assert "dialogue_document" not in next(
        node.metadata for node in after_restart.nodes if node.id == "dialogue"
    )
    assert "quest_document" not in next(
        node.metadata for node in after_restart.nodes if node.id == "quest"
    )
    assert after_restart.suggestions[0].status == "accepted"
    assert any(edge.type == "member_of" for edge in after_restart.edges)
    assert after_restart.style_profiles[0].name == "Citadel restraint"
    assert after_restart.scene_style_assignments[0].scene_node_id == "scene"
    assert after_restart.agent_memories[0].id == "memory-citadel-scene"


def test_reconcile_copies_complete_document_transactionally(tmp_path: Path) -> None:
    source_factory, source_engine = _session_factory(tmp_path / "source.sqlite")
    _seed_complete_project(source_factory, path="/source/Project.narrative")
    with SqlAlchemyUnitOfWork(source_factory) as uow:
        source_document = ProjectDocumentService().load(uow, _manifest())
    source_engine.dispose()

    target_factory, target_engine = _session_factory(tmp_path / "target.sqlite")
    with SqlAlchemyUnitOfWork(target_factory) as uow:
        uow.projects.add(
            ProjectEntity(
                id=PROJECT_ID,
                name="Empty",
                path="/target/Project.narrative",
                format_version=2,
            )
        )
        uow.commit()
    with SqlAlchemyUnitOfWork(target_factory) as uow:
        reconciled = ProjectDocumentService().reconcile(uow, source_document)
    target_engine.dispose()

    assert reconciled.model_dump(mode="json") == source_document.model_dump(mode="json")


def test_document_validates_exact_dialogue_and_story_flow_memory_owners(
    tmp_path: Path,
) -> None:
    session_factory, engine = _session_factory(tmp_path / "memory-owners.sqlite")
    _seed_complete_project(session_factory, path="/memory/Project.narrative")
    with SqlAlchemyUnitOfWork(session_factory) as uow:
        document = ProjectDocumentService().load(uow, _manifest())
    engine.dispose()
    payload = document.model_dump(mode="python", exclude={"checksum"})
    payload["agent_memories"] = [
        {
            **payload["agent_memories"][0],
            "id": "memory-dialogue-line",
            "scope": {
                "scope_version": 1,
                "kind": "dialogue_field",
                "node_id": "dialogue",
                "field_kind": "line_text",
                "element_id": "line-1",
                "option_id": None,
            },
        },
        {
            **payload["agent_memories"][0],
            "id": "memory-main-flow",
            "title": "Preserve main flow",
            "scope": {
                "scope_version": 1,
                "kind": "story_flow",
                "flow_id": "main-flow",
            },
        },
    ]
    valid = create_project_document(**payload)
    broken = valid.model_dump(mode="python", exclude={"checksum"})
    broken["agent_memories"][0]["scope"]["element_id"] = "missing-line"

    assert [memory.scope.kind for memory in valid.agent_memories] == [
        "dialogue_field",
        "story_flow",
    ]
    with pytest.raises(ValueError, match="missing Dialogue field"):
        create_project_document(**broken)


def test_reconcile_rolls_back_every_collection_when_commit_fails(tmp_path: Path) -> None:
    session_factory, engine = _session_factory(tmp_path / "rollback.sqlite")
    _seed_complete_project(session_factory, path="/rollback/Project.narrative")
    service = ProjectDocumentService()
    with SqlAlchemyUnitOfWork(session_factory) as uow:
        original = service.load(uow, _manifest())
        changed_nodes = [
            replace_record(node, title="Must Roll Back") if node.id == "event" else node
            for node in original.nodes
        ]
        payload = original.model_dump(mode="python", exclude={"checksum"})
        payload["nodes"] = changed_nodes
        changed = create_project_document(**payload)

        def fail_commit() -> None:
            raise RuntimeError("injected commit failure")

        uow.commit = fail_commit  # type: ignore[method-assign]
        with pytest.raises(RuntimeError, match="injected commit failure"):
            service.reconcile(uow, changed)

    with SqlAlchemyUnitOfWork(session_factory) as uow:
        after_failure = service.load(uow, _manifest())
    engine.dispose()

    assert after_failure.model_dump(mode="json") == original.model_dump(mode="json")


def test_checksum_rejects_content_changes_and_order_changes(tmp_path: Path) -> None:
    session_factory, engine = _session_factory(tmp_path / "checksum.sqlite")
    _seed_complete_project(session_factory, path="/checksum/Project.narrative")
    with SqlAlchemyUnitOfWork(session_factory) as uow:
        document = ProjectDocumentService().load(uow, _manifest())
    engine.dispose()

    changed = document.model_dump(mode="json")
    changed["nodes"][0]["title"] = "Tampered"
    with pytest.raises(ValueError, match="checksum"):
        ProjectDocument.model_validate(changed)

    reordered = document.model_dump(mode="python", exclude={"checksum"})
    reordered["nodes"] = list(reversed(reordered["nodes"]))
    with pytest.raises(ValueError, match="stable id ordering"):
        create_project_document(**reordered)

    assert project_document_checksum(document) == document.checksum
    assert project_document_checksum({"z": 1, "a": 2}) == project_document_checksum(
        {"a": 2, "z": 1}
    )


def test_v1_checkpoint_migrates_empty_composition_without_mutating_input(
    tmp_path: Path,
) -> None:
    session_factory, engine = _session_factory(tmp_path / "legacy-checkpoint.sqlite")
    _seed_complete_project(session_factory, path="/legacy/Project.narrative")
    with SqlAlchemyUnitOfWork(session_factory) as uow:
        current = ProjectDocumentService().load(uow, _manifest())
    engine.dispose()

    legacy = current.model_dump(mode="json")
    legacy["document_version"] = 1
    legacy.pop("flow_invocations")
    legacy.pop("flow_exits")
    legacy.pop("flow_exit_bindings")
    legacy.pop("style_profiles")
    legacy.pop("scene_style_assignments")
    legacy.pop("agent_memories")
    legacy["checksum"] = project_document_checksum(legacy)
    original = deepcopy(legacy)

    migrated = parse_project_document(legacy)

    assert legacy == original
    assert migrated.document_version == 5
    assert migrated.flow_invocations == []
    assert migrated.flow_exits == []
    assert migrated.flow_exit_bindings == []
    assert migrated.flow_initial_states == []
    assert migrated.narrative_effects == []
    assert migrated.narrative_effect_bindings == []
    assert migrated.style_profiles == []
    assert migrated.scene_style_assignments == []
    assert migrated.agent_memories == []
    assert migrated.checksum != legacy["checksum"]

    corrupted = deepcopy(legacy)
    corrupted["project_metadata"] = {"tampered": True}
    with pytest.raises(ValueError, match="legacy project document checksum"):
        parse_project_document(corrupted)
    with pytest.raises(ValueError, match="unsupported project document version"):
        parse_project_document({**legacy, "document_version": 99})


def test_v2_checkpoint_migrates_empty_state_without_inferring_custody(
    tmp_path: Path,
) -> None:
    session_factory, engine = _session_factory(tmp_path / "v2-checkpoint.sqlite")
    _seed_complete_project(session_factory, path="/legacy/V2.narrative")
    with SqlAlchemyUnitOfWork(session_factory) as uow:
        current = ProjectDocumentService().load(uow, _manifest())
    engine.dispose()

    legacy = current.model_dump(mode="json")
    legacy["document_version"] = 2
    legacy.pop("flow_initial_states")
    legacy.pop("narrative_effects")
    legacy.pop("narrative_effect_bindings")
    legacy.pop("style_profiles")
    legacy.pop("scene_style_assignments")
    legacy.pop("agent_memories")
    legacy["checksum"] = project_document_checksum(legacy)
    original = deepcopy(legacy)

    migrated = parse_project_document(legacy)

    assert legacy == original
    assert migrated.document_version == 5
    assert migrated.flow_invocations == current.flow_invocations
    assert migrated.flow_initial_states == []
    assert migrated.narrative_effects == []
    assert migrated.narrative_effect_bindings == []
    assert migrated.style_profiles == []
    assert migrated.scene_style_assignments == []
    assert migrated.agent_memories == []


def test_v3_checkpoint_migrates_empty_styles_without_mutating_input(
    tmp_path: Path,
) -> None:
    session_factory, engine = _session_factory(tmp_path / "v3-checkpoint.sqlite")
    _seed_complete_project(session_factory, path="/legacy/V3.narrative")
    with SqlAlchemyUnitOfWork(session_factory) as uow:
        current = ProjectDocumentService().load(uow, _manifest())
    engine.dispose()

    legacy = current.model_dump(mode="json")
    legacy["document_version"] = 3
    legacy.pop("style_profiles")
    legacy.pop("scene_style_assignments")
    legacy.pop("agent_memories")
    legacy["checksum"] = project_document_checksum(legacy)
    original = deepcopy(legacy)

    migrated = parse_project_document(legacy)

    assert legacy == original
    assert migrated.document_version == 5
    assert migrated.narrative_effects == current.narrative_effects
    assert migrated.style_profiles == []
    assert migrated.scene_style_assignments == []
    assert migrated.agent_memories == []


def test_v4_checkpoint_adds_empty_memory_idempotently_and_preserves_extensions(
    tmp_path: Path,
) -> None:
    session_factory, engine = _session_factory(tmp_path / "v4-checkpoint.sqlite")
    _seed_complete_project(session_factory, path="/legacy/V4.narrative")
    with SqlAlchemyUnitOfWork(session_factory) as uow:
        current = ProjectDocumentService().load(uow, _manifest())
    engine.dispose()

    legacy = current.model_dump(mode="json")
    legacy["document_version"] = 4
    legacy.pop("agent_memories")
    legacy["project_metadata"] = {"future_extension": {"retained": True}}
    legacy["checksum"] = project_document_checksum(legacy)
    original = deepcopy(legacy)

    migrated = parse_project_document(legacy)
    reparsed = parse_project_document(migrated.model_dump(mode="json"))

    assert legacy == original
    assert migrated.document_version == 5
    assert migrated.agent_memories == []
    assert migrated.project_metadata == {"future_extension": {"retained": True}}
    assert reparsed.model_dump(mode="json") == migrated.model_dump(mode="json")


def test_document_record_contracts_cover_every_durable_entity_field() -> None:
    mappings = [
        (NodeEntity, ProjectNodeRecord),
        (EdgeEntity, ProjectEdgeRecord),
        (IssueEntity, ProjectIssueRecord),
        (SuggestionEntity, ProjectSuggestionRecord),
        (EngineTagEntity, ProjectEngineTagRecord),
        (VisualPlacementEntity, ProjectPlacementRecord),
        (StoryFlowEntity, ProjectStoryFlowRecord),
        (StoryFlowNodeEntity, ProjectStoryFlowNodeRecord),
        (FlowTransitionEntity, ProjectFlowTransitionRecord),
        (SceneFlowBoundaryEntity, ProjectSceneFlowBoundaryRecord),
        (FlowInvocationEntity, ProjectFlowInvocationRecord),
        (FlowExitEntity, ProjectFlowExitRecord),
        (FlowExitBindingEntity, ProjectFlowExitBindingRecord),
        (FlowInitialStateEntity, ProjectFlowInitialStateRecord),
        (NarrativeEffectEntity, ProjectNarrativeEffectRecord),
        (NarrativeEffectBindingEntity, ProjectNarrativeEffectBindingRecord),
        (StyleProfileEntity, StyleProfileV1),
        (SceneStyleAssignmentEntity, SceneStyleAssignmentV1),
        (AgentMemoryEntity, AgentMemoryEntryV1),
    ]

    for entity_type, record_type in mappings:
        assert {field.name for field in fields(entity_type)} == set(record_type.model_fields)


def test_document_inventory_names_every_durable_authoring_section() -> None:
    """Make adding an unreviewed durable section an explicit contract failure."""

    assert set(ProjectDocument.model_fields) == {
        "document_version",
        "checksum",
        "manifest",
        "project_metadata",
        "nodes",
        "edges",
        "issues",
        "suggestions",
        "engine_tags",
        "engine_tag_definitions",
        "engine_tag_bindings",
        "legacy_engine_tags",
        "placements",
        "dialogues",
        "quests",
        "story_flows",
        "story_flow_nodes",
        "flow_transitions",
        "scene_flow_boundaries",
        "flow_invocations",
        "flow_exits",
        "flow_exit_bindings",
        "flow_initial_states",
        "narrative_effects",
        "narrative_effect_bindings",
        "style_profiles",
        "scene_style_assignments",
        "agent_memories",
    }


def test_document_contract_excludes_transient_playback_and_ui_state() -> None:
    assert "playback_sessions" not in ProjectDocument.model_fields
    assert "selection" not in ProjectDocument.model_fields
    assert "open_dialogs" not in ProjectDocument.model_fields
    assert "search_query" not in ProjectDocument.model_fields


def replace_record(record: ProjectNodeRecord, **changes: object) -> ProjectNodeRecord:
    """Return a validated immutable-style record update for document tests."""

    return ProjectNodeRecord.model_validate({**record.model_dump(mode="python"), **changes})

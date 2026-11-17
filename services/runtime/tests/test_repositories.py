from collections.abc import Callable
from dataclasses import replace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from services.runtime.stt_runtime.db.base import Base, import_model_metadata
from services.runtime.stt_runtime.domain.entities import (
    AgentMemoryEntity,
    EdgeEntity,
    EngineTagEntity,
    IssueEntity,
    NodeEntity,
    ProjectEntity,
    SuggestionEntity,
    StyleProfileEntity,
    SceneStyleAssignmentEntity,
    VisualPlacementEntity,
)
from services.runtime.stt_runtime.repositories.interfaces import UnitOfWork
from services.runtime.stt_runtime.repositories.sqlite import EntityNotFoundError, SqlAlchemyUnitOfWork


def make_session_factory() -> Callable[[], Session]:
    import_model_metadata()
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return lambda: Session(engine)


def create_project(uow: UnitOfWork) -> ProjectEntity:
    return uow.projects.add(
        ProjectEntity(
            name="Repository Test",
            path="/tmp/RepositoryTest.narrative",
            format_version=1,
        )
    )


def test_sqlalchemy_unit_of_work_satisfies_repository_protocols() -> None:
    session_factory = make_session_factory()

    with SqlAlchemyUnitOfWork(session_factory) as uow:
        protocol_uow: UnitOfWork = uow
        project = create_project(protocol_uow)
        node = protocol_uow.nodes.add(NodeEntity(project_id=project.id, type="Scene", title="Opening"))
        second_node = protocol_uow.nodes.add(NodeEntity(project_id=project.id, type="Lore", title="Embargo"))
        edge = protocol_uow.edges.add(
            EdgeEntity(
                project_id=project.id,
                source_node_id=node.id,
                target_node_id=second_node.id,
                type="reveals",
            )
        )
        protocol_uow.issues.add(IssueEntity(project_id=project.id, node_id=node.id, title="Check voice"))
        protocol_uow.suggestions.add(
            SuggestionEntity(project_id=project.id, title="Suggested patch", patch={"operations": []})
        )
        protocol_uow.engine_tags.add(
            EngineTagEntity(
                project_id=project.id,
                target_type="node",
                target_id=node.id,
                engine="unity",
                key="guid",
                value="unity-guid",
            )
        )
        placement = protocol_uow.visual_placements.add(
            VisualPlacementEntity(
                project_id=project.id,
                canonical_node_id=node.id,
                scope_key="__root__",
                x=80,
                y=120,
                width=240,
                height=140,
                is_primary=True,
            )
        )
        style = protocol_uow.style_profiles.add(
            StyleProfileEntity(
                project_id=project.id,
                name="Repository style",
                guidance="Use precise repository prose.",
                traits={"traits_version": 1},
            )
        )
        assignment = protocol_uow.scene_style_assignments.add(
            SceneStyleAssignmentEntity(
                project_id=project.id,
                scene_node_id=node.id,
                style_profile_id=style.id,
            )
        )
        memory = protocol_uow.agent_memories.add(
            AgentMemoryEntity(
                id="memory-opening",
                project_id=project.id,
                agent_id="canon_checker",
                namespace="canon_checker",
                scope={"scope_version": 1, "kind": "scene", "scene_node_id": node.id},
                content_locale="en",
                title="Keep the opening",
                instruction="Preserve the established opening state.",
            )
        )
        protocol_uow.commit()

    with SqlAlchemyUnitOfWork(session_factory) as uow:
        assert uow.projects.get(project.id) == project
        assert [stored.title for stored in uow.nodes.list(project_id=project.id)] == ["Opening", "Embargo"]
        assert uow.edges.get(edge.id) == edge
        assert len(uow.issues.list(project_id=project.id)) == 1
        assert len(uow.suggestions.list(project_id=project.id)) == 1
        assert len(uow.engine_tags.list(project_id=project.id)) == 1
        assert uow.visual_placements.get(placement.id) == placement
        assert uow.style_profiles.get(style.id) == style
        assert uow.scene_style_assignments.get(assignment.id) == assignment
        assert uow.agent_memories.get(memory.id) == memory
        assert [
            item.id
            for item in uow.agent_memories.list_for_owner(
                project_id=project.id,
                owner_kind="scene",
                owner_id=node.id,
            )
        ] == [memory.id]


def test_agent_memory_repository_enforces_owner_duplicate_and_supersession_rules() -> None:
    session_factory = make_session_factory()
    with SqlAlchemyUnitOfWork(session_factory) as uow:
        project = create_project(uow)
        scene = uow.nodes.add(
            NodeEntity(project_id=project.id, type="Scene", title="Opening")
        )
        base = uow.agent_memories.add(
            AgentMemoryEntity(
                id="memory-base",
                project_id=project.id,
                agent_id="style_rewriter",
                namespace="style_rewriter",
                scope={"scope_version": 1, "kind": "scene", "scene_node_id": scene.id},
                content_locale="en",
                title="Short rhythm",
                instruction="Keep sentences short.",
            )
        )
        with pytest.raises(ValueError, match="identity duplicated"):
            uow.agent_memories.add(
                AgentMemoryEntity(
                    id="memory-duplicate",
                    project_id=project.id,
                    agent_id="style_rewriter",
                    namespace="style_rewriter",
                    scope=base.scope,
                    content_locale="en",
                    title=" short rhythm ",
                    instruction="Repeat the same identity.",
                )
            )
        with pytest.raises(ValueError, match="owner not found"):
            uow.agent_memories.add(
                AgentMemoryEntity(
                    id="memory-missing",
                    project_id=project.id,
                    agent_id="canon_checker",
                    namespace="canon_checker",
                    scope={"scope_version": 1, "kind": "node", "node_id": "missing"},
                    content_locale="en",
                    title="Missing",
                    instruction="Cannot resolve this owner.",
                )
            )
        uow.agent_memories.add(
            replace(
                base,
                id="memory-next",
                title="Next",
                supersedes_id=base.id,
            )
        )
        with pytest.raises(ValueError, match="supersession cycle"):
            uow.agent_memories.update(replace(base, supersedes_id="memory-next"))


def test_repository_update_and_delete_round_trip() -> None:
    session_factory = make_session_factory()

    with SqlAlchemyUnitOfWork(session_factory) as uow:
        project = create_project(uow)
        node = uow.nodes.add(NodeEntity(project_id=project.id, type="Scene", title="Opening"))
        uow.commit()

    with SqlAlchemyUnitOfWork(session_factory) as uow:
        node.title = "Opening Revised"
        assert uow.nodes.update(node).title == "Opening Revised"
        uow.nodes.delete(node.id)
        uow.commit()

    with SqlAlchemyUnitOfWork(session_factory) as uow:
        assert uow.nodes.get(node.id) is None


def test_repository_update_missing_entity_raises() -> None:
    session_factory = make_session_factory()

    with SqlAlchemyUnitOfWork(session_factory) as uow:
        missing = NodeEntity(project_id="missing-project", type="Scene", title="Missing")

        try:
            uow.nodes.update(missing)
        except EntityNotFoundError as error:
            assert missing.id in str(error)
        else:
            raise AssertionError("Expected missing entity update to fail")


def test_unit_of_work_rolls_back_when_not_committed() -> None:
    session_factory = make_session_factory()

    with SqlAlchemyUnitOfWork(session_factory) as uow:
        project = create_project(uow)

    with SqlAlchemyUnitOfWork(session_factory) as uow:
        assert uow.projects.get(project.id) is None

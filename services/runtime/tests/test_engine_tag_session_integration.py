"""Engine Tag mutations must remain atomic across history and project saves."""

from pathlib import Path

from services.runtime.stt_runtime.composition.service import CompositionService
from services.runtime.stt_runtime.domain.entities import NodeEntity, VisualPlacementEntity
from services.runtime.stt_runtime.project_fixture import import_project_fixture
from services.runtime.stt_runtime.project_session.service import ProjectSessionRegistry
from services.runtime.stt_runtime.schemas.engine_tags import (
    EngineTagMutationCommandV1,
    EngineTagOwnerV1,
)


FIXTURE = Path(__file__).parents[3] / "fixtures/projects/project-aurora.v1.json"


def test_definition_creation_records_history_and_survives_save_and_reopen(
    tmp_path: Path,
) -> None:
    """A successful response must never hide a partial registry commit."""

    project_path = tmp_path / "Aurora.narrative"
    import_project_fixture(FIXTURE, project_path)
    sessions = ProjectSessionRegistry()
    opened = sessions.open(project_path)
    session_id = opened.session.session_id
    initial_definition_ids = {
        item.id for item in opened.document.engine_tag_definitions
    }
    initial_binding_count = len(opened.document.engine_tag_bindings)
    result = sessions.apply_engine_tag_command(
        session_id,
        EngineTagMutationCommandV1(
            command_id="create-test-engine-tag",
            action="create_definition",
            expected_source_checksum=opened.document.checksum,
            expected_history_revision=0,
            key="Quest.OptionalRoute",
            description="Optional quest route",
        ),
    )

    assert result.history_revision == 1
    created = next(
        item
        for item in result.catalog.definitions
        if item.key == "Quest.OptionalRoute"
    )
    assert created.id not in initial_definition_ids
    assert len(result.catalog.definitions) == len(initial_definition_ids) + 1
    definition_id = created.id
    for index, node_id in enumerate(("node-hero", "node-dockmaster"), start=1):
        result = sessions.apply_engine_tag_command(
            session_id,
            EngineTagMutationCommandV1(
                command_id=f"bind-test-engine-tag-{index}",
                action="bind",
                expected_source_checksum=result.source_checksum,
                expected_history_revision=result.history_revision,
                definition_id=definition_id,
                owner=EngineTagOwnerV1(
                    kind="node",
                    project_id="project-aurora",
                    node_id=node_id,
                ),
            ),
        )

    assert result.history_revision == 3
    assert [item.id for item in result.catalog.bindings] == sorted(
        item.id for item in result.catalog.bindings
    )
    history = sessions.inspect_history(session_id)
    assert history.undo_depth == 3
    assert history.next_undo is not None
    assert history.next_undo.command_kind == "engine_tag_bind"

    committed_checksum = result.source_checksum
    undone = sessions.undo_history(session_id, expected_history_revision=3)
    assert len(undone.project.document.engine_tag_bindings) == initial_binding_count + 1
    assert undone.history.history_revision == 4
    redone = sessions.redo_history(session_id, expected_history_revision=4)
    assert redone.project.document.checksum == committed_checksum
    assert len(redone.project.document.engine_tag_bindings) == initial_binding_count + 2
    assert redone.history.history_revision == 5

    saved = sessions.save(
        session_id,
        expected_revision=opened.session.saved_revision,
        reason="manual",
    )
    assert saved.session.save_status == "clean"
    sessions.close(session_id)

    reopened = sessions.open(project_path)
    try:
        assert len(reopened.document.engine_tag_definitions) == len(initial_definition_ids) + 1
        assert any(
            item.id == definition_id and item.key == "Quest.OptionalRoute"
            for item in reopened.document.engine_tag_definitions
        )
        assert len(reopened.document.engine_tag_bindings) == initial_binding_count + 2
        assert [item.id for item in reopened.document.engine_tag_bindings] == sorted(
            item.id for item in reopened.document.engine_tag_bindings
        )
    finally:
        sessions.close_all()


def test_reviewed_node_deletion_removes_only_owned_bindings(tmp_path: Path) -> None:
    """Composition deletion removes direct/nested owner bindings but keeps definitions."""

    sessions = ProjectSessionRegistry()
    opened = sessions.create(tmp_path / "DeleteTaggedNode.narrative", "Delete tagged node")
    session_id = opened.session.session_id
    with sessions.authoring_unit_of_work(
        session_id, command_kind="create_node", label_key="history.command.createNode",
    ) as uow:
        uow.nodes.add(NodeEntity(
            id="node-tagged", project_id=opened.session.project_id,
            type="Character", title="Tagged character",
        ))
        uow.visual_placements.add(VisualPlacementEntity(
            id="placement-tagged", project_id=opened.session.project_id,
            canonical_node_id="node-tagged", scope_key="__root__",
            x=0, y=0, width=260, height=156, is_primary=True,
        ))
        uow.commit()
    current = sessions.inspect(session_id)
    tagged = sessions.apply_engine_tag_command(
        session_id,
        EngineTagMutationCommandV1(
            command_id="tag-node-before-delete", action="create_and_bind",
            expected_source_checksum=current.document.checksum,
            expected_history_revision=1, key="Character.Tagged",
            owner=EngineTagOwnerV1(
                kind="node", project_id=opened.session.project_id, node_id="node-tagged",
            ),
        ),
    )
    binding_id = tagged.catalog.bindings[0].id

    with sessions.authoring_unit_of_work(
        session_id, command_kind="delete_node", label_key="history.command.deleteNode",
        expected_history_revision=2,
    ) as uow:
        impact = CompositionService().deletion_impact(uow, "node-tagged")
        assert impact.engine_tag_binding_ids == [binding_id]
        CompositionService().delete_entity(uow, "node-tagged")

    deleted = sessions.inspect(session_id).document
    assert [item.key for item in deleted.engine_tag_definitions] == ["Character.Tagged"]
    assert deleted.engine_tag_bindings == []
    sessions.discard(session_id)
    sessions.close(session_id)

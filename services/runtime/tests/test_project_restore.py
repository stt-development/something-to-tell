"""Discard fast-path eligibility and unchanged-record write bounds."""

from unittest.mock import Mock

import pytest

from services.runtime.scripts.scale_fixture import document_for
from services.runtime.scripts.scale_fixture_files import load_scale_fixture
from services.runtime.stt_runtime.domain.entities import ProjectEntity
from services.runtime.stt_runtime.project_document.restore import restore_in_place, restore_history_in_place
from services.runtime.stt_runtime.project_session.documents import document_with_project_identity
from services.runtime.stt_runtime.schemas.project_document import create_project_document


@pytest.fixture(scope="module")
def target():
    return document_for(load_scale_fixture(1000))


def changed(target, mutate):
    payload = target.model_dump(mode="python", exclude={"checksum"})
    mutate(payload)
    return create_project_document(**payload)


def repository(target):
    uow = Mock()
    manifest = target.manifest
    uow.projects.get.return_value = ProjectEntity(id=manifest.project_id, name=manifest.name,
        path="/preserved/path", metadata=target.project_metadata, format_version=manifest.format_version,
        created_at=manifest.created_at, updated_at=manifest.updated_at)
    return uow


def test_thousand_node_move_and_text_restore_write_only_changed_records(target):
    def mutate(payload):
        payload["nodes"][0]["title"] = "Unsaved title"
        payload["placements"][0]["x"] += 100
    current = changed(target, mutate)
    uow = repository(target)
    assert restore_in_place(uow, current, target)
    uow.nodes.update.assert_called_once()
    uow.visual_placements.update.assert_called_once()
    uow.projects.update.assert_not_called()
    uow.nodes.add.assert_not_called()
    uow.nodes.delete.assert_not_called()
    uow.commit.assert_not_called()
    assert uow.nodes.update.call_args.args[0].title == target.nodes[0].title
    assert uow.projects.get.call_args.args[0] == target.manifest.project_id


@pytest.mark.parametrize("kind,key,collection", [("Dialogue", "dialogue_document", "dialogues"),
    ("Quest", "quest_document", "quests")])
def test_specialized_metadata_survives_node_text_restore(target, kind, key, collection):
    node = next(item for item in target.nodes if item.type == kind)
    current = changed(target, lambda p: next(item for item in p["nodes"] if item["id"] == node.id).update(title="Changed"))
    uow = repository(target)
    assert restore_in_place(uow, current, target)
    restored = uow.nodes.update.call_args.args[0]
    owned = next(item for item in getattr(target, collection) if item.node_id == node.id)
    assert restored.metadata[key] == owned.document.model_dump(mode="json")


def test_structural_fallback_happens_before_repository_access(target):
    current = changed(target, lambda p: p["edges"][0].update(label="Changed edge"))
    uow = Mock()
    assert restore_in_place(uow, current, target) is False
    assert not uow.mock_calls


def test_unchanged_discard_issues_no_writes(target):
    uow = repository(target)
    assert restore_in_place(uow, target, target)
    uow.nodes.update.assert_not_called()
    uow.visual_placements.update.assert_not_called()
    uow.projects.update.assert_not_called()


def test_invalid_target_is_rejected_before_any_repository_access(target):
    uow = Mock()
    corrupt = target.model_copy(update={"checksum": "0" * 64})
    with pytest.raises(ValueError):
        restore_in_place(uow, target, corrupt)
    assert not uow.mock_calls


def test_other_project_cannot_be_restored_in_place(target):
    other = document_with_project_identity(target, target.manifest.model_copy(update={"project_id": "another-project"}),
        target.manifest.project_id)
    uow = Mock()
    with pytest.raises(ValueError, match="restore_project_scope_mismatch"):
        restore_in_place(uow, target, other)
    assert not uow.mock_calls


@pytest.mark.parametrize("collection,key", [("dialogues", "dialogue_document"), ("quests", "quest_document")])
def test_history_restores_only_changed_specialized_owner_with_unchanged_generic_node(target, collection, key):
    def mutate(payload):
        owned = payload[collection][0]
        if collection == "dialogues":
            next(item for item in owned["document"]["elements"] if item["kind"] == "line")["text"] += " Changed."
        else:
            owned["document"]["objective"] += " Changed."
    current = changed(target, mutate)
    assert current.nodes == target.nodes
    ordinary = Mock()
    assert restore_in_place(ordinary, current, target) is False
    assert not ordinary.mock_calls
    uow = repository(target)
    assert restore_history_in_place(uow, current, target)
    uow.nodes.update.assert_called_once()
    uow.visual_placements.update.assert_not_called()
    uow.projects.update.assert_not_called()
    restored = uow.nodes.update.call_args.args[0]
    owned = getattr(target, collection)[0]
    assert restored.id == owned.node_id and restored.metadata[key] == owned.document.model_dump(mode="json")
    assert [call[0] for call in uow.mock_calls] == ["projects.get", "nodes.update"]
    uow.commit.assert_not_called()


def test_history_variant_retains_structural_fallback_and_invalid_scope_guards(target):
    cases = [changed(target, lambda p: p["edges"][0].update(label="Changed")),
             changed(target, lambda p: p["agent_memories"][0].update(title="Changed")),
             changed(target, lambda p: p["engine_tag_definitions"][0].update(description="Changed existing definition"))]
    for current in cases:
        uow = Mock()
        assert restore_history_in_place(uow, current, target) is False
        assert not uow.mock_calls
    for invalid in [target.model_copy(update={"checksum": "0" * 64}),
                    document_with_project_identity(target, target.manifest.model_copy(update={"project_id": "foreign"}), target.manifest.project_id)]:
        uow = Mock()
        with pytest.raises(ValueError):
            restore_history_in_place(uow, target, invalid)
        assert not uow.mock_calls

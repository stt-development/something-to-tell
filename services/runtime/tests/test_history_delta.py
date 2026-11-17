"""Undo/Redo delta keeps the existing transaction, complete checksum and stack owner."""

from contextlib import nullcontext
from dataclasses import replace
from unittest.mock import Mock

import pytest
from sqlalchemy import event

from services.runtime.scripts.benchmark_storage import _profile, disposable_database
from services.runtime.scripts.scale_fixture import generate_scale_fixture
from services.runtime.stt_runtime.dialogue.service import DialogueService
from services.runtime.stt_runtime.quest.service import QuestService
from services.runtime.stt_runtime.project_fixture import import_project_fixture, write_project_fixture
from services.runtime.stt_runtime.project_history.service import ProjectHistoryError
from services.runtime.stt_runtime.project_session import history_integration
from services.runtime.stt_runtime.project_session.service import ProjectSessionRegistry
from services.runtime.stt_runtime.storage_profiles import StorageProfileRegistry
from services.runtime.tests.test_project_identity import MODES


@pytest.fixture(params=MODES)
def workspace(request, tmp_path):
    with disposable_database() if request.param == "postgresql" else nullcontext(None) as url:
        source = tmp_path / "source.json"
        write_project_fixture(source, generate_scale_fixture(16))
        path = tmp_path / "History.narrative"
        import_project_fixture(source, path)
        registry = ProjectSessionRegistry(StorageProfileRegistry([_profile(url)] if url else [], master_key_file=tmp_path / "machine.key"))
        try:
            opened = registry.open(path)
            session_id = opened.session.session_id
            if url:
                registry.migrate_storage(session_id, expected_revision=opened.session.saved_revision,
                    target_mode="postgresql", target_profile_id="scale-test")
            yield registry, session_id
        finally:
            registry.close_all()
        assert not list(path.rglob("project.lock.json"))


def edit(registry, session_id, kind):
    before = registry.inspect(session_id).document
    node = next(node for node in before.nodes if node.type == kind)
    with registry.authoring_unit_of_work(session_id, command_kind="update_node", label_key="history.command.updateNode") as uow:
        if kind == "Lore":
            stored = uow.nodes.get(node.id)
            uow.nodes.update(replace(stored, body=stored.body + " Changed.")); uow.commit()
        else:
            service = DialogueService() if kind == "Dialogue" else QuestService()
            current = service.get_document(uow, node.id)
            payload = current.model_dump(mode="json")
            if kind == "Dialogue":
                next(item for item in payload["elements"] if item["kind"] == "line")["text"] += " Changed."
            else:
                payload["objective"] += " Changed."
            service.update_document(uow, node.id, type(current).model_validate(payload))
    return before, registry.inspect(session_id).document


@pytest.mark.parametrize("kind", ["Lore", "Dialogue", "Quest"])
def test_exact_round_trip_updates_one_owner_without_canonical_reinsertion(workspace, monkeypatch, kind):
    registry, session_id = workspace
    before, after = edit(registry, session_id, kind)
    assert before.checksum != after.checksum
    active = registry._sessions[session_id]
    statements = []
    def trace(_, __, sql, *___):
        statements.append(sql.lstrip().upper())
    event.listen(active.engine, "before_cursor_execute", trace)
    # An eligible undo/redo must never call the full rewrite fallback.
    monkeypatch.setattr(history_integration.ProjectDocumentService, "reconcile", Mock(side_effect=AssertionError("full rewrite")))
    saved_revision = active.state.saved_revision
    initial = registry.inspect_history(session_id)
    try:
        undone = registry.undo_history(session_id, expected_history_revision=initial.history_revision)
        assert undone.project.document.checksum == before.checksum
        assert undone.history.undo_depth == 0 and undone.history.redo_depth == 1
        redone = registry.redo_history(session_id, expected_history_revision=undone.history.history_revision)
        assert redone.project.document.checksum == after.checksum
        assert redone.history.undo_depth == 1 and redone.history.redo_depth == 0
        assert redone.project.session.saved_revision == saved_revision
        assert sum(sql.startswith("UPDATE NODES ") for sql in statements) == 2
        # Sparse legacy fixtures get initial nested tags on first aggregate edit.
        # Their own rows can change, but unrelated canonical records never reinsert.
        allowed_deletes = ("DELETE FROM ENGINE_TAG_BINDINGS ", "DELETE FROM ENGINE_TAG_DEFINITIONS ")
        allowed_inserts = ("INSERT INTO REMOTE_COMMAND_RECEIPTS ", "INSERT INTO ENGINE_TAG_BINDINGS ", "INSERT INTO ENGINE_TAG_DEFINITIONS ")
        assert all(sql.startswith(allowed_deletes) for sql in statements if sql.startswith("DELETE "))
        assert all(sql.startswith(allowed_inserts) for sql in statements if sql.startswith("INSERT "))
    finally:
        event.remove(active.engine, "before_cursor_execute", trace)


def test_failure_after_delta_write_preserves_document_stack_and_lifecycle_metadata(workspace, monkeypatch):
    registry, session_id = workspace
    _, after = edit(registry, session_id, "Dialogue")
    active = registry._sessions[session_id]
    summary = registry.inspect_history(session_id)
    manifest = (active.path / "project.config.json").read_bytes()
    original = history_integration.restore_history_in_place
    def fail(*args, **kwargs):
        assert original(*args, **kwargs)
        raise RuntimeError("injected delta write failure")
    monkeypatch.setattr(history_integration, "restore_history_in_place", fail)
    with pytest.raises(ProjectHistoryError, match="history_apply_failed"):
        registry.undo_history(session_id, expected_history_revision=summary.history_revision)
    assert registry.inspect_history(session_id) == summary
    assert registry.inspect(session_id).document.checksum == after.checksum
    assert (active.path / "project.config.json").read_bytes() == manifest


def test_unrelated_aggregate_change_keeps_full_reconciliation_fallback(workspace, monkeypatch):
    registry, session_id = workspace
    before = registry.inspect(session_id).document
    with registry.authoring_unit_of_work(session_id, command_kind="update_edge", label_key="history.command.updateEdge") as uow:
        edge = uow.edges.get(before.edges[0].id)
        uow.edges.update(replace(edge, label=edge.label + " Changed.")); uow.commit()
    original = history_integration.ProjectDocumentService.reconcile
    calls = []
    def fallback(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)
    monkeypatch.setattr(history_integration.ProjectDocumentService, "reconcile", fallback)
    result = registry.undo_history(session_id, expected_history_revision=registry.inspect_history(session_id).history_revision)
    assert result.project.document.checksum == before.checksum and calls == [1]


def test_checksum_mismatch_is_rejected_before_delta_commit(monkeypatch):
    uow = Mock()
    candidate = Mock(checksum="expected", manifest=Mock())
    monkeypatch.setattr(history_integration, "restore_history_in_place", Mock(return_value=True))
    monkeypatch.setattr(history_integration.ProjectDocumentService, "load", Mock(return_value=Mock(checksum="wrong")))
    with pytest.raises(ValueError, match="history_restore_checksum_mismatch"):
        history_integration.reconcile_history_document(uow, candidate, current=Mock())
    uow.commit.assert_not_called()

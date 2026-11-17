"""In-place Discard parity and rollback on the existing SQL repository adapters."""

from dataclasses import replace
from contextlib import nullcontext
from copy import deepcopy
from unittest.mock import Mock

import pytest
from sqlalchemy import event

from services.runtime.scripts.scale_fixture import document_for, generate_scale_fixture
from services.runtime.stt_runtime.project_document.restore import restore_in_place, restore_history_in_place
from services.runtime.stt_runtime.project_document.service import ProjectDocumentService
from services.runtime.stt_runtime.project_session.database import create_session_factory
from services.runtime.stt_runtime.repositories.sqlite import SqlAlchemyUnitOfWork
from services.runtime.tests.test_project_identity import authority, seed


@pytest.mark.parametrize("failure", [False, True])
def test_restore_checksum_and_rollback_without_reinserting(authority, monkeypatch, failure):
    engine, config = authority
    from alembic import command
    command.upgrade(config, "head")
    target = seed(engine, document_for(generate_scale_fixture(16)))
    factory = create_session_factory(engine)
    project_id = target.manifest.project_id
    node_id, placement_id = target.nodes[0].id, target.placements[0].id
    with SqlAlchemyUnitOfWork(factory, project_id=project_id) as uow:
        node = uow.nodes.get(node_id)
        placement = uow.visual_placements.get(placement_id)
        uow.nodes.update(replace(node, title="Unsaved node text"))
        uow.visual_placements.update(replace(placement, x=placement.x + 100))
        uow.commit()
    with SqlAlchemyUnitOfWork(factory, project_id=project_id) as uow:
        current = ProjectDocumentService().load(uow, target.manifest)
    assert current.checksum != target.checksum
    statements = []
    def trace(_, __, sql, *___):
        statements.append(sql.lstrip().split()[0].upper())
    event.listen(engine, "before_cursor_execute", trace)
    try:
        if failure:
            with pytest.raises(RuntimeError, match="injected placement restore failure"):
                with SqlAlchemyUnitOfWork(factory, project_id=project_id) as uow:
                    monkeypatch.setattr(uow.visual_placements, "update", Mock(side_effect=RuntimeError("injected placement restore failure")))
                    restore_in_place(uow, current, target)
        else:
            with SqlAlchemyUnitOfWork(factory, project_id=project_id) as uow:
                assert restore_in_place(uow, current, target)
                uow.commit()
        assert "DELETE" not in statements and "INSERT" not in statements
        assert statements.count("UPDATE") <= 3
        with SqlAlchemyUnitOfWork(factory, project_id=project_id) as uow:
            actual = ProjectDocumentService().load(uow, target.manifest)
        assert actual.checksum == (current.checksum if failure else target.checksum)
    finally:
        event.remove(engine, "before_cursor_execute", trace)


@pytest.mark.parametrize("kind,key", [("Dialogue", "dialogue_document"), ("Quest", "quest_document")])
@pytest.mark.parametrize("failure", [False, True])
def test_specialized_history_restore_updates_one_owner_with_full_checksum_and_rollback(authority, monkeypatch, kind, key, failure):
    engine, config = authority
    from alembic import command
    command.upgrade(config, "head")
    target = seed(engine, document_for(generate_scale_fixture(16)))
    factory = create_session_factory(engine)
    project_id = target.manifest.project_id
    node_id = next(node.id for node in target.nodes if node.type == kind)
    with SqlAlchemyUnitOfWork(factory, project_id=project_id) as uow:
        node = uow.nodes.get(node_id)
        metadata = deepcopy(node.metadata)
        if kind == "Dialogue":
            next(item for item in metadata[key]["elements"] if item["kind"] == "line")["text"] += " Changed."
        else:
            metadata[key]["objective"] += " Changed."
        uow.nodes.update(replace(node, metadata=metadata)); uow.commit()
    with SqlAlchemyUnitOfWork(factory, project_id=project_id) as uow:
        current = ProjectDocumentService().load(uow, target.manifest)
    # PostgreSQL's ordinary update policy may also advance the edited owner's
    # timestamp. Every other node and every other generic field must stay exact.
    assert current.checksum != target.checksum
    assert [node.model_copy(update={"updated_at": next(old.updated_at for old in target.nodes if old.id == node_id)})
            if node.id == node_id else node for node in current.nodes] == target.nodes
    statements = []
    def trace(_, __, sql, *___):
        statements.append(sql.lstrip().split()[0].upper())
    event.listen(engine, "before_cursor_execute", trace)
    try:
        with pytest.raises(RuntimeError, match="injected history restore") if failure else nullcontext():
            with SqlAlchemyUnitOfWork(factory, project_id=project_id) as uow:
                if failure:
                    original = uow.nodes.update
                    def fail(entity):
                        original(entity)
                        raise RuntimeError("injected history restore")
                    monkeypatch.setattr(uow.nodes, "update", fail)
                assert restore_history_in_place(uow, current, target)
                uow.commit()
        assert "DELETE" not in statements and "INSERT" not in statements
        assert statements.count("UPDATE") == 1
        with SqlAlchemyUnitOfWork(factory, project_id=project_id) as uow:
            actual = ProjectDocumentService().load(uow, target.manifest)
        assert actual.checksum == (current.checksum if failure else target.checksum)
    finally:
        event.remove(engine, "before_cursor_execute", trace)

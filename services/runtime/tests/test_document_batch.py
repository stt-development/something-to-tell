"""Document consumer keeps adapter substitution and aggregate transaction ownership."""

from uuid import uuid4
from types import SimpleNamespace

import pytest

from services.runtime.scripts.scale_fixture import document_for, generate_scale_fixture
from services.runtime.stt_runtime.domain.entities import NodeEntity, ProjectEntity
from services.runtime.stt_runtime.project_document.service import ProjectDocumentService
from services.runtime.stt_runtime.project_session.documents import document_with_project_identity
from services.runtime.stt_runtime.repositories import sqlite as adapter
from services.runtime.stt_runtime.repositories.interfaces import BatchAddRepository
from services.runtime.tests.test_repository_batch import factory  # noqa: F401


def _document():
    original = document_for(generate_scale_fixture(16))
    manifest = original.manifest.model_copy(update={"project_id": str(uuid4())})
    return document_with_project_identity(original, manifest, original.manifest.project_id)


def _root(uow, document):
    uow.projects.add(ProjectEntity(id=document.manifest.project_id, name=document.manifest.name,
                                  path="/tmp/owned-document", format_version=2))


def _same_document(actual, expected):
    before, after = expected.model_dump(mode="json"), actual.model_dump(mode="json")
    for key in [key for key in before if key != "checksum"] + ["checksum"]:
        assert after[key] == before[key], key


def _seed_ordinary(factory, document):
    """Single-add reference preserves established string timestamp normalization."""
    class Ordinary:
        def __init__(self, repository):
            self.repository = repository
        def __getattr__(self, name):
            if name == "add_many":
                raise AttributeError(name)
            return getattr(self.repository, name)
    with adapter.SqlAlchemyUnitOfWork(factory, project_id=document.manifest.project_id) as uow:
        _root(uow, document)
        for name, repository in list(vars(uow).items()):
            if not name.startswith("_") and isinstance(repository, BatchAddRepository):
                setattr(uow, name, Ordinary(repository))
        return ProjectDocumentService().reconcile(uow, document)


def test_consumer_falls_back_for_adapter_without_batch_capability():
    class Ordinary:
        def add(self, entity):
            rows.append(entity)
    rows = []
    document = _document()
    ProjectDocumentService._add_records(Ordinary(), NodeEntity, document.nodes)
    assert [row.id for row in rows] == [node.id for node in document.nodes]
    assert all(row.project_id == document.manifest.project_id for row in rows)


def test_batch_failure_is_not_replayed_through_single_adds():
    class BrokenBatch:
        def add(self, entity):
            pytest.fail("failed batch must not be replayed")
        def add_many(self, entities):
            raise RuntimeError("batch_failed")
    with pytest.raises(RuntimeError, match="batch_failed"):
        ProjectDocumentService._add_entities(BrokenBatch(), [object()])


@pytest.mark.parametrize("batch", [False, True])
def test_memory_consumer_keeps_supersession_waves_and_ordered_substitution(batch):
    base = _document().agent_memories[0]
    root = base.model_copy(update={"id": "root", "supersedes_id": None})
    child = base.model_copy(update={"id": "child", "supersedes_id": "root"})
    other = base.model_copy(update={"id": "other", "supersedes_id": None})
    calls = []
    class Ordinary:
        def add(self, entity):
            calls.append([entity.id])
    class Batch(Ordinary):
        def add_many(self, entities):
            calls.append([entity.id for entity in entities])
    repository = Batch() if batch else Ordinary()
    ProjectDocumentService._add_agent_memories(SimpleNamespace(agent_memories=repository), [child, root, other])
    assert calls == ([["other", "root"], ["child"]] if batch else [["other"], ["root"], ["child"]])


def test_complete_document_and_shared_canonical_copy_survive_batch_wiring(factory, monkeypatch):
    document = _seed_ordinary(factory, _document())
    service = ProjectDocumentService()
    original_batch, original_add = adapter.SqlAlchemyNodeRepository.add_many, adapter.SqlAlchemyNodeRepository.add
    batches, singles = [], []
    def batched(self, entities):
        batches.append([entity.type for entity in entities])
        return original_batch(self, entities)
    def single(self, entity):
        singles.append(entity.type)
        return original_add(self, entity)
    monkeypatch.setattr(adapter.SqlAlchemyNodeRepository, "add_many", batched)
    monkeypatch.setattr(adapter.SqlAlchemyNodeRepository, "add", single)
    with adapter.SqlAlchemyUnitOfWork(factory, project_id=document.manifest.project_id) as uow:
        _same_document(service.reconcile(uow, document), document)
    manifest = document.manifest.model_copy(update={"project_id": str(uuid4())})
    copied = document_with_project_identity(document, manifest, document.manifest.project_id)
    with adapter.SqlAlchemyUnitOfWork(factory, project_id=copied.manifest.project_id) as uow:
        _root(uow, copied)
        _same_document(service.reconcile(uow, copied), copied)
    assert len(batches) == 2
    assert all(set(batch) >= {"Dialogue", "Quest", "Character"} for batch in batches)
    assert not singles
    for candidate in (document, copied):
        with adapter.SqlAlchemyUnitOfWork(factory, project_id=candidate.manifest.project_id) as uow:
            _same_document(service.load(uow, candidate.manifest), candidate)


def test_later_batch_failure_rolls_back_earlier_groups_and_destructive_reconcile(factory, monkeypatch):
    document = _seed_ordinary(factory, _document())
    service = ProjectDocumentService()
    original = adapter.SqlAlchemyEdgeRepository.add_many
    def failed(self, entities):
        original(self, entities)
        raise RuntimeError("injected_after_edges")
    monkeypatch.setattr(adapter.SqlAlchemyEdgeRepository, "add_many", failed)
    with adapter.SqlAlchemyUnitOfWork(factory, project_id=document.manifest.project_id) as uow:
        with pytest.raises(RuntimeError, match="injected_after_edges"):
            service.reconcile(uow, document)
    with adapter.SqlAlchemyUnitOfWork(factory, project_id=document.manifest.project_id) as uow:
        _same_document(service.load(uow, document.manifest), document)

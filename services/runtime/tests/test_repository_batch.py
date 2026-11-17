"""Optional batch contract parity against owned SQLite/PostgreSQL databases."""

from contextlib import ExitStack
from dataclasses import replace
import os
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.exc import IntegrityError

from services.runtime.scripts.benchmark_storage import disposable_database
from services.runtime.stt_runtime.db.base import Base, import_model_metadata
from services.runtime.stt_runtime.db import models
from services.runtime.stt_runtime.db.session import create_session_factory
from services.runtime.stt_runtime.db.sqlite_policy import enable_foreign_keys
from services.runtime.stt_runtime.domain.entities import (
    AgentMemoryEntity, EdgeEntity, LegacyEngineTagEntity, NodeEntity, ProjectEntity, SuggestionEntity,
)
from services.runtime.stt_runtime.repositories import sqlite as adapter
from services.runtime.stt_runtime.repositories.interfaces import BatchAddRepository
from services.runtime.stt_runtime.repositories.project_scope import (
    ProjectScopeError, validate_entities, validate_entity,
)


@pytest.fixture(scope="module", params=["sqlite", "postgresql"])
def factory(request, tmp_path_factory):
    if request.param == "postgresql" and not os.getenv("STT_TEST_POSTGRES_URL"):
        pytest.skip("requires explicit disposable PostgreSQL test URL")
    with ExitStack() as stack:
        url = stack.enter_context(disposable_database()) if request.param == "postgresql" else (
            "sqlite:///" + str(tmp_path_factory.mktemp("batch") / "owned.sqlite"))
        engine = create_engine(url)
        stack.callback(engine.dispose)
        enable_foreign_keys(engine)
        import_model_metadata()
        Base.metadata.create_all(engine)
        yield create_session_factory(engine)


@pytest.fixture
def owners(factory):
    # Distinct roots per case, no schema reset or user-project session acquisition.
    own, foreign = str(uuid4()), str(uuid4())
    with adapter.SqlAlchemyUnitOfWork(factory) as uow:
        for identity in (own, foreign):
            uow.projects.add(ProjectEntity(id=identity, name="Batch test", path="/tmp/owned", format_version=2))
        for project, identity in ((own, "shared"), (foreign, "shared"), (foreign, "foreign-only")):
            uow.nodes.add(NodeEntity(project_id=project, id=identity, type="Character", title=identity))
        uow.commit()
    return own, foreign


def test_reviewed_fast_paths_cannot_silently_gain_custom_validation():
    for repository in adapter._BATCH_ADD_REPOSITORIES:
        for name in ("add", "_model_values", "_model_from_entity", "_entity_from_model"):
            assert getattr(repository, name) is getattr(adapter.SqlAlchemyRepository, name)
    assert adapter.SqlAlchemyAgentMemoryRepository not in adapter._BATCH_ADD_REPOSITORIES
    assert adapter.SqlAlchemyLegacyEngineTagRepository not in adapter._BATCH_ADD_REPOSITORIES


def test_batch_preserves_order_metadata_dates_and_outer_rollback(factory, owners):
    own, _ = owners
    rows = [NodeEntity(project_id=own, id=f"new-{i}", type="Lore", title=str(i),
                       metadata={"node_id": "authored metadata is opaque"}) for i in (2, 0, 1)]
    with adapter.SqlAlchemyUnitOfWork(factory, project_id=own) as uow:
        session = uow._session
        flushes, commits = [], []
        event.listen(session, "after_flush", lambda *args: flushes.append(1))
        event.listen(session, "after_commit", lambda *args: commits.append(1))
        assert isinstance(uow.nodes, BatchAddRepository)
        assert uow.nodes.add_many(rows) == rows
        assert len(flushes) == 1 and not commits
        assert [uow.nodes.get(row.id) for row in rows] == rows
        assert all(row.created_at.tzinfo is not None for row in rows)
        uow.rollback()
    with adapter.SqlAlchemyUnitOfWork(factory, project_id=own) as uow:
        assert all(uow.nodes.get(row.id) is None for row in rows)
        uow.nodes.add_many(rows)
        uow.commit()
    with adapter.SqlAlchemyUnitOfWork(factory, project_id=own) as uow:
        assert [uow.nodes.get(row.id) for row in rows] == rows


def test_empty_batch_does_not_query_or_flush(factory, owners):
    own, _ = owners
    with adapter.SqlAlchemyUnitOfWork(factory, project_id=own) as uow:
        event.listen(uow._session, "before_flush", lambda *args: pytest.fail("empty batch flushed"))
        assert uow.nodes.add_many([]) == []
        assert not uow._session.in_transaction()


def test_reference_queries_are_bounded_deduplicated_and_local_ids_win(factory, owners):
    own, _ = owners
    with adapter.SqlAlchemyUnitOfWork(factory, project_id=own) as uow:
        # More than two chunks, repeated source references and an identical
        # canonical id in the foreign copy must not cause per-row queries.
        nodes = [NodeEntity(project_id=own, id=f"many-{i}", type="Lore", title=str(i)) for i in range(805)]
        uow.nodes.add_many(nodes)
        edges = [EdgeEntity(project_id=own, source_node_id="shared", target_node_id=node.id,
                            type="relates_to") for node in nodes]
        reads, flushes = [], []
        def count(_conn, _cursor, statement, *_args):
            if statement.lstrip().upper().startswith("SELECT"):
                reads.append(1)
        engine = uow._session.get_bind()
        event.listen(engine, "before_cursor_execute", count)
        event.listen(uow._session, "after_flush", lambda *args: flushes.append(1))
        try:
            assert uow.edges.add_many(edges) == edges
        finally:
            event.remove(engine, "before_cursor_execute", count)
        assert len(reads) == 3
        assert len(flushes) == 1


@pytest.mark.parametrize("violation", ["project", "relational", "json"])
def test_whole_batch_scope_validation_precedes_any_insert(factory, owners, violation):
    own, foreign = owners
    with adapter.SqlAlchemyUnitOfWork(factory, project_id=own) as uow:
        if violation == "relational":
            repo = uow.edges
            valid = EdgeEntity(project_id=own, source_node_id="shared", target_node_id="shared", type="relates_to")
            invalid = replace(valid, id="bad-edge", target_node_id="foreign-only")
        else:
            repo = uow.nodes
            valid = NodeEntity(project_id=own, type="Lore", title="valid")
            invalid = replace(valid, id="bad-node", project_id=foreign) if violation == "project" else replace(
                valid, id="bad-node", type="Dialogue", metadata={"dialogue_document": {
                    "lines": [{"speaker_node_id": "foreign-only"}]}})
        with pytest.raises(ProjectScopeError) as error:
            repo.add_many([valid, invalid])
        assert str(error.value) == "project_scope_mismatch"
        assert not uow._session.new
        assert repo.get(valid.id) is None


@pytest.mark.parametrize("payload", [
    {"participants": ["foreign-only"]},
    {"prerequisite_node_ids": ["foreign-only"]},
    {"nested": [{"reward_node_ids": ["foreign-only"]}]},
    {"exit_node_ids": ["foreign-only"]},
    {"target_node_id": "foreign-only"},
])
def test_single_and_batch_walk_the_same_nested_reference_fields(factory, owners, payload):
    own, _ = owners
    with adapter.SqlAlchemyUnitOfWork(factory, project_id=own) as uow:
        entity = SuggestionEntity(project_id=own, title="Nested", patch=payload)
        for check in (lambda: validate_entity(uow._session, models.Suggestion, entity),
                      lambda: validate_entities(uow._session, models.Suggestion, [entity])):
            with pytest.raises(ProjectScopeError, match="^project_scope_mismatch$"):
                check()


def test_json_project_scope_and_opaque_prose_match_single_add(factory, owners):
    own, foreign = owners
    with adapter.SqlAlchemyUnitOfWork(factory, project_id=own) as uow:
        valid = SuggestionEntity(project_id=own, title="foreign-only", patch={
            "description": "foreign-only", "metadata": {"project_id": foreign, "node_id": "foreign-only"}})
        assert uow.suggestions.add_many([valid]) == [valid]
        invalid = replace(valid, id="wrong-json-project", patch={"nested": [{"project_id": foreign}]})
        with pytest.raises(ProjectScopeError):
            uow.suggestions.add_many([invalid])


def test_each_call_checks_fresh_references_without_changing_missing_id_semantics(factory, owners):
    own, foreign = owners
    with adapter.SqlAlchemyUnitOfWork(factory, project_id=own) as uow:
        candidate = SuggestionEntity(project_id=own, title="Missing JSON reference", patch={"node_id": "late"})
        assert uow.suggestions.add_many([candidate]) == [candidate]
        # Test-only foreign fixture insertion in the same connection avoids a
        # competing SQLite writer. A borrowed UoW must retain the existing scope.
        uow._session.add(models.Node(project_id=foreign, id="late", type="Lore", title="late"))
        uow._session.flush()
        with pytest.raises(ProjectScopeError):
            uow.suggestions.add_many([replace(candidate, id="second")])
        uow.nodes.add(NodeEntity(project_id=own, id="late", type="Lore", title="local copy"))
        assert uow.suggestions.add_many([replace(candidate, id="third")])[0].id == "third"


def test_database_fk_failure_keeps_outer_transaction_atomic(factory, owners):
    own, _ = owners
    with adapter.SqlAlchemyUnitOfWork(factory, project_id=own) as uow:
        uow.nodes.add_many([NodeEntity(project_id=own, id="must-roll-back", type="Lore", title="pending")])
        with pytest.raises(IntegrityError):
            uow.edges.add_many([EdgeEntity(project_id=own, source_node_id="shared", target_node_id="missing", type="relates_to")])
        uow.rollback()
    with adapter.SqlAlchemyUnitOfWork(factory, project_id=own) as uow:
        assert uow.nodes.get("must-roll-back") is None


def test_custom_subclass_uses_ordered_add_and_read_only_rules_still_apply(factory, owners):
    own, _ = owners
    class Custom(adapter.SqlAlchemyNodeRepository):
        def add(self, entity):
            calls.append(entity.id)
            return super().add(replace(entity, title="custom"))
    with adapter.SqlAlchemyUnitOfWork(factory, project_id=own) as uow:
        calls = []
        rows = [NodeEntity(project_id=own, type="Lore", title="original") for _ in range(2)]
        assert [row.title for row in Custom(uow._session).add_many(rows)] == ["custom", "custom"]
        assert calls == [row.id for row in rows]
        stamp = rows[0].created_at
        legacy = LegacyEngineTagEntity(project_id=own, id="legacy", target_type="node", target_id="shared",
            engine="generic", key="test", value="", metadata={}, created_at=stamp, updated_at=stamp)
        with pytest.raises(ValueError, match="read-only"):
            uow.legacy_engine_tags.add_many([legacy])


def test_agent_memory_batch_preserves_sequential_supersession_and_duplicate_checks(factory, owners):
    own, _ = owners
    base = AgentMemoryEntity(project_id=own, id="base", agent_id="canon_checker", namespace="canon_checker",
        scope={"scope_version": 1, "kind": "project"}, content_locale="en", title="first", instruction="Keep")
    next_memory = replace(base, id="next", title="next", supersedes_id=base.id)
    with adapter.SqlAlchemyUnitOfWork(factory, project_id=own) as uow:
        assert uow.agent_memories.add_many([base, next_memory]) == [base, next_memory]
        with pytest.raises(ValueError, match="identity duplicated"):
            uow.agent_memories.add_many([replace(base, id="duplicate")])


def test_pending_parent_flush_precedes_bulk_insert_and_no_internal_commit(factory, owners):
    own, _ = owners
    with adapter.SqlAlchemyUnitOfWork(factory, project_id=own) as uow:
        # Test the shared ORM-UoW boundary, not only already-flushed repository adds.
        uow._session.add(models.Node(project_id=own, id="pending-parent", type="Lore", title="pending"))
        row = EdgeEntity(project_id=own, source_node_id="shared", target_node_id="pending-parent", type="relates_to")
        commits = []
        event.listen(uow._session, "after_commit", lambda *args: commits.append(1))
        assert uow.edges.add_many([row]) == [row]
        assert not commits
        uow.rollback()
    with adapter.SqlAlchemyUnitOfWork(factory, project_id=own) as uow:
        assert uow.nodes.get("pending-parent") is None and uow.edges.get(row.id) is None


def test_return_correlation_uses_project_relative_not_bare_canonical_id(factory, owners):
    own, foreign = owners
    rows = [NodeEntity(project_id=identity, id="same-batch-id", type="Lore", title=identity)
            for identity in (foreign, own)]
    # Explicit provisioning/legacy UoW can insert multiple project roots. Its
    # returned records must still be correctly correlated, never merged by id.
    with adapter.SqlAlchemyUnitOfWork(factory) as uow:
        assert uow.nodes.add_many(rows) == rows


def _planned_dialogue(project_id):
    return NodeEntity(project_id=project_id, id="planned-dialogue", type="Dialogue", title="Local dialogue",
        metadata={"dialogue_document": {"participants": ["foreign-only"],
            "elements": [{"speaker_node_id": "foreign-only", "project_id": project_id}]}})


def test_node_json_can_reference_local_owner_in_same_atomic_group(factory, owners):
    own, _ = owners
    dialogue = _planned_dialogue(own)
    character = NodeEntity(project_id=own, id="foreign-only", type="Character", title="New local copy")
    with adapter.SqlAlchemyUnitOfWork(factory, project_id=own) as uow:
        # Forward reference plus an identical foreign canonical id. The whole
        # scope-validated group inserts together, so this is a proven local owner.
        assert uow.nodes.add_many([dialogue, character]) == [dialogue, character]
        assert uow.nodes.get(character.id).project_id == own
        assert uow.nodes.get(dialogue.id).metadata == dialogue.metadata


def test_foreign_planned_owner_never_qualifies_as_local_or_inserts_partial_group(factory, owners):
    own, foreign = owners
    with adapter.SqlAlchemyUnitOfWork(factory, project_id=own) as uow:
        with pytest.raises(ProjectScopeError):
            uow.nodes.add_many([_planned_dialogue(own),
                NodeEntity(project_id=foreign, id="foreign-only", type="Character", title="Still foreign")])
        assert not uow._session.new
        assert uow.nodes.get("planned-dialogue") is None


def test_failed_node_group_rolls_back_promised_owner_and_preserves_foreign_copy(factory, owners):
    own, foreign = owners
    with adapter.SqlAlchemyUnitOfWork(factory, project_id=own) as uow:
        with pytest.raises(IntegrityError):
            uow.nodes.add_many([_planned_dialogue(own),
                NodeEntity(project_id=own, id="foreign-only", type="Character", title="Planned local"),
                NodeEntity(project_id=own, id="shared", type="Lore", title="Duplicate must not overwrite")])
        uow.rollback()
        assert uow.nodes.get("planned-dialogue") is None and uow.nodes.get("foreign-only") is None
        assert uow.nodes.get("shared").title == "shared"
        # Another call cannot reuse the rolled-back owner's promise.
        with pytest.raises(ProjectScopeError):
            uow.nodes.add_many([_planned_dialogue(own)])
    with adapter.SqlAlchemyUnitOfWork(factory, project_id=foreign) as uow:
        assert uow.nodes.get("foreign-only").title == "foreign-only"

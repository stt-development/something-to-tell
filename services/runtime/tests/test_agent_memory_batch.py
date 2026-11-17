"""Custom memory batching must preserve every single-add rule in both dialects."""

from dataclasses import replace

import pytest
from sqlalchemy import event
from sqlalchemy.exc import IntegrityError

from services.runtime.stt_runtime.domain.entities import AgentMemoryEntity, NodeEntity, StoryFlowEntity
from services.runtime.stt_runtime.repositories import sqlite as adapter
from services.runtime.stt_runtime.repositories.project_scope import ProjectScopeError
from services.runtime.tests.test_repository_batch import factory, owners  # noqa: F401


def memory(project_id, **values):
    return AgentMemoryEntity(**{**dict(id="memory", project_id=project_id,
        agent_id="canon_checker", namespace="canon_checker", content_locale="en",
        scope={"scope_version": 1, "kind": "node", "node_id": "shared"},
        title="Reviewed", instruction="Preserve authored intent"), **values})


def test_custom_batch_has_bounded_reads_one_flush_and_outer_rollback(factory, owners):
    own, _ = owners
    rows = [memory(own, id=f"memory-{index}", title=f"Identity {index}") for index in range(80)]
    with adapter.SqlAlchemyUnitOfWork(factory, project_id=own) as uow:
        reads, flushes, commits = [], [], []
        engine = uow._session.get_bind()
        def count(_conn, _cursor, statement, *_args):
            if statement.lstrip().upper().startswith("SELECT"):
                reads.append(1)
        event.listen(engine, "before_cursor_execute", count)
        event.listen(uow._session, "after_flush", lambda *args: flushes.append(1))
        event.listen(uow._session, "after_commit", lambda *args: commits.append(1))
        try:
            assert uow.agent_memories.add_many(rows) == rows
        finally:
            event.remove(engine, "before_cursor_execute", count)
        assert len(reads) <= 4
        assert flushes == [1] and not commits
        uow.rollback()
    with adapter.SqlAlchemyUnitOfWork(factory, project_id=own) as uow:
        assert not uow.agent_memories.list(project_id=own)
        assert uow.agent_memories.add_many(rows) == rows
        uow.commit()
    with adapter.SqlAlchemyUnitOfWork(factory, project_id=own) as uow:
        assert [uow.agent_memories.get(row.id) for row in rows] == rows


@pytest.mark.parametrize("violation", ["foreign_project", "foreign_node", "missing_node", "scene_type",
    "dialogue_type", "missing_flow", "duplicate", "locale", "agent", "cycle", "missing_superseded"])
def test_group_validation_preserves_single_add_failures_without_partial_insert(factory, owners, violation):
    own, foreign = owners
    first = memory(own)
    invalid = replace(first, id="invalid", title="Different")
    if violation == "foreign_project":
        invalid = replace(invalid, project_id=foreign)
    elif violation in {"foreign_node", "missing_node", "scene_type", "dialogue_type"}:
        kind = {"scene_type": "scene", "dialogue_type": "dialogue_field"}.get(violation, "node")
        node_id = {"foreign_node": "foreign-only", "missing_node": "absent"}.get(violation, "shared")
        invalid = replace(invalid, scope={"scope_version": 1, "kind": kind,
            "scene_node_id" if kind == "scene" else "node_id": node_id})
    elif violation == "missing_flow":
        invalid = replace(invalid, scope={"scope_version": 1, "kind": "story_flow", "flow_id": "absent"})
    elif violation == "duplicate":
        invalid = replace(invalid, title="  REVIEWED  ")
    elif violation in {"locale", "agent", "missing_superseded"}:
        invalid = replace(invalid, supersedes_id="absent" if violation == "missing_superseded" else first.id,
            **({"content_locale": "ru"} if violation == "locale" else
               {"agent_id": "impact_analyzer"} if violation == "agent" else {}))
    elif violation == "cycle":
        invalid = replace(invalid, supersedes_id=invalid.id)
    with adapter.SqlAlchemyUnitOfWork(factory, project_id=own) as uow:
        with pytest.raises((ValueError, ProjectScopeError)):
            uow.agent_memories.add_many([first, invalid])
        assert not uow._session.new
        assert uow.agent_memories.list(project_id=own) == []
        # Single-add reference must reject for the same reason, not just the batch.
        uow.agent_memories.add(first)
        with pytest.raises((ValueError, ProjectScopeError)):
            uow.agent_memories.add(invalid)


def test_scope_checks_see_fresh_typed_local_owners_and_shared_foreign_ids(factory, owners):
    own, _ = owners
    with adapter.SqlAlchemyUnitOfWork(factory, project_id=own) as uow:
        scene = uow.nodes.add(NodeEntity(project_id=own, id="scene", type="Scene", title="Scene"))
        dialogue = uow.nodes.add(NodeEntity(project_id=own, id="dialogue", type="Dialogue", title="Dialogue"))
        flow = uow.story_flows.add(StoryFlowEntity(project_id=own, id="flow", name="Flow", normalized_name="flow"))
        rows = [memory(own, id=kind, title=kind, scope={"scope_version": 1, "kind": kind, **data})
            for kind, data in (("node", {"node_id": "shared"}), ("scene", {"scene_node_id": scene.id}),
                ("dialogue_field", {"node_id": dialogue.id}), ("story_flow", {"flow_id": flow.id}), ("project", {}))]
        assert uow.agent_memories.add_many(rows) == rows
        uow.nodes.delete(scene.id)
        with pytest.raises(ValueError, match="owner not found"):
            uow.agent_memories.add_many([replace(rows[1], id="after-delete", title="New")])


def test_chain_order_custom_fallback_and_empty_group_keep_existing_contract(factory, owners):
    own, _ = owners
    with adapter.SqlAlchemyUnitOfWork(factory, project_id=own) as uow:
        assert uow.agent_memories.add_many([]) == []
        assert not uow._session.in_transaction()
        base = memory(own, status="archived")
        successor = replace(base, id="next", title="Successor", status="active", supersedes_id=base.id)
        assert uow.agent_memories.add_many([base, successor]) == [base, successor]
        calls = []
        class Custom(adapter.SqlAlchemyAgentMemoryRepository):
            def add(self, row):
                calls.append(row.id)
                return super().add(replace(row, instruction="Custom validated"))
        row = memory(own, id="custom", title="Custom")
        assert Custom(uow._session).add_many([row])[0].instruction == "Custom validated"
        assert calls == [row.id]


def test_database_failure_rolls_back_the_whole_group_and_prior_writes(factory, owners):
    own, _ = owners
    with adapter.SqlAlchemyUnitOfWork(factory, project_id=own) as uow:
        uow.nodes.add(NodeEntity(project_id=own, id="rollback-node", type="Lore", title="Pending"))
        with pytest.raises(IntegrityError):
            uow.agent_memories.add_many([memory(own), memory(own, title="Same id but distinct identity")])
        uow.rollback()
    with adapter.SqlAlchemyUnitOfWork(factory, project_id=own) as uow:
        assert uow.nodes.get("rollback-node") is None
        assert not uow.agent_memories.list(project_id=own)


def test_owner_queries_remain_chunked_below_sqlite_bind_ceiling(factory, owners):
    own, _ = owners
    with adapter.SqlAlchemyUnitOfWork(factory, project_id=own) as uow:
        nodes = [NodeEntity(project_id=own, id=f"owner-{index}", type="Lore", title="Owner") for index in range(405)]
        uow.nodes.add_many(nodes)
        rows = [memory(own, id=f"chunk-{index}", scope={"scope_version": 1, "kind": "node", "node_id": node.id})
            for index, node in enumerate(nodes)]
        reads = []
        engine = uow._session.get_bind()
        def count(_conn, _cursor, statement, *_args):
            if statement.lstrip().upper().startswith("SELECT"):
                reads.append(1)
        event.listen(engine, "before_cursor_execute", count)
        try:
            assert uow.agent_memories.add_many(rows) == rows
        finally:
            event.remove(engine, "before_cursor_execute", count)
        assert len(reads) <= 6

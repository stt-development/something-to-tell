"""Selected-session isolation against two full projects in one SQL authority.

PostgreSQL uses a fresh random database, never the configured schema. SQLite
executes the same repository/HTTP contract without a network dependency.
"""

from contextlib import ExitStack
from dataclasses import replace
import os
import re

from services.runtime.tests.remote_support import GuardedTestClient as TestClient
import pytest
from sqlalchemy.exc import IntegrityError

from services.runtime.scripts.benchmark_storage import disposable_database, _profile
from services.runtime.scripts.scale_fixture import _identifiers, _rebind, document_for, generate_scale_fixture
from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.domain.entities import IssueEntity, ProjectEntity, SuggestionEntity
from services.runtime.stt_runtime.project_document.service import ProjectDocumentService
from services.runtime.stt_runtime.project_fixture import import_project_fixture, write_project_fixture
from services.runtime.stt_runtime.repositories.project_scope import ProjectScopeError
from services.runtime.stt_runtime.repositories.sqlite import EntityNotFoundError, SqlAlchemyUnitOfWork
from services.runtime.stt_runtime.schemas.project_document import create_project_document
from services.runtime.stt_runtime.storage_profiles import StorageProfileRegistry

MODES = ["sqlite"] + (["postgresql"] if os.getenv("STT_TEST_POSTGRES_URL") else [])
REPOSITORIES = (
    "nodes", "edges", "issues", "suggestions", "impact_resolution_decisions",
    "engine_tags", "engine_tag_definitions", "engine_tag_bindings", "legacy_engine_tags",
    "visual_placements", "story_flows", "story_flow_nodes", "flow_transitions",
    "scene_flow_boundaries", "flow_invocations", "flow_exits", "flow_exit_bindings",
    "flow_initial_states", "narrative_effects", "narrative_effect_bindings",
    "style_profiles", "scene_style_assignments", "agent_memories",
)


@pytest.fixture(scope="module", params=MODES)
def shared_projects(request, tmp_path_factory):
    folder = tmp_path_factory.mktemp("project-scope")
    fixture = generate_scale_fixture(16)
    source = folder / "source.json"
    write_project_fixture(source, fixture)
    path = folder / "A.narrative"
    import_project_fixture(source, path)
    with ExitStack() as stack:
        url = stack.enter_context(disposable_database()) if request.param == "postgresql" else None
        app = create_app()
        client = stack.enter_context(TestClient(app))
        registry = app.state.project_sessions
        opened = registry.open(path)
        session_id = opened.session.session_id
        if url is not None:
            registry._storage_profiles = StorageProfileRegistry([_profile(url)])
            registry.migrate_storage(session_id, expected_revision=opened.session.saved_revision,
                                     target_mode="postgresql", target_profile_id="scale-test")
        active = registry._sessions[session_id]
        factory = active.session_factory
        own = registry.inspect(session_id).document
        raw = document_for(fixture).model_dump(mode="json", exclude={"checksum"})
        identifiers = set(_identifiers(raw)) | {own.manifest.project_id}
        identities = {identity: "foreign-" + identity for identity in identifiers}
        tokens = re.compile("|".join(re.escape(identity) for identity in sorted(identifiers, key=len, reverse=True)))
        foreign_payload = _rebind(raw, identities, tokens)
        foreign_payload["nodes"][0]["title"] = "Confidential foreign title"
        foreign = create_project_document(**foreign_payload)
        with SqlAlchemyUnitOfWork(factory) as uow:
            uow.projects.add(ProjectEntity(id=foreign.manifest.project_id, name="Private foreign project",
                path=str(folder / "B.narrative"), format_version=2))
            foreign = ProjectDocumentService().reconcile(uow, foreign)
        yield client, registry, session_id, factory, own, foreign
        registry.close_all()
    assert not list(folder.rglob("project.lock.json"))


@pytest.mark.parametrize("name", REPOSITORIES)
def test_every_repository_rejects_scope_override_and_hides_foreign_objects(shared_projects, name):
    _, _, _, factory, own, foreign = shared_projects
    project_id = own.manifest.project_id
    with SqlAlchemyUnitOfWork(factory) as unbound:
        records = getattr(unbound, name).list(project_id=foreign.manifest.project_id)
    with SqlAlchemyUnitOfWork(factory, project_id=project_id) as uow:
        repository = getattr(uow, name)
        with pytest.raises(ProjectScopeError):
            repository.list(project_id=foreign.manifest.project_id)
        for record in records:
            assert repository.get(record.id) is None
            if name != "legacy_engine_tags":
                with pytest.raises(EntityNotFoundError):
                    repository.update(replace(record, project_id=project_id))
                repository.delete(record.id)
                with pytest.raises(ProjectScopeError):
                    repository.add(record)
        assert all(record.project_id == project_id for record in repository.list(project_id=project_id))
    with SqlAlchemyUnitOfWork(factory) as unbound:
        assert getattr(unbound, name).list(project_id=foreign.manifest.project_id) == records


def test_project_root_and_specialized_lookups_cannot_escape_scope(shared_projects):
    _, _, _, factory, own, foreign = shared_projects
    member = foreign.story_flow_nodes[0]
    boundary = foreign.scene_flow_boundaries[0]
    with SqlAlchemyUnitOfWork(factory, project_id=own.manifest.project_id) as uow:
        assert uow.projects.get(foreign.manifest.project_id) is None
        assert [item.id for item in uow.projects.list()] == [own.manifest.project_id]
        assert uow.story_flow_nodes.get_for_node(flow_id=member.flow_id, node_id=member.node_id) is None
        assert uow.scene_flow_boundaries.get_for_scene(
            flow_id=boundary.flow_id, scene_node_id=boundary.scene_node_id) is None
        transition = foreign.flow_transitions[0]
        with pytest.raises(ProjectScopeError):
            uow.flow_transitions.reorder(flow_id=transition.flow_id, source_node_id=transition.source_node_id,
                                        transition_ids=[transition.id])


def test_foreign_references_and_ownership_transfers_fail_before_flush(shared_projects):
    _, _, _, factory, own, foreign = shared_projects
    with SqlAlchemyUnitOfWork(factory) as unbound:
        edge = unbound.edges.get(own.edges[0].id)
        node = unbound.nodes.get(own.nodes[0].id)
        binding = unbound.engine_tag_bindings.get(own.engine_tag_bindings[0].id)
    with SqlAlchemyUnitOfWork(factory, project_id=own.manifest.project_id) as uow:
        for candidate, repository in (
            (replace(node, project_id=foreign.manifest.project_id), uow.nodes),
            (replace(edge, source_node_id=foreign.nodes[0].id), uow.edges),
            (replace(binding, owner={"kind": "node", "project_id": own.manifest.project_id,
                                    "node_id": foreign.nodes[0].id}), uow.engine_tag_bindings),
        ):
            with pytest.raises(ProjectScopeError):
                repository.update(candidate)
        with pytest.raises(ProjectScopeError):
            uow.suggestions.add(SuggestionEntity(project_id=own.manifest.project_id, title="Untrusted patch",
                patch={"operations": [{"op": "update_node", "node_id": foreign.nodes[0].id,
                                        "updates": {"title": "Wrong"}}]}))
        # P9-003 permits the same canonical id when this project owns the row.
        duplicate_id = uow.nodes.add(replace(node, id=foreign.nodes[0].id))
        assert duplicate_id.project_id == own.manifest.project_id
        accepted = uow.suggestions.add(SuggestionEntity(project_id=own.manifest.project_id,
            title="Authored metadata is not authority", patch={"operations": [],
                "metadata": {"project_id": foreign.manifest.project_id}}))
        assert accepted.project_id == own.manifest.project_id


def test_relational_reference_inventory_cannot_cross_projects(shared_projects):
    _, _, _, factory, own, foreign = shared_projects
    checked = 0
    with SqlAlchemyUnitOfWork(factory) as unbound, SqlAlchemyUnitOfWork(
        factory, project_id=own.manifest.project_id
    ) as scoped:
        by_table = {getattr(unbound, name)._model_type.__table__.name: getattr(unbound, name)
                    for name in REPOSITORIES}
        for name in REPOSITORIES:
            if name == "legacy_engine_tags":
                continue
            repository = getattr(scoped, name)
            records = repository.list(project_id=own.manifest.project_id)
            if not records:
                continue
            for fk in repository._model_type.__table__.foreign_keys:
                if fk.column.name != "id":
                    continue
                target = by_table.get(fk.column.table.name)
                if target is None:
                    continue
                foreign_records = target.list(project_id=foreign.manifest.project_id)
                if foreign_records:
                    with pytest.raises(ProjectScopeError):
                        repository.update(replace(records[0], **{fk.parent.key: foreign_records[0].id}))
                    checked += 1
    assert checked >= 25


@pytest.mark.parametrize("dependency", ["direct", "indirect"])
def test_database_rejects_cross_project_cascade_sources(shared_projects, dependency):
    _, _, _, factory, own, foreign = shared_projects
    with SqlAlchemyUnitOfWork(factory) as unbound:
        template = unbound.edges.get(foreign.edges[0].id)
        target = own.edges[0].source_node_id
        invalid = replace(template, id="legacy-cross-project-edge", source_node_id=target)
        if dependency == "indirect":
            invalid = IssueEntity(id="legacy-cross-project-issue", project_id=foreign.manifest.project_id,
                                  title="Legacy reference", edge_id=own.edges[0].id)
        repository = "edges" if dependency == "direct" else "issues"
        with pytest.raises(IntegrityError):
            getattr(unbound, repository).add(invalid)
        unbound.rollback()
    with SqlAlchemyUnitOfWork(factory, project_id=own.manifest.project_id) as scoped:
        assert scoped.nodes.get(target) is not None


def test_selected_http_routes_preserve_documents_and_history_after_denial(shared_projects):
    client, registry, session_id, factory, own, foreign = shared_projects
    headers = {"X-Project-Session-Id": session_id}
    before = registry.inspect(session_id)
    history = registry.inspect_history(session_id)
    foreign_character = next(node for node in foreign.nodes if node.type == "Character")
    own_dialogue = own.dialogues[0]
    own_quest = own.quests[0]
    placement = own.placements[0]
    placement_update = {
        "project_id": own.manifest.project_id, "placement_id": placement.id,
        "container_node_id": placement.container_node_id,
        "position": {"x": placement.x + 30, "y": placement.y + 30},
        "size": {"width": placement.width, "height": placement.height},
        "is_primary": placement.is_primary,
    }
    requests = [
        ("get", f"/api/nodes/{foreign.nodes[0].id}", None),
        ("get", f"/api/edges/{foreign.edges[0].id}", None),
        ("get", f"/api/issues/{foreign.issues[0].id}", None),
        ("get", f"/api/dialogues/{foreign.dialogues[0].node_id}", None),
        ("get", f"/api/quests/{foreign.quests[0].node_id}", None),
        ("get", f"/api/nodes?project_id={foreign.manifest.project_id}", None),
        ("get", f"/api/projects/{foreign.manifest.project_id}", None),
        ("delete", f"/api/nodes/{foreign.nodes[0].id}", None),
        ("post", "/api/nodes", {"project_id": foreign.manifest.project_id, "type": "Lore", "title": "Wrong"}),
        ("put", f"/api/nodes/{own.nodes[0].id}", {
            **own.nodes[0].model_dump(mode="json", exclude={"id", "created_at", "updated_at"}),
            "project_id": foreign.manifest.project_id}),
        ("put", f"/api/dialogues/{own_dialogue.node_id}", {
            **own_dialogue.document.model_dump(mode="json"), "participants": [foreign_character.id]}),
        ("put", f"/api/quests/{own_quest.node_id}", {
            **own_quest.document.model_dump(mode="json"), "quest_giver_node_id": foreign_character.id}),
        ("put", "/api/compositions/placements", {"project_id": own.manifest.project_id,
            "placements": [placement_update, {**placement_update, "placement_id": foreign.placements[0].id}]}),
        ("delete", f"/api/projects/{own.manifest.project_id}", None),
    ]
    for method, url, payload in requests:
        response = client.request(method, url, headers=headers, json=payload)
        assert 400 <= response.status_code < 500, (url, response.text)
        assert "Private foreign project" not in response.text
        assert "Confidential foreign title" not in response.text
        assert registry.inspect(session_id) == before
        assert registry.inspect_history(session_id) == history
    with SqlAlchemyUnitOfWork(factory) as uow:
        assert ProjectDocumentService().load(uow, foreign.manifest).checksum == foreign.checksum
    # Session captures and export plans must contain only the selected document.
    captured = registry.capture_canon_input(session_id)
    assert captured.project_id == own.manifest.project_id
    assert not any(node.id.startswith("foreign-") for node in captured.document.nodes)
    response = client.post(f"/api/exports/{session_id}/plans", json={"options": {
        "format": "json", "scope": "whole_project", "engine_tag_target": "generic"}})
    assert response.status_code == 200, response.text
    assert "foreign-s0000" not in response.json()["preview"]["text"]
    assert registry.inspect_history(session_id) == history


def test_session_authoring_and_history_preserve_neighbour(shared_projects):
    client, registry, session_id, factory, own, foreign = shared_projects
    headers = {"X-Project-Session-Id": session_id}
    before = registry.inspect(session_id).document
    target = next(node for node in before.nodes if node.type == "Lore")
    payload = target.model_dump(mode="json", exclude={"id", "created_at", "updated_at"})
    payload["title"] = "Scoped title change"
    response = client.put(f"/api/nodes/{target.id}", headers=headers, json=payload)
    assert response.status_code == 200, response.text
    changed = registry.inspect(session_id).document
    assert changed.checksum != before.checksum
    registry.undo_history(session_id, expected_history_revision=registry.inspect_history(session_id).history_revision)
    assert registry.inspect(session_id).document.checksum == before.checksum
    registry.redo_history(session_id, expected_history_revision=registry.inspect_history(session_id).history_revision)
    assert registry.inspect(session_id).document.checksum == changed.checksum
    with SqlAlchemyUnitOfWork(factory) as uow:
        assert ProjectDocumentService().load(uow, foreign.manifest).checksum == foreign.checksum


@pytest.mark.parametrize("reference", ["foreign", "missing"])
def test_raw_nested_metadata_is_validated_before_commit_without_history(shared_projects, reference):
    _, registry, session_id, _, _, foreign = shared_projects
    before = registry.inspect(session_id)
    history = registry.inspect_history(session_id)
    with pytest.raises(ProjectScopeError):
        with registry.authoring_unit_of_work(session_id, command_kind="update_node",
                label_key="history.command.updateNode") as uow:
            node = uow.nodes.get(before.document.dialogues[0].node_id)
            document = dict(node.metadata["dialogue_document"])
            target = next(item.id for item in foreign.nodes if item.type == "Character")
            document["participants"] = [*document["participants"], target if reference == "foreign" else "missing-character"]
            uow.nodes.update(replace(node, metadata={**node.metadata, "dialogue_document": document}))
            uow.commit()
    assert registry.inspect(session_id) == before
    assert registry.inspect_history(session_id) == history

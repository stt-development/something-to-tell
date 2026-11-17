"""Same-call publication handoff keeps fresh request/checkpoint and lease owners."""

import os
from pathlib import Path
from unittest.mock import patch

import pytest
from sqlalchemy import update

from services.runtime.scripts.benchmark_storage import _profile, disposable_database
from services.runtime.scripts.prepare_frontend_baseline import prepare
from services.runtime.stt_runtime.db.remote_ownership import checkpoints
from services.runtime.stt_runtime.project_document.service import ProjectDocumentService
from services.runtime.stt_runtime.project_session import remote_files, remote_store
from services.runtime.stt_runtime.project_session.errors import ProjectSessionError
from services.runtime.stt_runtime.project_session.service import ProjectSessionRegistry
from services.runtime.stt_runtime.storage_profiles import StorageProfileRegistry


@pytest.fixture(scope="module")
def workspace(tmp_path_factory):
    if not os.environ.get("STT_TEST_POSTGRES_URL"):
        pytest.skip("requires explicit disposable PostgreSQL test URL")
    root = tmp_path_factory.mktemp("publication-capture")
    fixture = prepare(root / "fixture", "small")
    path = Path(fixture["path"]).resolve()
    with disposable_database() as url:
        registry = ProjectSessionRegistry(StorageProfileRegistry([_profile(url)], master_key_file=root / "machine.key"))
        try:
            opened = registry.open(path)
            registry.migrate_storage(opened.session.session_id, expected_revision=opened.session.saved_revision,
                target_mode="postgresql", target_profile_id="scale-test")
            yield registry, path
        finally:
            # This registry owns only this generated project, including any test
            # that intentionally models shutdown while server work is unsaved.
            registry.close_all()
    assert not list(root.rglob("project.lock.json"))


def _active(workspace):
    registry, path = workspace
    return registry._sessions[registry._paths[path]]


def test_existing_remote_open_uses_one_complete_capture(workspace):
    registry, path = workspace
    expected = registry.inspect(_active(workspace).state.session_id)
    registry.close(expected.session.session_id)
    calls = []
    original = ProjectDocumentService.load
    def counted(self, *args, **kwargs):
        calls.append(1)
        return original(self, *args, **kwargs)
    with patch.object(ProjectDocumentService, "load", counted):
        opened = registry.open(path)
    assert len(calls) == 1
    assert opened.document == expected.document
    assert opened.session.saved_revision == expected.session.saved_revision
    assert opened.session.save_status == "clean"


def test_publication_reuses_only_provided_factory_bound_pair_without_canonical_writes(workspace):
    active = _active(workspace)
    document, row = remote_store.capture(active.session_factory, active.manifest.project_id)
    before = remote_store.head_dto(row)
    with patch.object(remote_files, "capture", side_effect=AssertionError("redundant capture")):
        assert remote_files.publish_local(active, captured=(active.session_factory, document, row)) == document
    with active.engine.connect() as connection:
        after = remote_store.head_dto(remote_store.row_for(connection, active.manifest.project_id))
    assert after == before
    assert active.saved_checksum == row["_saved_checksum"]
    assert remote_files.read_binding(active.path, active.manifest.project_id)["observed_revision"] == before.authoring_revision


@pytest.mark.parametrize("invalid", ["factory", "document_project", "row_project", "checksum"])
def test_invalid_handoff_fails_before_checkpoint_reads_or_file_writes(workspace, invalid):
    active = _active(workspace)
    document, row = remote_store.capture(active.session_factory, active.manifest.project_id)
    factory = active.session_factory
    if invalid == "factory":
        factory = object()
    elif invalid == "document_project":
        document = document.model_copy(update={"manifest": document.manifest.model_copy(update={"project_id": "foreign"})})
    else:
        row = {**row, "project_id" if invalid == "row_project" else "checksum": "foreign"}
    with patch.object(remote_files, "saved_document", side_effect=AssertionError("invalid handoff read checkpoint")), \
            patch.object(remote_files, "atomic_json", side_effect=AssertionError("invalid handoff wrote files")):
        with pytest.raises(ProjectSessionError) as error:
            remote_files.publish_local(active, captured=(factory, document, row))
    assert error.value.code == "remote_contract_invalid"


def test_next_publication_without_handoff_still_captures_fresh(workspace):
    active = _active(workspace)
    original = remote_files.capture
    with patch.object(remote_files, "capture", wraps=original) as captured:
        result = remote_files.publish_local(active)
    assert captured.call_count == 1
    assert result.checksum == active.remote_head.document_checksum


def test_server_saved_checkpoint_is_still_fully_validated(workspace):
    active = _active(workspace)
    document, row = remote_store.capture(active.session_factory, active.manifest.project_id)
    with active.engine.connect() as connection:
        saved = remote_store.saved_document(connection, active.manifest.project_id, row)
    predicate = (checkpoints.c.project_id == active.manifest.project_id,
        checkpoints.c.storage_generation == row["storage_generation"], checkpoints.c.saved_revision == row["saved_revision"])
    payload = saved.model_dump(mode="json")
    try:
        with active.engine.begin() as connection:
            connection.execute(update(checkpoints).where(*predicate).values(document={**payload, "checksum": "0" * 64}))
        with patch.object(remote_files, "atomic_json", side_effect=AssertionError("invalid checkpoint wrote files")):
            with pytest.raises(ValueError):
                remote_files.publish_local(active, captured=(active.session_factory, document, row))
    finally:
        # Test-only corruption is confined to one owned row and restored exactly.
        with active.engine.begin() as connection:
            connection.execute(update(checkpoints).where(*predicate).values(document=payload))


def test_dirty_server_open_does_not_become_clean_from_reused_capture(workspace):
    from dataclasses import replace
    registry, path = workspace
    active = _active(workspace)
    sid = active.state.session_id
    before = registry.inspect(sid)
    target = before.document.nodes[0]
    with registry.authoring_unit_of_work(sid, command_kind="update_node", label_key="history.command.updateNode") as uow:
        node = uow.nodes.get(target.id)
        uow.nodes.update(replace(node, summary=node.summary + " Unsaved owned check."))
        uow.commit()
    changed = registry.inspect(sid)
    registry.close_all()
    try:
        reopened = registry.open(path)
        assert reopened.document.checksum == changed.document.checksum != before.document.checksum
        assert reopened.session.save_status == "dirty"
        assert reopened.session.saved_revision == before.session.saved_revision
    finally:
        registry.discard(_active(workspace).state.session_id)

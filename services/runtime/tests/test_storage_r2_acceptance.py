"""R2 public ASGI/HTTP contract on pinned1000 in owned SQLite/PostgreSQL only."""

from contextlib import ExitStack
import os
from pathlib import Path

import pytest

from services.runtime.scripts.benchmark_storage import _profile, disposable_database
from services.runtime.scripts.prepare_frontend_baseline import prepare
from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.core.config import RuntimeSettings
from services.runtime.stt_runtime.schemas.project_session import ProjectSessionResponse
from services.runtime.stt_runtime.schemas.resources import NodeResponse, NodeUpdate
from services.runtime.stt_runtime.storage_profiles import StorageProfileRegistry
from services.runtime.tests.remote_support import GuardedTestClient


def _snapshot(response):
    assert response.status_code == 200, response.text
    # Parse the existing wire schema, not just an HTTP success code.
    return ProjectSessionResponse.model_validate(response.json())


def _content(document):
    return document.model_dump(mode="json", exclude={"manifest", "checksum"})


@pytest.mark.parametrize("mode", ["local_sqlite", "postgresql"])
def test_pinned_1000_public_open_edit_save_close_and_reopen_preserve_complete_project(tmp_path, mode):
    if mode == "postgresql" and not os.environ.get("STT_TEST_POSTGRES_URL"):
        pytest.skip("requires explicit disposable PostgreSQL test URL")
    fixture = prepare(tmp_path / "fixture", "1000")
    path = Path(fixture["path"])
    # No normal runtime, machine provider profiles, user key or process DB access.
    settings = RuntimeSettings(database_url=f"sqlite:///{tmp_path / 'process.sqlite'}",
        storage_profiles_file=tmp_path / "profiles.json", storage_master_key_file=tmp_path / "machine.key",
        canon_provider_profiles_file=tmp_path / "providers.enc", ink_compiler_policy="disabled", yarn_compiler_policy="disabled")
    with ExitStack() as stack:
        url = stack.enter_context(disposable_database()) if mode == "postgresql" else None
        app = create_app(settings)
        profiles = StorageProfileRegistry([_profile(url)] if url else [], master_key_file=settings.storage_master_key_file)
        app.state.storage_profiles = profiles
        registry = app.state.project_sessions
        registry._storage_profiles = profiles
        client = stack.enter_context(GuardedTestClient(app))
        source = _snapshot(client.post("/api/project-sessions/open", json={"path": str(path)}))
        assert len(source.document.nodes) == 1000
        sid = source.session.session_id
        current = source
        if url is not None:
            migrated = client.post("/api/storage-migrations", json={"session_id": sid,
                "expected_revision": source.session.saved_revision, "target_mode": "postgresql", "target_profile_id": "scale-test"})
            assert migrated.status_code == 200, migrated.text
            current = ProjectSessionResponse.model_validate(migrated.json()["project"])
            assert migrated.json()["verified_checksum"] == current.document.checksum
            assert _content(current.document) == _content(source.document)
        assert current.session.storage_mode == mode

        # Admit the persisted selected authority through HTTP again before edit.
        closed = _snapshot(client.post(f"/api/project-sessions/{sid}/close"))
        assert closed.document.checksum == current.document.checksum
        assert not list(path.rglob("project.lock.json"))
        current = _snapshot(client.post("/api/project-sessions/open", json={"path": str(path)}))
        sid = current.session.session_id
        assert current.document.checksum == closed.document.checksum
        assert current.session.save_status == "clean"
        assert current.session.saved_revision == source.session.saved_revision

        target = next(node for node in current.document.nodes if node.type == "Lore")
        payload = {name: getattr(target, name) for name in NodeUpdate.model_fields}
        payload["summary"] += " R2 public HTTP edit."
        changed = client.put(f"/api/nodes/{target.id}", headers={"X-Project-Session-Id": sid}, json=payload)
        assert changed.status_code == 200, changed.text
        returned = NodeResponse.model_validate(changed.json())
        expected_node = {**target.model_dump(mode="json"), "summary": payload["summary"]}
        # ORM-managed updated_at may advance. Require every other field to stay
        # exact, then use the actual acknowledged timestamp in the full document.
        assert returned.updated_at >= target.updated_at
        expected_node["updated_at"] = returned.model_dump(mode="json")["updated_at"]
        assert returned.model_dump(mode="json") == expected_node
        expected = _content(current.document)
        for index, record in enumerate(expected["nodes"]):
            if record["id"] == target.id:
                expected["nodes"][index] = expected_node
        edited = _snapshot(client.get(f"/api/project-sessions/{sid}"))
        assert _content(edited.document) == expected
        assert edited.session.save_status == "dirty"

        # Refused close/stale Save must leave the complete project and lock live.
        refused = client.post(f"/api/project-sessions/{sid}/close")
        assert refused.status_code == 409 and refused.json()["detail"]["code"] == "project_unsaved_changes"
        stale = client.post(f"/api/project-sessions/{sid}/save", json={
            "expected_revision": current.session.saved_revision + 1, "reason": "manual"})
        assert stale.status_code == 409 and stale.json()["detail"]["code"] == "project_save_revision_stale"
        assert list(path.rglob("project.lock.json"))
        assert _snapshot(client.get(f"/api/project-sessions/{sid}")).document.checksum == edited.document.checksum

        saved = _snapshot(client.post(f"/api/project-sessions/{sid}/save", json={
            "expected_revision": current.session.saved_revision, "reason": "manual"}))
        assert _content(saved.document) == expected
        assert saved.session.save_status == "clean"
        assert saved.session.saved_revision == current.session.saved_revision + 1
        if url is not None:
            assert saved.session.remote_storage.saved_revision == str(saved.session.saved_revision)
        closed = _snapshot(client.post(f"/api/project-sessions/{sid}/close"))
        assert closed.session.lifecycle == "closed" and closed.document.checksum == saved.document.checksum
        assert not list(path.rglob("project.lock.json"))

        reopened = _snapshot(client.post("/api/project-sessions/open", json={"path": str(path)}))
        assert reopened.document == saved.document
        assert reopened.session.save_status == "clean" and reopened.session.saved_revision == saved.session.saved_revision
        if url is not None:
            # A fresh writer epoch proves the released lease was reacquired,
            # rather than forcing away an old owner or clearing somebody's lock.
            assert int(reopened.session.remote_storage.writer_epoch) > int(saved.session.remote_storage.writer_epoch)
        _snapshot(client.post(f"/api/project-sessions/{reopened.session.session_id}/close"))
    assert not list(tmp_path.rglob("project.lock.json"))

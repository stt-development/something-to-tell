"""Owned desktop children use a disposable DB, preserving real lease expiry."""
import json
import os
from time import monotonic, sleep

import pytest
from sqlalchemy import create_engine, text

from services.runtime.stt_runtime.project_session.database import upgrade_external_database
from services.runtime.tests.desktop_lifecycle_support import add_draft, post, running_child, stop_child
from services.runtime.tests.test_remote_storage_protocol_audit import audit_database

pytestmark = pytest.mark.skipif(not os.getenv("STT_TEST_POSTGRES_URL"), reason="Disposable PostgreSQL required")


@pytest.mark.parametrize("mode", ["shutdown", "eof", "kill"])
def test_desktop_release_or_expiry_preserves_remote_working_data(audit_database, tmp_path, mode):
    upgrade_external_database(audit_database)
    observer = create_engine(audit_database)
    path = tmp_path / "Owned remote.narrative"
    lock = path / "cache/project.lock.json"
    url = audit_database
    (tmp_path / "profiles.json").write_text(json.dumps({"profiles": [{
        "profile_id": "owned", "label": "Owned test DB", "host": url.host, "port": url.port,
        "database": url.database, "username": url.username, "password": url.password,
        "tls_policy": "disable"}]}), encoding="utf-8")
    try:
        with running_child(tmp_path) as (process, port, token):
            created = post(port, token, "/api/project-sessions/create", {"path": str(path), "name": "Owned remote"}, expected=201)
            sid = created["session"]["session_id"]
            migrated = post(port, token, "/api/storage-migrations", {"session_id": sid,
                "expected_revision": 0, "target_mode": "postgresql", "target_profile_id": "owned"})["project"]
            node = add_draft(port, token, migrated)
            pid = migrated["session"]["project_id"]
            if mode != "kill":
                post(port, token, f"/api/project-sessions/{sid}/save", {
                    "expected_revision": migrated["session"]["saved_revision"], "reason": "close"})
                post(port, token, f"/api/project-sessions/{sid}/close")
            old_lock = lock.read_bytes() if mode == "kill" else None
            stop_child(process, mode)
        with observer.connect() as connection:
            row = connection.execute(text("SELECT owner_token, authoring_revision, saved_authoring_revision FROM project_storage_heads WHERE project_id=:id"), {"id": pid}).one()
        if mode == "kill":
            assert lock.read_bytes() == old_lock
            assert row.owner_token is not None and row.authoring_revision > row.saved_authoring_revision
            # Retain real production lease/transaction policy. A one-second
            # transaction budget incorrectly times out migration/capture itself.
            deadline = monotonic() + 75
            while True:
                with observer.connect() as connection:
                    expired = connection.scalar(text("SELECT lease_expires_at <= clock_timestamp() FROM project_storage_heads WHERE project_id=:id"), {"id": pid})
                if expired:
                    break
                assert monotonic() < deadline, "Owned lease did not expire"
                sleep(0.1)
        else:
            assert row.owner_token is None and not lock.exists()
        with running_child(tmp_path) as (_, port, token):
            if mode == "kill":
                rejected = post(port, token, "/api/project-sessions/open", {"path": str(path)}, expected=409)
                assert rejected["detail"]["code"] == "project_lock_stale"
                assert lock.read_bytes() == old_lock
            opened = post(port, token, "/api/project-sessions/open", {"path": str(path), "recover_stale_lock": mode == "kill"})
            assert node["id"] in {item["id"] for item in opened["document"]["nodes"]}
            sid = opened["session"]["session_id"]
            if mode == "kill":
                assert opened["session"]["save_status"] == "dirty"
                post(port, token, f"/api/project-sessions/{sid}/save", {
                    "expected_revision": opened["session"]["saved_revision"], "reason": "manual"})
            post(port, token, f"/api/project-sessions/{sid}/close")
            assert not lock.exists()
    finally:
        observer.dispose()

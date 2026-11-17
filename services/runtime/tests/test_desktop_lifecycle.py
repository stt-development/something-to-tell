"""Real desktop-process close and recovery, without user projects or fixed ports."""
import json
import os
import socket
import subprocess
import sys
from time import monotonic, sleep

import pytest

from services.runtime.tests.desktop_lifecycle_support import add_draft, post, running_child, stop_child
from services.runtime.tests.test_desktop_runtime import ROOT, read_frame


@pytest.mark.parametrize("mode", ["shutdown", "eof"])
def test_saved_project_releases_lock_and_reopens_after_child_stop(tmp_path, mode):
    path = tmp_path / "Owned desktop.narrative"
    with running_child(tmp_path) as (process, port, token):
        created = post(port, token, "/api/project-sessions/create", {"path": str(path), "name": "Owned desktop"}, expected=201)
        node = add_draft(port, token, created)
        sid = created["session"]["session_id"]
        saved = post(port, token, f"/api/project-sessions/{sid}/save", {"expected_revision": 0, "reason": "close"})
        post(port, token, f"/api/project-sessions/{sid}/close")
        assert not (path / "cache/project.lock.json").exists()
        stop_child(process, mode)
    with running_child(tmp_path) as (_, port, token):
        reopened = post(port, token, "/api/project-sessions/open", {"path": str(path)})
        assert reopened["document"]["checksum"] == saved["document"]["checksum"]
        assert [item["id"] for item in reopened["document"]["nodes"]] == [node["id"]]
        post(port, token, f"/api/project-sessions/{reopened['session']['session_id']}/close")


@pytest.mark.parametrize("mode", ["shutdown", "eof", "kill"])
def test_unsaved_stop_requires_explicit_recovery_without_implicit_lock_deletion(tmp_path, mode):
    path = tmp_path / "Owned recovery.narrative"
    lock = path / "cache/project.lock.json"
    with running_child(tmp_path) as (process, port, token):
        created = post(port, token, "/api/project-sessions/create", {"path": str(path), "name": "Owned recovery"}, expected=201)
        node = add_draft(port, token, created)
        old_lock = lock.read_bytes()
        stop_child(process, mode)
    if mode == "kill":
        assert lock.read_bytes() == old_lock
    else:
        assert not lock.exists()
    with running_child(tmp_path) as (_, port, token):
        rejected = post(port, token, "/api/project-sessions/open", {"path": str(path)}, expected=409)
        assert rejected["detail"]["code"] in {"project_recovery_required", "project_lock_stale"}
        if mode == "kill":
            assert lock.read_bytes() == old_lock
        recovered = post(port, token, "/api/project-sessions/open", {
            "path": str(path), "recover_stale_lock": mode == "kill", "recovery_mode": "recover"})
        assert recovered["session"]["save_status"] == "dirty"
        assert node["id"] in {item["id"] for item in recovered["document"]["nodes"]}
        sid = recovered["session"]["session_id"]
        post(port, token, f"/api/project-sessions/{sid}/discard")
        post(port, token, f"/api/project-sessions/{sid}/close")
        assert not lock.exists()


def test_abrupt_supervisor_death_closes_private_pipe_and_preserves_recovery(tmp_path):
    path = tmp_path / "Parent death.narrative"
    lock = path / "cache/project.lock.json"
    env = {**os.environ, "PYTHONPATH": str(ROOT)}
    parent = subprocess.Popen([sys.executable, "-m", "services.runtime.tests.desktop_parent_fixture", str(tmp_path)],
        cwd=tmp_path, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        ready = json.loads(read_frame(parent))
        assert lock.exists()
        parent.stdin.write("exit\n"); parent.stdin.flush()
        assert parent.wait(timeout=10) == 17
        deadline = monotonic() + 15
        # Both the owned project's lock and its child's ephemeral listener must
        # disappear. No process-name lookup, lock deletion or port-based kill.
        while True:
            with socket.socket() as probe:
                probe.settimeout(0.2)
                listening = probe.connect_ex(("127.0.0.1", ready["port"])) == 0
            if not lock.exists() and not listening:
                break
            assert monotonic() < deadline, "Owned orphan runtime did not stop"
            sleep(0.05)
        with running_child(tmp_path) as (_, port, token):
            blocked = post(port, token, "/api/project-sessions/open", {"path": str(path)}, expected=409)
            assert blocked["detail"]["code"] == "project_recovery_required"
            recovered = post(port, token, "/api/project-sessions/open", {"path": str(path), "recovery_mode": "recover"})
            assert ready["node_id"] in {node["id"] for node in recovered["document"]["nodes"]}
            sid = recovered["session"]["session_id"]
            post(port, token, f"/api/project-sessions/{sid}/discard")
            post(port, token, f"/api/project-sessions/{sid}/close")
    finally:
        if parent.poll() is None:
            parent.kill()
        parent.wait(timeout=10)
        for stream in (parent.stdin, parent.stdout, parent.stderr):
            stream.close()


def test_unicode_and_spaces_project_path_survives_save_and_reopen(tmp_path):
    # Escaped Cyrillic keeps source ASCII while exercising a real non-ASCII path.
    path = tmp_path / "\u041f\u0440\u043e\u0435\u043a\u0442 with spaces.narrative"
    with running_child(tmp_path) as (process, port, token):
        created = post(port, token, "/api/project-sessions/create", {"path": str(path), "name": "Unicode path"}, expected=201)
        node = add_draft(port, token, created)
        sid = created["session"]["session_id"]
        saved = post(port, token, f"/api/project-sessions/{sid}/save", {"expected_revision": 0, "reason": "manual"})
        post(port, token, f"/api/project-sessions/{sid}/close")
        stop_child(process, "shutdown")
    with running_child(tmp_path) as (_, port, token):
        opened = post(port, token, "/api/project-sessions/open", {"path": str(path)})
        assert opened["document"]["checksum"] == saved["document"]["checksum"]
        assert node["id"] in {item["id"] for item in opened["document"]["nodes"]}
        post(port, token, f"/api/project-sessions/{opened['session']['session_id']}/close")
        assert not (path / "cache/project.lock.json").exists()

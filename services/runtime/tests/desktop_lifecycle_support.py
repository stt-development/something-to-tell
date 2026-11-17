"""Authenticated subprocess helpers scoped to test-owned paths and child handles."""
from contextlib import contextmanager
import json
import secrets
import re
from uuid import uuid4

from services.runtime.stt_runtime.desktop_protocol import DesktopReadyV1, parse_frame
from services.runtime.tests.test_desktop_runtime import child, read_frame, request


@contextmanager
def running_child(tmp_path):
    with child(tmp_path) as (process, errors):
        token = secrets.token_urlsafe(32)
        process.stdin.write(json.dumps({"protocol_version": 1, "type": "bootstrap", "token": token}) + "\n")
        process.stdin.flush()
        ready = parse_frame(read_frame(process).encode(), DesktopReadyV1)
        yield process, ready.port, token
        errors.seek(0)
        assert token not in errors.read()


def post(port, token, path, payload=None, *, session_id=None, expected=200):
    headers = {"Content-Type": "application/json", "X-Remote-Storage-Version": "1"}
    if session_id:
        headers["X-Project-Session-Id"] = session_id
    match = re.fullmatch(r"/api/project-sessions/([^/]+)/(save|discard|close)", path)
    sid = session_id or (payload or {}).get("session_id") or (match.group(1) if match else None)
    if sid:
        status, body = request(port, f"/api/project-sessions/{sid}", token, headers=headers)
        assert status == 200
        if json.loads(body)["session"]["storage_mode"] == "postgresql":
            status, body = request(port, f"/api/project-sessions/{sid}/remote-storage", token, headers=headers)
            assert status == 200
            head = json.loads(body)
            # Negotiate the production remote protocol; no in-process registry or
            # SQL shortcut is used to authorize HTTP mutations in these tests.
            headers.update({"X-Project-Session-Id": sid, "X-Remote-Storage-Generation": head["storage_generation"],
                "X-Remote-Writer-Epoch": str(head["writer_epoch"]), "X-Remote-Expected-Revision": str(head["authoring_revision"]),
                "X-Remote-Command-Id": str(uuid4())})
    status, body = request(port, path, token, method="POST", headers=headers,
                           data=json.dumps(payload or {}).encode())
    result = json.loads(body)
    assert status == expected, result
    return result


def stop_child(process, mode):
    if mode == "kill":
        process.kill()
    elif mode == "eof":
        # Models parent disappearance: no further private control writer exists.
        process.stdin.close()
    else:
        assert mode == "shutdown"
        process.stdin.write('{"protocol_version":1,"type":"shutdown"}\n')
        process.stdin.flush()
    result = process.wait(timeout=15)
    if mode == "kill":
        assert result != 0
    else:
        assert result == 0


def add_draft(port, token, project):
    return post(port, token, "/api/nodes", {"project_id": project["session"]["project_id"],
                "type": "Event", "title": "Owned desktop draft"},
                session_id=project["session"]["session_id"], expected=201)

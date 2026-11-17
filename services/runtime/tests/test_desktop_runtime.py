"""Real owned children use private pipes and disposable paths, never normal8719."""

from contextlib import contextmanager
import json
import os
from pathlib import Path
from queue import Queue
import secrets
import subprocess
import sys
from tempfile import TemporaryFile
from threading import Thread
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from services.runtime.stt_runtime.desktop_runtime import _production_settings
from services.runtime.stt_runtime.desktop_protocol import DesktopReadyV1, parse_frame

ROOT = Path(__file__).parents[3]


@contextmanager
def child(tmp_path):
    env = {**os.environ, "PYTHONPATH": str(ROOT),
        "STT_RUNTIME_STORAGE_PROFILES_FILE": str(tmp_path / "profiles.json"),
        "STT_RUNTIME_STORAGE_MASTER_KEY_FILE": str(tmp_path / "key"),
        "STT_RUNTIME_CANON_PROVIDER_PROFILES_FILE": str(tmp_path / "providers.enc")}
    with TemporaryFile(mode="w+", encoding="utf-8") as errors:
        executable = os.environ.get("STT_TEST_DESKTOP_RUNTIME_EXECUTABLE")
        command = [executable, "--desktop"] if executable else [sys.executable, "-m", "services.runtime.desktop_entry", "--desktop"]
        if executable:
            assert Path(executable).is_absolute() and Path(executable).is_file()
            # A frozen candidate must not discover Python or imports in the checkout.
            env.pop("PYTHONPATH", None)
            env["PATH"] = "/nonexistent"
        process = subprocess.Popen(command,
            cwd=tmp_path, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=errors, text=True)
        try:
            yield process, errors
        finally:
            if process.poll() is None:
                process.kill()  # Only our child; no PID/port/name discovery.
            process.wait(timeout=10)
            if process.stdin and not process.stdin.closed:
                process.stdin.close()
            process.stdout.close()


def read_frame(process):
    queue = Queue(maxsize=1)
    reader = Thread(target=lambda: queue.put(process.stdout.readline(4097)), daemon=True)
    reader.start()
    try:
        result = queue.get(timeout=20)
    except Exception:
        process.kill()
        process.wait(timeout=10)
        raise
    finally:
        reader.join(timeout=1)
    assert result.endswith("\n") and len(result.encode()) <= 4096
    return result


def request(port, path, token=None, **kwargs):
    headers = {"Authorization": "Bearer " + token} if token else {}
    headers.update(kwargs.pop("headers", {}))
    try:
        with urlopen(Request(f"http://127.0.0.1:{port}{path}", headers=headers, **kwargs), timeout=5) as response:
            return response.status, response.read()
    except HTTPError as error:
        return error.code, error.read()


@pytest.mark.parametrize("stop", ["shutdown", "eof", "invalid"])
def test_real_child_auth_identity_and_private_stop(tmp_path, stop):
    token = secrets.token_urlsafe(32)
    with child(tmp_path) as (process, errors):
        process.stdin.write(json.dumps({"protocol_version": 1, "type": "bootstrap", "token": token}) + "\n")
        process.stdin.flush()
        line = read_frame(process)
        ready = parse_frame(line.encode(), DesktopReadyV1)
        assert ready.pid == process.pid
        assert token not in line
        assert request(ready.port, "/api/health")[0] == 401
        status, body = request(ready.port, "/api/health", token)
        assert status == 200 and json.loads(body)["version"] == ready.runtime_version
        assert request(ready.port, "/api/health", token, headers={"Origin": "https://bad.example"})[0] == 403
        assert request(ready.port, "/docs", token)[0] == 404
        if stop == "eof":
            process.stdin.close()
        else:
            value = {"protocol_version": 1, "type": "shutdown"} if stop == "shutdown" else {"private": token}
            process.stdin.write(json.dumps(value) + "\n")
            process.stdin.flush()
        assert process.wait(timeout=15) == (1 if stop == "invalid" else 0)
        remaining = process.stdout.read()
        if stop == "invalid":
            assert json.loads(remaining)["code"] == "desktop_control_invalid"
        else:
            assert remaining == ""
        errors.seek(0)
        assert token not in remaining + errors.read()
        assert not list(tmp_path.rglob("project.lock.json"))
        assert not (tmp_path / "key").exists()


@pytest.mark.parametrize("frame", ["invalid private-input\n", "x" * 4097 + "\n", ""])
def test_invalid_bootstrap_exits_with_only_redacted_frame(tmp_path, frame):
    with child(tmp_path) as (process, errors):
        process.stdin.write(frame)
        process.stdin.close()
        assert process.wait(timeout=10) == 1
        assert json.loads(process.stdout.read())["code"] == "desktop_bootstrap_invalid"
        errors.seek(0)
        assert "private-input" not in errors.read()


def test_bootstrap_input_deadline_does_not_wait_forever_for_parent(tmp_path):
    with child(tmp_path) as (process, errors):
        assert process.wait(timeout=10) == 1
        assert json.loads(process.stdout.read())["code"] == "desktop_bootstrap_invalid"


def test_production_ignores_dotenv_and_development_overrides(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / ".env").write_text("STT_RUNTIME_HOST=0.0.0.0\nSTT_RUNTIME_DOCS_ENABLED=true\n")
    monkeypatch.setenv("STT_RUNTIME_RELOAD", "true")
    settings = _production_settings()
    assert settings.host == "127.0.0.1" and settings.port == 0
    assert settings.docs_enabled is False and settings.reload is False
    assert "http://localhost:1420" not in settings.allowed_origins

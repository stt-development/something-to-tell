"""Public profile probes are temporary, thread-local, secret-free observers."""

import json
from types import SimpleNamespace
from threading import Thread

import httpx
import pytest
from sqlalchemy import create_engine, make_url, text

from services.runtime.scripts import profile_storage_admission as probe
from services.runtime.stt_runtime.project_session.errors import ProjectSessionError
from services.runtime.stt_runtime.project_session.service import ProjectSessionRegistry


def test_sql_failure_metadata_is_allowlisted_and_thread_bound():
    profile = probe.AdmissionProfile()
    context = SimpleNamespace(original_exception=SimpleNamespace(sqlstate="25P04"),
                              statement="INSERT INTO private_values (secret) VALUES ('password')")
    background = Thread(target=lambda: profile._error(context))
    background.start()
    background.join()
    assert profile.summary()["sql_failures"] == []
    profile._error(context)
    context.original_exception.sqlstate = "private exception text"
    context.statement = "untrusted private query"
    profile._error(context)
    assert profile.summary()["sql_failures"] == [
        {"sqlstate": "25P04", "command": "INSERT"}, {"sqlstate": "unavailable", "command": "other"}]
    assert "private" not in json.dumps(profile.summary())
    assert "password" not in json.dumps(profile.summary())


def test_runtime_profile_is_constructed_in_calling_worker_and_restores_wrappers(tmp_path, monkeypatch):
    def migrate(*args, **kwargs):
        engine = create_engine("sqlite:///:memory:")
        try:
            with engine.connect() as connection:
                connection.execute(text("SELECT 1"))
        finally:
            engine.dispose()
        raise ProjectSessionError("remote_storage_timeout", secret="must not be recorded")
    monkeypatch.setattr(ProjectSessionRegistry, "migrate_storage", migrate)
    app = probe.owned_app(tmp_path, instrumented=True)
    failures = []
    def work():
        try:
            app.state.project_sessions.migrate_storage("private-session")
        except ProjectSessionError as error:
            failures.append(error.code)
    worker = Thread(target=work)
    worker.start()
    worker.join()
    assert failures == ["remote_storage_timeout"]
    report = json.loads((tmp_path / "migration-metrics.json").read_text())
    assert report["sql"]["cursor_calls"] == 1
    assert report["migration_wall_seconds"] >= 0
    for value in ("secret", "private-session", "must not"):
        assert value not in json.dumps(report)
    assert ProjectSessionRegistry.migrate_storage is migrate


@pytest.mark.parametrize("instrumented", [False, True])
def test_public_encrypted_profile_failure_keeps_authority_and_releases_owned_folder(tmp_path, monkeypatch, instrumented):
    def failed(*args, **kwargs):
        raise ProjectSessionError("remote_storage_timeout", secret="private-password")
    monkeypatch.setattr(ProjectSessionRegistry, "migrate_storage", failed)
    report = probe.profile_admission("small", make_url("postgresql+psycopg://private-user:private-password@invalid/test"),
        transport="asgi", instrumented=instrumented, parent=tmp_path)
    assert report["status"] == "failed"
    assert report["stage"] == "storage-migrations"
    assert report["error_code"] == "remote_storage_timeout"
    assert report["invariants"] == {"source_authority_preserved": True}
    assert report["cleanup"] == report["runtime_cleanup"] == "released"
    assert not list(tmp_path.iterdir())
    for value in ("private-user", "private-password", str(tmp_path), '"session_id"', "postgresql+psycopg"):
        assert value not in json.dumps(report)


def test_failed_close_retains_folder_instead_of_erasing_ownership(tmp_path, monkeypatch):
    def failed(*args, **kwargs):
        raise ProjectSessionError("remote_storage_timeout")
    original = probe._post
    def post(client, route, payload=None):
        if route.endswith("/close"):
            return None, "project_unsaved_changes"
        return original(client, route, payload)
    monkeypatch.setattr(ProjectSessionRegistry, "migrate_storage", failed)
    monkeypatch.setattr(probe, "_post", post)
    report = probe.profile_admission("small", make_url("postgresql+psycopg://private:private@invalid/test"),
        transport="asgi", parent=tmp_path)
    assert report["cleanup"] == "retained"
    assert list(tmp_path.iterdir())
    # Lifespan still releases the actual clean session normally, not forcibly.
    assert not list(tmp_path.rglob("project.lock.json"))


def test_http_error_body_is_not_a_diagnostic_record():
    client = httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(503,
        json={"detail": {"code": "remote_storage_timeout", "password": "never-retain"}})), base_url="http://test")
    with client:
        assert probe._post(client, "/storage-migrations") == (None, "remote_storage_timeout")


@pytest.mark.parametrize("size,transport", [("10000", "live"), ("small", "remote")])
def test_invalid_case_rejects_before_allocating_owned_files(tmp_path, size, transport):
    with pytest.raises(ValueError, match="admission_case_unsupported"):
        probe.profile_admission(size, None, transport=transport, parent=tmp_path)
    assert not list(tmp_path.iterdir())

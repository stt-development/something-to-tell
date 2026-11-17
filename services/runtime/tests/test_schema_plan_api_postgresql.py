"""Real C3b HTTP composition against disposable SQL only; requests never run DDL."""

import os

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import event, text

from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.project_format.service import create_project_folder
from services.runtime.tests.test_remote_storage_protocol_audit import audit_database
from services.runtime.tests.test_schema_plan_context_postgresql import source
from services.runtime.tests.test_schema_plan_api import PLAN, ACK, HEADERS, body, confirmation, settings

pytestmark = pytest.mark.skipif(not os.getenv("STT_TEST_POSTGRES_URL"), reason="Disposable PostgreSQL required")


def folder_bytes(folder):
    return {str(p.relative_to(folder)): p.read_bytes() for p in folder.rglob("*") if p.is_file()}


def test_empty_preparation_is_read_only_and_never_opens_or_provisions(source, tmp_path, monkeypatch):
    engine, _, folder, profiles = source
    app = create_app(settings(tmp_path))
    app.state.storage_profiles = profiles
    monkeypatch.setattr(profiles, "create_engine", lambda *_: engine)
    before, statements = folder_bytes(folder.path), []
    def trace(_, __, sql, *___):
        statements.append(sql)
    event.listen(engine, "before_cursor_execute", trace)
    try:
        with TestClient(app) as client:
            request = body(folder.path, profile_id="audit", action="provision", expected_schema_revision=None)
            response = client.post(PLAN, headers=HEADERS, json=request)
            assert response.status_code == 200, response.text
            plan = response.json()
            assert plan["action"] == "provision" and not plan["backup_required"]
            assert plan["source_schema_revision"] is None
            assert plan["migration_revisions"][-1] == plan["target_schema_revision"]
            rejected = client.post(ACK, headers=HEADERS,
                json=confirmation(folder.path, plan, profile_id="audit"))
            assert rejected.status_code == 400
            assert rejected.json()["detail"]["code"] == "remote_contract_invalid"
            assert not app.state.project_sessions._sessions
            assert folder_bytes(folder.path) == before
        assert not app.state.schema_plans._plans
        assert all(sql.lstrip().upper().startswith(("SELECT", "SET", "SHOW")) for sql in statements)
    finally:
        event.remove(engine, "before_cursor_execute", trace)
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT count(*) FROM pg_tables WHERE schemaname='public'")) == 0


def test_legacy_confirmation_rechecks_control_and_completed_upgrade(source, tmp_path):
    engine, config, folder, profiles = source
    command.upgrade(config, "20261022_0011")  # Fixture alone is allowed to mutate SQL.
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE author_notes(body text)"))
        connection.execute(text("INSERT INTO author_notes VALUES ('private narrative stays exact')"))
    app = create_app(settings(tmp_path))
    app.state.storage_profiles = profiles
    before = folder_bytes(folder.path)
    with TestClient(app) as client:
        request = body(folder.path, profile_id="audit")
        response = client.post(PLAN, headers=HEADERS, json=request)
        assert response.status_code == 200, response.text
        plan = response.json()
        assert plan["migration_revisions"] == ["20261022_0012"] and plan["backup_required"]
        data = confirmation(folder.path, plan, profile_id="audit")
        first = client.post(ACK, headers=HEADERS, json=data)
        assert first.status_code == 200, first.text
        assert client.post(ACK, headers=HEADERS, json=data).json() == first.json()
        with engine.begin() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "20261022_0011"
            connection.execute(text("UPDATE remote_storage_control SET maintenance=true"))
        changed = client.post(ACK, headers=HEADERS, json=data)
        assert changed.status_code == 409 and changed.json()["detail"]["code"] == "remote_schema_plan_stale"
        with engine.begin() as connection:
            connection.execute(text("UPDATE remote_storage_control SET maintenance=false"))
        assert client.post(ACK, headers=HEADERS, json=data).status_code == 409
        plan = client.post(PLAN, headers=HEADERS, json=request).json()
        command.upgrade(config, "head")
        current = client.post(ACK, headers=HEADERS, json=confirmation(folder.path, plan, profile_id="audit"))
        assert current.status_code == 409 and current.json()["detail"]["code"] == "remote_schema_plan_stale"
        assert folder_bytes(folder.path) == before
        assert not app.state.project_sessions._sessions
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT body FROM author_notes")) == "private narrative stays exact"
        assert connection.scalar(text("SELECT count(*) FROM project_storage_heads")) == 0
        assert connection.scalar(text("SELECT count(*) FROM remote_command_receipts")) == 0


def test_project_encrypted_profile_is_resolved_in_selected_folder(source, tmp_path):
    engine, config, folder, profiles = source
    command.upgrade(config, "20261022_0011")
    profiles._master_key_file = tmp_path / "test-profile.key"
    configured = profiles.resolve("audit")
    encrypted = profiles.add(folder.path, label="Private admin", host=configured.host, port=configured.port,
        database=configured.database, username=configured.username, password=configured.password, tls_policy="disable")
    other = create_project_folder(tmp_path / "Other.narrative")
    app = create_app(settings(tmp_path))
    app.state.storage_profiles = profiles
    before = folder_bytes(folder.path), folder_bytes(other.path)
    with TestClient(app) as client:
        response = client.post(PLAN, headers=HEADERS, json=body(folder.path, profile_id=encrypted.profile_id))
        assert response.status_code == 200, response.text
        plan = response.json()
        denied = client.post(ACK, headers=HEADERS,
            json=confirmation(other.path, plan, profile_id=encrypted.profile_id))
        assert denied.status_code == 400 and denied.json()["detail"]["code"] == "remote_storage_binding_required"
        accepted = client.post(ACK, headers=HEADERS,
            json=confirmation(folder.path, plan, profile_id=encrypted.profile_id))
        assert accepted.status_code == 200, accepted.text
        assert configured.password not in response.text + denied.text + accepted.text
        assert (folder_bytes(folder.path), folder_bytes(other.path)) == before

"""D3 real HTTP/SQL composition including a committed-but-lost acknowledgement."""

import os

from alembic import command
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import inspect, text
from sqlalchemy.exc import OperationalError
from services.runtime.stt_runtime import schema_upgrade

from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.project_format.service import create_project_folder
from services.runtime.tests.test_remote_storage_protocol_audit import audit_database
from services.runtime.tests.test_schema_plan_context_postgresql import source
from services.runtime.tests.test_schema_plan_api import PLAN, ACK, HEADERS, settings
from services.runtime.tests.test_schema_execution_api import EXECUTE

pytestmark = pytest.mark.skipif(not os.getenv("STT_TEST_POSTGRES_URL"), reason="Disposable PostgreSQL required")


def prepare(client, folder, profile="audit", *, upgrade=False):
    request = dict(project_path=str(folder.path), profile_id=profile, action="upgrade" if upgrade else "provision",
        expected_schema_revision="20261022_0011" if upgrade else None)
    response = client.post(PLAN, headers=HEADERS, json=request)
    assert response.status_code == 200, response.text
    return dict(project_path=str(folder.path), profile_id=profile, plan_id=response.json()["plan_id"],
        plan_fingerprint=response.json()["plan_fingerprint"], backup_attestation_id=None)


def inspect_schema(client, request):
    response = client.post("/api/storage-profiles/inspect", headers=HEADERS,
        json={key: request[key] for key in ("project_path", "profile_id")})
    assert response.status_code == 200, response.text
    return response.json()


def test_project_scoped_encrypted_profile_executes_once_without_local_mutation(source, tmp_path):
    engine, _, folder, profiles = source
    profiles._master_key_file = tmp_path / "test.key"
    configured = profiles.resolve("audit")
    profile = profiles.add(folder.path, label="Admin", host=configured.host, port=configured.port,
        database=configured.database, username=configured.username, password=configured.password, tls_policy="disable")
    app = create_app(settings(tmp_path)); app.state.storage_profiles = profiles
    before = {p: p.read_bytes() for p in folder.path.rglob("*") if p.is_file()}
    with TestClient(app) as client:
        request = prepare(client, folder, profile.profile_id)
        other = create_project_folder(tmp_path / "Other.narrative")
        denied = client.post(EXECUTE, headers=HEADERS, json=request | {"project_path": str(other.path)})
        # E3 rejects a misbound plan before resolving any profile/connecting SQL.
        assert denied.status_code == 409
        assert denied.json()["detail"]["code"] == "remote_schema_plan_stale"
        completed = client.post(EXECUTE, headers=HEADERS, json=request)
        assert completed.status_code == 200, completed.text
        assert completed.json() == dict(protocol_version=1, plan_id=request["plan_id"], action="provision",
            schema_revision="20261022_0012", status="completed")
        repeated = client.post(EXECUTE, headers=HEADERS, json=request)
        assert repeated.status_code == 409 and repeated.json()["detail"]["code"] == "remote_schema_plan_stale"
        assert inspect_schema(client, request)["schema_status"] == "current"
        assert configured.password not in completed.text + denied.text + repeated.text
        assert not app.state.project_sessions._sessions
    assert {p: p.read_bytes() for p in folder.path.rglob("*") if p.is_file()} == before
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT count(*) FROM projects")) == 0


@pytest.mark.parametrize("backup", [False, True])
def test_reviewed_upgrade_requires_backup_and_executes_exactly_once(source, tmp_path, backup):
    engine, config, folder, profiles = source
    command.upgrade(config, "20261022_0011")
    app = create_app(settings(tmp_path)); app.state.storage_profiles = profiles
    before = {p: p.read_bytes() for p in folder.path.rglob("*") if p.is_file()}
    with TestClient(app) as client:
        request = prepare(client, folder, upgrade=True)
        if backup:
            ack_body = {key: value for key, value in request.items() if key != "backup_attestation_id"}
            acknowledged = client.post(ACK, headers=HEADERS, json=ack_body | {"confirmation": "backup_and_restore_verified"})
            assert acknowledged.status_code == 200, acknowledged.text
            request["backup_attestation_id"] = acknowledged.json()["backup_attestation_id"]
        response = client.post(EXECUTE, headers=HEADERS, json=request)
        if backup:
            assert response.status_code == 200, response.text
            assert response.json() == dict(protocol_version=1, plan_id=request["plan_id"], action="upgrade",
                schema_revision="20261022_0012", status="completed")
            assert request["plan_id"] not in app.state.schema_plans._plans
            assert client.post(EXECUTE, headers=HEADERS, json=request).status_code == 409
        else:
            assert response.status_code == 409 and response.json()["detail"]["code"] == "remote_schema_backup_required"
            assert request["plan_id"] in app.state.schema_plans._plans
        assert inspect_schema(client, request)["schema_revision"] == ("20261022_0012" if backup else "20261022_0011")
        assert not app.state.project_sessions._sessions
    assert {p: p.read_bytes() for p in folder.path.rglob("*") if p.is_file()} == before
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == ("20261022_0012" if backup else "20261022_0011")


def test_lost_commit_acknowledgement_requires_inspection_not_replay(source, tmp_path, monkeypatch):
    engine, _, folder, profiles = source
    app = create_app(settings(tmp_path)); app.state.storage_profiles = profiles
    with TestClient(app) as client:
        request = prepare(client, folder)
        real_commit = engine.dialect.do_commit
        def lost_ack(dbapi_connection):
            real_commit(dbapi_connection)
            raise OperationalError("redacted", None, Exception("private connection detail"))
        with monkeypatch.context() as patch:
            patch.setattr(profiles, "create_engine", lambda *_: engine)
            patch.setattr(engine.dialect, "do_commit", lost_ack)
            response = client.post(EXECUTE, headers=HEADERS, json=request)
        assert response.status_code == 503
        assert response.json()["detail"]["code"] == "remote_commit_unknown"
        assert "private connection detail" not in response.text
        assert request["plan_id"] not in app.state.schema_plans._plans
        # The actual COMMIT succeeded: a false "rolled back" outcome would lose authority.
        assert inspect_schema(client, request)["schema_status"] == "current"
        repeated = client.post(EXECUTE, headers=HEADERS, json=request)
        assert repeated.status_code == 409 and repeated.json()["detail"]["code"] == "remote_schema_plan_stale"
    with engine.connect() as connection:
        assert "alembic_version" in inspect(connection).get_table_names()


@pytest.mark.parametrize("failure", ["ddl", "commit-ack"])
def test_upgrade_http_failure_never_reports_completed_and_retains_true_sql_outcome(source, tmp_path, monkeypatch, failure):
    engine, config, folder, profiles = source
    command.upgrade(config, "20261022_0011")
    app = create_app(settings(tmp_path)); app.state.storage_profiles = profiles
    before = {p: p.read_bytes() for p in folder.path.rglob("*") if p.is_file()}
    with TestClient(app) as client:
        request = prepare(client, folder, upgrade=True)
        ack_body = {key: value for key, value in request.items() if key != "backup_attestation_id"}
        acknowledged = client.post(ACK, headers=HEADERS, json=ack_body | {"confirmation": "backup_and_restore_verified"})
        assert acknowledged.status_code == 200
        request["backup_attestation_id"] = acknowledged.json()["backup_attestation_id"]
        real_upgrade, real_commit = command.upgrade, engine.dialect.do_commit
        commits = []
        def fail_ddl(config, target):
            real_upgrade(config, target)
            config.attributes["connection"].execute(text("SELECT 1/0"))
        def lost_ack(dbapi):
            real_commit(dbapi); commits.append(True)
            if len(commits) == 2:
                raise OperationalError("redacted", None, Exception("private detail"))
        with monkeypatch.context() as patch:
            patch.setattr(profiles, "create_engine", lambda *_: engine)
            if failure == "ddl":
                patch.setattr(schema_upgrade.command, "upgrade", fail_ddl)
            else:
                patch.setattr(engine.dialect, "do_commit", lost_ack)
            response = client.post(EXECUTE, headers=HEADERS, json=request)
        assert response.status_code == 503
        assert response.json()["detail"]["code"] == ("remote_storage_unavailable" if failure == "ddl" else "remote_commit_unknown")
        assert "private detail" not in response.text and request["plan_id"] not in app.state.schema_plans._plans
        assert client.post(EXECUTE, headers=HEADERS, json=request).status_code == 409
        observed = inspect_schema(client, request)
        assert observed["schema_revision"] == ("20261022_0011" if failure == "ddl" else "20261022_0012")
        assert not app.state.project_sessions._sessions
    assert {p: p.read_bytes() for p in folder.path.rglob("*") if p.is_file()} == before
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT maintenance FROM remote_storage_control")) is (failure == "ddl")

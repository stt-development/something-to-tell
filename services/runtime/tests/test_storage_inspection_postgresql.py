"""The inspection endpoint observes disposable storage without creating project sessions."""

import os

import pytest
from alembic import command
from sqlalchemy import create_engine, text

from services.runtime.tests.test_remote_storage_protocol_audit import audit_database, _profile
from services.runtime.tests.test_storage_profile_permissions import restricted_profile, grant_runtime
from services.runtime.tests.test_storage_inspection_api import workspace, post
from services.runtime.stt_runtime.project_session.database import alembic_config
from services.runtime.stt_runtime.storage_profiles import StorageProfileRegistry

pytestmark = pytest.mark.skipif(not os.getenv("STT_TEST_POSTGRES_URL"), reason="Disposable PostgreSQL required")


@pytest.mark.parametrize("state", ["empty", "current", "older", "future", "unknown", "partial"])
def test_endpoint_returns_all_schema_states_without_repair(workspace, audit_database, state):
    app, client, folder = workspace
    engine = create_engine(audit_database, hide_parameters=True)
    config = alembic_config(audit_database.render_as_string(hide_password=False))
    before = {str(path.relative_to(folder)): path.read_bytes() for path in folder.rglob("*") if path.is_file()}
    try:
        if state in {"current", "partial", "older"}:
            command.upgrade(config, "20261022_0011" if state == "older" else "head")
        with engine.begin() as connection:
            if state == "partial":
                connection.execute(text("DROP TABLE legacy_engine_tags"))
            if state == "future":
                connection.execute(text("CREATE TABLE alembic_version(version_num text)"))
                connection.execute(text("INSERT INTO alembic_version VALUES ('20261023_0013')"))
            if state == "unknown":
                connection.execute(text("CREATE TABLE author_data(id integer)"))
        app.state.storage_profiles = StorageProfileRegistry([_profile(audit_database)])
        response = post(client, folder)
        assert response.status_code == 200, response.text
        value = response.json()
        assert value["schema_status"] == state and value["privileges"] == "administrator"
        assert value["identity_verified"] is False and value["server_major"] == 17
        assert set(value) == {"protocol_version", "server_major", "schema_status", "schema_revision",
                              "tls_policy", "tls_active", "identity_verified", "privileges"}
        assert before == {str(path.relative_to(folder)): path.read_bytes() for path in folder.rglob("*") if path.is_file()}
        assert not app.state.project_sessions._sessions
    finally:
        engine.dispose()


def test_runtime_and_insufficient_are_distinct_even_with_create_grant(workspace, restricted_profile):
    app, client, folder = workspace
    profiles, admin, _, role, statements = restricted_profile
    grant_runtime(admin, role)
    with admin.begin() as connection:
        connection.exec_driver_sql(f'GRANT CREATE ON SCHEMA public TO "{role}"')
    app.state.storage_profiles = profiles
    result = post(client, folder)
    assert result.status_code == 200, result.text
    assert result.json()["privileges"] == "runtime"
    with admin.begin() as connection:
        connection.exec_driver_sql(f'REVOKE DELETE ON nodes FROM "{role}"')
    result = post(client, folder)
    assert result.status_code == 200 and result.json()["privileges"] == "insufficient"
    assert all(sql.lstrip().upper().startswith(("SELECT", "SET", "SHOW")) for sql in statements)

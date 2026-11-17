"""Real role/session/lease preflight, isolated from every user database and login."""

import os
from uuid import uuid4

from alembic import command
import pytest
from sqlalchemy import create_engine, event, text
from sqlalchemy.pool import NullPool

from services.runtime.stt_runtime.project_session.errors import ProjectSessionError
from services.runtime.stt_runtime.schema_upgrade_preflight import require_upgrade_quiescence
from services.runtime.tests.test_remote_storage_protocol_audit import audit_database
from services.runtime.tests.test_schema_plan_context_postgresql import source

pytestmark = pytest.mark.skipif(not os.getenv("STT_TEST_POSTGRES_URL"), reason="Disposable PostgreSQL required")


def check(engine):
    with engine.begin() as connection:
        require_upgrade_quiescence(connection)


@pytest.mark.parametrize("revision", ["20260919_0009", "20261022_0011"])
def test_quiet_legacy_and_control_schema_are_observational(source, revision):
    engine, config, _, _ = source
    command.upgrade(config, revision)
    statements = []
    event.listen(engine, "before_cursor_execute", lambda _, __, sql, *___: statements.append(sql))
    with engine.begin() as connection:
        before = connection.scalar(text("SELECT version_num FROM alembic_version"))
        require_upgrade_quiescence(connection)
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == before
    assert all(sql.lstrip().upper().startswith("SELECT") for sql in statements)


def test_other_idle_client_even_same_admin_rejects_without_termination(source):
    engine, config, _, _ = source
    command.upgrade(config, "20260919_0009")
    other = create_engine(engine.url, poolclass=NullPool)
    try:
        with other.connect() as idle:
            with pytest.raises(ProjectSessionError, match="remote_schema_busy"):
                check(engine)
            assert idle.scalar(text("SELECT 1")) == 1
        check(engine)
    finally:
        other.dispose()


def test_recheck_in_same_transaction_does_not_reuse_cached_activity(source):
    engine, config, _, _ = source
    command.upgrade(config, "20260919_0009")
    other = create_engine(engine.url, poolclass=NullPool)
    try:
        with engine.begin() as connection:
            require_upgrade_quiescence(connection)
            with other.connect():
                with pytest.raises(ProjectSessionError, match="remote_schema_busy"):
                    require_upgrade_quiescence(connection)
            require_upgrade_quiescence(connection)
    finally:
        other.dispose()


@pytest.fixture
def roles(source):
    engine, config, _, _ = source
    command.upgrade(config, "20260919_0009")
    login, group = "stt_e1_login_" + uuid4().hex, "stt_e1_group_" + uuid4().hex
    with engine.begin() as connection:
        connection.exec_driver_sql(f'CREATE ROLE "{login}" LOGIN')
        connection.exec_driver_sql(f'CREATE ROLE "{group}" NOLOGIN')
    try:
        yield engine, login, group
    finally:
        with engine.begin() as connection:
            connection.exec_driver_sql('REVOKE INSERT ON nodes FROM PUBLIC')
            for role in (login, group):
                # Return fixture table ownership before removing role grants;
                # never cascade-drop the referenced narrative tables.
                connection.exec_driver_sql(f'REASSIGN OWNED BY "{role}" TO CURRENT_USER')
                connection.exec_driver_sql(f'DROP OWNED BY "{role}"')
                connection.exec_driver_sql(f'DROP ROLE "{role}"')


@pytest.mark.parametrize("grant", ["direct", "inherited", "set-role", "public", "owner"])
def test_connectable_legacy_login_with_effective_write_access_blocks(roles, grant):
    engine, login, group = roles
    with engine.begin() as connection:
        if grant == "owner":
            connection.exec_driver_sql(f'ALTER TABLE nodes OWNER TO "{login}"')
        elif grant in {"inherited", "set-role"}:
            connection.exec_driver_sql(f'GRANT UPDATE ON nodes TO "{group}"')
            if grant == "set-role":
                connection.exec_driver_sql(f'ALTER ROLE "{login}" NOINHERIT')
            connection.exec_driver_sql(f'GRANT "{group}" TO "{login}"')
        else:
            target = 'PUBLIC' if grant == "public" else f'"{login}"'
            connection.exec_driver_sql(f'GRANT INSERT ON nodes TO {target}')
    with pytest.raises(ProjectSessionError, match="remote_schema_busy"):
        check(engine)
    with engine.begin() as connection:
        # This is operator/test setup, not production automatic account mutation.
        connection.exec_driver_sql(f'ALTER ROLE "{login}" NOLOGIN')
    check(engine)


def test_revoked_database_connect_can_fence_a_login_without_changing_its_grants(roles):
    engine, login, _ = roles
    with engine.begin() as connection:
        connection.exec_driver_sql(f'GRANT UPDATE ON nodes TO "{login}"')
        database = connection.dialect.identifier_preparer.quote_identifier(engine.url.database)
        connection.exec_driver_sql(f'REVOKE CONNECT ON DATABASE {database} FROM PUBLIC')
        connection.exec_driver_sql(f'REVOKE CONNECT ON DATABASE {database} FROM "{login}"')
    check(engine)


@pytest.mark.parametrize("active", [False, True])
def test_server_clock_lease_check_never_clears_or_renews_owners(source, active):
    engine, config, _, _ = source
    command.upgrade(config, "20261022_0011")
    interval = "60 seconds" if active else "-60 seconds"
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO projects(id,name,path,format_version,metadata,created_at,updated_at) VALUES ('p','P','fixture',2,'{}',now(),now())"))
        connection.execute(text("""INSERT INTO project_storage_heads(project_id,storage_generation,writer_epoch,owner_token,lease_expires_at)
            VALUES ('p',:generation,1,'private-token',clock_timestamp()+cast(:duration AS interval))"""),
            {"generation": str(uuid4()), "duration": interval})
    if active:
        with pytest.raises(ProjectSessionError, match="remote_schema_busy"):
            check(engine)
    else:
        check(engine)
    with engine.connect() as connection:
        assert connection.execute(text("SELECT writer_epoch,owner_token FROM project_storage_heads")).one() == (1, "private-token")

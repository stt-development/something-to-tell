"""Capability upgrade fences ownership-only clients without silently stamping data."""

import os
from uuid import uuid4
import pytest
from alembic import command
from sqlalchemy import create_engine, inspect, text
from services.runtime.tests.test_remote_storage_protocol_audit import audit_database
from services.runtime.stt_runtime.project_session.database import alembic_config


def test_sqlite_v11_upgrade_adds_protocol_capabilities(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'legacy.sqlite'}")
    config = alembic_config(engine.url.render_as_string(hide_password=False))
    try:
        command.upgrade(config, "20261022_0011")
        command.upgrade(config, "head")
        with engine.connect() as connection:
            row = connection.execute(text("SELECT protocol_version,capabilities FROM remote_storage_control")).one()
            assert row[0] == 1 and "durable_commands" in json_load(row[1])
    finally:
        engine.dispose()


def json_load(value):
    import json
    return json.loads(value) if isinstance(value, str) else value


@pytest.mark.skipif(not os.getenv("STT_TEST_POSTGRES_URL"), reason="Disposable PostgreSQL required")
def test_v11_live_owner_blocks_upgrade_and_expired_owner_is_fenced(audit_database):
    engine = create_engine(audit_database)
    config = alembic_config(audit_database.render_as_string(hide_password=False))
    generation = str(uuid4())
    try:
        command.upgrade(config, "20261022_0011")
        with engine.begin() as connection:
            connection.execute(text("INSERT INTO projects(id,name,path,format_version,metadata,created_at,updated_at) VALUES ('p','P','/tmp/Test.narrative',2,'{}',now(),now())"))
            connection.execute(text("INSERT INTO project_storage_heads(project_id,storage_generation,writer_epoch,owner_token,lease_expires_at) VALUES ('p',:generation,7,'private-test-token',clock_timestamp()+interval '60 seconds')"), {"generation": generation})
        with pytest.raises(RuntimeError, match="remote_upgrade_requires_stopped_writers"):
            command.upgrade(config, "head")
        assert "protocol_version" not in {item["name"] for item in inspect(engine).get_columns("remote_storage_control")}
        with engine.begin() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "20261022_0011"
            connection.execute(text("UPDATE project_storage_heads SET lease_expires_at=clock_timestamp()-interval '1 second'"))
        command.upgrade(config, "head")
        with engine.connect() as connection:
            assert connection.execute(text("SELECT storage_generation,writer_epoch,owner_token,lease_expires_at FROM project_storage_heads")).one() == (generation, 8, None, None)
            assert connection.scalar(text("SELECT protocol_version FROM remote_storage_control")) == 1
    finally:
        engine.dispose()

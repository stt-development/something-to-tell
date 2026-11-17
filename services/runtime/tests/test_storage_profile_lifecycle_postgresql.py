"""Actual external password rotation affects new handshakes, not authenticated clients."""

import os
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import OperationalError

from services.runtime.stt_runtime.storage_failures import storage_failure_code
from services.runtime.stt_runtime.project_format.service import PROJECT_CONFIG_FILE
from services.runtime.stt_runtime.storage_profiles import StorageProfileRegistry
from services.runtime.tests.test_remote_storage_protocol_audit import audit_database, _profile
from services.runtime.tests.test_schema_plan_context_postgresql import source

pytestmark = pytest.mark.skipif(not os.getenv("STT_TEST_POSTGRES_URL"), reason="Disposable PostgreSQL required")


def test_additive_credentials_never_replace_a_live_engine_or_revoke_its_authenticated_connection(source, tmp_path):
    admin, _, folder, _ = source
    role, first, rotated = "stt_rotation_" + uuid4().hex, uuid4().hex, uuid4().hex
    profile = _profile(admin.url).model_copy(update={"username": role, "password": first})
    profiles = StorageProfileRegistry([profile], master_key_file=tmp_path / "rotation.key")
    engine = replacement = active = None
    before = (folder.path / PROJECT_CONFIG_FILE).read_bytes()
    created = False
    try:
        with admin.begin() as connection:
            connection.exec_driver_sql(f'CREATE ROLE "{role}" LOGIN PASSWORD \'{first}\'')
        created = True
        engine = profiles.create_engine("audit", folder.path)
        active = engine.connect()
        assert active.scalar(text("SELECT current_user")) == role
        with admin.begin() as connection:
            connection.exec_driver_sql(f'ALTER ROLE "{role}" PASSWORD \'{rotated}\'')
        # PostgreSQL does not revoke this already authenticated connection.
        assert active.scalar(text("SELECT current_user")) == role
        configured = profiles.add(folder.path, label="Rotated candidate", host=profile.host, port=profile.port,
            database=profile.database, username=role, password=rotated, tls_policy="disable")
        assert engine.url == profile.database_url() and profiles.resolve("audit", folder.path).password == first
        assert configured.profile_id != profile.profile_id
        assert (folder.path / PROJECT_CONFIG_FILE).read_bytes() == before
        # The first physical connection stays checked out; a second handshake
        # on the old engine must fail rather than adopting the new definition.
        with pytest.raises(OperationalError) as caught:
            engine.connect()
        assert storage_failure_code(caught.value) == "remote_auth_failed"
        replacement = profiles.create_engine(configured.profile_id, folder.path)
        with replacement.connect() as connection:
            assert connection.scalar(text("SELECT current_user")) == role
    finally:
        if active is not None:
            active.close()
        for value in (engine, replacement):
            if value is not None:
                value.dispose()
        if created:
            with admin.begin() as connection:
                connection.exec_driver_sql(f'DROP ROLE "{role}"')

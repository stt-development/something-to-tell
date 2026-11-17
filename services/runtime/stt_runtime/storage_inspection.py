"""Compose profile-owned connections with observational schema inspection only."""

from contextlib import contextmanager
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from .project_session.errors import ProjectSessionError
from .schema_inspection import schema_snapshot, inspect_schema_connection
from .schemas.remote_storage import RemoteStorageInspectionV1
from .storage_permissions import inspection_privileges
from .storage_profiles import StorageProfileError
from .storage_failures import storage_failure_code


def inspect_storage(profiles, project_path, profile_id):
    with inspected_storage(profiles, project_path, profile_id) as (_, __, inspection):
        return inspection


@contextmanager
def inspected_storage(profiles, project_path, profile_id):
    """Keep public inspection on one read-only snapshot with shared engine cleanup."""
    with storage_profile_engine(profiles, project_path, profile_id) as (engine, profile, scripts):
        with schema_snapshot(engine) as connection:
            yield connection, scripts, inspect_storage_connection(connection, scripts, profile.tls_policy)


def inspect_storage_connection(connection, scripts, tls_policy):
    """Observe an active caller transaction without changing its mode or lifecycle."""
    if not connection.in_transaction():
        raise ProjectSessionError("remote_contract_invalid")
    major = int(connection.scalar(text("SHOW server_version_num"))) // 10000
    if not 10 <= major <= 99:
        raise ProjectSessionError("remote_server_version_unsupported")
    tls = bool(connection.scalar(text("SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()")))
    if tls != (tls_policy != "disable"):
        raise ProjectSessionError("remote_tls_failed")
    schema = inspect_schema_connection(connection, scripts)
    privileges = inspection_privileges(connection, schema_status=schema.status)
    return RemoteStorageInspectionV1(server_major=major, schema_status=schema.status,
        schema_revision=schema.revision, tls_policy=tls_policy, tls_active=tls,
        identity_verified=tls and tls_policy == "verify-full", privileges=privileges)


@contextmanager
def storage_profile_engine(profiles, project_path, profile_id):
    """Own only profile resolution, engine disposal and redaction, not transactions."""
    engine = None
    try:
        profile = profiles.resolve(profile_id, project_path)
        engine = profiles.create_engine(profile_id, project_path)
        scripts = ScriptDirectory.from_config(profiles._alembic_config())
        yield engine, profile, scripts
    except StorageProfileError:
        raise ProjectSessionError("remote_storage_binding_required") from None
    except SQLAlchemyError as error:
        raise ProjectSessionError(storage_failure_code(error)) from None
    finally:
        if engine is not None:
            engine.dispose()

"""Backup-reviewed upgrade coordination; never reopen accounts or infer recovery."""

from alembic import command
from sqlalchemy import inspect, text

from .project_session.errors import ProjectSessionError
from .schema_admin_transaction import admin_transaction, schema_admin_connection
from .schema_plan_context import capture_schema_plan_context_connection
from .schema_upgrade_preflight import require_upgrade_quiescence
from .storage_inspection import inspect_storage_connection, storage_profile_engine


def execute_upgrade(profiles, folder, request, plans):
    """Keep a committed maintenance marker on any unverified/failed upgrade."""
    with storage_profile_engine(profiles, folder.path, request.profile_id) as (engine, profile, scripts):
        with schema_admin_connection(engine) as connection:
            before = _capture(connection, scripts, folder, request.profile_id, profile.tls_policy)
            if before.maintenance:
                raise ProjectSessionError("remote_schema_busy")
            require_upgrade_quiescence(connection)
            plan = plans.claim(request, before, action="upgrade")
            if before.inspection.schema_status != "older":
                raise ProjectSessionError("remote_schema_plan_stale")
            has_control = _has_control(connection)
            if has_control:
                _commit_maintenance(engine)
                connection.execute(text("SELECT id FROM remote_storage_control WHERE id=1 FOR UPDATE"))
                require_upgrade_quiescence(connection)
            config = profiles._alembic_config()
            config.attributes["connection"] = connection
            for revision in plan.migration_revisions:
                command.upgrade(config, revision)
                if not has_control and _has_control(connection):
                    # Older schemas have no marker table: their revoked logins
                    # remain the durable fence until this transactional creation.
                    connection.execute(text("UPDATE remote_storage_control SET maintenance=true WHERE id=1"))
                    has_control = True
            if not has_control:
                raise ProjectSessionError("remote_schema_partial")
            connection.execute(text("UPDATE remote_storage_control SET maintenance=false WHERE id=1"))
            after = _capture(connection, scripts, folder, request.profile_id, profile.tls_policy)
            if (after.inspection.schema_status != "current" or after.inspection.schema_revision != plan.target_schema_revision
                    or after.authority_fingerprint != before.authority_fingerprint
                    or after.migration_revisions or after.maintenance):
                raise ProjectSessionError("remote_schema_partial")
        return after


def _commit_maintenance(engine):
    # Primary holds the advisory lock but no control-row lock yet. This separate
    # commit survives primary DDL rollback. Never return this owned connection to
    # the pool as an idle client that would invalidate the quiescence recheck.
    with engine.connect().execution_options(isolation_level="READ COMMITTED") as marker:
        try:
            with admin_transaction(marker):
                changed = marker.execute(text("UPDATE remote_storage_control SET maintenance=true WHERE id=1 AND maintenance=false"))
                if changed.rowcount != 1:
                    raise ProjectSessionError("remote_schema_busy")
        finally:
            marker.invalidate()


def _has_control(connection):
    schema = connection.scalar(text("SELECT current_schema()"))
    return "remote_storage_control" in inspect(connection).get_table_names(schema=schema)


def _capture(connection, scripts, folder, profile_id, tls_policy):
    inspection = inspect_storage_connection(connection, scripts, tls_policy)
    return capture_schema_plan_context_connection(connection, scripts, folder, profile_id, inspection)

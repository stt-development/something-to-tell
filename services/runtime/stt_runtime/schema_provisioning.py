"""Execute one reviewed empty-schema plan; never open projects or upgrade legacy data."""

from alembic import command

from .project_session.errors import ProjectSessionError
from .schema_plan_context import capture_schema_plan_context_connection
from .schema_admin_transaction import schema_admin_connection
from .storage_inspection import inspect_storage_connection, storage_profile_engine


def execute_provisioning(profiles, folder, request, plans):
    """Commit only a complete exact target; a claimed plan never revives on failure."""
    with storage_profile_engine(profiles, folder.path, request.profile_id) as (engine, profile, scripts):
        with schema_admin_connection(engine) as connection:
            before = _capture(connection, scripts, folder, request.profile_id, profile.tls_policy)
            plan = plans.claim(request, before, action="provision")
            if before.inspection.schema_status != "empty" or before.maintenance:
                raise ProjectSessionError("remote_schema_plan_stale")
            config = profiles._alembic_config()
            config.attributes["connection"] = connection
            command.upgrade(config, plan.target_schema_revision)
            after = _capture(connection, scripts, folder, request.profile_id, profile.tls_policy)
            if (after.inspection.schema_status != "current"
                    or after.inspection.schema_revision != plan.target_schema_revision
                    or after.authority_fingerprint != before.authority_fingerprint
                    or after.migration_revisions or after.maintenance):
                raise ProjectSessionError("remote_schema_partial")
        return after


def _capture(connection, scripts, folder, profile_id, tls_policy):
    inspection = inspect_storage_connection(connection, scripts, tls_policy)
    return capture_schema_plan_context_connection(connection, scripts, folder, profile_id, inspection)

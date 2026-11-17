"""Observe operator-established maintenance; never stop writers or grant/revoke access."""

from sqlalchemy import inspect, text

from .project_session.errors import ProjectSessionError


def require_upgrade_quiescence(connection):
    """Called under schema coordination by an admin, never a browser-provided snapshot."""
    if (connection.dialect.name != "postgresql" or not connection.in_transaction()
            or getattr(connection.connection.driver_connection, "autocommit", True) is not False):
        raise ProjectSessionError("remote_contract_invalid")
    # NOLOGIN/credential rotation does not terminate an already connected writer.
    # Count idle connections too; never infer safety from a missing lease table.
    # Activity snapshots also live until transaction end unless explicitly retired.
    connection.execute(text("SELECT pg_stat_clear_snapshot()"))
    if connection.scalar(text("""SELECT EXISTS (
        SELECT 1 FROM pg_catalog.pg_stat_activity
        WHERE datid=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())
          AND pid<>pg_backend_pid() AND coalesce(backend_type,'client backend')='client backend')""")):
        raise ProjectSessionError("remote_schema_busy")
    # ADR0025 trusts dormant cluster superusers, not arbitrary role names or
    # non-superuser logins that can SET ROLE to privileged accounts.
    if connection.scalar(text("""SELECT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles r
        WHERE r.rolname<>current_user AND r.rolcanlogin AND NOT r.rolsuper
          AND has_database_privilege(r.oid, current_database(), 'CONNECT')
          AND EXISTS (
              SELECT 1 FROM pg_catalog.pg_roles effective
              WHERE (effective.oid=r.oid OR pg_has_role(r.oid, effective.oid, 'SET'))
                AND (effective.rolsuper OR EXISTS (
                    SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
                    WHERE n.nspname=current_schema() AND c.relkind IN ('r','p')
                      AND (has_table_privilege(effective.oid, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE')
                           OR pg_has_role(effective.oid, c.relowner, 'USAGE'))))))""")):
        raise ProjectSessionError("remote_schema_busy")
    schema = connection.scalar(text("SELECT current_schema()"))
    if "project_storage_heads" in inspect(connection).get_table_names(schema=schema):
        # Source schema integrity/capabilities are separately verified by context
        # capture; only inspect the known shape, never invent or repair metadata.
        if connection.scalar(text("""SELECT EXISTS (SELECT 1 FROM project_storage_heads
            WHERE owner_token IS NOT NULL AND lease_expires_at>clock_timestamp())""")):
            raise ProjectSessionError("remote_schema_busy")

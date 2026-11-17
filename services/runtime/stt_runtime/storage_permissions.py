"""Read-only PostgreSQL ACL checks; profile health never attempts DDL or DML."""

from sqlalchemy import text

from .db.base import Base, import_model_metadata


_OPERATIONAL_GRANTS = {
    "remote_storage_control": ("SELECT",),
    "project_storage_heads": ("SELECT", "INSERT", "UPDATE"),
    "remote_command_receipts": ("SELECT", "INSERT"),
    "remote_saved_checkpoints": ("SELECT", "INSERT", "DELETE"),
    "alembic_version": ("SELECT",),
}


def profile_permissions_valid(connection, *, empty_schema: bool) -> bool:
    """Inspect the current role, not an administrator impersonated by a probe."""
    schema = connection.execute(text("""
        SELECT has_schema_privilege(current_schema(), 'USAGE') AS usable,
               has_schema_privilege(current_schema(), 'CREATE') AS creatable
    """)).mappings().one()
    if not schema["usable"]:
        return False
    if empty_schema:
        return bool(schema["creatable"])

    import_model_metadata()
    rows = connection.execute(text("""
        SELECT c.relname,
               has_table_privilege(c.oid, 'SELECT') AS "SELECT",
               has_table_privilege(c.oid, 'INSERT') AS "INSERT",
               has_table_privilege(c.oid, 'UPDATE') AS "UPDATE",
               has_table_privilege(c.oid, 'DELETE') AS "DELETE",
               has_any_column_privilege(c.oid, 'UPDATE') AS lock_update
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p')
    """)).mappings()
    tables = {row["relname"]: row for row in rows}
    for name in set(Base.metadata.tables) | {"alembic_version"}:
        grants = _OPERATIONAL_GRANTS.get(name, ("SELECT", "INSERT", "UPDATE", "DELETE"))
        row = tables.get(name)
        # Check every grant: has_table_privilege(..., 'SELECT,UPDATE') means ANY.
        if row is None or not all(row[grant] for grant in grants):
            return False
    # FOR SHARE needs UPDATE on at least one column, even without a data mutation.
    return bool(tables["remote_storage_control"]["lock_update"])


def inspection_privileges(connection, *, schema_status: str) -> str:
    """Report an effective capability candidate, never authorize future DDL."""
    administrator = connection.scalar(text("""
        SELECT coalesce(has_schema_privilege(current_schema(), 'USAGE')
                    AND has_schema_privilege(current_schema(), 'CREATE'), false)
           AND NOT EXISTS (
               SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n
                 ON n.oid=c.relnamespace
               WHERE n.nspname=current_schema() AND NOT pg_has_role(c.relowner, 'USAGE')
           )
    """))
    if administrator:
        return "administrator"
    if schema_status == "current" and profile_permissions_valid(connection, empty_schema=False):
        return "runtime"
    return "insufficient"

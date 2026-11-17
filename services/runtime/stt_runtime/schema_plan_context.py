"""Read-only trusted plan observations, never caller-provided DB identities or DDL."""

from hashlib import sha256
import json

from sqlalchemy import Text, cast, column, func, inspect, select, table, text
from sqlalchemy.dialects.postgresql import aggregate_order_by

from .project_format.service import ProjectFolder
from .project_session.errors import ProjectSessionError
from .schema_plans import SchemaPlanContext
from .schemas.remote_storage import REMOTE_SUPPORTED_POSTGRES_MAJORS
from .storage_inspection import inspected_storage


# Hash definitions on the server: no function/view bodies or default expressions
# leave SQL. Exclude volatile relation statistics and ordinary application rows.
_CATALOG_FINGERPRINT = text("""
    SELECT encode(sha256(convert_to(jsonb_build_object(
      'namespace', (SELECT to_jsonb(n) FROM pg_catalog.pg_namespace n WHERE n.oid=:schema),
      'relations', (SELECT jsonb_agg(jsonb_build_array(c.oid,c.relname,c.relkind,c.relpersistence,
          c.relowner,c.relacl,c.reloptions,c.relrowsecurity,c.relforcerowsecurity,
          CASE WHEN c.relkind IN ('v','m') THEN pg_catalog.pg_get_viewdef(c.oid,true) END) ORDER BY c.oid)
          FROM pg_catalog.pg_class c WHERE c.relnamespace=:schema),
      'columns', (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.attrelid,a.attnum)
          FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
          WHERE c.relnamespace=:schema AND a.attnum>0),
      'defaults', (SELECT jsonb_agg(to_jsonb(d) ORDER BY d.oid)
          FROM pg_catalog.pg_attrdef d JOIN pg_catalog.pg_class c ON c.oid=d.adrelid WHERE c.relnamespace=:schema),
      'constraints', (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.oid)
          FROM pg_catalog.pg_constraint c WHERE c.connamespace=:schema),
      'indexes', (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.indexrelid)
          FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indrelid WHERE c.relnamespace=:schema),
      'procedures', (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid)
          FROM pg_catalog.pg_proc p WHERE p.pronamespace=:schema),
      'types', (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid)
          FROM pg_catalog.pg_type t WHERE t.typnamespace=:schema),
      'enums', (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.oid)
          FROM pg_catalog.pg_enum e JOIN pg_catalog.pg_type t ON t.oid=e.enumtypid WHERE t.typnamespace=:schema),
      'policies', (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid)
          FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid WHERE c.relnamespace=:schema),
      'rules', (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.oid)
          FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid=r.ev_class WHERE c.relnamespace=:schema),
      'triggers', (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid)
          FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace=:schema),
      'sequences', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.seqrelid)
          FROM pg_catalog.pg_sequence s JOIN pg_catalog.pg_class c ON c.oid=s.seqrelid WHERE c.relnamespace=:schema)
    )::text,'UTF8')),'hex')
""")

_HEAD_FIELDS = ("project_id", "storage_generation", "writer_epoch", "authoring_revision",
                "saved_authoring_revision", "saved_revision")


def _fingerprint(value):
    return sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()


def _operational_observation(connection, schema, required):
    inspector = inspect(connection)
    tables = set(inspector.get_table_names(schema=schema))
    control, heads, maintenance = None, None, False
    partial = required and not {"remote_storage_control", "project_storage_heads"}.issubset(tables)
    if "remote_storage_control" in tables:
        names = {item["name"] for item in inspector.get_columns("remote_storage_control", schema=schema)}
        if not {"id", "maintenance"}.issubset(names):
            partial = True
        else:
            resource = table("remote_storage_control", column("id"), schema=schema)
            control = list(connection.scalars(select(func.to_jsonb(resource.table_valued())).order_by(resource.c.id).limit(2)))
            if (len(control) != 1 or type(control[0].get("id")) is not int or control[0]["id"] != 1
                    or type(control[0].get("maintenance")) is not bool):
                partial = True
            else:
                maintenance = control[0]["maintenance"]
    if "project_storage_heads" in tables:
        names = {item["name"] for item in inspector.get_columns("project_storage_heads", schema=schema)}
        if not set(_HEAD_FIELDS).issubset(names):
            partial = True
        else:
            resource = table("project_storage_heads", *(column(name) for name in _HEAD_FIELDS), schema=schema)
            rows = func.jsonb_agg(aggregate_order_by(func.jsonb_build_array(*resource.c), resource.c.project_id))
            heads = connection.scalar(select(func.encode(func.sha256(func.convert_to(
                func.coalesce(cast(rows, Text), "[]"), "UTF8")), "hex")))
    return dict(control=control, heads=heads), maintenance, partial


def capture_schema_plan_context(profiles, folder: ProjectFolder, profile_id: str) -> SchemaPlanContext:
    """Caller authorizes the canonical folder; all DB observations come from one snapshot."""
    with inspected_storage(profiles, folder.path, profile_id) as (connection, scripts, inspection):
        return capture_schema_plan_context_connection(connection, scripts, folder, profile_id, inspection)


def capture_schema_plan_context_connection(connection, scripts, folder: ProjectFolder, profile_id: str, inspection) -> SchemaPlanContext:
    """Caller supplies same-connection inspection; this reader never starts/finalizes SQL."""
    if not connection.in_transaction():
        raise ProjectSessionError("remote_contract_invalid")
    if inspection.server_major not in REMOTE_SUPPORTED_POSTGRES_MAJORS:
        raise ProjectSessionError("remote_server_version_unsupported")
    if inspection.privileges != "administrator":
        raise ProjectSessionError("remote_admin_required")
    identity = connection.execute(text("""
        SELECT s.system_identifier::text AS cluster, d.oid::text AS database,
               n.oid::text AS namespace, n.nspname AS schema_name, r.oid::text AS role
        FROM pg_catalog.pg_control_system() s
        JOIN pg_catalog.pg_database d ON d.datname=current_database()
        JOIN pg_catalog.pg_namespace n ON n.nspname=current_schema()
        JOIN pg_catalog.pg_roles r ON r.rolname=current_user
    """)).mappings().one_or_none()
    if identity is None:
        raise ProjectSessionError("remote_schema_unknown")
    known = {revision.revision for revision in scripts.walk_revisions()}
    source = inspection.schema_revision
    eligible = inspection.schema_status == "empty" or source in known
    steps = tuple(revision.revision for revision in reversed(list(
        scripts.iterate_revisions("head", source or "base")))) if eligible else ()
    required = source in known and "20261022_0011" in {
        revision.revision for revision in scripts.iterate_revisions(source, "base")}
    operational, maintenance, partial = _operational_observation(connection, identity["schema_name"], required)
    if partial:
        inspection = inspection.model_copy(update={"schema_status": "partial"})
    catalog = connection.scalar(_CATALOG_FINGERPRINT, {"schema": int(identity["namespace"])})
    return SchemaPlanContext(project_id=folder.project_id, profile_id=profile_id,
        authority_fingerprint=_fingerprint(dict(identity)),
        schema_fingerprint=_fingerprint(dict(catalog=catalog, operational=operational)),
        inspection=inspection, target_schema_revision=scripts.get_current_head(),
        migration_revisions=steps, maintenance=maintenance)

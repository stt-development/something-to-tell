"""Observational schema compatibility, not migration or write authorization."""

from dataclasses import dataclass
from contextlib import contextmanager
from datetime import datetime
import re

from alembic.script import ScriptDirectory
from pydantic import TypeAdapter, ValidationError
from sqlalchemy import Column, Engine, MetaData, String, Table, inspect, select, text

from .db.base import Base, import_model_metadata
from .schemas.remote_storage import RemoteSchemaRevision, RemoteSchemaStatus


@dataclass(frozen=True)
class SchemaInspection:
    status: RemoteSchemaStatus
    revision: str | None


def _revision_order(value: str):
    if not re.fullmatch(r"[0-9]{8}_[0-9]{4}", value):
        return None
    try:
        return datetime.strptime(value[:8], "%Y%m%d").date(), int(value[9:])
    except ValueError:
        return None


def classify_revision(revisions, *, head: str, known: set[str], current_complete: bool) -> SchemaInspection:
    """Unknown text never becomes a known ancestor through lexical sorting."""
    if len(revisions) != 1:
        return SchemaInspection("partial", None)
    try:
        revision = TypeAdapter(RemoteSchemaRevision).validate_python(revisions[0], strict=True)
    except ValidationError:
        return SchemaInspection("unknown", None)
    if revision == head:
        return SchemaInspection("current" if current_complete else "partial", revision)
    if revision in known:
        return SchemaInspection("older", revision)
    observed, expected = _revision_order(revision), _revision_order(head)
    if observed and expected and observed[0] >= expected[0] and observed[1] > expected[1]:
        return SchemaInspection("future", revision)
    return SchemaInspection("unknown", revision if observed else None)


def _current_structure_complete(inspector, schema: str, tables: set[str]) -> bool:
    import_model_metadata()
    if not set(Base.metadata.tables).issubset(tables):
        return False
    for name, expected in Base.metadata.tables.items():
        columns = {item["name"]: item for item in inspector.get_columns(name, schema=schema)}
        for column in expected.columns:
            actual = columns.get(column.name)
            if actual is None or not isinstance(actual["type"], type(column.type)):
                return False
            if not column.nullable and actual["nullable"]:
                return False
        primary = inspector.get_pk_constraint(name, schema=schema)["constrained_columns"]
        if tuple(primary) != tuple(column.name for column in expected.primary_key.columns):
            return False
        expected_fks = {(tuple(element.parent.name for element in fk.elements), fk.referred_table.name,
                         tuple(element.column.name for element in fk.elements), (fk.ondelete or "NO ACTION").upper())
                        for fk in expected.foreign_key_constraints}
        actual_fks = {(tuple(fk["constrained_columns"]), fk["referred_table"], tuple(fk["referred_columns"]),
                       fk.get("options", {}).get("ondelete", "NO ACTION").upper())
                      for fk in inspector.get_foreign_keys(name, schema=schema)
                      if fk["referred_schema"] in {None, schema}}
        if expected_fks != actual_fks:
            return False
    return True


@contextmanager
def schema_snapshot(engine: Engine):
    """Compose schema, TLS and capability reads without mixing SQL snapshots."""
    if engine.dialect.name != "postgresql":
        raise ValueError("PostgreSQL schema inspection requires a PostgreSQL engine")
    with engine.connect().execution_options(isolation_level="REPEATABLE READ") as connection:
        connection.execute(text("SET TRANSACTION READ ONLY"))
        connection.execute(text("SET LOCAL lock_timeout='3s'"))
        connection.execute(text("SET LOCAL statement_timeout='10s'"))
        yield connection


def inspect_schema(engine: Engine, scripts: ScriptDirectory) -> SchemaInspection:
    """Capture one schema under bounded SQL; caller still owns engine disposal."""
    with schema_snapshot(engine) as connection:
        return inspect_schema_connection(connection, scripts)


def inspect_schema_connection(connection, scripts: ScriptDirectory) -> SchemaInspection:
    """Observe the caller's transaction without writes, commit or connection close."""
    head = scripts.get_current_head()
    if head is None:
        raise ValueError("The application migration chain must have one head")
    known = {revision.revision for revision in scripts.walk_revisions()}
    schema = connection.scalar(text("SELECT current_schema()"))
    if schema is None:
        return SchemaInspection("unknown", None)
    inspector = inspect(connection)
    tables = set(inspector.get_table_names(schema=schema))
    if "alembic_version" not in tables:
        # Views, standalone types and functions also make a schema nonempty.
        occupied = connection.scalar(text("""
            SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n
                          ON n.oid=c.relnamespace WHERE n.nspname=:schema)
                OR EXISTS(SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n
                          ON n.oid=t.typnamespace WHERE n.nspname=:schema)
                OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n
                          ON n.oid=p.pronamespace WHERE n.nspname=:schema)
        """), {"schema": schema})
        return SchemaInspection("unknown" if occupied else "empty", None)
    columns = inspector.get_columns("alembic_version", schema=schema)
    if {column["name"] for column in columns} != {"version_num"}:
        return SchemaInspection("partial", None)
    version = Table("alembic_version", MetaData(), Column("version_num", String), schema=schema)
    # Two rows already prove unsupported branch/partial state; never read an unbounded ledger.
    revisions = list(connection.scalars(select(version.c.version_num).limit(2)))
    current_complete = revisions != [head] or _current_structure_complete(inspector, schema, tables)
    return classify_revision(revisions, head=head, known=known, current_complete=current_complete)

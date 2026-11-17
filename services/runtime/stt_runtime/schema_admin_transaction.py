"""Shared schema coordination and bounded commit classification, not plan ownership."""

from contextlib import contextmanager

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from .project_session.errors import ProjectSessionError
from .schemas.remote_storage import (
    REMOTE_LOCK_TIMEOUT_SECONDS, REMOTE_STATEMENT_TIMEOUT_SECONDS,
    REMOTE_TRANSACTION_TIMEOUT_SECONDS, REMOTE_SUPPORTED_POSTGRES_MAJORS,
)

SCHEMA_MIGRATION_LOCK = text("""SELECT pg_advisory_xact_lock(
    hashtextextended('something-to-tell:schema:' || current_schema(), 0))""")


@contextmanager
def admin_transaction(connection):
    """Known-completed body does not prove COMMIT acknowledgement arrived."""
    validated = False
    try:
        with connection.begin():
            major = int(connection.scalar(text("SHOW server_version_num"))) // 10000
            if major not in REMOTE_SUPPORTED_POSTGRES_MAJORS:
                raise ProjectSessionError("remote_server_version_unsupported")
            for name, seconds in (("lock_timeout", REMOTE_LOCK_TIMEOUT_SECONDS),
                                  ("statement_timeout", REMOTE_STATEMENT_TIMEOUT_SECONDS),
                                  ("transaction_timeout", REMOTE_TRANSACTION_TIMEOUT_SECONDS)):
                connection.execute(text("SELECT set_config(:name, :value, true)"),
                                   {"name": name, "value": f"{seconds}s"})
            yield
            validated = True
    except SQLAlchemyError:
        if validated:
            raise ProjectSessionError("remote_commit_unknown") from None
        raise


@contextmanager
def schema_admin_connection(engine):
    """Use a post-wait READ COMMITTED view, never a pre-lock immutable snapshot."""
    if engine.dialect.name != "postgresql":
        raise ProjectSessionError("remote_contract_invalid")
    with engine.connect().execution_options(isolation_level="READ COMMITTED") as connection:
        with admin_transaction(connection):
            try:
                connection.execute(SCHEMA_MIGRATION_LOCK)
            except SQLAlchemyError as error:
                if getattr(getattr(error, "orig", None), "sqlstate", None) == "55P03":
                    raise ProjectSessionError("remote_schema_busy") from None
                raise
            yield connection

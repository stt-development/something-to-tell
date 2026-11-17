"""MVCC capture followed by a short, non-authoring head guard for installation."""

from contextlib import contextmanager
from sqlalchemy import text
from time import monotonic

from .errors import ProjectSessionError
from .remote_store import capture, row_for
from .remote_files import sync_active
from ..export.installation_guard import installation_check


def remote_token(row):
    return row["storage_generation"], str(row["authoring_revision"]), row["checksum"]


@contextmanager
def document_guard(active, expected=None):
    document, row = capture(active.session_factory, active.manifest.project_id)
    sync_active(active, document, row)
    token = remote_token(row)
    if expected is not None and token != expected:
        raise ProjectSessionError("remote_revision_stale")
    # READ COMMITTED, not READ ONLY: FOR SHARE conflicts with owner/write locks.
    with active.engine.connect().execution_options(remote_read_probe=True) as connection:
        with connection.begin():
            locked = row_for(connection, active.manifest.project_id, shared=True)
            if remote_token(locked) != token:
                raise ProjectSessionError("remote_revision_stale")
            started = monotonic()
            def check():
                if monotonic() - started >= 20:
                    raise ProjectSessionError("remote_storage_timeout")
                connection.execute(text("SELECT 1"))
            context_token = installation_check.set(check)
            try:
                yield document, active.path
                check()
            finally:
                installation_check.reset(context_token)

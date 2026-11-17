"""Pure redacted connection diagnostics; never retry, log driver text or switch TLS."""

import re

from psycopg import OperationalError
from psycopg.errors import ConnectionTimeout
from sqlalchemy.exc import TimeoutError as PoolTimeout


def storage_failure_code(error: Exception) -> str:
    """Prefer structured failures; unknown/localized handshake text fails conservatively."""
    original = getattr(error, "orig", error)
    state = getattr(original, "sqlstate", None)
    if state and state.startswith("28"):
        return "remote_auth_failed"
    if state == "42501":
        return "remote_admin_required"
    if state in {"57014", "55P03", "25P04"} or isinstance(error, PoolTimeout) or isinstance(original, ConnectionTimeout):
        return "remote_storage_timeout"
    if isinstance(original, OperationalError) and not state:
        # libpq handshake failures have no SQL result/SQLSTATE. Bound examination
        # to known diagnostics; return only our enum, never this private message.
        message = str(original)[:16384]
        if re.search(r"FATAL:\s+(?:password authentication failed|no pg_hba.conf entry|role .* does not exist)", message):
            return "remote_auth_failed"
        if re.search(r"SSL error:.*certificate verify failed|server certificate .* does not match host name"
                     r"|root certificate file .* does not exist|could not (?:read|load) root certificate file"
                     r"|server does not support SSL, but SSL was required", message):
            return "remote_tls_failed"
    return "remote_storage_unavailable"

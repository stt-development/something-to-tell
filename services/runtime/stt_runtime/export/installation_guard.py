"""A narrow last-moment publication precondition, supplied by the source authority."""

from contextvars import ContextVar
from collections.abc import Callable

installation_check: ContextVar[Callable[[], None] | None] = ContextVar("export_installation_check", default=None)


def check_installation():
    callback = installation_check.get()
    if callback is not None:
        callback()

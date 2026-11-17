"""Non-thread-affine guard with request-owned nesting for FastAPI dependencies."""

from threading import Lock, get_ident
from .remote_context import request_intent


class SessionWriteGuard:
    def __init__(self):
        self._lock = Lock()
        self._owner = None
        self._depth = 0

    def __enter__(self):
        intent = request_intent.get()
        owner = id(intent) if intent is not None else ("thread", get_ident())
        if self._owner != owner:
            self._lock.acquire()
            self._owner = owner
        self._depth += 1
        return self

    def __exit__(self, *_):
        self._depth -= 1
        if self._depth == 0:
            self._owner = None
            self._lock.release()

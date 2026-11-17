"""Request identity and borrowed SQL transaction state, never a second session owner."""

from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any


@dataclass
class RemoteIntent:
    version: str | None
    headers: dict[str, str]
    kind: str
    payload: Any
    target: dict[str, str]
    receipt: Any = None
    transaction: Any = None


@dataclass
class RemoteTransaction:
    factory: Any
    session: Any
    before: Any
    manifest: Any
    saved: bool = False


request_intent: ContextVar[RemoteIntent | None] = ContextVar("remote_request", default=None)
transaction: ContextVar[RemoteTransaction | None] = ContextVar("remote_transaction", default=None)


def current_transaction(factory):
    intent = request_intent.get()
    current = intent.transaction if intent is not None else transaction.get()
    return current if current is not None and current.factory is factory else None

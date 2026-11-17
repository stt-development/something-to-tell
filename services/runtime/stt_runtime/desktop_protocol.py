"""Bounded private-pipe wire frames; validation errors never contain input tokens."""

import json
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

DESKTOP_PROTOCOL_VERSION = 1
DESKTOP_MAX_FRAME_BYTES = 4096
DESKTOP_BOOTSTRAP_TIMEOUT_SECONDS = 5
DESKTOP_READY_TIMEOUT_SECONDS = 15
DESKTOP_SHUTDOWN_TIMEOUT_SECONDS = 10


class _Frame(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True, hide_input_in_errors=True)
    protocol_version: Literal[1]

    @field_validator("protocol_version", mode="before")
    @classmethod
    def exact_version(cls, value):
        if type(value) is not int or value != DESKTOP_PROTOCOL_VERSION:
            raise ValueError("desktop_protocol_unsupported")
        return value


class DesktopBootstrapV1(_Frame):
    type: Literal["bootstrap"]
    token: str = Field(min_length=43, max_length=128, pattern=r"^[A-Za-z0-9_-]+$", repr=False)


class DesktopShutdownV1(_Frame):
    type: Literal["shutdown"]


class DesktopReadyV1(_Frame):
    type: Literal["ready"]
    port: int = Field(ge=1, le=65535)
    pid: int = Field(ge=1, le=2147483647)
    runtime_version: str = Field(min_length=1, max_length=64, pattern=r"^[0-9]+\.[0-9]+\.[0-9]+$")


class DesktopErrorV1(_Frame):
    type: Literal["error"]
    code: Literal["desktop_bootstrap_invalid", "desktop_startup_failed", "desktop_control_invalid"]


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate")
        value[key] = item
    return value


def parse_frame(frame: bytes, model: type[_Frame]) -> _Frame:
    """Reject oversized, ambiguous or unsupported input without echoing its bytes."""
    try:
        if not isinstance(frame, bytes) or len(frame) > DESKTOP_MAX_FRAME_BYTES or not frame.endswith(b"\n"):
            raise ValueError("frame")
        payload = json.loads(frame.decode("utf-8"), object_pairs_hook=_unique_object)
        return model.model_validate(payload)
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise ValueError("desktop_frame_invalid") from None

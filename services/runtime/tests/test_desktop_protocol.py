"""Shared private-wire examples use a deliberately fake token, never credentials."""

import json
from pathlib import Path
import re

import pytest

from services.runtime.stt_runtime import desktop_protocol as wire

ROOT = Path(__file__).parents[3]
FIXTURE = json.loads((ROOT / "packages/contracts/fixtures/desktop-runtime-v1.json").read_text())


def test_shared_frame_fixtures_round_trip_with_strict_models():
    for name, model in (("bootstrap", wire.DesktopBootstrapV1), ("shutdown", wire.DesktopShutdownV1),
                        ("ready", wire.DesktopReadyV1), ("error", wire.DesktopErrorV1)):
        frame = json.dumps(FIXTURE[name]).encode() + b"\n"
        assert wire.parse_frame(frame, model).model_dump() == FIXTURE[name]
    assert FIXTURE["bootstrap"]["token"] not in repr(wire.parse_frame(
        json.dumps(FIXTURE["bootstrap"]).encode() + b"\n", wire.DesktopBootstrapV1))


def test_python_typescript_and_golden_limits_agree():
    source = (ROOT / "packages/contracts/src/desktopRuntime.ts").read_text()
    for suffix, expected in FIXTURE["constants"].items():
        name = "DESKTOP_PROTOCOL_VERSION" if suffix == "version" else "DESKTOP_" + suffix.upper()
        assert getattr(wire, name) == expected
        assert re.search(rf"export const {name} = {expected}(?: as const)?;", source)


@pytest.mark.parametrize("payload", [
    b"{}", b"not-json\n", b"[]\n", b"\xff\n", b"a" * 4097 + b"\n",
    b'{"protocol_version":1,"protocol_version":1,"type":"shutdown"}\n',
    b'{"protocol_version":true,"type":"shutdown"}\n',
    b'{"protocol_version":2,"type":"shutdown"}\n',
    b'{"protocol_version":1,"type":"shutdown","private-secret":"value"}\n',
])
def test_invalid_frames_have_one_redacted_error(payload):
    with pytest.raises(ValueError) as failure:
        wire.parse_frame(payload, wire.DesktopShutdownV1)
    assert str(failure.value) == "desktop_frame_invalid"


@pytest.mark.parametrize("token", ["short", "x" * 129, "x" * 43 + "\n", "я" * 43, True])
def test_bootstrap_rejects_bad_token_without_echo(token):
    payload = {**FIXTURE["bootstrap"], "token": token}
    with pytest.raises(ValueError, match="^desktop_frame_invalid$"):
        wire.parse_frame(json.dumps(payload).encode() + b"\n", wire.DesktopBootstrapV1)


@pytest.mark.parametrize("change", [{"port": 0}, {"port": 65536}, {"port": True}, {"pid": 0}, {"runtime_version": "private/path"}])
def test_ready_identity_is_bounded(change):
    payload = {**FIXTURE["ready"], **change}
    with pytest.raises(ValueError, match="^desktop_frame_invalid$"):
        wire.parse_frame(json.dumps(payload).encode() + b"\n", wire.DesktopReadyV1)

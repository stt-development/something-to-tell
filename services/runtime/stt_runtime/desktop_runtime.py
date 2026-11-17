"""Own one loopback listener controlled only through the parent's private stdin."""

import asyncio
import json
import os
from queue import Empty, Queue
import socket
from threading import Thread

import uvicorn

from . import __version__
from .app import create_app
from .core.config import RuntimeSettings
from .desktop_protocol import (
    DESKTOP_BOOTSTRAP_TIMEOUT_SECONDS, DESKTOP_MAX_FRAME_BYTES,
    DESKTOP_PROTOCOL_VERSION, DESKTOP_READY_TIMEOUT_SECONDS, DESKTOP_SHUTDOWN_TIMEOUT_SECONDS,
    DesktopBootstrapV1, DesktopReadyV1, DesktopShutdownV1, parse_frame,
)


class _PrivateInput:
    """Bounded daemon reader uses raw OS reads, not locked buffered stdin at exit."""
    def __init__(self, descriptor: int):
        self._frames = Queue(maxsize=4)
        Thread(target=self._read, args=(descriptor,), daemon=True,
               name="desktop-control-input").start()

    def _read(self, descriptor):
        frame = bytearray()
        try:
            while True:
                value = os.read(descriptor, 1)
                if not value:
                    self._frames.put(None)
                    return
                frame.extend(value)
                if len(frame) > DESKTOP_MAX_FRAME_BYTES:
                    self._frames.put(b"")  # Invalid marker, never retain an unbounded input.
                    return
                if value == b"\n":
                    self._frames.put(bytes(frame))
                    frame.clear()
        except OSError:
            self._frames.put(None)

    async def next_frame(self):
        while True:
            try:
                return self._frames.get_nowait()
            except Empty:
                await asyncio.sleep(0.02)


def _emit(output, payload):
    output.write(json.dumps(payload, separators=(",", ":")) + "\n")
    output.flush()


def _production_settings():
    """Do not load launch-directory dotenv, development origins or docs in a bundle."""
    return RuntimeSettings(
        _env_file=None, host="127.0.0.1", port=0, reload=False, docs_enabled=False,
        allowed_origins=("tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"),
    )


async def _serve(bootstrap: DesktopBootstrapV1, reader: _PrivateInput, output):
    app = create_app(_production_settings(), desktop_token=bootstrap.token)
    server = uvicorn.Server(uvicorn.Config(
        app, host="127.0.0.1", port=0, access_log=False, log_config=None,
        log_level="critical", ws="none", lifespan="on",
        timeout_graceful_shutdown=DESKTOP_SHUTDOWN_TIMEOUT_SECONDS,
    ))
    # Keep this bound socket for the entire server lifetime: no free-port race.
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server_task = control_task = None
    try:
        listener.bind(("127.0.0.1", 0))
        listener.listen(128)
        listener.setblocking(False)
        server_task = asyncio.create_task(server.serve(sockets=[listener]))

        async def ready():
            while not server.started:
                if server_task.done():
                    raise RuntimeError("desktop_startup_failed")
                await asyncio.sleep(0.02)
        await asyncio.wait_for(ready(), DESKTOP_READY_TIMEOUT_SECONDS)
        frame = DesktopReadyV1(protocol_version=DESKTOP_PROTOCOL_VERSION, type="ready",
                               port=listener.getsockname()[1], pid=os.getpid(), runtime_version=__version__)
        _emit(output, frame.model_dump())
        control_task = asyncio.create_task(reader.next_frame())
        done, _ = await asyncio.wait((server_task, control_task), return_when=asyncio.FIRST_COMPLETED)
        if control_task not in done:
            raise RuntimeError("desktop_startup_failed")
        control = control_task.result()
        if control is not None:
            try:
                parse_frame(control, DesktopShutdownV1)
            except ValueError:
                raise RuntimeError("desktop_control_invalid") from None
    finally:
        if control_task is not None:
            control_task.cancel()
            await asyncio.gather(control_task, return_exceptions=True)
        server.should_exit = True
        try:
            if server_task is not None:
                try:
                    await asyncio.wait_for(asyncio.shield(server_task), DESKTOP_SHUTDOWN_TIMEOUT_SECONDS)
                except (asyncio.TimeoutError, asyncio.CancelledError):
                    server_task.cancel()
                    await asyncio.gather(server_task, return_exceptions=True)
                    raise RuntimeError("desktop_startup_failed") from None
        finally:
            listener.close()


async def run_desktop(input_descriptor: int, output) -> int:
    """Read one bootstrap, serve one owned socket, stop on explicit shutdown/EOF."""
    reader = _PrivateInput(input_descriptor)
    try:
        raw = await asyncio.wait_for(reader.next_frame(), DESKTOP_BOOTSTRAP_TIMEOUT_SECONDS)
        bootstrap = parse_frame(raw, DesktopBootstrapV1)
    except (ValueError, asyncio.TimeoutError):
        _emit(output, {"protocol_version": 1, "type": "error", "code": "desktop_bootstrap_invalid"})
        return 1
    try:
        await _serve(bootstrap, reader, output)
    except Exception as error:
        # The private pipe carries only stable codes, never provider/driver/input text.
        code = "desktop_control_invalid" if str(error) == "desktop_control_invalid" else "desktop_startup_failed"
        _emit(output, {"protocol_version": 1, "type": "error", "code": code})
        return 1
    return 0

"""Windows lock checks query owned handles, never use kill(signal=0)."""

import ctypes
from ctypes import wintypes
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from services.runtime.stt_runtime.project_session import process_liveness as liveness


@pytest.mark.parametrize("pid", [0, -1, True, "123"])
def test_invalid_pid_is_not_probed(pid):
    assert liveness.process_alive(pid) is False


@pytest.mark.parametrize("error,expected", [(None, True), (ProcessLookupError(), False), (PermissionError(), True)])
def test_posix_probe_preserves_existing_semantics(monkeypatch, error, expected):
    kill = Mock(side_effect=error)
    monkeypatch.setattr(liveness, "sys", SimpleNamespace(platform="linux"))
    monkeypatch.setattr(liveness, "os", SimpleNamespace(kill=kill))
    assert liveness.process_alive(123) is expected
    kill.assert_called_once_with(123, 0)


@pytest.mark.parametrize("handle,error,exit_code,query_ok,expected", [
    (0, 87, 0, True, False), (0, 5, 0, True, True), (0, 6, 0, True, True),
    (42, 0, 259, True, True), (42, 0, 0, True, False),
    (42, 0, 17, True, False), (42, 0, 0, False, True),
])
def test_windows_uses_read_only_exit_code_query_and_closes_handle(monkeypatch, handle, error, exit_code, query_ok, expected):
    def query(actual_handle, pointer):
        assert actual_handle == handle
        ctypes.cast(pointer, ctypes.POINTER(wintypes.DWORD)).contents.value = exit_code
        return query_ok

    kernel = SimpleNamespace(OpenProcess=Mock(return_value=handle),
                             GetExitCodeProcess=Mock(side_effect=query), CloseHandle=Mock())
    loader = Mock(return_value=kernel)
    monkeypatch.setattr(ctypes, "WinDLL", loader, raising=False)
    monkeypatch.setattr(ctypes, "get_last_error", lambda: error, raising=False)
    monkeypatch.setattr(liveness, "sys", SimpleNamespace(platform="win32"))
    monkeypatch.setattr(liveness, "os", SimpleNamespace(kill=Mock(side_effect=AssertionError("Windows must not signal"))))
    assert liveness.process_alive(123) is expected
    kernel.OpenProcess.assert_called_once_with(0x1000, False, 123)
    loader.assert_called_once_with("kernel32", use_last_error=True)
    if handle:
        kernel.CloseHandle.assert_called_once_with(handle)
    else:
        kernel.CloseHandle.assert_not_called()


def test_windows_oversized_pid_cannot_wrap_to_another_owner(monkeypatch):
    loader = Mock(side_effect=AssertionError("Invalid PID must not reach the OS"))
    monkeypatch.setattr(ctypes, "WinDLL", loader, raising=False)
    assert liveness._windows_process_alive(0x100000000) is False


def test_windows_query_failure_keeps_owner_protected_and_releases_handle(monkeypatch):
    kernel = SimpleNamespace(OpenProcess=Mock(return_value=42),
        GetExitCodeProcess=Mock(side_effect=OSError("unavailable")), CloseHandle=Mock())
    monkeypatch.setattr(ctypes, "WinDLL", Mock(return_value=kernel), raising=False)
    assert liveness._windows_process_alive(123) is True
    kernel.CloseHandle.assert_called_once_with(42)

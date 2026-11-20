"""Read-only local lock-owner liveness; never signal or terminate Windows owners."""

import os
import sys


def process_alive(pid: int) -> bool:
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        return False
    if sys.platform == "win32":
        return _windows_process_alive(pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _windows_process_alive(pid: int) -> bool:
    import ctypes
    from ctypes import wintypes

    if pid > 0xFFFFFFFF:
        return False
    try:
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        kernel.GetExitCodeProcess.restype = wintypes.BOOL
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        # QUERY_LIMITED_INFORMATION has no termination, mutation or signal authority.
        handle = kernel.OpenProcess(0x1000, False, pid)
    except OSError:
        return True
    if not handle:
        # INVALID_PARAMETER means no such PID; access denied/unknown remain protected.
        return ctypes.get_last_error() != 87
    try:
        code = wintypes.DWORD()
        if not kernel.GetExitCodeProcess(handle, ctypes.byref(code)):
            return True
        return code.value == 259  # STILL_ACTIVE; an exited-but-retained PID is stale.
    except OSError:
        return True
    finally:
        kernel.CloseHandle(handle)

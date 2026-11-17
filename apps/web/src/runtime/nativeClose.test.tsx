import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { registerNativeCloseHandler, requestNativeProjectClose, resolveNativeClose, useNativeCloseRequests } from "./nativeClose";

afterEach(() => { delete window.__TAURI_INTERNALS__; });

it("routes a request through the current workspace owner instead of approving automatically", async () => {
  const invoke = vi.fn(async () => null);
  window.__TAURI_INTERNALS__ = { invoke };
  const owner = vi.fn(async () => {});
  const unregister = registerNativeCloseHandler(owner);
  try {
    await requestNativeProjectClose(4);
    expect(owner).toHaveBeenCalledWith(4);
    expect(invoke).not.toHaveBeenCalled();
  } finally { unregister(); }
  await requestNativeProjectClose(5);
  expect(invoke).toHaveBeenCalledWith("resolve_native_close", { requestId: 5, approve: true });
});

it("cannot let an old workspace cleanup remove a newer handler", async () => {
  const removeOld = registerNativeCloseHandler(vi.fn());
  const owner = vi.fn();
  const removeNew = registerNativeCloseHandler(owner);
  try { removeOld(); await requestNativeProjectClose(1); expect(owner).toHaveBeenCalledWith(1); }
  finally { removeNew(); }
});

it("polls sequentially, delivers a pending id once and rejects invalid ids", async () => {
  let value: unknown = 1;
  const invoke = vi.fn(async () => value);
  window.__TAURI_INTERNALS__ = { invoke };
  const owner = vi.fn();
  const { unmount } = renderHook(() => useNativeCloseRequests(owner, 5));
  await waitFor(() => expect(owner).toHaveBeenCalledWith(1));
  await waitFor(() => expect(invoke.mock.calls.length).toBeGreaterThan(2));
  expect(owner).toHaveBeenCalledTimes(1);
  for (const invalid of ["2", 0, -1, 1.5, 0x100000000, null]) {
    value = invalid;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 12)); });
  }
  expect(owner).toHaveBeenCalledTimes(1);
  value = 2;
  await waitFor(() => expect(owner).toHaveBeenCalledWith(2));
  unmount();
  const calls = invoke.mock.calls.length;
  await new Promise(resolve => setTimeout(resolve, 15));
  expect(invoke).toHaveBeenCalledTimes(calls);
});

it("does not authorize anything on unavailable IPC and sends explicit Cancel", async () => {
  await expect(resolveNativeClose(1, true)).rejects.toThrow("desktop_close_unavailable");
  const invoke = vi.fn(async () => null);
  window.__TAURI_INTERNALS__ = { invoke };
  await resolveNativeClose(9, false);
  expect(invoke).toHaveBeenCalledWith("resolve_native_close", { requestId: 9, approve: false });
});

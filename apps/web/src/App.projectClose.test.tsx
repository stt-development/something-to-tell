import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { applyProjectLocale } from "./localization/i18n";
import { useGraphStore } from "./state/graphStore";
import { createProjectFixtureRuntimeFetch, loadProjectFixturesForTests, projectFixture } from "./testFixtures/projectFixtures";
import { requestNativeProjectClose } from "./runtime/nativeClose";

/** Close must retain the canonical workspace until the runtime releases it. */
describe("project close ownership", () => {
  beforeEach(async () => {
    window.localStorage.clear();
    await applyProjectLocale("en");
    useGraphStore.setState(useGraphStore.getInitialState(), true);
    loadProjectFixturesForTests();
    useGraphStore.getState().setProjectSessionState(projectFixture("aurora").response.session);
  });

  afterEach(() => { vi.unstubAllGlobals(); delete window.__TAURI_INTERNALS__; });

  function runtime(handler: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined) {
    const fallback = createProjectFixtureRuntimeFetch();
    const fetcher = vi.fn((input: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(handler(String(input), init) ?? fallback(input, init)));
    vi.stubGlobal("fetch", fetcher);
    return fetcher;
  }

  it("routes native close to Cancel without releasing or approving the project", async () => {
    const invoke = vi.fn(async () => null);
    window.__TAURI_INTERNALS__ = { invoke };
    const fetcher = runtime(() => undefined);
    render(<App />);
    act(() => useGraphStore.getState().markProjectSessionDirty());
    await act(async () => requestNativeProjectClose(7));
    expect(screen.getByRole("heading", { name: "Unsaved changes" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("resolve_native_close", { requestId: 7, approve: false }));
    expect(useGraphStore.getState().activeProjectId).toBe("project-aurora");
    expect(fetcher.mock.calls.some(([url]) => /\/(save|discard|close)$/.test(String(url)))).toBe(false);
  });

  it("waits for slow Save then runtime release before approving native exit", async () => {
    const invoke = vi.fn(async () => null);
    window.__TAURI_INTERNALS__ = { invoke };
    let finish!: (value: Response) => void;
    const fetcher = runtime(url => url.endsWith("/save") ? new Promise<Response>(resolve => { finish = resolve; }) : undefined);
    render(<App />);
    act(() => useGraphStore.getState().markProjectSessionDirty());
    await act(async () => requestNativeProjectClose(8));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(finish).toBeDefined());
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(invoke).not.toHaveBeenCalledWith("resolve_native_close", expect.anything());
    const response = projectFixture("aurora").response;
    await act(async () => finish(json({ ...response, session: { ...response.session, save_status: "clean" } })));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("resolve_native_close", { requestId: 8, approve: true }));
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/close"))).toBe(true);
  });

  it("never approves native exit after failed Save", async () => {
    const invoke = vi.fn(async () => null);
    window.__TAURI_INTERNALS__ = { invoke };
    runtime(url => url.endsWith("/save") ? Promise.reject(new Error("Save failed")) : undefined);
    render(<App />);
    act(() => useGraphStore.getState().markProjectSessionDirty());
    await act(async () => requestNativeProjectClose(9));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Save failed"));
    expect(invoke).not.toHaveBeenCalledWith("resolve_native_close", expect.anything());
    expect(useGraphStore.getState().activeProjectId).toBe("project-aurora");
  });

  it("discards through the runtime before acknowledging native exit", async () => {
    const invoke = vi.fn(async () => null);
    window.__TAURI_INTERNALS__ = { invoke };
    const response = projectFixture("aurora").response;
    const fetcher = runtime(url => url.endsWith("/discard")
      ? json({ ...response, session: { ...response.session, save_status: "clean" } }) : undefined);
    render(<App />);
    act(() => useGraphStore.getState().markProjectSessionDirty());
    await act(async () => requestNativeProjectClose(10));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("resolve_native_close", { requestId: 10, approve: true }));
    const urls = fetcher.mock.calls.map(([url]) => String(url));
    expect(urls.findIndex(url => url.endsWith("/discard"))).toBeLessThan(urls.findIndex(url => url.endsWith("/close")));
  });

  it("cancels native exit if a delayed release belongs to a replaced session", async () => {
    const invoke = vi.fn(async () => null);
    window.__TAURI_INTERNALS__ = { invoke };
    let finish!: (value: Response) => void;
    runtime(url => url.endsWith("/close") ? new Promise<Response>(resolve => { finish = resolve; }) : undefined);
    render(<App />);
    let closing!: Promise<void>;
    act(() => { closing = requestNativeProjectClose(11); });
    await waitFor(() => expect(finish).toBeDefined());
    const response = projectFixture("aurora").response;
    act(() => useGraphStore.getState().setProjectSessionState({ ...response.session, session_id: "replacement" }));
    await act(async () => { finish(json(response)); await closing; });
    expect(invoke).toHaveBeenCalledWith("resolve_native_close", { requestId: 11, approve: false });
    expect(useGraphStore.getState().activeSessionId).toBe("replacement");
  });

  it("asks before closing a dirty project and Cancel retains ownership", async () => {
    const fetcher = runtime(() => undefined);
    render(<App />);
    // Status-only updates deliberately do not rerender App's workspace selector.
    act(() => useGraphStore.getState().markProjectSessionDirty());
    fireEvent.click(screen.getByTitle("Close project"));
    expect(screen.getByRole("heading", { name: "Unsaved changes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useGraphStore.getState().activeProjectSession?.save_status).toBe("dirty");
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/close"))).toBe(false);
  });

  it("retains the project on a failed Close and shows the failure", async () => {
    runtime((url) => url.endsWith("/close") ? Promise.reject(new Error("Connection lost")) : undefined);
    render(<App />);
    fireEvent.click(screen.getByTitle("Close project"));
    await screen.findByRole("heading", { name: "Unsaved changes" });
    expect(screen.getByRole("alert")).toHaveTextContent("Connection lost");
    expect(useGraphStore.getState().activeProjectSession?.lifecycle).toBe("open");
    expect(screen.queryByRole("heading", { name: "Projects" })).not.toBeInTheDocument();
  });

  it("opens the decision dialog when runtime rejects a stale clean mirror", async () => {
    runtime((url) => url.endsWith("/close") ? json({ detail: {
      code: "project_unsaved_changes", message_key: "project_session.project_unsaved_changes", parameters: {}
    } }, 409) : undefined);
    render(<App />);
    fireEvent.click(screen.getByTitle("Close project"));
    await screen.findByRole("heading", { name: "Unsaved changes" });
    expect(useGraphStore.getState().activeProjectSession?.save_status).toBe("dirty");
    expect(useGraphStore.getState().activeProjectId).toBe("project-aurora");
  });

  it("does not detach until Close succeeds", async () => {
    let finish!: (response: Response) => void;
    runtime((url) => url.endsWith("/close") ? new Promise<Response>((resolve) => { finish = resolve; }) : undefined);
    render(<App />);
    fireEvent.click(screen.getByTitle("Close project"));
    await waitFor(() => expect(finish).toBeDefined());
    expect(useGraphStore.getState().activeSessionId).not.toBeNull();
    const response = projectFixture("aurora").response;
    await act(async () => finish(json({ ...response, session: { ...response.session, lifecycle: "closed" } })));
    await screen.findByRole("heading", { name: "Projects" });
    expect(useGraphStore.getState().activeSessionId).toBeNull();
  });

  it("ignores a delayed Close response after a different session becomes active", async () => {
    let finish!: (response: Response) => void;
    runtime((url) => url.endsWith("/close") ? new Promise<Response>((resolve) => { finish = resolve; }) : undefined);
    render(<App />);
    fireEvent.click(screen.getByTitle("Close project"));
    await waitFor(() => expect(finish).toBeDefined());
    const response = projectFixture("aurora").response;
    act(() => useGraphStore.getState().setProjectSessionState({ ...response.session, session_id: "replacement" }));
    await act(async () => finish(json({ ...response, session: { ...response.session, lifecycle: "closed" } })));
    expect(useGraphStore.getState().activeSessionId).toBe("replacement");
  });

  it("keeps the dialog and project when Discard fails", async () => {
    useGraphStore.getState().markProjectSessionDirty();
    const fetcher = runtime((url) => url.endsWith("/discard") ? Promise.reject(new Error("Discard failed")) : undefined);
    render(<App />);
    fireEvent.click(screen.getByTitle("Close project"));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Discard failed"));
    expect(useGraphStore.getState().activeProjectSession?.lifecycle).toBe("open");
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/close"))).toBe(false);
  });

  it("ignores a delayed Close failure for an old session", async () => {
    let fail!: (error: Error) => void;
    runtime((url) => url.endsWith("/close") ? new Promise<Response>((_, reject) => { fail = reject; }) : undefined);
    render(<App />);
    fireEvent.click(screen.getByTitle("Close project"));
    await waitFor(() => expect(fail).toBeDefined());
    const replacement = { ...projectFixture("aurora").response.session, session_id: "replacement" };
    act(() => useGraphStore.getState().setProjectSessionState(replacement));
    await act(async () => fail(new Error("Old request failed")));
    expect(useGraphStore.getState().activeProjectSession).toEqual(replacement);
    expect(screen.queryByRole("heading", { name: "Unsaved changes" })).not.toBeInTheDocument();
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "../app/shell/workspaceStore";
import { projectFixture } from "../testFixtures/projectFixtures";
import { useGraphStore } from "./graphStore";

describe("dirty session publications", () => {
  beforeEach(() => {
    useGraphStore.setState(useGraphStore.getInitialState(), true);
    useGraphStore.getState().setProjectSessionState({
      ...projectFixture("aurora").response.session,
      save_status: "dirty",
      save_error: null
    });
  });

  afterEach(() => {
    cleanup();
    useGraphStore.setState(useGraphStore.getInitialState(), true);
  });

  /** Subscription lifetime is local so test resets cannot pollute counts. */
  function observeDirtyCommand() {
    const notify = vi.fn();
    const unsubscribe = useGraphStore.subscribe(notify);
    try {
      useGraphStore.getState().markProjectSessionDirty();
      return notify;
    } finally {
      unsubscribe();
    }
  }

  it("retains state/session identity and emits nothing when already dirty", () => {
    const before = useGraphStore.getState();
    expect(observeDirtyCommand()).not.toHaveBeenCalled();
    expect(useGraphStore.getState()).toBe(before);
    expect(useGraphStore.getState().activeProjectSession).toBe(before.activeProjectSession);
  });

  it("does not publish a null session after Close", () => {
    useGraphStore.getState().closeActiveProject();
    const before = useGraphStore.getState();
    expect(observeDirtyCommand()).not.toHaveBeenCalled();
    expect(useGraphStore.getState()).toBe(before);
  });

  it.each(["clean", "saving", "error"] as const)("publishes the real %s to dirty transition", (save_status) => {
    const session = {
      ...useGraphStore.getState().activeProjectSession!,
      save_status,
      save_error: save_status === "error" ? "Save failed" : null
    };
    useGraphStore.getState().setProjectSessionState(session);
    expect(observeDirtyCommand()).toHaveBeenCalledOnce();
    expect(useGraphStore.getState().activeProjectSession).toEqual({
      ...session, save_status: "dirty", save_error: null
    });
    expect(useGraphStore.getState().activeSessionId).toBe(session.session_id);
  });

  it("still clears an outstanding error on a dirty session", () => {
    useGraphStore.setState((state) => ({
      activeProjectSession: { ...state.activeProjectSession!, save_error: "Previous failure" }
    }));
    expect(observeDirtyCommand()).toHaveBeenCalledOnce();
    expect(useGraphStore.getState().activeProjectSession?.save_error).toBeNull();
    expect(observeDirtyCommand()).not.toHaveBeenCalled();
  });

  it("preserves an authoritative revision update and dirties it normally", () => {
    const current = useGraphStore.getState().activeProjectSession!;
    const newer = { ...current, saved_revision: current.saved_revision + 1, save_status: "clean" as const };
    useGraphStore.getState().setProjectSessionState(newer);
    expect(useGraphStore.getState().activeProjectSession).toBe(newer);
    expect(observeDirtyCommand()).toHaveBeenCalledOnce();
    expect(useGraphStore.getState().activeProjectSession).toEqual({ ...newer, save_status: "dirty" });
  });

  it("keeps status publications canonical without rendering the workspace consumer", () => {
    let renders = 0;
    const workspace = renderHook(() => { renders += 1; return useWorkspaceStore(); });
    const initial = workspace.result.current;
    act(() => useGraphStore.getState().markProjectSessionDirty());
    act(() => useGraphStore.getState().markProjectSessionDirty());
    expect(renders).toBe(1);
    expect(workspace.result.current).toBe(initial);
    act(() => useGraphStore.getState().setProjectSessionState({
      ...useGraphStore.getState().activeProjectSession!, save_status: "saving"
    }));
    expect(renders).toBe(1);
    expect(useGraphStore.getState().activeProjectSession?.save_status).toBe("saving");
    act(() => useGraphStore.getState().markProjectSessionDirty());
    expect(renders).toBe(1);
    expect(useGraphStore.getState().activeProjectSession?.save_status).toBe("dirty");
    expect(workspace.result.current.activeProjectSession).not.toHaveProperty("save_status");
  });
});

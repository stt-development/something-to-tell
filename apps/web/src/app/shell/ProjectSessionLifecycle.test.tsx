import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectFixture } from "../../testFixtures/projectFixtures";
import { useGraphStore } from "../../state/graphStore";
import { ProjectSessionLifecycle, type ProjectSessionLifecycleProps } from "./ProjectSessionLifecycle";
import { useWorkspaceStore } from "./workspaceStore";

function setStatus(save_status: "clean" | "dirty" | "saving" | "error") {
  useGraphStore.getState().setProjectSessionState({
    ...useGraphStore.getState().activeProjectSession!, save_status
  });
}

function pagehide(persisted = false) {
  const event = new Event("pagehide");
  Object.defineProperty(event, "persisted", { value: persisted });
  fireEvent(window, event);
}

describe("browser session lifecycle", () => {
  let props: ProjectSessionLifecycleProps;
  beforeEach(() => {
    vi.useFakeTimers();
    useGraphStore.setState(useGraphStore.getInitialState(), true);
    useGraphStore.getState().setProjectSessionState({
      ...projectFixture("aurora").response.session, save_status: "dirty", save_error: null
    });
    useGraphStore.setState({ activeAutosave: { enabled: true, interval_seconds: 300 } });
    props = {
      canonSuggestionStatus: null, resolutionOperation: null, resolutionRunStatus: null,
      onSave: vi.fn(async () => true),
      persistence: { exitProjectSession: vi.fn().mockResolvedValue({}) }
    };
  });

  afterEach(() => {
    cleanup();
    useGraphStore.setState(useGraphStore.getInitialState(), true);
    vi.useRealTimers();
  });

  it("updates autosave configuration without notifying the workspace consumer", async () => {
    let workspaceRenders = 0;
    renderHook(() => { workspaceRenders += 1; return useWorkspaceStore(); });
    render(<ProjectSessionLifecycle {...props} />);
    act(() => useGraphStore.setState({ activeAutosave: { enabled: true, interval_seconds: 10 } }));
    await act(async () => vi.advanceTimersByTimeAsync(9999));
    expect(props.onSave).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(props.onSave).toHaveBeenCalledTimes(1);
    expect(props.onSave).toHaveBeenCalledWith("autosave");
    expect(workspaceRenders).toBe(1);
    act(() => useGraphStore.setState({ activeAutosave: { enabled: false, interval_seconds: 10 } }));
    await act(async () => vi.advanceTimersByTimeAsync(300000));
    expect(props.onSave).toHaveBeenCalledTimes(1);
    expect(workspaceRenders).toBe(1);
  });

  it("uses the latest committed save command for Ctrl/Cmd+S", () => {
    const view = render(<ProjectSessionLifecycle {...props} />);
    const latestSave = vi.fn(async () => true);
    view.rerender(<ProjectSessionLifecycle {...props} onSave={latestSave} />);
    fireEvent.keyDown(window, { key: "s" });
    expect(latestSave).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(window, { key: "S", ctrlKey: true })).toBe(false);
    expect(fireEvent.keyDown(window, { key: "s", metaKey: true })).toBe(false);
    expect(latestSave).toHaveBeenCalledTimes(2);
    expect(latestSave).toHaveBeenLastCalledWith("manual");
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it("retains the deadline across command refresh and Graph/Playback sibling replacement", async () => {
    function Host({ playback, onSave }: { playback: boolean; onSave: ProjectSessionLifecycleProps["onSave"] }) {
      return <><ProjectSessionLifecycle {...props} onSave={onSave} />{playback ? <section>Playback</section> : <div>Canvas</div>}</>;
    }
    const view = render(<Host playback={false} onSave={props.onSave} />);
    await act(async () => vi.advanceTimersByTimeAsync(100000));
    const latestSave = vi.fn(async () => true);
    view.rerender(<Host playback onSave={latestSave} />);
    await act(async () => vi.advanceTimersByTimeAsync(199999));
    expect(latestSave).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(latestSave).toHaveBeenCalledTimes(1);
    expect(latestSave).toHaveBeenCalledWith("autosave");
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it("cancels dirty deadlines on clean/saving/error and absent sessions", async () => {
    render(<ProjectSessionLifecycle {...props} />);
    for (const status of ["clean", "saving", "error"] as const) {
      act(() => setStatus(status));
      await act(async () => vi.advanceTimersByTimeAsync(300000));
      expect(props.onSave).not.toHaveBeenCalled();
      act(() => setStatus("dirty"));
    }
    act(() => useGraphStore.getState().closeActiveProject());
    await act(async () => vi.advanceTimersByTimeAsync(300000));
    expect(props.onSave).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { canonSuggestionStatus: "pending" },
    { resolutionOperation: "starting" },
    { resolutionRunStatus: "queued" },
    { resolutionRunStatus: "running" }
  ])("defers autosave for provider blocker %j", async (blocker) => {
    const view = render(<ProjectSessionLifecycle {...props} />);
    await act(async () => vi.advanceTimersByTimeAsync(100000));
    view.rerender(<ProjectSessionLifecycle {...props} {...blocker} />);
    await act(async () => vi.advanceTimersByTimeAsync(300000));
    expect(props.onSave).not.toHaveBeenCalled();
    view.rerender(<ProjectSessionLifecycle {...props} />);
    await act(async () => vi.advanceTimersByTimeAsync(300000));
    expect(props.onSave).toHaveBeenCalledTimes(1);
    expect(props.onSave).toHaveBeenCalledWith("autosave");
  });

  it("restarts the deadline when the observed saved revision changes", async () => {
    render(<ProjectSessionLifecycle {...props} />);
    await act(async () => vi.advanceTimersByTimeAsync(100000));
    act(() => useGraphStore.getState().setProjectSessionState({
      ...useGraphStore.getState().activeProjectSession!, saved_revision: 7
    }));
    await act(async () => vi.advanceTimersByTimeAsync(200000));
    expect(props.onSave).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(100000));
    expect(props.onSave).toHaveBeenCalledTimes(1);
    expect(props.onSave).toHaveBeenCalledWith("autosave");
  });

  it("protects unsaved unload and releases protection after clean/Close", () => {
    render(<ProjectSessionLifecycle {...props} />);
    for (const status of ["dirty", "saving", "error", "clean"] as const) {
      act(() => setStatus(status));
      const event = new Event("beforeunload", { cancelable: true });
      fireEvent(window, event);
      expect(event.defaultPrevented).toBe(status !== "clean");
    }
    act(() => useGraphStore.getState().closeActiveProject());
    const event = new Event("beforeunload", { cancelable: true });
    fireEvent(window, event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("uses current session, revision and client on pagehide while preserving BFCache", () => {
    const view = render(<ProjectSessionLifecycle {...props} />);
    pagehide(true);
    expect(props.persistence.exitProjectSession).not.toHaveBeenCalled();
    const current = useGraphStore.getState().activeProjectSession!;
    act(() => useGraphStore.getState().setProjectSessionState({ ...current, session_id: "recovered", saved_revision: 9 }));
    const nextClient = { exitProjectSession: vi.fn().mockResolvedValue({}) };
    view.rerender(<ProjectSessionLifecycle {...props} persistence={nextClient} />);
    pagehide();
    expect(nextClient.exitProjectSession).toHaveBeenCalledTimes(1);
    expect(nextClient.exitProjectSession).toHaveBeenCalledWith("recovered", { expected_revision: 9 });
    expect(props.persistence.exitProjectSession).not.toHaveBeenCalled();
    act(() => useGraphStore.getState().closeActiveProject());
    pagehide();
    expect(nextClient.exitProjectSession).toHaveBeenCalledTimes(1);
  });

  it("treats a rejected exit request as best-effort without retrying", async () => {
    const exitProjectSession = vi.fn().mockRejectedValue(new Error("offline"));
    render(<ProjectSessionLifecycle {...props} persistence={{ exitProjectSession }} />);
    await act(async () => { pagehide(); });
    expect(exitProjectSession).toHaveBeenCalledTimes(1);
  });

  it("releases timers/listeners on unmount and does not duplicate them in StrictMode", async () => {
    const view = render(<StrictMode><ProjectSessionLifecycle {...props} /></StrictMode>);
    expect(vi.getTimerCount()).toBe(1);
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    expect(props.onSave).toHaveBeenCalledTimes(1);
    expect(props.onSave).toHaveBeenCalledWith("manual");
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    pagehide();
    const unload = new Event("beforeunload", { cancelable: true });
    fireEvent(window, unload);
    await act(async () => vi.advanceTimersByTimeAsync(300000));
    expect(props.onSave).toHaveBeenCalledTimes(1);
    expect(props.persistence.exitProjectSession).not.toHaveBeenCalled();
    expect(unload.defaultPrevented).toBe(false);
  });
});

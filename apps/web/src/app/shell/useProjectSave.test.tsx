import type { ProjectSessionState } from "@something-to-tell/contracts/project-session";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectFixture } from "../../testFixtures/projectFixtures";
import { useGraphStore } from "../../state/graphStore";
import type { RuntimeProjectSessionResponse } from "../../runtime/apiClient";
import { useProjectSave, type ProjectSavePersistence } from "./useProjectSave";

function response(session: Partial<ProjectSessionState> = {}): RuntimeProjectSessionResponse {
  const original = projectFixture("aurora").response;
  return { ...original, session: { ...original.session, save_status: "clean", save_error: null, ...session } };
}

function deferred() {
  let resolve!: (value: RuntimeProjectSessionResponse) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<RuntimeProjectSessionResponse>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("project save command", () => {
  let persistence: {
    saveProjectSession: ReturnType<typeof vi.fn<ProjectSavePersistence["saveProjectSession"]>>;
    inspectProjectSession: ReturnType<typeof vi.fn<ProjectSavePersistence["inspectProjectSession"]>>;
  };
  const id = response().session.session_id;
  beforeEach(() => {
    useGraphStore.setState(useGraphStore.getInitialState(), true);
    useGraphStore.getState().setProjectSessionState(response({ save_status: "dirty" }).session);
    persistence = {
      saveProjectSession: vi.fn<ProjectSavePersistence["saveProjectSession"]>().mockResolvedValue(response({ saved_revision: 2 })),
      inspectProjectSession: vi.fn<ProjectSavePersistence["inspectProjectSession"]>().mockResolvedValue(response())
    };
  });
  afterEach(() => {
    cleanup();
    useGraphStore.setState(useGraphStore.getInitialState(), true);
  });

  it("reads current status/revision at invocation rather than hook render", async () => {
    useGraphStore.getState().setProjectSessionState(response().session);
    const onSaved = vi.fn();
    const { result } = renderHook(() => useProjectSave(id, persistence, onSaved));
    useGraphStore.getState().setProjectSessionState(response({ saved_revision: 7, save_status: "dirty" }).session);
    persistence.saveProjectSession.mockResolvedValue(response({ saved_revision: 8 }));
    await act(async () => { expect(await result.current("manual")).toBe(true); });
    expect(persistence.saveProjectSession).toHaveBeenCalledWith(id, { expected_revision: 7, reason: "manual" });
    expect(useGraphStore.getState().activeProjectSession?.saved_revision).toBe(8);
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it.each(["clean", "saving"] as const)("does not issue a save for current %s status", async (save_status) => {
    const { result } = renderHook(() => useProjectSave(id, persistence, vi.fn()));
    useGraphStore.getState().setProjectSessionState(response({ save_status }).session);
    expect(await result.current("close")).toBe(save_status === "clean");
    expect(persistence.saveProjectSession).not.toHaveBeenCalled();
  });

  it("returns a harmless success without a session and rejects a stale bound callback", async () => {
    const { result } = renderHook(() => useProjectSave(id, persistence, vi.fn()));
    useGraphStore.getState().closeActiveProject();
    expect(await result.current("close")).toBe(true);
    useGraphStore.getState().setProjectSessionState(response({ session_id: "other", save_status: "dirty" }).session);
    expect(await result.current("manual")).toBe(false);
    expect(persistence.saveProjectSession).not.toHaveBeenCalled();
  });

  it("shares the in-flight promise across reasons, client refresh and callback replacement", async () => {
    const pending = deferred();
    persistence.saveProjectSession.mockReturnValue(pending.promise);
    const firstSaved = vi.fn();
    const latestSaved = vi.fn();
    const view = renderHook((props: { client: ProjectSavePersistence; onSaved: () => void }) =>
      useProjectSave(id, props.client, props.onSaved), { initialProps: { client: persistence, onSaved: firstSaved } });
    let first!: Promise<boolean>;
    act(() => { first = view.result.current("manual"); });
    const nextClient = { ...persistence, saveProjectSession: vi.fn<ProjectSavePersistence["saveProjectSession"]>() };
    view.rerender({ client: nextClient, onSaved: latestSaved });
    expect(view.result.current("autosave")).toBe(first);
    expect(view.result.current("close")).toBe(first);
    await act(async () => { pending.resolve(response({ saved_revision: 2 })); expect(await first).toBe(true); });
    expect(persistence.saveProjectSession).toHaveBeenCalledOnce();
    expect(nextClient.saveProjectSession).not.toHaveBeenCalled();
    expect(firstSaved).not.toHaveBeenCalled();
    expect(latestSaved).toHaveBeenCalledOnce();
  });

  it("accepts an already completed stale save without another write", async () => {
    persistence.saveProjectSession.mockRejectedValue({ code: "project_save_revision_stale" });
    persistence.inspectProjectSession.mockResolvedValue(response({ saved_revision: 5 }));
    const { result } = renderHook(() => useProjectSave(id, persistence, vi.fn()));
    await act(async () => { expect(await result.current("manual")).toBe(true); });
    expect(persistence.saveProjectSession).toHaveBeenCalledOnce();
    expect(persistence.inspectProjectSession).toHaveBeenCalledWith(id);
    expect(useGraphStore.getState().activeProjectSession).toMatchObject({ saved_revision: 5, save_status: "clean" });
  });

  it("retries a stale dirty save once with the inspected revision and original reason", async () => {
    persistence.saveProjectSession.mockRejectedValueOnce({ code: "project_save_revision_stale" })
      .mockResolvedValueOnce(response({ saved_revision: 6 }));
    persistence.inspectProjectSession.mockResolvedValue(response({ saved_revision: 5, save_status: "dirty" }));
    const { result } = renderHook(() => useProjectSave(id, persistence, vi.fn()));
    await act(async () => { expect(await result.current("autosave")).toBe(true); });
    expect(persistence.saveProjectSession).toHaveBeenCalledTimes(2);
    expect(persistence.saveProjectSession).toHaveBeenNthCalledWith(2, id, { expected_revision: 5, reason: "autosave" });
  });

  it("keeps the inspected revision when that single retry fails", async () => {
    persistence.saveProjectSession.mockRejectedValueOnce({ code: "project_save_revision_stale" })
      .mockRejectedValueOnce(new Error("Retry failed"));
    persistence.inspectProjectSession.mockResolvedValue(response({ saved_revision: 5, save_status: "dirty" }));
    const onSaved = vi.fn();
    const { result } = renderHook(() => useProjectSave(id, persistence, onSaved));
    await act(async () => { expect(await result.current("close")).toBe(false); });
    expect(persistence.saveProjectSession).toHaveBeenCalledTimes(2);
    expect(useGraphStore.getState().activeProjectSession).toMatchObject({ saved_revision: 5, save_status: "error", save_error: "Retry failed" });
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("preserves a newer canonical revision on failure and permits a later manual retry", async () => {
    const pending = deferred();
    persistence.saveProjectSession.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useProjectSave(id, persistence, vi.fn()));
    let operation!: Promise<boolean>;
    act(() => { operation = result.current("manual"); });
    useGraphStore.getState().setProjectSessionState(response({ saved_revision: 9, save_status: "saving" }).session);
    await act(async () => { pending.reject(new Error("Offline")); expect(await operation).toBe(false); });
    expect(useGraphStore.getState().activeProjectSession).toMatchObject({ saved_revision: 9, save_status: "error" });
    persistence.saveProjectSession.mockResolvedValue(response({ saved_revision: 10 }));
    await act(async () => { expect(await result.current("manual")).toBe(true); });
    expect(persistence.saveProjectSession).toHaveBeenLastCalledWith(id, { expected_revision: 9, reason: "manual" });
  });

  it("does not install an old completion or clear the replacement session's in-flight guard", async () => {
    const firstPending = deferred();
    const nextPending = deferred();
    persistence.saveProjectSession.mockReturnValueOnce(firstPending.promise).mockReturnValueOnce(nextPending.promise);
    const onSaved = vi.fn();
    const view = renderHook((scope: string) => useProjectSave(scope, persistence, onSaved), { initialProps: id });
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => { first = view.result.current("manual"); });
    const replacement = response({ session_id: "replacement", save_status: "dirty" }).session;
    useGraphStore.getState().setProjectSessionState(replacement);
    view.rerender("replacement");
    act(() => { second = view.result.current("manual"); });
    await act(async () => { firstPending.resolve(response()); expect(await first).toBe(false); });
    expect(view.result.current("close")).toBe(second);
    expect(useGraphStore.getState().activeSessionId).toBe("replacement");
    await act(async () => { nextPending.resolve(response({ session_id: "replacement" })); expect(await second).toBe(true); });
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("ignores pending completions and retained commands after unmount", async () => {
    const pending = deferred();
    persistence.saveProjectSession.mockReturnValue(pending.promise);
    const onSaved = vi.fn();
    const view = renderHook(() => useProjectSave(id, persistence, onSaved));
    let operation!: Promise<boolean>;
    act(() => { operation = view.result.current("manual"); });
    const command = view.result.current;
    view.unmount();
    const before = useGraphStore.getState().activeProjectSession;
    await act(async () => { pending.resolve(response()); expect(await operation).toBe(false); });
    expect(await command("manual")).toBe(false);
    expect(useGraphStore.getState().activeProjectSession).toBe(before);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("accepts a recovered response only when it matches the current session of the same project", async () => {
    persistence.saveProjectSession.mockImplementationOnce(async () => {
      const recovered = response({ session_id: "recovered", saved_revision: 3 });
      useGraphStore.getState().setProjectSessionState(recovered.session);
      return recovered;
    });
    const { result } = renderHook(() => useProjectSave(id, persistence, vi.fn()));
    await act(async () => { expect(await result.current("manual")).toBe(true); });
    expect(useGraphStore.getState().activeSessionId).toBe("recovered");
  });

  it("rejects a response belonging to a different project without installing it", async () => {
    persistence.saveProjectSession.mockResolvedValue(response({ project_id: "foreign-project" }));
    const onSaved = vi.fn();
    const { result } = renderHook(() => useProjectSave(id, persistence, onSaved));
    await act(async () => { expect(await result.current("manual")).toBe(false); });
    expect(useGraphStore.getState().activeProjectSession?.project_id).toBe(response().session.project_id);
    expect(useGraphStore.getState().activeProjectSession?.save_status).toBe("error");
    expect(onSaved).not.toHaveBeenCalled();
  });
});

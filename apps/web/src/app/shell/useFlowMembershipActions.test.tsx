import { act, renderHook } from "@testing-library/react";
import { StrictMode, Suspense } from "react";
import { expect, it, vi } from "vitest";
import type { WorkspaceMode } from "../../story-flow/workspace";
import { useFlowMembershipActions, type FlowMembershipActionInputs } from "./useFlowMembershipActions";

function inputs(): FlowMembershipActionInputs {
  return { projectId: "project-a", nodes: [{ id: "primary", data: { canonicalNodeId: "canonical" } },
    { id: "placement:linked", data: { canonicalNodeId: "canonical" } }],
    activeStoryFlow: { flow: { id: "flow-a" }, nodes: [] }, workspaceMode: "relationships",
    addNodeToActiveStoryFlow: vi.fn(async () => null), openContinueFlow: vi.fn(), openFlowInvocation: vi.fn(), openFlowExit: vi.fn(),
    setEntryCandidateId: vi.fn(), setBoundarySceneId: vi.fn(), setFlowActionError: vi.fn(), setDialog: vi.fn() };
}
const flow = (member: boolean) => ({ flow: { id: "flow-a" }, nodes: member ? [{ node_id: "canonical" }] : [] });

it.each((["relationships", "flow", "story"] as WorkspaceMode[]).flatMap((mode) => [false, true].map((member) => ({ mode, member }))))(
  "preserves action eligibility in $mode with member=$member", ({ mode, member }) => {
    const context = { ...inputs(), workspaceMode: mode, activeStoryFlow: flow(member) };
    const view = renderHook(() => useFlowMembershipActions(context));
    const actions = view.result.current.get("canonical")!;
    expect(typeof actions.onAddToFlow === "function").toBe(mode === "relationships" && !member);
    expect(typeof actions.onContinueFlow === "function").toBe(mode !== "story" && member);
    expect(typeof actions.onCallFlow === "function").toBe(mode !== "story" && member);
    expect(typeof actions.onCreateFlowExit === "function").toBe(mode !== "story" && member);
    expect(typeof actions.onSetFlowEntry === "function").toBe(mode !== "story" && member);
    expect(actions.onConfigureSceneBoundary).toBeUndefined();
    expect(context.addNodeToActiveStoryFlow).not.toHaveBeenCalled();
    expect(context.openContinueFlow).not.toHaveBeenCalled();
  }
);

it("clears both action keys without an active Flow, including for call portals", () => {
  const context = { ...inputs(), activeStoryFlow: null };
  const view = renderHook(() => useFlowMembershipActions(context));
  expect(view.result.current.get("canonical")).toEqual({ onAddToFlow: undefined, onContinueFlow: undefined, onCallFlow: undefined, onCreateFlowExit: undefined, onSetFlowEntry: undefined, onConfigureSceneBoundary: undefined });
  view.rerender();
  expect(context.addNodeToActiveStoryFlow).not.toHaveBeenCalled();
});

it("shares canonical actions across placements while preserving fallback and empty canonical ids", () => {
  const context = inputs();
  context.nodes = [...context.nodes, { id: "raw", data: {} }, { id: "empty-placement", data: { canonicalNodeId: "" } }];
  const view = renderHook(() => useFlowMembershipActions(context));
  expect([...view.result.current.keys()]).toEqual(["canonical", "raw", ""]);
  let returned: unknown;
  act(() => { returned = view.result.current.get("canonical")!.onAddToFlow!(); });
  expect(returned).toBeUndefined();
  expect(context.addNodeToActiveStoryFlow).toHaveBeenCalledWith("canonical");
  act(() => view.result.current.get("raw")!.onAddToFlow!());
  expect(context.addNodeToActiveStoryFlow).toHaveBeenLastCalledWith("raw");
  act(() => view.result.current.get("")!.onAddToFlow!());
  expect(context.addNodeToActiveStoryFlow).toHaveBeenLastCalledWith("");
});

it.each([false, true])("retains actions and adopts command-only replacements with member=%s", (member) => {
  const original = { ...inputs(), activeStoryFlow: flow(member) };
  const view = renderHook(({ context }) => useFlowMembershipActions(context), { initialProps: { context: original } });
  const actions = view.result.current;
  const next = { ...original, addNodeToActiveStoryFlow: vi.fn(async () => null), openContinueFlow: vi.fn() };
  view.rerender({ context: next });
  expect(view.result.current).toBe(actions);
  act(() => member ? actions.get("canonical")!.onContinueFlow!() : actions.get("canonical")!.onAddToFlow!());
  expect(member ? next.openContinueFlow : next.addNodeToActiveStoryFlow).toHaveBeenCalledWith("canonical");
  expect(original.addNodeToActiveStoryFlow).not.toHaveBeenCalled();
  expect(original.openContinueFlow).not.toHaveBeenCalled();
});

it("rechecks current membership/mode on retained actions without giving portals continuation", () => {
  const context = inputs();
  const view = renderHook(({ context }) => useFlowMembershipActions(context), { initialProps: { context } });
  const add = view.result.current.get("canonical")!.onAddToFlow!;
  view.rerender({ context: { ...context, activeStoryFlow: flow(true) } });
  const continuation = view.result.current.get("canonical")!.onContinueFlow!;
  act(() => { add(); continuation(); });
  expect(context.addNodeToActiveStoryFlow).not.toHaveBeenCalled();
  expect(context.openContinueFlow).toHaveBeenCalledWith("canonical");
  view.rerender({ context: { ...context, activeStoryFlow: flow(true), workspaceMode: "story" } });
  act(() => continuation());
  expect(context.openContinueFlow).toHaveBeenCalledOnce();
  view.rerender({ context: { ...context, activeStoryFlow: flow(false), workspaceMode: "flow" } });
  expect(view.result.current.get("canonical")).toEqual({ onAddToFlow: undefined, onContinueFlow: undefined, onCallFlow: undefined, onCreateFlowExit: undefined, onSetFlowEntry: undefined, onConfigureSceneBoundary: undefined });
  act(() => { add(); continuation(); });
  expect(context.openContinueFlow).toHaveBeenCalledOnce();
  expect(context.addNodeToActiveStoryFlow).not.toHaveBeenCalled();
  view.rerender({ context });
  expect(view.result.current.get("canonical")!.onAddToFlow).toBe(add);
});

it.each(["project", "flow"] as const)("retires actions across a %s switch even when canonical ids repeat", (scope) => {
  const original = inputs();
  const view = renderHook(({ context }) => useFlowMembershipActions(context), { initialProps: { context: original } });
  const old = view.result.current.get("canonical")!.onAddToFlow!;
  const next = { ...inputs(), ...(scope === "project" ? { projectId: "project-b" } : { activeStoryFlow: { flow: { id: "flow-b" }, nodes: [] } }) };
  view.rerender({ context: next });
  const active = view.result.current.get("canonical")!.onAddToFlow!;
  expect(active).not.toBe(old);
  act(() => { old(); active(); });
  expect(next.addNodeToActiveStoryFlow).toHaveBeenCalledOnce();
  expect(original.addNodeToActiveStoryFlow).not.toHaveBeenCalled();
  view.rerender({ context: original });
  expect(view.result.current.get("canonical")!.onAddToFlow).not.toBe(old);
  act(() => { old(); active(); });
  expect(original.addNodeToActiveStoryFlow).not.toHaveBeenCalled();
});

it("prunes removed canonical nodes, revokes on Flow removal and bounds live keys", () => {
  const context = inputs();
  const view = renderHook(({ context }) => useFlowMembershipActions(context), { initialProps: { context } });
  const old = view.result.current.get("canonical")!.onAddToFlow!;
  for (let index = 0; index < 20; index += 1) {
    view.rerender({ context: { ...context, nodes: [{ id: `node:${index}`, data: {} }] } });
    expect([...view.result.current.keys()]).toEqual([`node:${index}`]);
  }
  view.rerender({ context });
  const restored = view.result.current.get("canonical")!.onAddToFlow!;
  expect(restored).not.toBe(old);
  act(() => old());
  expect(context.addNodeToActiveStoryFlow).not.toHaveBeenCalled();
  view.rerender({ context: { ...context, activeStoryFlow: null } });
  act(() => restored());
  expect(context.addNodeToActiveStoryFlow).not.toHaveBeenCalled();
});

it("does not publish speculative Flow, eligibility, nodes or commands before commit", () => {
  const original = inputs();
  const pending = new Promise<void>(() => {});
  const view = renderHook(({ context, suspend }) => {
    const actions = useFlowMembershipActions(context);
    if (suspend) throw pending;
    return actions;
  }, { initialProps: { context: original, suspend: false }, wrapper: ({ children }) => <Suspense fallback={null}>{children}</Suspense> });
  const old = view.result.current.get("canonical")!.onAddToFlow!;
  const next = { ...inputs(), activeStoryFlow: { flow: { id: "flow-b" }, nodes: [{ node_id: "canonical" }] } };
  view.rerender({ context: next, suspend: true });
  act(() => old());
  expect(original.addNodeToActiveStoryFlow).toHaveBeenCalledOnce();
  expect(next.addNodeToActiveStoryFlow).not.toHaveBeenCalled();
  view.rerender({ context: next, suspend: false });
  act(() => old());
  expect(original.addNodeToActiveStoryFlow).toHaveBeenCalledOnce();
  act(() => view.result.current.get("canonical")!.onContinueFlow!());
  expect(next.openContinueFlow).toHaveBeenCalledWith("canonical");
});

it("supports Strict Mode replay and revokes detached actions on unmount", () => {
  const context = inputs();
  const view = renderHook(() => useFlowMembershipActions(context), { wrapper: StrictMode });
  const add = view.result.current.get("canonical")!.onAddToFlow!;
  act(() => add());
  expect(context.addNodeToActiveStoryFlow).toHaveBeenCalledOnce();
  view.unmount();
  act(() => add());
  expect(context.addNodeToActiveStoryFlow).toHaveBeenCalledOnce();
});

it("preserves synchronous command errors without invoking another command", () => {
  const context = inputs();
  const error = new Error("Dispatch failed");
  vi.mocked(context.addNodeToActiveStoryFlow).mockImplementation(() => { throw error; });
  const view = renderHook(() => useFlowMembershipActions(context));
  expect(() => view.result.current.get("canonical")!.onAddToFlow!()).toThrow(error);
  expect(context.openContinueFlow).not.toHaveBeenCalled();
});

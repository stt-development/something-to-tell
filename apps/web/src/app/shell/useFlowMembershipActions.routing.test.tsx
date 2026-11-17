import { act, renderHook } from "@testing-library/react";
import { StrictMode, Suspense } from "react";
import { expect, it, vi } from "vitest";
import { useFlowMembershipActions, type FlowMembershipActionInputs } from "./useFlowMembershipActions";

function inputs(): FlowMembershipActionInputs {
  return { projectId: "project-a", nodes: [{ id: "visual", data: { canonicalNodeId: "canonical", kind: "Scene" } }],
    activeStoryFlow: { flow: { id: "flow-a" }, nodes: [{ node_id: "canonical" }] }, workspaceMode: "relationships",
    addNodeToActiveStoryFlow: vi.fn(async () => null), openContinueFlow: vi.fn(), openFlowInvocation: vi.fn(), openFlowExit: vi.fn(),
    setEntryCandidateId: vi.fn(), setBoundarySceneId: vi.fn(), setFlowActionError: vi.fn(), setDialog: vi.fn() };
}
const cases = [
  { action: "onSetFlowEntry", source: "setEntryCandidateId", dialog: "set-flow-entry" },
  { action: "onConfigureSceneBoundary", source: "setBoundarySceneId", dialog: "scene-boundary" }
] as const;

it.each([
  { mode: "relationships", kind: "Scene", member: true },
  { mode: "flow", kind: "Scene", member: true },
  { mode: "story", kind: "Scene", member: true },
  { mode: "relationships", kind: "Scene", member: false },
  { mode: "relationships", kind: "Location", member: true },
  { mode: "relationships", kind: "Character", member: true }
] as const)("preserves routing eligibility for $kind in $mode with member=$member", ({ mode, kind, member }) => {
  const context = inputs();
  context.workspaceMode = mode;
  context.nodes = [{ id: "visual", data: { canonicalNodeId: "canonical", kind } }];
  context.activeStoryFlow = { flow: { id: "flow-a" }, nodes: member ? [{ node_id: "canonical" }] : [] };
  const view = renderHook(() => useFlowMembershipActions(context));
  const actions = view.result.current.get("canonical")!;
  expect(typeof actions.onSetFlowEntry === "function").toBe(mode !== "story" && member);
  expect(typeof actions.onConfigureSceneBoundary === "function").toBe(mode !== "story" && member && kind === "Scene");
});

it.each(cases)("keeps $action identity and exact setter order with current committed commands", ({ action, source, dialog }) => {
  const original = inputs();
  const view = renderHook(({ context }) => useFlowMembershipActions(context), { initialProps: { context: original } });
  const actions = view.result.current;
  const retained = actions.get("canonical")![action]!;
  const next = { ...inputs(), nodes: original.nodes, activeStoryFlow: original.activeStoryFlow };
  view.rerender({ context: next });
  expect(view.result.current).toBe(actions);
  act(() => retained());
  expect(next[source]).toHaveBeenCalledWith("canonical");
  expect(next.setDialog).toHaveBeenCalledWith(dialog);
  const sourceOrder = vi.mocked(next[source]).mock.invocationCallOrder[0]!;
  const dialogOrder = vi.mocked(next.setDialog).mock.invocationCallOrder[0]!;
  expect(sourceOrder).toBeLessThan(dialogOrder);
  if (action === "onConfigureSceneBoundary") {
    expect(next.setFlowActionError).toHaveBeenCalledWith(null);
    const errorOrder = vi.mocked(next.setFlowActionError).mock.invocationCallOrder[0]!;
    expect(sourceOrder).toBeLessThan(errorOrder);
    expect(errorOrder).toBeLessThan(dialogOrder);
    expect(next.setEntryCandidateId).not.toHaveBeenCalled();
  } else {
    expect(next.setFlowActionError).not.toHaveBeenCalled();
    expect(next.setBoundarySceneId).not.toHaveBeenCalled();
  }
  expect(original[source]).not.toHaveBeenCalled();
  expect(original.setDialog).not.toHaveBeenCalled();
});

it("uses current canonical Scene types rather than freezing boundary eligibility", () => {
  const context = inputs();
  const view = renderHook(({ context }) => useFlowMembershipActions(context), { initialProps: { context } });
  const boundary = view.result.current.get("canonical")!.onConfigureSceneBoundary!;
  const entry = view.result.current.get("canonical")!.onSetFlowEntry;
  view.rerender({ context: { ...context, nodes: [{ id: "visual", data: { canonicalNodeId: "canonical", kind: "Location" } }] } });
  expect(view.result.current.get("canonical")!.onConfigureSceneBoundary).toBeUndefined();
  expect(view.result.current.get("canonical")!.onSetFlowEntry).toBe(entry);
  act(() => boundary());
  expect(context.setDialog).not.toHaveBeenCalled();
  view.rerender({ context });
  expect(view.result.current.get("canonical")!.onConfigureSceneBoundary).toBe(boundary);
  act(() => boundary());
  expect(context.setBoundarySceneId).toHaveBeenCalledWith("canonical");
});

it("resolves Scene eligibility across canonical aliases independently of placement order", () => {
  const context = inputs();
  context.nodes = [{ id: "portal", data: { canonicalNodeId: "canonical", kind: "Location" } }, ...context.nodes];
  const view = renderHook(({ context }) => useFlowMembershipActions(context), { initialProps: { context } });
  const boundary = view.result.current.get("canonical")!.onConfigureSceneBoundary!;
  expect(boundary).toBeTypeOf("function");
  view.rerender({ context: { ...context, nodes: context.nodes.slice(0, 1) } });
  act(() => boundary());
  expect(context.setDialog).not.toHaveBeenCalled();
});

it.each(cases)("retires $action across removed/project/Flow scopes and unmount", ({ action }) => {
  const context = inputs();
  const view = renderHook(({ context }) => useFlowMembershipActions(context), { initialProps: { context }, wrapper: StrictMode });
  for (const replacement of [
    { ...context, nodes: [] }, { ...context, projectId: "project-b" },
    { ...context, activeStoryFlow: { flow: { id: "flow-b" }, nodes: [{ node_id: "canonical" }] } },
    { ...context, activeStoryFlow: null }
  ]) {
    const old = view.result.current.get("canonical")![action]!;
    view.rerender({ context: replacement });
    act(() => old());
    view.rerender({ context });
    expect(view.result.current.get("canonical")![action]).not.toBe(old);
  }
  expect(context.setDialog).not.toHaveBeenCalled();
  const active = view.result.current.get("canonical")![action]!;
  act(() => active());
  expect(context.setDialog).toHaveBeenCalledOnce();
  view.unmount();
  act(() => active());
  expect(context.setDialog).toHaveBeenCalledOnce();
});

it.each(cases)("does not publish suspended $action commands or eligibility", ({ action, source }) => {
  const original = inputs();
  const pending = new Promise<void>(() => {});
  const view = renderHook(({ context, suspend }) => {
    const actions = useFlowMembershipActions(context);
    if (suspend) throw pending;
    return actions;
  }, { initialProps: { context: original, suspend: false }, wrapper: ({ children }) => <Suspense fallback={null}>{children}</Suspense> });
  const retained = view.result.current.get("canonical")![action]!;
  const next = { ...inputs(), workspaceMode: "story" as const };
  view.rerender({ context: next, suspend: true });
  act(() => retained());
  expect(original[source]).toHaveBeenCalledWith("canonical");
  expect(next[source]).not.toHaveBeenCalled();
  view.rerender({ context: next, suspend: false });
  act(() => retained());
  expect(original[source]).toHaveBeenCalledOnce();
  expect(next[source]).not.toHaveBeenCalled();
});

it.each(cases)("propagates $action setter failures without opening a partial dialog", ({ action, source }) => {
  const context = inputs();
  const error = new Error("Setter failed");
  const failed = action === "onSetFlowEntry" ? context.setEntryCandidateId : context.setFlowActionError;
  vi.mocked(failed).mockImplementation(() => { throw error; });
  const view = renderHook(() => useFlowMembershipActions(context));
  expect(() => view.result.current.get("canonical")![action]!()).toThrow(error);
  expect(context[source]).toHaveBeenCalledWith("canonical");
  expect(context.setDialog).not.toHaveBeenCalled();
});

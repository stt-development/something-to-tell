import { act, renderHook } from "@testing-library/react";
import { StrictMode, Suspense } from "react";
import { expect, it, vi } from "vitest";
import { useFlowMembershipActions, type FlowMembershipActionInputs } from "./useFlowMembershipActions";

const cases = [
  { action: "onCallFlow", command: "openFlowInvocation" },
  { action: "onCreateFlowExit", command: "openFlowExit" }
] as const;
function inputs(): FlowMembershipActionInputs {
  return { projectId: "project-a", nodes: [{ id: "primary", data: { canonicalNodeId: "canonical" } },
    { id: "linked", data: { canonicalNodeId: "canonical" } }],
    activeStoryFlow: { flow: { id: "flow-a" }, nodes: [{ node_id: "canonical" }] }, workspaceMode: "relationships",
    addNodeToActiveStoryFlow: vi.fn(async () => null), openContinueFlow: vi.fn(), openFlowInvocation: vi.fn(), openFlowExit: vi.fn(),
    setEntryCandidateId: vi.fn(), setBoundarySceneId: vi.fn(), setFlowActionError: vi.fn(), setDialog: vi.fn() };
}

it.each(cases)("retains $action and passes canonical identity to the current command", ({ action, command }) => {
  const original = inputs();
  const view = renderHook(({ context }) => useFlowMembershipActions(context), { initialProps: { context: original } });
  const actions = view.result.current;
  const retained = actions.get("canonical")![action]!;
  expect(actions.size).toBe(1);
  const next = { ...original, [command]: vi.fn() };
  view.rerender({ context: next });
  expect(view.result.current).toBe(actions);
  act(() => retained());
  expect(next[command]).toHaveBeenCalledOnce();
  expect(next[command]).toHaveBeenCalledWith("canonical");
  expect(original[command]).not.toHaveBeenCalled();
  expect(next.openContinueFlow).not.toHaveBeenCalled();
  expect(next.addNodeToActiveStoryFlow).not.toHaveBeenCalled();
});

it.each(cases)("rechecks $action eligibility and retires removed/project/Flow scopes", ({ action, command }) => {
  const context = inputs();
  const view = renderHook(({ context }) => useFlowMembershipActions(context), { initialProps: { context } });
  const retained = view.result.current.get("canonical")![action]!;
  view.rerender({ context: { ...context, workspaceMode: "story" } });
  expect(view.result.current.get("canonical")![action]).toBeUndefined();
  act(() => retained());
  view.rerender({ context: { ...context, workspaceMode: "flow", activeStoryFlow: { flow: { id: "flow-a" }, nodes: [] } } });
  expect(view.result.current.get("canonical")![action]).toBeUndefined();
  act(() => retained());
  expect(context[command]).not.toHaveBeenCalled();
  view.rerender({ context });
  expect(view.result.current.get("canonical")![action]).toBe(retained);
  view.rerender({ context: { ...context, nodes: [] } });
  act(() => retained());
  view.rerender({ context });
  const restored = view.result.current.get("canonical")![action]!;
  expect(restored).not.toBe(retained);
  view.rerender({ context: { ...context, projectId: "project-b" } });
  act(() => restored());
  const otherProject = view.result.current.get("canonical")![action]!;
  view.rerender({ context: { ...context, projectId: "project-b", activeStoryFlow: { flow: { id: "flow-b" }, nodes: [{ node_id: "canonical" }] } } });
  act(() => otherProject());
  expect(context[command]).not.toHaveBeenCalled();
  act(() => view.result.current.get("canonical")![action]!());
  expect(context[command]).toHaveBeenCalledOnce();
});

it.each(cases)("isolates suspended $action inputs and revokes callbacks on unmount", ({ action, command }) => {
  const original = inputs();
  const pending = new Promise<void>(() => {});
  const view = renderHook(({ context, suspend }) => {
    const actions = useFlowMembershipActions(context);
    if (suspend) throw pending;
    return actions;
  }, { initialProps: { context: original, suspend: false }, wrapper: ({ children }) => <StrictMode><Suspense fallback={null}>{children}</Suspense></StrictMode> });
  const retained = view.result.current.get("canonical")![action]!;
  const next = { ...inputs(), projectId: "project-b" };
  view.rerender({ context: next, suspend: true });
  act(() => retained());
  expect(original[command]).toHaveBeenCalledOnce();
  expect(next[command]).not.toHaveBeenCalled();
  view.rerender({ context: next, suspend: false });
  act(() => retained());
  expect(original[command]).toHaveBeenCalledOnce();
  const active = view.result.current.get("canonical")![action]!;
  act(() => active());
  expect(next[command]).toHaveBeenCalledWith("canonical");
  view.unmount();
  act(() => active());
  expect(next[command]).toHaveBeenCalledOnce();
});

it.each(cases)("propagates $action command errors without invoking another action", ({ action, command }) => {
  const context = inputs();
  const error = new Error("Dialog failed");
  vi.mocked(context[command]).mockImplementation(() => { throw error; });
  const view = renderHook(() => useFlowMembershipActions(context));
  expect(() => view.result.current.get("canonical")![action]!()).toThrow(error);
  expect(command === "openFlowInvocation" ? context.openFlowExit : context.openFlowInvocation).not.toHaveBeenCalled();
  expect(context.openContinueFlow).not.toHaveBeenCalled();
});

import { act, renderHook } from "@testing-library/react";
import { StrictMode, Suspense } from "react";
import { expect, it, vi } from "vitest";
import { useFlowCallOpenActions, type FlowCallOpenInputs } from "./useFlowCallOpenActions";

function inputs(): FlowCallOpenInputs {
  return { projectId: "project-a", nodes: [{ id: "primary", data: { canonicalNodeId: "source" } }, { id: "linked", data: { canonicalNodeId: "source" } }],
    activeStoryFlow: { flow: { id: "flow-a" }, invocations: [{ id: "call-a", source_node_id: "source" }, { id: "call-b", source_node_id: "source" }, { id: "hidden", source_node_id: "absent" }] },
    setSelectedInvocationId: vi.fn(), setDialog: vi.fn() };
}

it("keys by invocation id, shares across canonical placements and selects before opening", () => {
  const context = inputs();
  const view = renderHook(() => useFlowCallOpenActions(context));
  expect([...view.result.current.keys()]).toEqual(["call-a", "call-b"]);
  expect(context.setSelectedInvocationId).not.toHaveBeenCalled();
  act(() => view.result.current.get("call-b")!());
  expect(context.setSelectedInvocationId).toHaveBeenCalledWith("call-b");
  expect(context.setDialog).toHaveBeenCalledWith("flow-call-bindings");
  expect(vi.mocked(context.setSelectedInvocationId).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(context.setDialog).mock.invocationCallOrder[0]!);
});

it("adopts replacement setters without new node/call inputs or action identities", () => {
  const original = inputs();
  const view = renderHook(({ context }) => useFlowCallOpenActions(context), { initialProps: { context: original } });
  const actions = view.result.current;
  const next = { ...original, setSelectedInvocationId: vi.fn(), setDialog: vi.fn() };
  view.rerender({ context: next });
  expect(view.result.current).toBe(actions);
  act(() => actions.get("call-a")!());
  expect(next.setSelectedInvocationId).toHaveBeenCalledWith("call-a");
  expect(next.setDialog).toHaveBeenCalledWith("flow-call-bindings");
  expect(original.setSelectedInvocationId).not.toHaveBeenCalled();
  expect(original.setDialog).not.toHaveBeenCalled();
});

it("retains call identity when records, source placement or source canonical id change", () => {
  const context = inputs();
  const view = renderHook(({ context }) => useFlowCallOpenActions(context), { initialProps: { context } });
  const open = view.result.current.get("call-a");
  const next = { ...context, nodes: [{ id: "other-placement", data: { canonicalNodeId: "other-source" } }],
    activeStoryFlow: { flow: { id: "flow-a" }, invocations: [{ id: "call-a", source_node_id: "other-source", label: "Updated", target_flow_id: "new-target" }] } };
  view.rerender({ context: next });
  expect([...view.result.current.keys()]).toEqual(["call-a"]);
  expect(view.result.current.get("call-a")).toBe(open);
});

it.each(["deleted", "hidden source"])("prunes a %s call and does not revive its retired callback", (reason) => {
  const context = inputs();
  const view = renderHook(({ context }) => useFlowCallOpenActions(context), { initialProps: { context } });
  const retired = view.result.current.get("call-a")!;
  view.rerender({ context: reason === "deleted" ? { ...context, activeStoryFlow: { flow: { id: "flow-a" }, invocations: [] } } : { ...context, nodes: [] } });
  expect(view.result.current.size).toBe(0);
  act(() => retired());
  view.rerender({ context });
  expect(view.result.current.get("call-a")).not.toBe(retired);
  act(() => retired());
  expect(context.setDialog).not.toHaveBeenCalled();
});

it.each(["project", "flow", "no flow"])("retires call actions on %s replacement even with reused ids", (scope) => {
  const context = inputs();
  const view = renderHook(({ context }) => useFlowCallOpenActions(context), { initialProps: { context } });
  const retired = view.result.current.get("call-a")!;
  const next = scope === "project" ? { ...context, projectId: "project-b" }
    : scope === "flow" ? { ...context, activeStoryFlow: { ...context.activeStoryFlow!, flow: { id: "flow-b" } } }
    : { ...context, activeStoryFlow: null };
  view.rerender({ context: next });
  act(() => retired());
  view.rerender({ context });
  expect(view.result.current.get("call-a")).not.toBe(retired);
  act(() => retired());
  expect(context.setSelectedInvocationId).not.toHaveBeenCalled();
});

it("bounds the registry to current visible invocations", () => {
  const context = inputs();
  const view = renderHook(({ context }) => useFlowCallOpenActions(context), { initialProps: { context } });
  for (let index = 0; index < 20; index += 1) {
    view.rerender({ context: { ...context, activeStoryFlow: { flow: { id: "flow-a" }, invocations: [{ id: `call:${index}`, source_node_id: "source" }] } } });
    expect([...view.result.current.keys()]).toEqual([`call:${index}`]);
  }
});

it("does not publish speculative setters or prune committed calls during suspension", () => {
  const original = inputs();
  const pending = new Promise<void>(() => {});
  const view = renderHook(({ context, suspend }) => {
    const actions = useFlowCallOpenActions(context);
    if (suspend) throw pending;
    return actions;
  }, { initialProps: { context: original, suspend: false }, wrapper: ({ children }) => <Suspense fallback={null}>{children}</Suspense> });
  const retained = view.result.current.get("call-a")!;
  const next = { ...inputs(), activeStoryFlow: null };
  view.rerender({ context: next, suspend: true });
  act(() => retained());
  expect(original.setSelectedInvocationId).toHaveBeenCalledWith("call-a");
  expect(next.setDialog).not.toHaveBeenCalled();
  view.rerender({ context: next, suspend: false });
  act(() => retained());
  expect(original.setSelectedInvocationId).toHaveBeenCalledOnce();
});

it("supports Strict Mode replay and revokes detached callbacks on unmount", () => {
  const context = inputs();
  const view = renderHook(() => useFlowCallOpenActions(context), { wrapper: StrictMode });
  const open = view.result.current.get("call-a")!;
  act(() => open());
  expect(context.setDialog).toHaveBeenCalledOnce();
  view.unmount();
  act(() => open());
  expect(context.setDialog).toHaveBeenCalledOnce();
});

it("propagates selection failures without opening a partial bindings dialog", () => {
  const context = inputs();
  vi.mocked(context.setSelectedInvocationId).mockImplementation(() => { throw new Error("Selection failed"); });
  const view = renderHook(() => useFlowCallOpenActions(context));
  expect(() => view.result.current.get("call-a")!()).toThrow("Selection failed");
  expect(context.setDialog).not.toHaveBeenCalled();
});

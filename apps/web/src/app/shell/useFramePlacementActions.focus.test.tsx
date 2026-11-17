import type { Node } from "@xyflow/react";
import { act, renderHook } from "@testing-library/react";
import { Suspense } from "react";
import { expect, it, vi } from "vitest";
import type { NarrativeNodeData } from "../../types";
import { useFramePlacementActions, type FramePlacementActionInputs } from "./useFramePlacementActions";

const frame = (id = "placement:scene"): Node<NarrativeNodeData> => ({
  id, position: { x: 100, y: 200 }, width: 900, height: 600,
  data: { kind: "Scene", isFrame: true, canonicalNodeId: "canonical", title: "Dock", label: "Dock", summary: "Initial text", tags: [], presentationState: "expanded" }
});
function inputs(nodes = [frame()]): FramePlacementActionInputs {
  return { projectId: "project-a", nodes, setFrameAddMenuId: vi.fn(), fitFrame: vi.fn(),
    toggleFrameCollapse: vi.fn(), openFrameWorkspace: vi.fn() };
}

it("retains focus identity but passes the exact current projected node and command", () => {
  const original = inputs();
  const view = renderHook(({ context }) => useFramePlacementActions(context), { initialProps: { context: original } });
  const focus = view.result.current.get("placement:scene")!.onFocusFrame;
  const projected: Node<NarrativeNodeData> = { ...frame(), position: { x: 0, y: 0 }, width: 210, height: 132,
    data: { ...frame().data, title: "Renamed Dock", summary: "Rewritten", presentationState: "collapsed" } };
  const next = inputs([projected]);
  view.rerender({ context: next });
  expect(view.result.current.get(projected.id)!.onFocusFrame).toBe(focus);
  act(() => focus());
  expect(next.openFrameWorkspace).toHaveBeenCalledOnce();
  expect(vi.mocked(next.openFrameWorkspace).mock.calls[0]![0]).toBe(projected);
  expect(original.openFrameWorkspace).not.toHaveBeenCalled();
  // Existing App command, not the adapter, decides collapse/selection/focus policy.
  expect(next.toggleFrameCollapse).not.toHaveBeenCalled();
  expect(next.fitFrame).not.toHaveBeenCalled();
});

it("adopts a replacement focus command without changing nodes or action identity", () => {
  const original = inputs();
  const view = renderHook(({ context }) => useFramePlacementActions(context), { initialProps: { context: original } });
  const actions = view.result.current;
  const next = { ...original, openFrameWorkspace: vi.fn() };
  view.rerender({ context: next });
  expect(view.result.current).toBe(actions);
  act(() => actions.get("placement:scene")!.onFocusFrame());
  expect(vi.mocked(next.openFrameWorkspace).mock.calls[0]![0]).toBe(original.nodes[0]);
  expect(original.openFrameWorkspace).not.toHaveBeenCalled();
});

it("does not publish a speculative node or focus command before commit", () => {
  const original = inputs();
  const pending = new Promise<void>(() => {});
  const view = renderHook(({ context, suspend }) => {
    const actions = useFramePlacementActions(context);
    if (suspend) throw pending;
    return actions;
  }, { initialProps: { context: original, suspend: false }, wrapper: ({ children }) => <Suspense fallback={null}>{children}</Suspense> });
  const focus = view.result.current.get("placement:scene")!.onFocusFrame;
  const next = inputs([{ ...frame(), data: { ...frame().data, title: "Uncommitted" } }]);
  view.rerender({ context: next, suspend: true });
  act(() => focus());
  expect(vi.mocked(original.openFrameWorkspace).mock.calls[0]![0]).toBe(original.nodes[0]);
  expect(next.openFrameWorkspace).not.toHaveBeenCalled();
  view.rerender({ context: next, suspend: false });
  expect(view.result.current.get("placement:scene")!.onFocusFrame).toBe(focus);
  act(() => focus());
  expect(vi.mocked(next.openFrameWorkspace).mock.calls[0]![0]).toBe(next.nodes[0]);
});

it("does not focus a removed, replaced-project or unmounted placement", () => {
  const original = inputs();
  const view = renderHook(({ context }) => useFramePlacementActions(context), { initialProps: { context: original } });
  const old = view.result.current.get("placement:scene")!.onFocusFrame;
  const next = { ...inputs(), projectId: "project-b" };
  view.rerender({ context: next });
  act(() => old());
  expect(next.openFrameWorkspace).not.toHaveBeenCalled();
  const active = view.result.current.get("placement:scene")!.onFocusFrame;
  view.rerender({ context: { ...next, nodes: [] } });
  act(() => active());
  expect(next.openFrameWorkspace).not.toHaveBeenCalled();
  view.rerender({ context: next });
  const restored = view.result.current.get("placement:scene")!.onFocusFrame;
  expect(restored).not.toBe(active);
  view.unmount();
  act(() => restored());
  expect(next.openFrameWorkspace).not.toHaveBeenCalled();
  expect(original.openFrameWorkspace).not.toHaveBeenCalled();
});

it("passes focus failures through without triggering another frame action", () => {
  const context = inputs();
  const error = new Error("Focus failed");
  vi.mocked(context.openFrameWorkspace).mockImplementation(() => { throw error; });
  const view = renderHook(() => useFramePlacementActions(context));
  expect(() => view.result.current.get("placement:scene")!.onFocusFrame()).toThrow(error);
  expect(context.toggleFrameCollapse).not.toHaveBeenCalled();
  expect(context.fitFrame).not.toHaveBeenCalled();
  expect(context.setFrameAddMenuId).not.toHaveBeenCalled();
});

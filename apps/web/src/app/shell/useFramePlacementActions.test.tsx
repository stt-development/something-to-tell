import { act, renderHook } from "@testing-library/react";
import { StrictMode, Suspense } from "react";
import { expect, it, vi } from "vitest";
import type { Node } from "@xyflow/react";
import type { NarrativeNodeData } from "../../types";
import { useFramePlacementActions, type FramePlacementActionInputs, type FramePlacementActions } from "./useFramePlacementActions";

const frame = (id: string): Node<NarrativeNodeData> => ({ id, position: { x: 10, y: 20 },
  data: { isFrame: true, canonicalNodeId: "shared-canonical", title: "Container", label: "Scene", kind: "Scene", summary: "", tags: [] } });
function inputs(): FramePlacementActionInputs {
  return { projectId: "project-a", nodes: [frame("placement:a"), frame("placement:b"), { ...frame("ordinary"), data: { ...frame("ordinary").data, isFrame: false } }],
    setFrameAddMenuId: vi.fn(), fitFrame: vi.fn(), toggleFrameCollapse: vi.fn(), openFrameWorkspace: vi.fn() };
}
function invoke(actions: FramePlacementActions) {
  act(() => { actions.onAddLinked(); actions.onFitContent(); actions.onToggleCollapse(); actions.onFocusFrame(); });
}

it("creates only frame actions for eligible placements and keeps exact visual ids", () => {
  const context = inputs();
  const view = renderHook(() => useFramePlacementActions(context));
  expect([...view.result.current.keys()]).toEqual(["placement:a", "placement:b"]);
  expect(Object.keys(view.result.current.get("placement:a")!)).toEqual(["onAddLinked", "onFitContent", "onToggleCollapse", "onFocusFrame"]);
  for (const command of [context.setFrameAddMenuId, context.fitFrame, context.toggleFrameCollapse]) expect(command).not.toHaveBeenCalled();
  invoke(view.result.current.get("placement:b")!);
  for (const command of [context.setFrameAddMenuId, context.fitFrame, context.toggleFrameCollapse]) expect(command).toHaveBeenCalledOnce();
  expect(context.setFrameAddMenuId).toHaveBeenCalledWith("placement:b");
  expect(context.fitFrame).toHaveBeenCalledWith("placement:b");
  expect(context.toggleFrameCollapse).toHaveBeenCalledWith("placement:b");
  expect(vi.mocked(context.openFrameWorkspace).mock.calls[0]![0]).toBe(context.nodes[1]);
});

it("retains bundles through node data/order changes while adopting current committed commands", () => {
  const original = inputs();
  const view = renderHook(({ context }) => useFramePlacementActions(context), { initialProps: { context: original } });
  const retained = view.result.current.get("placement:a")!;
  const next = { ...inputs(), nodes: [frame("placement:b"), { ...frame("placement:a"), data: { ...frame("placement:a").data, title: "Renamed" } }] };
  view.rerender({ context: next });
  expect(view.result.current.get("placement:a")).toBe(retained);
  invoke(retained);
  for (const command of [original.setFrameAddMenuId, original.fitFrame, original.toggleFrameCollapse, original.openFrameWorkspace]) expect(command).not.toHaveBeenCalled();
  for (const command of [next.setFrameAddMenuId, next.fitFrame, next.toggleFrameCollapse]) expect(command).toHaveBeenCalledWith("placement:a");
});

it.each(["removed", "not a frame"])("prunes a %s placement and does not revive retired closures on re-add", (reason) => {
  const context = inputs();
  const view = renderHook(({ context }) => useFramePlacementActions(context), { initialProps: { context } });
  const retired = view.result.current.get("placement:a")!;
  const remaining = reason === "removed" ? [frame("placement:b")] : [frame("placement:b"), { ...frame("placement:a"), data: { ...frame("placement:a").data, isFrame: false } }];
  view.rerender({ context: { ...context, nodes: remaining } });
  expect([...view.result.current.keys()]).toEqual(["placement:b"]);
  invoke(retired);
  view.rerender({ context });
  expect(view.result.current.get("placement:a")).not.toBe(retired);
  invoke(retired);
  for (const command of [context.setFrameAddMenuId, context.fitFrame, context.toggleFrameCollapse, context.openFrameWorkspace]) expect(command).not.toHaveBeenCalled();
  invoke(view.result.current.get("placement:a")!);
  expect(context.fitFrame).toHaveBeenCalledOnce();
});

it("replaces bundles on project switch even with reused ids and does not revive them on return", () => {
  const original = inputs();
  const view = renderHook(({ context }) => useFramePlacementActions(context), { initialProps: { context: original } });
  const retired = view.result.current.get("placement:a")!;
  const next = { ...inputs(), projectId: "project-b" };
  view.rerender({ context: next });
  const active = view.result.current.get("placement:a")!;
  expect(active).not.toBe(retired);
  invoke(retired);
  expect(next.fitFrame).not.toHaveBeenCalled();
  invoke(active);
  expect(next.fitFrame).toHaveBeenCalledWith("placement:a");
  view.rerender({ context: original });
  expect(view.result.current.get("placement:a")).not.toBe(retired);
  invoke(retired);
  invoke(active);
  expect(original.fitFrame).not.toHaveBeenCalled();
});

it("prunes to the live projection instead of accumulating previously seen placements", () => {
  const context = inputs();
  const view = renderHook(({ context }) => useFramePlacementActions(context), { initialProps: { context } });
  for (let index = 0; index < 25; index += 1) {
    view.rerender({ context: { ...context, nodes: [frame(`frame:${index}`)] } });
    expect([...view.result.current.keys()]).toEqual([`frame:${index}`]);
  }
  view.rerender({ context: { ...context, nodes: [] } });
  expect(view.result.current.size).toBe(0);
});

it("does not publish commands or prune the committed map during suspended renders", () => {
  const original = inputs();
  const pending = new Promise<void>(() => {});
  const view = renderHook(({ context, suspend }) => {
    const actions = useFramePlacementActions(context);
    if (suspend) throw pending;
    return actions;
  }, { initialProps: { context: original, suspend: false }, wrapper: ({ children }) => <Suspense fallback={null}>{children}</Suspense> });
  const retained = view.result.current.get("placement:a")!;
  const next = { ...inputs(), nodes: [frame("placement:b")] };
  view.rerender({ context: next, suspend: true });
  invoke(retained);
  expect(original.fitFrame).toHaveBeenCalledWith("placement:a");
  expect(next.fitFrame).not.toHaveBeenCalled();
  view.rerender({ context: original, suspend: false });
  expect(view.result.current.get("placement:a")).toBe(retained);
  view.rerender({ context: next, suspend: false });
  invoke(retained);
  expect(original.fitFrame).toHaveBeenCalledOnce();
  expect(next.fitFrame).not.toHaveBeenCalled();
});

it("adopts commands only when a suspended replacement project commits", () => {
  const original = inputs();
  const pending = new Promise<void>(() => {});
  const view = renderHook(({ context, suspend }) => {
    const actions = useFramePlacementActions(context);
    if (suspend) throw pending;
    return actions;
  }, { initialProps: { context: original, suspend: false }, wrapper: ({ children }) => <Suspense fallback={null}>{children}</Suspense> });
  const old = view.result.current.get("placement:a")!;
  const next = { ...inputs(), projectId: "project-b" };
  view.rerender({ context: next, suspend: true });
  invoke(old);
  expect(original.fitFrame).toHaveBeenCalledOnce();
  view.rerender({ context: next, suspend: false });
  invoke(old);
  expect(original.fitFrame).toHaveBeenCalledOnce();
  invoke(view.result.current.get("placement:a")!);
  expect(next.fitFrame).toHaveBeenCalledWith("placement:a");
});

it("revokes detached actions on unmount and supports Strict Mode effect replay", () => {
  const context = inputs();
  const view = renderHook(() => useFramePlacementActions(context), { wrapper: StrictMode });
  const actions = view.result.current.get("placement:a")!;
  invoke(actions);
  expect(context.fitFrame).toHaveBeenCalledOnce();
  view.unmount();
  invoke(actions);
  expect(context.fitFrame).toHaveBeenCalledOnce();
});

it("propagates command failures without changing the bundle or calling other commands", () => {
  const context = inputs();
  const error = new Error("Fit failed");
  vi.mocked(context.fitFrame).mockImplementation(() => { throw error; });
  const view = renderHook(() => useFramePlacementActions(context));
  const actions = view.result.current.get("placement:a")!;
  expect(() => actions.onFitContent()).toThrow(error);
  expect(view.result.current.get("placement:a")).toBe(actions);
  expect(context.setFrameAddMenuId).not.toHaveBeenCalled();
  expect(context.toggleFrameCollapse).not.toHaveBeenCalled();
});

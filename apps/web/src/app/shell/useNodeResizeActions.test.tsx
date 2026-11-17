import type { Node } from "@xyflow/react";
import { act, renderHook } from "@testing-library/react";
import { Suspense } from "react";
import { expect, it, vi } from "vitest";
import type { NarrativeNodeData } from "../../types";
import { useNodeResizeActions, type NodeResizeInputs } from "./useNodeResizeActions";

const primary: Node<NarrativeNodeData> = {
  id: "primary", position: { x: 20, y: 30 }, width: 240, height: 180,
  data: { kind: "Character", label: "Character", title: "Actor", summary: "", tags: [], canonicalNodeId: "canonical" }
};
const linked = { ...primary, id: "placement:linked", parentId: "frame", width: 320,
  data: { ...primary.data, isLinkedInstance: true } };

function inputs() {
  const dragStartNodesRef: NodeResizeInputs["dragStartNodesRef"] = { current: null };
  return { dragStartNodesRef, getActiveGraph: vi.fn(() => ({ nodes: [primary, linked] })),
    completeNodeResize: vi.fn<NodeResizeInputs["completeNodeResize"]>() } satisfies NodeResizeInputs;
}

it("captures the live graph array at start without cloning canonical or linked placements", () => {
  const context = inputs();
  const view = renderHook(() => useNodeResizeActions(context));
  expect(context.getActiveGraph).not.toHaveBeenCalled();
  const eventNodes = [{ ...primary, width: 500 }, linked];
  context.getActiveGraph.mockReturnValue({ nodes: eventNodes });
  act(() => view.result.current.onResizeStart());
  expect(context.getActiveGraph).toHaveBeenCalledOnce();
  expect(context.dragStartNodesRef.current).toBe(eventNodes);
  expect(context.dragStartNodesRef.current?.[1]).toBe(linked);
  expect(context.completeNodeResize).not.toHaveBeenCalled();
});

it("completes with the exact start snapshot before clearing and does not query at end", () => {
  const context = inputs();
  const view = renderHook(() => useNodeResizeActions(context));
  act(() => view.result.current.onResizeStart());
  const snapshot = context.dragStartNodesRef.current;
  context.getActiveGraph.mockReturnValue({ nodes: [primary, { ...linked, width: 700 }] });
  context.completeNodeResize.mockImplementation((previous) => expect(context.dragStartNodesRef.current).toBe(previous));
  act(() => view.result.current.onResizeEnd());
  expect(context.completeNodeResize).toHaveBeenCalledOnce();
  expect(context.completeNodeResize.mock.calls[0]![0]).toBe(snapshot);
  expect(context.getActiveGraph).toHaveBeenCalledOnce();
  expect(context.dragStartNodesRef.current).toBeNull();
  act(() => view.result.current.onResizeEnd());
  expect(context.completeNodeResize).toHaveBeenCalledOnce();
});

it.each([null, []])("preserves missing versus empty snapshot semantics: %j", (snapshot) => {
  const context = inputs();
  context.dragStartNodesRef.current = snapshot;
  const view = renderHook(() => useNodeResizeActions(context));
  act(() => view.result.current.onResizeEnd());
  expect(context.completeNodeResize.mock.calls).toEqual(snapshot ? [[snapshot]] : []);
  expect(context.getActiveGraph).not.toHaveBeenCalled();
  expect(context.dragStartNodesRef.current).toBeNull();
});

it("uses the live shared ref at end and lets a subsequent start replace its contents", () => {
  const context = inputs();
  const view = renderHook(() => useNodeResizeActions(context));
  act(() => view.result.current.onResizeStart());
  const next = [linked];
  context.dragStartNodesRef.current = next;
  act(() => view.result.current.onResizeEnd());
  expect(context.completeNodeResize).toHaveBeenLastCalledWith(next);
  context.getActiveGraph.mockReturnValue({ nodes: [] });
  act(() => view.result.current.onResizeStart());
  act(() => view.result.current.onResizeEnd());
  expect(context.completeNodeResize).toHaveBeenLastCalledWith([]);
});

it("retains both actions while using current query, command and ref after replacement", () => {
  const original = inputs();
  const view = renderHook(({ context }) => useNodeResizeActions(context), { initialProps: { context: original } });
  const actions = view.result.current;
  const next = inputs();
  view.rerender({ context: next });
  expect(view.result.current).toBe(actions);
  act(() => actions.onResizeStart());
  const snapshot = next.dragStartNodesRef.current;
  const complete = vi.fn<NodeResizeInputs["completeNodeResize"]>();
  view.rerender({ context: { ...next, completeNodeResize: complete } });
  act(() => actions.onResizeEnd());
  expect(complete).toHaveBeenCalledOnce();
  expect(complete.mock.calls[0]![0]).toBe(snapshot);
  expect(next.dragStartNodesRef.current).toBeNull();
  expect(next.completeNodeResize).not.toHaveBeenCalled();
  expect(original.getActiveGraph).not.toHaveBeenCalled();
  expect(original.completeNodeResize).not.toHaveBeenCalled();
  expect(original.dragStartNodesRef.current).toBeNull();
});

it("propagates completion errors and retains the snapshot as before", () => {
  const context = inputs();
  const view = renderHook(() => useNodeResizeActions(context));
  act(() => view.result.current.onResizeStart());
  const snapshot = context.dragStartNodesRef.current;
  const error = new Error("Dispatch failed");
  context.completeNodeResize.mockImplementation(() => { throw error; });
  expect(() => view.result.current.onResizeEnd()).toThrow(error);
  expect(context.dragStartNodesRef.current).toBe(snapshot);
});

it("does not migrate an old gesture buffer into a replacement ref", () => {
  const original = inputs();
  const view = renderHook(({ context }) => useNodeResizeActions(context), { initialProps: { context: original } });
  act(() => view.result.current.onResizeStart());
  const snapshot = original.dragStartNodesRef.current;
  const next = inputs();
  view.rerender({ context: next });
  act(() => view.result.current.onResizeEnd());
  expect(next.completeNodeResize).not.toHaveBeenCalled();
  expect(original.completeNodeResize).not.toHaveBeenCalled();
  expect(original.dragStartNodesRef.current).toBe(snapshot);
  expect(next.dragStartNodesRef.current).toBeNull();
});

it("does not publish suspended query, ref or command inputs until commit", () => {
  const original = inputs();
  const pending = new Promise<void>(() => {});
  const view = renderHook(({ context, suspend }) => {
    const actions = useNodeResizeActions(context);
    if (suspend) throw pending;
    return actions;
  }, { initialProps: { context: original, suspend: false }, wrapper: ({ children }) => <Suspense fallback={null}>{children}</Suspense> });
  const actions = view.result.current;
  const next = inputs();
  view.rerender({ context: next, suspend: true });
  act(() => actions.onResizeStart());
  act(() => actions.onResizeEnd());
  expect(original.completeNodeResize).toHaveBeenCalledOnce();
  expect(next.getActiveGraph).not.toHaveBeenCalled();
  expect(next.completeNodeResize).not.toHaveBeenCalled();
  view.rerender({ context: next, suspend: false });
  act(() => actions.onResizeStart());
  act(() => actions.onResizeEnd());
  expect(next.completeNodeResize).toHaveBeenCalledOnce();
  expect(view.result.current).toBe(actions);
});

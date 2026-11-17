import type { Edge, EdgeChange, Node, NodeChange } from "@xyflow/react";
import { act, render } from "@testing-library/react";
import { Suspense, useLayoutEffect } from "react";
import { expect, it, vi } from "vitest";
import { createCanvasSelection, type CanvasSelection, type NarrativeEdgeData, type NarrativeNodeData } from "../../types";
import { useCanvasChangeHandlers, type CanvasChangeInputs } from "./useCanvasChangeHandlers";

type NodeBatch = NodeChange<Node<NarrativeNodeData>>[];
type EdgeBatch = EdgeChange<Edge<NarrativeEdgeData>>[];
const parent: Node<NarrativeNodeData> = {
  id: "parent-placement", position: { x: 0, y: 0 },
  data: { kind: "Scene", label: "Scene", title: "Stage", summary: "", tags: [], canonicalNodeId: "scene" }
};
const child: Node<NarrativeNodeData> = { ...parent, id: "child-placement", parentId: parent.id };
const position: NodeBatch[number] = { type: "position", id: child.id, position: { x: 0, y: 20 }, dragging: true };

function inputs() {
  const alternatePanGestureRef: CanvasChangeInputs["alternatePanGestureRef"] = { current: false };
  const groupDragActiveRef: CanvasChangeInputs["groupDragActiveRef"] = { current: false };
  return {
    alternatePanGestureRef, groupDragActiveRef,
    canvasSelection: createCanvasSelection(),
    setCanvasSelection: vi.fn<CanvasChangeInputs["setCanvasSelection"]>(),
    getActiveGraph: vi.fn(() => ({ nodes: [parent, child] })),
    onNodesChange: vi.fn<CanvasChangeInputs["onNodesChange"]>(),
    onEdgesChange: vi.fn<CanvasChangeInputs["onEdgesChange"]>()
  } satisfies CanvasChangeInputs;
}

/** Retain only committed adapters, just as React Flow retains its event props. */
function mount(initial: CanvasChangeInputs) {
  const committed: ReturnType<typeof useCanvasChangeHandlers>[] = [];
  const pending = new Promise<void>(() => {});
  function Consumer({ context, suspend }: { context: CanvasChangeInputs; suspend: boolean }) {
    const handlers = useCanvasChangeHandlers(context);
    useLayoutEffect(() => { committed.push(handlers); });
    if (suspend) throw pending;
    return null;
  }
  const tree = (context: CanvasChangeInputs, suspend = false) =>
    <Suspense fallback={null}><Consumer context={context} suspend={suspend} /></Suspense>;
  const view = render(tree(initial));
  return { committed, handlers: committed[0]!, update: (next: CanvasChangeInputs, suspend = false) => view.rerender(tree(next, suspend)) };
}

function resolveUpdate(update: Parameters<CanvasChangeInputs["setCanvasSelection"]>[0], selection: CanvasSelection) {
  expect(typeof update).toBe("function");
  return typeof update === "function" ? update(selection) : update;
}

it("retains both callbacks while adopting replacement project queries and commands", () => {
  const original = inputs();
  original.alternatePanGestureRef.current = true;
  original.groupDragActiveRef.current = true;
  const view = mount(original);
  const next = inputs();
  view.update(next);
  expect(view.committed[1]).toBe(view.handlers);
  act(() => {
    view.handlers.onNodesChange([{ type: "select", id: child.id, selected: true }]);
    view.handlers.onEdgesChange([{ type: "select", id: "edge", selected: true }]);
  });
  expect(next.setCanvasSelection).toHaveBeenCalledTimes(2);
  expect(next.getActiveGraph).toHaveBeenCalledOnce();
  expect(next.onNodesChange).toHaveBeenCalledOnce();
  expect(next.onEdgesChange).toHaveBeenCalledOnce();
  expect(original.setCanvasSelection).not.toHaveBeenCalled();
  expect(original.getActiveGraph).not.toHaveBeenCalled();
  expect(original.onNodesChange).not.toHaveBeenCalled();
  expect(original.onEdgesChange).not.toHaveBeenCalled();
});

it("preserves mixed node batch order and applies selection to the setter's current state", () => {
  const context = inputs();
  const { handlers } = mount(context);
  const batch: NodeBatch = [
    { type: "select", id: child.id, selected: true }, position,
    { type: "select", id: "old", selected: false },
    { type: "dimensions", id: child.id, dimensions: { width: 200, height: 100 } },
    { type: "select", id: child.id, selected: false },
    { type: "select", id: child.id, selected: true }
  ];
  act(() => handlers.onNodesChange(batch));
  const update = context.setCanvasSelection.mock.calls[0]![0];
  expect(resolveUpdate(update, createCanvasSelection(["old", "newer"], ["edge"])))
    .toEqual(createCanvasSelection(["newer", child.id], ["edge"]));
  expect(context.onNodesChange.mock.calls[0]![0]).toBe(batch);
  expect(context.setCanvasSelection.mock.invocationCallOrder[0]).toBeLessThan(context.getActiveGraph.mock.invocationCallOrder[0]!);
  expect(context.getActiveGraph.mock.invocationCallOrder[0]).toBeLessThan(context.onNodesChange.mock.invocationCallOrder[0]!);
});

it("preserves mixed edge batch order and resolves ordered selection changes without dropping node ids", () => {
  const context = inputs();
  const { handlers } = mount(context);
  const batch: EdgeBatch = [
    { type: "select", id: "edge", selected: true }, { type: "remove", id: "removed" },
    { type: "select", id: "old", selected: false },
    { type: "select", id: "edge", selected: false }, { type: "select", id: "edge", selected: true }
  ];
  act(() => handlers.onEdgesChange(batch));
  expect(resolveUpdate(context.setCanvasSelection.mock.calls[0]![0], createCanvasSelection([child.id], ["old", "newer"])))
    .toEqual(createCanvasSelection([child.id], ["newer", "edge"]));
  expect(context.onEdgesChange.mock.calls[0]![0]).toBe(batch);
  expect(context.setCanvasSelection.mock.invocationCallOrder[0]).toBeLessThan(context.onEdgesChange.mock.invocationCallOrder[0]!);
  expect(context.getActiveGraph).not.toHaveBeenCalled();
});

it.each(["node", "edge"] as const)("retains selection identity for repeated %s selections and absent removals", (kind) => {
  const context = inputs();
  const { handlers } = mount(context);
  const batch = [{ type: "select" as const, id: "selected", selected: true }, { type: "select" as const, id: "absent", selected: false }];
  act(() => kind === "node" ? handlers.onNodesChange(batch) : handlers.onEdgesChange(batch));
  const selection = createCanvasSelection(["selected"], ["selected"]);
  expect(resolveUpdate(context.setCanvasSelection.mock.calls[0]![0], selection)).toBe(selection);
});

it("reads live alternate-pan refs and filters only selection, still delivering empty batches", () => {
  const context = inputs();
  const { handlers } = mount(context);
  context.alternatePanGestureRef.current = true;
  const remove = { type: "remove" as const, id: "edge" };
  act(() => {
    handlers.onNodesChange([{ type: "select", id: child.id, selected: false }, position]);
    handlers.onEdgesChange([{ type: "select", id: "edge", selected: false }, remove]);
    handlers.onEdgesChange([{ type: "select", id: "edge", selected: false }]);
  });
  expect(context.setCanvasSelection).not.toHaveBeenCalled();
  expect(context.onNodesChange).toHaveBeenCalledWith([position]);
  expect(context.onEdgesChange.mock.calls.map(([batch]) => batch)).toEqual([[remove], []]);
  context.alternatePanGestureRef.current = false;
  act(() => handlers.onNodesChange([{ type: "select", id: child.id, selected: true }]));
  expect(context.setCanvasSelection).toHaveBeenCalledOnce();
});

it("preserves node selection during group drag but does not suppress edge selection", () => {
  const context = inputs();
  const { handlers } = mount(context);
  context.groupDragActiveRef.current = true;
  const edgeBatch: EdgeBatch = [{ type: "select", id: "edge", selected: true }];
  act(() => {
    handlers.onNodesChange([{ type: "select", id: child.id, selected: false }, position]);
    handlers.onEdgesChange(edgeBatch);
  });
  expect(context.onNodesChange).toHaveBeenCalledWith([position]);
  expect(context.onEdgesChange.mock.calls[0]![0]).toBe(edgeBatch);
  expect(context.setCanvasSelection).toHaveBeenCalledOnce();
  context.groupDragActiveRef.current = false;
  act(() => handlers.onNodesChange([{ type: "select", id: child.id, selected: false }]));
  expect(context.setCanvasSelection).toHaveBeenCalledTimes(2);
});

it("filters descendant moves against committed placement selection and the event-time graph", () => {
  const context = inputs();
  const view = mount(context);
  const dimensions: NodeBatch[number] = { type: "dimensions", id: child.id, dimensions: { width: 200, height: 100 } };
  const ancestorMove: NodeBatch[number] = { ...position, id: parent.id };
  const batch: NodeBatch = [ancestorMove, position, dimensions];
  act(() => view.handlers.onNodesChange(batch));
  expect(context.onNodesChange).toHaveBeenLastCalledWith(batch);
  view.update({ ...context, canvasSelection: createCanvasSelection([parent.id, child.id]) });
  act(() => view.handlers.onNodesChange(batch));
  expect(context.onNodesChange).toHaveBeenLastCalledWith([ancestorMove, dimensions]);
  // Placement parentage can change without a view render; query it per batch.
  context.getActiveGraph.mockReturnValue({ nodes: [parent, { ...child, parentId: undefined }] });
  act(() => view.handlers.onNodesChange(batch));
  expect(context.onNodesChange).toHaveBeenLastCalledWith(batch);
  expect(context.getActiveGraph).toHaveBeenCalledTimes(3);
});

it("delivers empty and non-selection batches without requesting selection updates", () => {
  const context = inputs();
  const { handlers } = mount(context);
  const nodes: NodeBatch = [];
  const edges: EdgeBatch = [{ type: "remove", id: "edge" }];
  act(() => { handlers.onNodesChange(nodes); handlers.onEdgesChange(edges); });
  expect(context.onNodesChange.mock.calls[0]![0]).toBe(nodes);
  expect(context.onEdgesChange.mock.calls[0]![0]).toBe(edges);
  expect(context.setCanvasSelection).not.toHaveBeenCalled();
});

it("composes queued node and edge selection updaters without stale-state overwrites", () => {
  const context = inputs();
  const { handlers } = mount(context);
  act(() => {
    handlers.onNodesChange([{ type: "select", id: child.id, selected: true }]);
    handlers.onEdgesChange([{ type: "select", id: "edge", selected: true }]);
  });
  let selection = createCanvasSelection(["other"], ["prior"]);
  for (const [update] of context.setCanvasSelection.mock.calls) selection = resolveUpdate(update, selection);
  expect(selection).toEqual(createCanvasSelection(["other", child.id], ["prior", "edge"]));
});

it("ignores suspended inputs and adopts replacement refs, query and commands only after commit", () => {
  const original = inputs();
  const view = mount(original);
  const next = inputs();
  next.alternatePanGestureRef.current = true;
  view.update(next, true);
  const batch = [{ type: "select" as const, id: child.id, selected: true }];
  act(() => { view.handlers.onNodesChange(batch); view.handlers.onEdgesChange(batch); });
  expect(original.setCanvasSelection).toHaveBeenCalledTimes(2);
  expect(next.onNodesChange).not.toHaveBeenCalled();
  expect(next.onEdgesChange).not.toHaveBeenCalled();
  expect(next.getActiveGraph).not.toHaveBeenCalled();
  view.update(next);
  act(() => { view.handlers.onNodesChange(batch); view.handlers.onEdgesChange(batch); });
  expect(next.setCanvasSelection).not.toHaveBeenCalled();
  expect(next.onNodesChange).toHaveBeenCalledWith([]);
  expect(next.onEdgesChange).toHaveBeenCalledWith([]);
  expect(next.getActiveGraph).toHaveBeenCalledOnce();
  expect(view.committed.at(-1)).toBe(view.handlers);
});

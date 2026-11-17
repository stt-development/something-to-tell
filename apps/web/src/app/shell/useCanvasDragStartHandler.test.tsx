import type { Node } from "@xyflow/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Suspense, useLayoutEffect } from "react";
import { expect, it, vi } from "vitest";
import { createCanvasSelection, type NarrativeNodeData } from "../../types";
import { useCanvasDragStartHandler, type CanvasDragStartInputs } from "./useCanvasDragStartHandler";

const node: Node<NarrativeNodeData> = {
  id: "placement", position: { x: 0, y: 0 },
  data: { kind: "Character", label: "Character", title: "Actor", summary: "", tags: [], canonicalNodeId: "canonical" }
};

function inputs() {
  const refs: Pick<CanvasDragStartInputs, "dragStartNodesRef" | "groupDragActiveRef" | "groupDragSelectionRef" | "suppressPaneClickRef" | "compositionDropRef"> = {
    dragStartNodesRef: { current: null }, groupDragActiveRef: { current: false },
    groupDragSelectionRef: { current: null }, suppressPaneClickRef: { current: false },
    compositionDropRef: { current: { frameId: "old-frame", message: "Old feedback", valid: true } }
  };
  return {
    ...refs, canvasSelection: createCanvasSelection(), getActiveGraph: vi.fn(() => ({ nodes: [node] })),
    setCompositionDrop: vi.fn<CanvasDragStartInputs["setCompositionDrop"]>(),
    setCanvasSelection: vi.fn<CanvasDragStartInputs["setCanvasSelection"]>(),
    selectItem: vi.fn<CanvasDragStartInputs["selectItem"]>()
  } satisfies CanvasDragStartInputs;
}

/** Retain the committed React Flow prop and invoke it with a real React mouse event. */
function mount(initial: CanvasDragStartInputs) {
  const committed: ReturnType<typeof useCanvasDragStartHandler>[] = [];
  const pending = new Promise<void>(() => {});
  let draggedNode = node;
  function Consumer({ context, suspend }: { context: CanvasDragStartInputs; suspend: boolean }) {
    const handler = useCanvasDragStartHandler(context);
    useLayoutEffect(() => { committed.push(handler); });
    if (suspend) throw pending;
    return null;
  }
  const tree = (context: CanvasDragStartInputs, suspend = false) => <>
    <button onMouseDown={(event) => committed[0]!(event, draggedNode, [draggedNode])}>Start drag</button>
    <Suspense fallback={null}><Consumer context={context} suspend={suspend} /></Suspense>
  </>;
  const view = render(tree(initial));
  return {
    committed,
    update: (next: CanvasDragStartInputs, suspend = false) => view.rerender(tree(next, suspend)),
    start: (target = node) => { draggedNode = target; fireEvent.mouseDown(screen.getByRole("button", { name: "Start drag" })); }
  };
}

it.each([
  { name: "empty", ids: [], group: false, replace: true },
  { name: "single selected", ids: [node.id], group: false, replace: false },
  { name: "selected group", ids: ["other", node.id], group: true, replace: false },
  { name: "unselected group", ids: ["other", "another"], group: false, replace: true }
])("preserves $name drag-start selection and group policy", ({ ids, group, replace }) => {
  const context = inputs();
  const selection = createCanvasSelection(ids, ["selected-edge"]);
  const view = mount({ ...context, canvasSelection: selection });
  expect(context.getActiveGraph).not.toHaveBeenCalled();
  view.start();
  expect(context.groupDragActiveRef.current).toBe(group);
  expect(context.groupDragSelectionRef.current).toEqual(group ? selection : null);
  expect(context.suppressPaneClickRef.current).toBe(group);
  expect(context.compositionDropRef.current).toBeNull();
  expect(context.setCompositionDrop).toHaveBeenCalledWith(null);
  expect(context.setCanvasSelection.mock.calls).toEqual(replace ? [[{ nodeIds: [node.id], edgeIds: [] }]] : []);
  expect(context.selectItem).toHaveBeenCalledWith({ type: "node", id: node.id });
});

it("captures the event-time graph array exactly once and prepares refs before selection commands", () => {
  const context = inputs();
  const view = mount(context);
  const currentNodes = [{ ...node, position: { x: 80, y: 20 } }];
  context.getActiveGraph.mockReturnValue({ nodes: currentNodes });
  context.setCompositionDrop.mockImplementation(() => {
    expect(context.dragStartNodesRef.current).toBe(currentNodes);
    expect(context.groupDragActiveRef.current).toBe(false);
    expect(context.groupDragSelectionRef.current).toBeNull();
    expect(context.compositionDropRef.current).toBeNull();
  });
  view.start();
  expect(context.getActiveGraph).toHaveBeenCalledOnce();
  expect(context.getActiveGraph.mock.invocationCallOrder[0]).toBeLessThan(context.setCompositionDrop.mock.invocationCallOrder[0]!);
  expect(context.setCompositionDrop.mock.invocationCallOrder[0]).toBeLessThan(context.setCanvasSelection.mock.invocationCallOrder[0]!);
  expect(context.setCanvasSelection.mock.invocationCallOrder[0]).toBeLessThan(context.selectItem.mock.invocationCallOrder[0]!);
});

it("copies and de-duplicates the group snapshot without changing the original group predicate", () => {
  const context = inputs();
  const selection = { nodeIds: [node.id, node.id], edgeIds: ["edge", "edge"] };
  const view = mount({ ...context, canvasSelection: selection });
  view.start();
  expect(context.groupDragActiveRef.current).toBe(true);
  const snapshot = context.groupDragSelectionRef.current;
  expect(snapshot).toEqual({ nodeIds: [node.id], edgeIds: ["edge"] });
  expect(snapshot?.nodeIds).not.toBe(selection.nodeIds);
  expect(snapshot?.edgeIds).not.toBe(selection.edgeIds);
  selection.nodeIds.push("later");
  selection.edgeIds.push("later-edge");
  expect(snapshot).toEqual({ nodeIds: [node.id], edgeIds: ["edge"] });
});

it("uses exact placement membership rather than canonical membership for linked nodes", () => {
  const context = inputs();
  const view = mount({ ...context, canvasSelection: createCanvasSelection(["canonical", "other-placement"]) });
  view.start();
  expect(context.groupDragActiveRef.current).toBe(false);
  expect(context.setCanvasSelection).toHaveBeenCalledWith({ nodeIds: ["placement"], edgeIds: [] });
  expect(context.selectItem).toHaveBeenCalledWith({ type: "node", id: "placement" });
});

it("clears the previous group on a subsequent single drag without clearing existing pane suppression", () => {
  const context = inputs();
  const view = mount({ ...context, canvasSelection: createCanvasSelection([node.id, "other"]) });
  view.start();
  expect(context.groupDragSelectionRef.current).not.toBeNull();
  view.update(context);
  view.start({ ...node, id: "new-placement" });
  expect(context.groupDragActiveRef.current).toBe(false);
  expect(context.groupDragSelectionRef.current).toBeNull();
  expect(context.suppressPaneClickRef.current).toBe(true);
  expect(context.selectItem).toHaveBeenLastCalledWith({ type: "node", id: "new-placement" });
});

it("retains the handler while adopting replacement project refs, selection, query and commands", () => {
  const original = inputs();
  const view = mount(original);
  const next = inputs();
  view.update({ ...next, canvasSelection: createCanvasSelection([node.id, "other"]) });
  view.start();
  expect(view.committed[1]).toBe(view.committed[0]);
  expect(next.getActiveGraph).toHaveBeenCalledOnce();
  expect(next.groupDragActiveRef.current).toBe(true);
  expect(next.setCompositionDrop).toHaveBeenCalledWith(null);
  expect(next.selectItem).toHaveBeenCalledWith({ type: "node", id: node.id });
  view.update(next);
  view.start();
  expect(next.setCanvasSelection).toHaveBeenCalledWith({ nodeIds: [node.id], edgeIds: [] });
  expect(original.dragStartNodesRef.current).toBeNull();
  expect(original.compositionDropRef.current).not.toBeNull();
  for (const callback of [original.getActiveGraph, original.setCompositionDrop, original.setCanvasSelection, original.selectItem]) expect(callback).not.toHaveBeenCalled();
});

it("ignores uncommitted drag inputs and adopts them after a suspended render commits", () => {
  const original = inputs();
  const view = mount(original);
  const next = inputs();
  const pending = { ...next, canvasSelection: createCanvasSelection([node.id, "other"]) };
  view.update(pending, true);
  view.start();
  expect(original.setCanvasSelection).toHaveBeenCalledWith({ nodeIds: [node.id], edgeIds: [] });
  expect(next.getActiveGraph).not.toHaveBeenCalled();
  expect(next.dragStartNodesRef.current).toBeNull();
  expect(next.selectItem).not.toHaveBeenCalled();
  view.update(pending);
  view.start();
  expect(next.groupDragActiveRef.current).toBe(true);
  expect(next.setCanvasSelection).not.toHaveBeenCalled();
  expect(next.selectItem).toHaveBeenCalledWith({ type: "node", id: node.id });
  expect(view.committed.at(-1)).toBe(view.committed[0]);
});

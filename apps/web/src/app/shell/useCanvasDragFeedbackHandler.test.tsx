import type { Node } from "@xyflow/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Suspense, useLayoutEffect } from "react";
import { expect, it, vi } from "vitest";
import type { NarrativeNodeData } from "../../types";
import { useCanvasDragFeedbackHandler, type CanvasDragFeedbackInputs } from "./useCanvasDragFeedbackHandler";

const node: Node<NarrativeNodeData> = {
  id: "placement", position: { x: 40, y: 80 }, width: 260, height: 156,
  data: { kind: "Character", label: "Character", title: "Actor", summary: "", tags: [], canonicalNodeId: "canonical" }
};
const large: Node<NarrativeNodeData> = {
  ...node, id: "scene", width: 600, height: 400,
  data: { ...node.data, kind: "Scene", title: "Scene", isFrame: true, canonicalNodeId: "scene-canonical" }
};
const small: Node<NarrativeNodeData> = {
  ...large, id: "location", width: 320, height: 220,
  data: { ...large.data, kind: "Location", title: "Location", canonicalNodeId: "location-canonical" }
};

function inputs() {
  const refs: Pick<CanvasDragFeedbackInputs, "groupDragActiveRef" | "compositionDropRef"> = {
    groupDragActiveRef: { current: false },
    compositionDropRef: { current: { frameId: "old", message: "Old feedback", valid: true } }
  };
  return {
    ...refs, getActiveGraph: vi.fn(() => ({ nodes: [node, large, small] })),
    getIntersectingNodes: vi.fn<CanvasDragFeedbackInputs["getIntersectingNodes"]>().mockReturnValue([large, small]),
    setCompositionDrop: vi.fn<CanvasDragFeedbackInputs["setCompositionDrop"]>()
  } satisfies CanvasDragFeedbackInputs;
}

/** Invoke the retained committed prop with a React mouse event and current dragged placement. */
function mount(initial: CanvasDragFeedbackInputs) {
  const committed: ReturnType<typeof useCanvasDragFeedbackHandler>[] = [];
  const pending = new Promise<void>(() => {});
  let dragged = node;
  function Consumer({ context, suspend }: { context: CanvasDragFeedbackInputs; suspend: boolean }) {
    const handler = useCanvasDragFeedbackHandler(context);
    useLayoutEffect(() => { committed.push(handler); });
    if (suspend) throw pending;
    return null;
  }
  const tree = (context: CanvasDragFeedbackInputs, suspend = false) => <>
    <button onMouseMove={(event) => committed[0]!(event, dragged, [dragged])}>Drag</button>
    <Suspense fallback={null}><Consumer context={context} suspend={suspend} /></Suspense>
  </>;
  const view = render(tree(initial));
  return {
    committed, update: (next: CanvasDragFeedbackInputs, suspend = false) => view.rerender(tree(next, suspend)),
    drag: (current = node) => { dragged = current; fireEvent.mouseMove(screen.getByRole("button", { name: "Drag" })); }
  };
}

it("chooses the smallest frame without sorting input candidates or applying projected layout", () => {
  const context = inputs();
  const nodes = context.getActiveGraph().nodes;
  context.getActiveGraph.mockClear();
  const before = structuredClone(nodes);
  const candidates = [large, small];
  Object.freeze(candidates);
  context.getIntersectingNodes.mockReturnValue(candidates);
  context.setCompositionDrop.mockImplementation((feedback) => expect(context.compositionDropRef.current).toBe(feedback));
  const view = mount(context);
  expect(context.getActiveGraph).not.toHaveBeenCalled();
  view.drag();
  expect(context.getActiveGraph).toHaveBeenCalledOnce();
  expect(context.getIntersectingNodes).toHaveBeenCalledWith(node, true);
  expect(context.getActiveGraph.mock.invocationCallOrder[0]).toBeLessThan(context.getIntersectingNodes.mock.invocationCallOrder[0]!);
  expect(context.setCompositionDrop).toHaveBeenCalledWith({ frameId: small.id, message: "Placed in Location", valid: true });
  expect(candidates).toEqual([large, small]);
  expect(nodes).toEqual(before);
});

it("excludes self, non-frames and indirect descendant frames using placement ancestry", () => {
  const context = inputs();
  const dragged = { ...small, id: "dragged", data: { ...small.data, canonicalNodeId: "dragged-canonical" } };
  const child = { ...small, id: "child", parentId: dragged.id };
  const grandchild = { ...small, id: "grandchild", parentId: child.id };
  context.getActiveGraph.mockReturnValue({ nodes: [dragged, child, grandchild, node, large] });
  context.getIntersectingNodes.mockReturnValue([dragged, node, child, grandchild, large]);
  mount(context).drag(dragged);
  expect(context.setCompositionDrop).toHaveBeenCalledWith({ frameId: large.id, message: "Placed in Scene", valid: true });
});

it("clears old feedback before publishing when no intersecting frame remains", () => {
  const context = inputs();
  context.getIntersectingNodes.mockReturnValue([]);
  context.setCompositionDrop.mockImplementation(() => expect(context.compositionDropRef.current).toBeNull());
  mount(context).drag();
  expect(context.setCompositionDrop).toHaveBeenCalledWith(null);
});

it("does no feedback or graph work during live group drag, then resumes after the flag clears", () => {
  const context = inputs();
  const view = mount(context);
  const previous = context.compositionDropRef.current;
  context.groupDragActiveRef.current = true;
  view.drag();
  expect(context.getActiveGraph).not.toHaveBeenCalled();
  expect(context.getIntersectingNodes).not.toHaveBeenCalled();
  expect(context.setCompositionDrop).not.toHaveBeenCalled();
  expect(context.compositionDropRef.current).toBe(previous);
  context.groupDragActiveRef.current = false;
  view.drag();
  expect(context.setCompositionDrop).toHaveBeenCalledOnce();
});

it("reports invalid smallest-frame feedback instead of skipping to a larger valid frame", () => {
  const context = inputs();
  const dialogue = { ...node, data: { ...node.data, kind: "Dialogue" as const } };
  context.getActiveGraph.mockReturnValue({ nodes: [dialogue, large, small] });
  mount(context).drag(dialogue);
  expect(context.setCompositionDrop).toHaveBeenCalledWith({ frameId: small.id, message: "Location cannot contain Dialogue", valid: false });
});

it.each([undefined, 0])("preserves missing/zero dimension ordering (%s) and stable equal-area candidate order", (width) => {
  const context = inputs();
  const first = { ...small, id: "first", width };
  const second = { ...small, id: "second", width };
  context.getActiveGraph.mockReturnValue({ nodes: [node, large, first, second] });
  context.getIntersectingNodes.mockReturnValue([large, first, second]);
  mount(context).drag();
  expect(context.setCompositionDrop).toHaveBeenCalledWith(expect.objectContaining({ frameId: first.id, valid: true }));
});

it("reads current graph parentage and validation data for every event without a rerender", () => {
  const context = inputs();
  const dragged = { ...small, id: "dragged", data: { ...small.data, canonicalNodeId: "dragged-canonical" } };
  context.getIntersectingNodes.mockReturnValue([small, large]);
  context.getActiveGraph.mockReturnValue({ nodes: [dragged, small, large] });
  const view = mount(context);
  view.drag(dragged);
  expect(context.setCompositionDrop).toHaveBeenLastCalledWith(expect.objectContaining({ frameId: small.id, valid: true }));
  context.getActiveGraph.mockReturnValue({ nodes: [dragged, { ...small, parentId: dragged.id }, large] });
  view.drag(dragged);
  expect(context.setCompositionDrop).toHaveBeenLastCalledWith(expect.objectContaining({ frameId: large.id, valid: true }));
  expect(context.getActiveGraph).toHaveBeenCalledTimes(2);
});

it("retains callback identity while adopting replacement project queries, refs and feedback command", () => {
  const original = inputs();
  original.groupDragActiveRef.current = true;
  const view = mount(original);
  const next = inputs();
  next.getIntersectingNodes.mockReturnValue([large]);
  view.update(next);
  view.drag();
  expect(view.committed[1]).toBe(view.committed[0]);
  expect(next.getActiveGraph).toHaveBeenCalledOnce();
  expect(next.getIntersectingNodes).toHaveBeenCalledWith(node, true);
  expect(next.setCompositionDrop).toHaveBeenCalledWith(expect.objectContaining({ frameId: large.id }));
  expect(original.compositionDropRef.current?.frameId).toBe("old");
  expect(original.getActiveGraph).not.toHaveBeenCalled();
  expect(original.getIntersectingNodes).not.toHaveBeenCalled();
  expect(original.setCompositionDrop).not.toHaveBeenCalled();
});

it("ignores speculative feedback inputs and adopts them only after commit", () => {
  const original = inputs();
  const view = mount(original);
  const next = inputs();
  next.getIntersectingNodes.mockReturnValue([]);
  view.update(next, true);
  view.drag();
  expect(original.setCompositionDrop).toHaveBeenCalledWith(expect.objectContaining({ frameId: small.id }));
  expect(next.getActiveGraph).not.toHaveBeenCalled();
  expect(next.compositionDropRef.current?.frameId).toBe("old");
  view.update(next);
  view.drag();
  expect(next.setCompositionDrop).toHaveBeenCalledWith(null);
  expect(next.compositionDropRef.current).toBeNull();
  expect(view.committed.at(-1)).toBe(view.committed[0]);
});

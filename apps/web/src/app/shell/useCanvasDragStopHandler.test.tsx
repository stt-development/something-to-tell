import type { Node } from "@xyflow/react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Suspense, useLayoutEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyProjectLocale } from "../../localization/i18n";
import { createCanvasSelection, type NarrativeNodeData } from "../../types";
import { useCanvasDragStopHandler, type CanvasDragStopInputs } from "./useCanvasDragStopHandler";

const node: Node<NarrativeNodeData> = {
  id: "placement", position: { x: 0, y: 0 },
  data: { kind: "Character", label: "Character", title: "Actor", summary: "", tags: [], canonicalNodeId: "canonical" }
};
beforeEach(async () => { await applyProjectLocale("en"); vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function inputs() {
  const refs: Pick<CanvasDragStopInputs, "dragStartNodesRef" | "groupDragActiveRef" | "groupDragSelectionRef" | "suppressPaneClickRef" | "compositionDropRef"> = {
    dragStartNodesRef: { current: [node] }, groupDragActiveRef: { current: true },
    groupDragSelectionRef: { current: null }, suppressPaneClickRef: { current: true },
    compositionDropRef: { current: { frameId: "frame-placement", message: "Preview", valid: true } }
  };
  return {
    ...refs, getActiveGraph: vi.fn(() => ({ nodes: [node] })),
    completeNodeDrop: vi.fn<CanvasDragStopInputs["completeNodeDrop"]>().mockReturnValue({ message: "Moved", valid: true }),
    completeGroupMove: vi.fn<CanvasDragStopInputs["completeGroupMove"]>(),
    setCompositionDrop: vi.fn<CanvasDragStopInputs["setCompositionDrop"]>(),
    setCompositionNotice: vi.fn<CanvasDragStopInputs["setCompositionNotice"]>(),
    setCanvasSelection: vi.fn<CanvasDragStopInputs["setCanvasSelection"]>()
  } satisfies CanvasDragStopInputs;
}

/** Retain the committed prop and invoke it with a React mouse event, not a replacement drag engine. */
function mount(initial: CanvasDragStopInputs) {
  const committed: ReturnType<typeof useCanvasDragStopHandler>[] = [];
  const pending = new Promise<void>(() => {});
  function Consumer({ context, suspend }: { context: CanvasDragStopInputs; suspend: boolean }) {
    const handler = useCanvasDragStopHandler(context);
    useLayoutEffect(() => { committed.push(handler); });
    if (suspend) throw pending;
    return null;
  }
  const tree = (context: CanvasDragStopInputs, suspend = false) => <>
    <button onMouseUp={(event) => committed[0]!(event, node, [node])}>Stop drag</button>
    <Suspense fallback={null}><Consumer context={context} suspend={suspend} /></Suspense>
  </>;
  const view = render(tree(initial));
  return {
    ...view, committed,
    update: (next: CanvasDragStopInputs, suspend = false) => view.rerender(tree(next, suspend)),
    stop: () => fireEvent.mouseUp(screen.getByRole("button", { name: "Stop drag" }))
  };
}
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

it.each([true, false])("completes a single drop with exact placement, snapshot and result notice (valid=%s)", (valid) => {
  const context = inputs();
  const snapshot = context.dragStartNodesRef.current;
  context.completeNodeDrop.mockReturnValue({ message: "Result", valid });
  mount(context).stop();
  expect(context.completeNodeDrop).toHaveBeenCalledWith(node.id, "frame-placement", snapshot);
  expect(context.completeNodeDrop.mock.calls[0]![2]).toBe(snapshot);
  expect(context.getActiveGraph).not.toHaveBeenCalled();
  expect(context.completeGroupMove).not.toHaveBeenCalled();
  expect(context.dragStartNodesRef.current).toBeNull();
  expect(context.compositionDropRef.current).toBeNull();
  expect(context.setCompositionNotice).toHaveBeenCalledWith("Result");
  advance(100);
  expect(context.setCanvasSelection).not.toHaveBeenCalled();
  expect(context.groupDragActiveRef.current).toBe(false);
  expect(context.suppressPaneClickRef.current).toBe(false);
});

it.each([0, 2])("uses the non-null group snapshot, including %s members, and restores it only after 100ms", (count) => {
  const context = inputs();
  const selection = createCanvasSelection(Array.from({ length: count }, (_, index) => `placement-${index}`), ["edge"]);
  context.groupDragSelectionRef.current = selection;
  context.groupDragActiveRef.current = false;
  const snapshot = context.dragStartNodesRef.current;
  mount(context).stop();
  expect(context.completeGroupMove).toHaveBeenCalledWith(snapshot);
  expect(context.completeGroupMove.mock.calls[0]![0]).toBe(snapshot);
  expect(context.completeNodeDrop).not.toHaveBeenCalled();
  expect(context.setCompositionNotice).toHaveBeenCalledWith(`Moved ${count} selected nodes`);
  advance(99);
  expect(context.groupDragSelectionRef.current).toBe(selection);
  expect(context.suppressPaneClickRef.current).toBe(true);
  expect(context.setCanvasSelection).not.toHaveBeenCalled();
  advance(1);
  expect(context.groupDragSelectionRef.current).toBeNull();
  expect(context.setCanvasSelection.mock.calls[0]![0]).toBe(selection);
  expect(context.suppressPaneClickRef.current).toBe(false);
  advance(1699);
  expect(context.setCompositionNotice).toHaveBeenCalledTimes(1);
  advance(1);
  expect(context.setCompositionNotice).toHaveBeenLastCalledWith(null);
});

it("uses an empty start snapshot without querying, and passes a root target when feedback is absent", () => {
  const context = inputs();
  const empty: Node<NarrativeNodeData>[] = [];
  context.dragStartNodesRef.current = empty;
  context.compositionDropRef.current = null;
  mount(context).stop();
  expect(context.getActiveGraph).not.toHaveBeenCalled();
  expect(context.completeNodeDrop.mock.calls[0]).toEqual([node.id, null, empty]);
  expect(context.completeNodeDrop.mock.calls[0]![2]).toBe(empty);
});

it("queries the event-time graph once only when no start snapshot exists", () => {
  const context = inputs();
  context.dragStartNodesRef.current = null;
  const view = mount(context);
  const currentNodes = [{ ...node, position: { x: 80, y: 20 } }];
  context.getActiveGraph.mockReturnValue({ nodes: currentNodes });
  view.stop();
  expect(context.getActiveGraph).toHaveBeenCalledOnce();
  expect(context.completeNodeDrop.mock.calls[0]![2]).toBe(currentNodes);
});

it("dispatches completion before ref/feedback cleanup and publishes the notice afterward", () => {
  const context = inputs();
  context.completeNodeDrop.mockImplementation(() => {
    expect(context.dragStartNodesRef.current).not.toBeNull();
    expect(context.compositionDropRef.current?.frameId).toBe("frame-placement");
    return { message: "Finished", valid: true };
  });
  context.setCompositionDrop.mockImplementation(() => {
    expect(context.dragStartNodesRef.current).toBeNull();
    expect(context.compositionDropRef.current).toBeNull();
  });
  mount(context).stop();
  expect(context.completeNodeDrop.mock.invocationCallOrder[0]).toBeLessThan(context.setCompositionDrop.mock.invocationCallOrder[0]!);
  expect(context.setCompositionDrop.mock.invocationCallOrder[0]).toBeLessThan(context.setCompositionNotice.mock.invocationCallOrder[0]!);
  expect(vi.getTimerCount()).toBe(2);
});

it("retains callback identity and reads replacement commands, refs and graph inputs at stop time", () => {
  const original = inputs();
  const view = mount(original);
  const next = inputs();
  next.dragStartNodesRef.current = null;
  view.update(next);
  view.stop();
  expect(view.committed[1]).toBe(view.committed[0]);
  expect(next.getActiveGraph).toHaveBeenCalledOnce();
  expect(next.completeNodeDrop).toHaveBeenCalledOnce();
  expect(next.setCompositionDrop).toHaveBeenCalledWith(null);
  expect(next.setCompositionNotice).toHaveBeenCalledWith("Moved");
  advance(1800);
  expect(next.groupDragActiveRef.current).toBe(false);
  expect(original.dragStartNodesRef.current).not.toBeNull();
  for (const command of [original.getActiveGraph, original.completeNodeDrop, original.setCompositionDrop, original.setCompositionNotice, original.setCanvasSelection]) expect(command).not.toHaveBeenCalled();
});

it("keeps pending resets and restoration bound to event-time refs, commands and the exact moved selection", () => {
  const original = inputs();
  const moved = createCanvasSelection([node.id, "other"]);
  original.groupDragSelectionRef.current = moved;
  original.setCanvasSelection.mockImplementation(() => {
    expect(original.groupDragActiveRef.current).toBe(false);
    expect(original.groupDragSelectionRef.current).toBeNull();
    expect(original.suppressPaneClickRef.current).toBe(false);
  });
  const view = mount(original);
  view.stop();
  const next = inputs();
  view.update(next);
  advance(100);
  expect(original.setCanvasSelection.mock.calls[0]![0]).toBe(moved);
  expect(original.groupDragSelectionRef.current).toBeNull();
  expect(next.groupDragActiveRef.current).toBe(true);
  expect(next.suppressPaneClickRef.current).toBe(true);
  expect(next.setCanvasSelection).not.toHaveBeenCalled();
  advance(1700);
  expect(original.setCompositionNotice).toHaveBeenLastCalledWith(null);
  expect(next.setCompositionNotice).not.toHaveBeenCalled();
});

it("preserves detached event-time callbacks after unmount without redirecting to a new workspace", () => {
  const original = inputs();
  original.groupDragSelectionRef.current = createCanvasSelection([node.id, "other"]);
  const first = mount(original);
  first.stop();
  first.unmount();
  const next = inputs();
  mount(next);
  advance(1800);
  expect(original.setCanvasSelection).toHaveBeenCalledOnce();
  expect(original.setCompositionNotice).toHaveBeenLastCalledWith(null);
  expect(next.groupDragActiveRef.current).toBe(true);
  expect(next.setCanvasSelection).not.toHaveBeenCalled();
  expect(next.setCompositionNotice).not.toHaveBeenCalled();
});

it("characterizes overlapping stops without introducing cancellation or coalescing", () => {
  const context = inputs();
  const first = createCanvasSelection(["first"]);
  const second = createCanvasSelection(["second"]);
  const view = mount(context);
  context.groupDragSelectionRef.current = first;
  view.stop();
  advance(50);
  context.groupDragSelectionRef.current = second;
  context.dragStartNodesRef.current = [node];
  view.stop();
  expect(vi.getTimerCount()).toBe(4);
  advance(50);
  expect(context.setCanvasSelection.mock.calls[0]![0]).toBe(first);
  advance(50);
  expect(context.setCanvasSelection.mock.calls[1]![0]).toBe(second);
  advance(1700);
  expect(context.setCompositionNotice.mock.calls).toEqual([["Moved 1 selected nodes"], ["Moved 1 selected nodes"], [null], [null]]);
});

it("ignores suspended stop inputs, then adopts the replacement group command only after commit", () => {
  const original = inputs();
  const view = mount(original);
  const next = inputs();
  const moved = createCanvasSelection([node.id, "other"]);
  next.groupDragSelectionRef.current = moved;
  view.update(next, true);
  view.stop();
  expect(original.completeNodeDrop).toHaveBeenCalledOnce();
  expect(next.completeGroupMove).not.toHaveBeenCalled();
  view.update(next);
  view.stop();
  expect(next.completeGroupMove).toHaveBeenCalledOnce();
  expect(next.completeNodeDrop).not.toHaveBeenCalled();
  advance(1800);
  expect(next.setCanvasSelection.mock.calls[0]![0]).toBe(moved);
  expect(view.committed.at(-1)).toBe(view.committed[0]);
});

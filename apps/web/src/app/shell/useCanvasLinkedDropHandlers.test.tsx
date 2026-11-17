import type { Node } from "@xyflow/react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Suspense, useLayoutEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NarrativeNodeData } from "../../types";
import { useCanvasLinkedDropHandlers, type CanvasLinkedDropInputs } from "./useCanvasLinkedDropHandlers";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

const frame: Node<NarrativeNodeData> = {
  id: "scene-placement", position: { x: 0, y: 0 }, width: 600, height: 400,
  data: { kind: "Scene", label: "Scene", title: "Scene", summary: "", tags: [], isFrame: true }
};
const inner: Node<NarrativeNodeData> = {
  ...frame, id: "location-placement", parentId: frame.id, position: { x: 20, y: 20 }, width: 320, height: 220,
  data: { ...frame.data, kind: "Location", title: "Location" }
};

function inputs() {
  return {
    nodes: [frame, inner],
    screenToFlowPosition: vi.fn<CanvasLinkedDropInputs["screenToFlowPosition"]>().mockReturnValue({ x: 50, y: 40 }),
    addLinkedInstance: vi.fn<CanvasLinkedDropInputs["addLinkedInstance"]>().mockReturnValue({ message: "Linked", valid: true }),
    setCompositionNotice: vi.fn<CanvasLinkedDropInputs["setCompositionNotice"]>()
  } satisfies CanvasLinkedDropInputs;
}

/** React drag events retain the native payload; no global DataTransfer/DragEvent polyfill is needed. */
function mount(initial: CanvasLinkedDropInputs) {
  const committed: ReturnType<typeof useCanvasLinkedDropHandlers>[] = [];
  const pending = new Promise<void>(() => {});
  function Consumer({ context, suspend }: { context: CanvasLinkedDropInputs; suspend: boolean }) {
    const handlers = useCanvasLinkedDropHandlers(context);
    useLayoutEffect(() => { committed.push(handlers); });
    if (suspend) throw pending;
    return null;
  }
  const tree = (context: CanvasLinkedDropInputs, suspend = false) => <>
    <div data-testid="drop-surface" onDragOver={(event) => committed[0]!.onDragOver(event)} onDrop={(event) => committed[0]!.onDrop(event)} />
    <Suspense fallback={null}><Consumer context={context} suspend={suspend} /></Suspense>
  </>;
  const view = render(tree(initial));
  return {
    ...view, committed, update: (next: CanvasLinkedDropInputs, suspend = false) => view.rerender(tree(next, suspend)),
    dispatch: (type = "drop", payload = "canonical-content-id") => {
      const dataTransfer = { dropEffect: "none", getData: vi.fn((mime: string) => mime === "application/x-stt-canonical-node" ? payload : "") };
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 100, clientY: 80 });
      Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
      fireEvent(screen.getByTestId("drop-surface"), event);
      return { event, dataTransfer };
    }
  };
}
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

it("accepts drag-over as copy without conversion or mutation", () => {
  const context = inputs();
  const { event, dataTransfer } = mount(context).dispatch("dragover");
  expect(event.defaultPrevented).toBe(true);
  expect(dataTransfer.dropEffect).toBe("copy");
  expect(context.screenToFlowPosition).not.toHaveBeenCalled();
  expect(context.addLinkedInstance).not.toHaveBeenCalled();
  expect(context.setCompositionNotice).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([true, false])("uses converted coordinates, exact canonical payload and smallest nested frame (valid=%s)", (valid) => {
  const context = inputs();
  context.addLinkedInstance.mockReturnValue({ message: "Command result", valid });
  const { event, dataTransfer } = mount(context).dispatch();
  expect(event.defaultPrevented).toBe(true);
  expect(context.screenToFlowPosition).toHaveBeenCalledWith({ x: 100, y: 80 });
  expect(dataTransfer.getData).toHaveBeenCalledWith("application/x-stt-canonical-node");
  expect(context.addLinkedInstance).toHaveBeenCalledWith("canonical-content-id", inner.id);
  expect(context.screenToFlowPosition.mock.invocationCallOrder[0]).toBeLessThan(context.addLinkedInstance.mock.invocationCallOrder[0]!);
  expect(context.addLinkedInstance.mock.invocationCallOrder[0]).toBeLessThan(context.setCompositionNotice.mock.invocationCallOrder[0]!);
  expect(context.setCompositionNotice.mock.calls).toEqual([["Command result"]]);
  advance(1799);
  expect(context.setCompositionNotice).toHaveBeenCalledOnce();
  advance(1);
  expect(context.setCompositionNotice.mock.calls).toEqual([["Command result"], [null]]);
});

it.each(["missing payload", "outside frames", "no frames"])("preserves no-result drop behavior for %s", (reason) => {
  const context = inputs();
  if (reason === "outside frames") context.screenToFlowPosition.mockReturnValue({ x: 900, y: 900 });
  if (reason === "no frames") context.nodes = [];
  const { event } = mount(context).dispatch("drop", reason === "missing payload" ? "" : "canonical-content-id");
  expect(event.defaultPrevented).toBe(true);
  expect(context.screenToFlowPosition).toHaveBeenCalledOnce();
  expect(context.addLinkedInstance).not.toHaveBeenCalled();
  expect(context.setCompositionNotice).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("retains both adapters and adopts replacement project nodes, converter and commands including zero coordinates", () => {
  const original = inputs();
  const view = mount(original);
  const next = inputs();
  next.nodes = [{ ...frame, id: "new-frame" }];
  next.screenToFlowPosition.mockReturnValue({ x: 0, y: 0 });
  view.update(next);
  view.dispatch();
  expect(view.committed[1]).toBe(view.committed[0]);
  expect(next.addLinkedInstance).toHaveBeenCalledWith("canonical-content-id", "new-frame");
  expect(next.setCompositionNotice).toHaveBeenCalledWith("Linked");
  for (const command of [original.screenToFlowPosition, original.addLinkedInstance, original.setCompositionNotice]) expect(command).not.toHaveBeenCalled();
});

it("binds pending notice clearing to the drop's event-time command rather than later inputs", () => {
  const original = inputs();
  const view = mount(original);
  view.dispatch();
  const next = inputs();
  view.update(next);
  advance(1800);
  expect(original.setCompositionNotice.mock.calls).toEqual([["Linked"], [null]]);
  expect(next.setCompositionNotice).not.toHaveBeenCalled();
});

it("preserves detached pending notice callbacks after unmount without redirecting to a new workspace", () => {
  const original = inputs();
  const first = mount(original);
  first.dispatch();
  first.unmount();
  const next = inputs();
  mount(next);
  advance(1800);
  expect(original.setCompositionNotice).toHaveBeenLastCalledWith(null);
  expect(next.setCompositionNotice).not.toHaveBeenCalled();
});

it("retains original overlapping notice timers without cancellation or coalescing", () => {
  const context = inputs();
  context.addLinkedInstance.mockReturnValueOnce({ message: "First", valid: true }).mockReturnValueOnce({ message: "Second", valid: false });
  const view = mount(context);
  view.dispatch();
  advance(50);
  view.dispatch();
  expect(vi.getTimerCount()).toBe(2);
  advance(1800);
  expect(context.setCompositionNotice.mock.calls).toEqual([["First"], ["Second"], [null], [null]]);
});

it("ignores speculative nodes/commands and adopts them only after commit", () => {
  const original = inputs();
  const view = mount(original);
  const next = inputs();
  next.nodes = [];
  view.update(next, true);
  view.dispatch();
  expect(original.addLinkedInstance).toHaveBeenCalledOnce();
  expect(next.screenToFlowPosition).not.toHaveBeenCalled();
  view.update(next);
  view.dispatch();
  expect(next.screenToFlowPosition).toHaveBeenCalledOnce();
  expect(next.addLinkedInstance).not.toHaveBeenCalled();
  expect(view.committed.at(-1)).toBe(view.committed[0]);
});

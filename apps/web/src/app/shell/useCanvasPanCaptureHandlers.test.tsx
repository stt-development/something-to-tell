import { act, fireEvent, render, screen } from "@testing-library/react";
import { Suspense, useLayoutEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCanvasPanCaptureHandlers, type CanvasPanCaptureInputs } from "./useCanvasPanCaptureHandlers";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function inputs(): CanvasPanCaptureInputs {
  return {
    spacePanActiveRef: { current: false }, alternatePanGestureRef: { current: false },
    suppressPaneClickRef: { current: false }
  };
}

/** Keep the first committed event props; pointer events need only MouseEvent's button in JSDOM. */
function mount(initial: CanvasPanCaptureInputs) {
  const committed: ReturnType<typeof useCanvasPanCaptureHandlers>[] = [];
  const pending = new Promise<void>(() => {});
  function Consumer({ context, suspend }: { context: CanvasPanCaptureInputs; suspend: boolean }) {
    const handlers = useCanvasPanCaptureHandlers(context);
    useLayoutEffect(() => { committed.push(handlers); });
    if (suspend) throw pending;
    return null;
  }
  const tree = (context: CanvasPanCaptureInputs, suspend = false) => <>
    <div data-testid="pan-surface"
      onPointerDownCapture={(event) => committed[0]!.onPointerDownCapture(event)}
      onPointerUpCapture={(event) => committed[0]!.onPointerUpCapture(event)} />
    <Suspense fallback={null}><Consumer context={context} suspend={suspend} /></Suspense>
  </>;
  const view = render(tree(initial));
  return {
    ...view, committed, handlers: committed[0]!,
    update: (next: CanvasPanCaptureInputs, suspend = false) => view.rerender(tree(next, suspend)),
    down: (button = 0) => fireEvent(screen.getByTestId("pan-surface"), new MouseEvent("pointerdown", { bubbles: true, button })),
    up: () => fireEvent(screen.getByTestId("pan-surface"), new MouseEvent("pointerup", { bubbles: true }))
  };
}

it.each([
  [false, 0, false], [false, 1, true], [false, 2, false],
  [true, 0, true], [true, 1, true], [true, 2, true]
] as const)("preserves pointer-down Space=%s button=%s guards", (space, button, expected) => {
  const context = inputs();
  context.spacePanActiveRef.current = space;
  const view = mount(context);
  view.down(button);
  expect(context.alternatePanGestureRef.current).toBe(expected);
  expect(context.suppressPaneClickRef.current).toBe(expected);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  { space: false, event: null, expected: false },
  { space: true, event: null, expected: true },
  { space: false, event: new MouseEvent("mousedown", { button: 0 }), expected: false },
  { space: false, event: new MouseEvent("mousedown", { button: 1 }), expected: true },
  { space: false, event: new TouchEvent("touchstart"), expected: false },
  { space: true, event: new TouchEvent("touchstart"), expected: true }
])("preserves move-start guard $expected with Space=$space and native/null input", ({ space, event, expected }) => {
  const context = inputs();
  context.spacePanActiveRef.current = space;
  const { handlers } = mount(context);
  act(() => handlers.onMoveStart(event, { x: 0, y: 0, zoom: 1 }));
  expect(context.suppressPaneClickRef.current).toBe(expected);
  expect(context.alternatePanGestureRef.current).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("reads live Space state and does not clear existing guards on ordinary pointer-down", () => {
  const context = inputs();
  const view = mount(context);
  context.spacePanActiveRef.current = true;
  view.down();
  expect(context.alternatePanGestureRef.current).toBe(true);
  context.spacePanActiveRef.current = false;
  view.down();
  expect(context.alternatePanGestureRef.current).toBe(true);
  expect(context.suppressPaneClickRef.current).toBe(true);
});

it("defers pointer-up reset until the next task and leaves pane suppression for its existing consumer", () => {
  const context = inputs();
  const view = mount(context);
  view.down(1);
  view.up();
  expect(context.alternatePanGestureRef.current).toBe(true);
  expect(context.suppressPaneClickRef.current).toBe(true);
  expect(vi.getTimerCount()).toBe(1);
  act(() => vi.runAllTimers());
  expect(context.alternatePanGestureRef.current).toBe(false);
  expect(context.suppressPaneClickRef.current).toBe(true);
});

it("retains adapters, adopts replacement refs, and binds an already pending reset to its event-time ref", () => {
  const original = inputs();
  const view = mount(original);
  view.down(1);
  view.up();
  const next = inputs();
  view.update(next);
  view.down(1);
  expect(view.committed[1]).toBe(view.handlers);
  expect(next.alternatePanGestureRef.current).toBe(true);
  expect(next.suppressPaneClickRef.current).toBe(true);
  act(() => vi.runAllTimers());
  expect(original.alternatePanGestureRef.current).toBe(false);
  expect(next.alternatePanGestureRef.current).toBe(true);
  view.up();
  act(() => vi.runAllTimers());
  expect(next.alternatePanGestureRef.current).toBe(false);
  next.suppressPaneClickRef.current = false;
  act(() => view.handlers.onMoveStart(new MouseEvent("mousedown", { button: 1 }), { x: 0, y: 0, zoom: 1 }));
  expect(next.suppressPaneClickRef.current).toBe(true);
});

it("preserves one reset per pointer-up even for ordinary pointer releases", () => {
  const context = inputs();
  const view = mount(context);
  view.up();
  view.up();
  expect(vi.getTimerCount()).toBe(2);
  act(() => vi.runAllTimers());
  expect(context.alternatePanGestureRef.current).toBe(false);
  expect(context.suppressPaneClickRef.current).toBe(false);
});

it("lets the existing pending reset finish on its detached ref after unmount without touching a new workspace", () => {
  const original = inputs();
  const first = mount(original);
  first.down(1);
  first.up();
  first.unmount();
  const next = inputs();
  const second = mount(next);
  second.down(1);
  act(() => vi.runAllTimers());
  expect(original.alternatePanGestureRef.current).toBe(false);
  expect(next.alternatePanGestureRef.current).toBe(true);
  expect(next.suppressPaneClickRef.current).toBe(true);
});

it("ignores speculative refs during suspension, then uses them only after commit", () => {
  const original = inputs();
  const view = mount(original);
  const next = inputs();
  view.update(next, true);
  view.down(1);
  view.up();
  expect(original.alternatePanGestureRef.current).toBe(true);
  expect(next.alternatePanGestureRef.current).toBe(false);
  view.update(next);
  view.down(1);
  act(() => vi.runAllTimers());
  expect(original.alternatePanGestureRef.current).toBe(false);
  expect(next.alternatePanGestureRef.current).toBe(true);
  expect(view.committed.at(-1)).toBe(view.handlers);
});

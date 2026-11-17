import { act, renderHook } from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FrameDrawState } from "../workspaceShared";
import { useFrameDrawCompletion, type FrameDrawCompletionInputs } from "./useFrameDrawCompletion";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function draw(kind: FrameDrawState["kind"] = "Location"): FrameDrawState {
  return { kind, startScreen: { x: 0, y: 0 }, currentScreen: { x: 20, y: 10 }, startFlow: { x: 500, y: 600 }, currentFlow: { x: 100, y: 100 } };
}
function inputs() {
  const refs: Pick<FrameDrawCompletionInputs, "frameDrawRef" | "suppressPaneClickRef"> = {
    frameDrawRef: { current: draw() }, suppressPaneClickRef: { current: false }
  };
  return {
    ...refs, setFrameDraw: vi.fn<FrameDrawCompletionInputs["setFrameDraw"]>(),
    addFrameAt: vi.fn<FrameDrawCompletionInputs["addFrameAt"]>(),
    setToolMode: vi.fn<FrameDrawCompletionInputs["setToolMode"]>()
  } satisfies FrameDrawCompletionInputs;
}

it.each([true, false])("cancels even when active=%s, clearing ref before state without creation or mode/timer changes", (active) => {
  const context = inputs();
  if (!active) context.frameDrawRef.current = null;
  context.setFrameDraw.mockImplementation(() => expect(context.frameDrawRef.current).toBeNull());
  const { result } = renderHook(() => useFrameDrawCompletion(context));
  act(() => result.current.cancelFrameDraw());
  expect(context.setFrameDraw).toHaveBeenCalledWith(null);
  expect(context.addFrameAt).not.toHaveBeenCalled();
  expect(context.setToolMode).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("does nothing on finish without an active draw", () => {
  const context = inputs();
  context.frameDrawRef.current = null;
  const { result } = renderHook(() => useFrameDrawCompletion(context));
  act(() => result.current.finishFrameDraw());
  expect(context.setFrameDraw).not.toHaveBeenCalled();
  expect(context.addFrameAt).not.toHaveBeenCalled();
  expect(context.setToolMode).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([{ x: 7.99, y: 0, creates: false }, { x: 8, y: 0, creates: true }, { x: 6, y: 6, creates: true }])("uses screen distance x=$x y=$y for the unchanged threshold", ({ x, y, creates }) => {
  const context = inputs();
  context.frameDrawRef.current = { ...draw(), currentScreen: { x, y }, currentFlow: { x: 0, y: 0 } };
  const { result } = renderHook(() => useFrameDrawCompletion(context));
  act(() => result.current.finishFrameDraw());
  expect(context.setFrameDraw).toHaveBeenCalledWith(null);
  expect(context.addFrameAt).toHaveBeenCalledTimes(creates ? 1 : 0);
  expect(context.setToolMode).toHaveBeenCalledTimes(creates ? 1 : 0);
  expect(vi.getTimerCount()).toBe(creates ? 1 : 0);
});

it.each(["Scene", "Location"] as const)("finishes %s with normalized flow bounds, ordered cleanup and deferred suppression reset", (kind) => {
  const context = inputs();
  context.frameDrawRef.current = draw(kind);
  context.addFrameAt.mockImplementation(() => {
    expect(context.frameDrawRef.current).toBeNull();
    expect(context.suppressPaneClickRef.current).toBe(false);
  });
  context.setToolMode.mockImplementation(() => expect(context.suppressPaneClickRef.current).toBe(true));
  const { result } = renderHook(() => useFrameDrawCompletion(context));
  act(() => result.current.finishFrameDraw());
  expect(context.addFrameAt).toHaveBeenCalledWith(expect.objectContaining({ kind }), { x: 100, y: 100 }, { width: 400, height: 500 });
  expect(context.setFrameDraw.mock.invocationCallOrder[0]).toBeLessThan(context.addFrameAt.mock.invocationCallOrder[0]!);
  expect(context.addFrameAt.mock.invocationCallOrder[0]).toBeLessThan(context.setToolMode.mock.invocationCallOrder[0]!);
  expect(context.setToolMode).toHaveBeenCalledWith("select");
  expect(context.suppressPaneClickRef.current).toBe(true);
  act(() => vi.runAllTimers());
  expect(context.suppressPaneClickRef.current).toBe(false);
});

it("retains both callbacks and adopts replacement refs, creation and mode commands", () => {
  const original = inputs();
  const view = renderHook(({ context }) => useFrameDrawCompletion(context), { initialProps: { context: original } });
  const handlers = view.result.current;
  const next = inputs();
  next.frameDrawRef.current = { ...draw("Scene"), currentFlow: { x: 500, y: 600 } };
  view.rerender({ context: next });
  expect(view.result.current).toBe(handlers);
  act(() => handlers.finishFrameDraw());
  expect(next.addFrameAt).toHaveBeenCalledWith(expect.objectContaining({ kind: "Scene" }), { x: 500, y: 600 }, { width: 320, height: 220 });
  expect(next.setToolMode).toHaveBeenCalledWith("select");
  next.frameDrawRef.current = draw();
  act(() => handlers.cancelFrameDraw());
  expect(next.frameDrawRef.current).toBeNull();
  for (const command of [original.setFrameDraw, original.addFrameAt, original.setToolMode]) expect(command).not.toHaveBeenCalled();
});

it("keeps a pending reset on its event-time ref across replacement and unmount", () => {
  const original = inputs();
  const view = renderHook(({ context }) => useFrameDrawCompletion(context), { initialProps: { context: original } });
  act(() => view.result.current.finishFrameDraw());
  const next = inputs();
  next.suppressPaneClickRef.current = true;
  view.rerender({ context: next });
  view.unmount();
  act(() => vi.runAllTimers());
  expect(original.suppressPaneClickRef.current).toBe(false);
  expect(next.suppressPaneClickRef.current).toBe(true);
  expect(next.frameDrawRef.current).not.toBeNull();
  expect(next.setFrameDraw).not.toHaveBeenCalled();
});

it("preserves independent pending resets without introducing cancellation or coalescing", () => {
  const context = inputs();
  const { result } = renderHook(() => useFrameDrawCompletion(context));
  act(() => result.current.finishFrameDraw());
  context.frameDrawRef.current = draw();
  act(() => result.current.finishFrameDraw());
  act(() => result.current.cancelFrameDraw());
  expect(vi.getTimerCount()).toBe(2);
  act(() => vi.runAllTimers());
  expect(context.suppressPaneClickRef.current).toBe(false);
});

it("does not publish suspended completion inputs before commit", () => {
  const original = inputs();
  const pending = new Promise<void>(() => {});
  const view = renderHook(({ context, suspend }) => {
    const handlers = useFrameDrawCompletion(context);
    if (suspend) throw pending;
    return handlers;
  }, { initialProps: { context: original, suspend: false }, wrapper: ({ children }) => <Suspense fallback={null}>{children}</Suspense> });
  const handlers = view.result.current;
  const next = inputs();
  view.rerender({ context: next, suspend: true });
  act(() => handlers.cancelFrameDraw());
  expect(original.frameDrawRef.current).toBeNull();
  expect(next.setFrameDraw).not.toHaveBeenCalled();
  view.rerender({ context: next, suspend: false });
  act(() => handlers.finishFrameDraw());
  expect(next.addFrameAt).toHaveBeenCalledOnce();
  expect(next.setToolMode).toHaveBeenCalledWith("select");
  expect(view.result.current).toBe(handlers);
});

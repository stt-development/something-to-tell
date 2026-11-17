import { fireEvent, render, screen } from "@testing-library/react";
import { Suspense, useLayoutEffect } from "react";
import { expect, it, vi } from "vitest";
import type { ToolMode } from "../workspaceShared";
import { useFrameDrawPointerHandlers, type FrameDrawPointerInputs } from "./useFrameDrawPointerHandlers";

function inputs() {
  const frameDrawRef: FrameDrawPointerInputs["frameDrawRef"] = { current: null };
  return {
    toolMode: "location-frame" as ToolMode, frameDrawRef,
    setFrameDraw: vi.fn<FrameDrawPointerInputs["setFrameDraw"]>(),
    screenToFlowPosition: vi.fn<FrameDrawPointerInputs["screenToFlowPosition"]>(({ x, y }) => ({ x: x / 2, y: y / 2 }))
  } satisfies FrameDrawPointerInputs;
}

/** Retain committed stage handlers and dispatch real capture-phase React mouse events. */
function mount(initial: FrameDrawPointerInputs) {
  const committed: ReturnType<typeof useFrameDrawPointerHandlers>[] = [];
  const pending = new Promise<void>(() => {});
  function Consumer({ context, suspend }: { context: FrameDrawPointerInputs; suspend: boolean }) {
    const handlers = useFrameDrawPointerHandlers(context);
    useLayoutEffect(() => { committed.push(handlers); });
    if (suspend) throw pending;
    return null;
  }
  const tree = (context: FrameDrawPointerInputs, suspend = false) => <>
    <div onMouseDownCapture={(event) => committed[0]!.startFrameDraw(event)} onMouseMoveCapture={(event) => committed[0]!.continueFrameDraw(event)}>
      <div data-testid="pane" className="react-flow__pane"><button>Child</button></div>
    </div>
    <Suspense fallback={null}><Consumer context={context} suspend={suspend} /></Suspense>
  </>;
  const view = render(tree(initial));
  return {
    committed, update: (next: FrameDrawPointerInputs, suspend = false) => view.rerender(tree(next, suspend)),
    start: (button = 0, child = false) => fireEvent.mouseDown(child ? screen.getByRole("button", { name: "Child" }) : screen.getByTestId("pane"), { button, clientX: 0, clientY: -20 }),
    move: () => fireEvent.mouseMove(screen.getByTestId("pane"), { clientX: 120, clientY: 80 })
  };
}

it.each(["scene-frame", "location-frame"] as const)("starts %s with exact screen coordinates, both original conversions and ref-before-setter order", (toolMode) => {
  const context = inputs();
  context.setFrameDraw.mockImplementation((draw) => expect(context.frameDrawRef.current).toBe(draw));
  const view = mount({ ...context, toolMode });
  view.start();
  expect(context.screenToFlowPosition.mock.calls).toEqual([[{ x: 0, y: -20 }], [{ x: 0, y: -20 }]]);
  expect(context.frameDrawRef.current).toEqual({
    kind: toolMode === "scene-frame" ? "Scene" : "Location",
    currentFlow: { x: 0, y: -10 }, startFlow: { x: 0, y: -10 },
    currentScreen: { x: 0, y: -20 }, startScreen: { x: 0, y: -20 }
  });
  expect(context.setFrameDraw).toHaveBeenCalledOnce();
});

it.each([
  { toolMode: "select", button: 0, child: false },
  { toolMode: "pan", button: 0, child: false },
  { toolMode: "Character", button: 0, child: false },
  { toolMode: "scene-frame", button: 1, child: false },
  { toolMode: "scene-frame", button: 2, child: false },
  { toolMode: "scene-frame", button: 0, child: true }
] satisfies Array<{ toolMode: ToolMode; button: number; child: boolean }>)("preserves start guards for $toolMode/button=$button/child=$child", ({ toolMode, button, child }) => {
  const context = inputs();
  mount({ ...context, toolMode }).start(button, child);
  expect(context.screenToFlowPosition).not.toHaveBeenCalled();
  expect(context.setFrameDraw).not.toHaveBeenCalled();
  expect(context.frameDrawRef.current).toBeNull();
});

it("does not convert or publish an update without an active draw", () => {
  const context = inputs();
  mount(context).move();
  expect(context.screenToFlowPosition).not.toHaveBeenCalled();
  expect(context.setFrameDraw).not.toHaveBeenCalled();
});

it("updates only current coordinates from the live buffer, preserving kind and start coordinates", () => {
  const context = inputs();
  const view = mount(context);
  view.start();
  const first = context.frameDrawRef.current!;
  context.setFrameDraw.mockImplementation((draw) => expect(context.frameDrawRef.current).toBe(draw));
  view.update({ ...context, toolMode: "scene-frame" });
  view.move();
  expect(context.frameDrawRef.current).toEqual({ ...first, currentScreen: { x: 120, y: 80 }, currentFlow: { x: 60, y: 40 } });
  expect(context.frameDrawRef.current?.startFlow).toBe(first.startFlow);
  expect(context.frameDrawRef.current?.startScreen).toBe(first.startScreen);
  expect(context.frameDrawRef.current?.kind).toBe("Location");
  expect(context.screenToFlowPosition).toHaveBeenCalledTimes(3);
});

it("does not revive a gesture after its existing owner clears the draw ref", () => {
  const context = inputs();
  const view = mount(context);
  view.start();
  context.frameDrawRef.current = null;
  context.setFrameDraw.mockClear();
  context.screenToFlowPosition.mockClear();
  view.move();
  expect(context.setFrameDraw).not.toHaveBeenCalled();
  expect(context.screenToFlowPosition).not.toHaveBeenCalled();
});

it("retains handlers and adopts replacement tool, ref, converter and setter inputs", () => {
  const original = inputs();
  const view = mount(original);
  const next = inputs();
  next.screenToFlowPosition.mockReturnValue({ x: 0, y: 0 });
  view.update({ ...next, toolMode: "scene-frame" });
  view.start();
  view.move();
  expect(view.committed[1]).toBe(view.committed[0]);
  expect(next.frameDrawRef.current).toMatchObject({ kind: "Scene", currentFlow: { x: 0, y: 0 }, currentScreen: { x: 120, y: 80 } });
  expect(next.setFrameDraw).toHaveBeenCalledTimes(2);
  expect(original.frameDrawRef.current).toBeNull();
  expect(original.screenToFlowPosition).not.toHaveBeenCalled();
  expect(original.setFrameDraw).not.toHaveBeenCalled();
});

it("ignores suspended pointer inputs and adopts them only after commit", () => {
  const original = inputs();
  const view = mount(original);
  const next = inputs();
  const pending = { ...next, toolMode: "scene-frame" as const };
  view.update(pending, true);
  view.start();
  view.move();
  expect(original.frameDrawRef.current?.kind).toBe("Location");
  expect(next.setFrameDraw).not.toHaveBeenCalled();
  expect(next.frameDrawRef.current).toBeNull();
  view.update(pending);
  view.start();
  view.move();
  expect(next.frameDrawRef.current?.kind).toBe("Scene");
  expect(next.setFrameDraw).toHaveBeenCalledTimes(2);
  expect(view.committed.at(-1)).toBe(view.committed[0]);
});

import type { Node } from "@xyflow/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Suspense, useLayoutEffect } from "react";
import { expect, it, vi } from "vitest";
import type { NarrativeNodeData } from "../../types";
import { useCanvasConnectionHoverHandlers, type CanvasConnectionHoverInputs } from "./useCanvasConnectionHoverHandlers";

const target: Node<NarrativeNodeData> = {
  id: "target-placement", position: { x: 0, y: 0 },
  data: { kind: "Character", label: "Character", title: "Actor", summary: "", tags: [], canonicalNodeId: "shared-canonical" }
};

function inputs() {
  return {
    connectionSourceId: "source-placement" as string | null,
    connectionTargetId: null as string | null,
    setConnectionTargetId: vi.fn<CanvasConnectionHoverInputs["setConnectionTargetId"]>()
  } satisfies CanvasConnectionHoverInputs;
}

/** Invoke the first committed callbacks with real React enter/leave events. */
function mount(initial: CanvasConnectionHoverInputs) {
  const committed: ReturnType<typeof useCanvasConnectionHoverHandlers>[] = [];
  const pending = new Promise<void>(() => {});
  let eventNode = target;
  function Consumer({ context, suspend }: { context: CanvasConnectionHoverInputs; suspend: boolean }) {
    const handlers = useCanvasConnectionHoverHandlers(context);
    useLayoutEffect(() => { committed.push(handlers); });
    if (suspend) throw pending;
    return null;
  }
  const tree = (context: CanvasConnectionHoverInputs, suspend = false) => <>
    <div data-testid="hover-target"
      onMouseEnter={(event) => committed[0]!.onNodeMouseEnter(event, eventNode)}
      onMouseLeave={(event) => committed[0]!.onNodeMouseLeave(event, eventNode)} />
    <Suspense fallback={null}><Consumer context={context} suspend={suspend} /></Suspense>
  </>;
  const view = render(tree(initial));
  return {
    committed,
    update: (next: CanvasConnectionHoverInputs, suspend = false) => view.rerender(tree(next, suspend)),
    enter: (node = target) => { eventNode = node; fireEvent.mouseEnter(screen.getByTestId("hover-target")); },
    leave: (node = target) => { eventNode = node; fireEvent.mouseLeave(screen.getByTestId("hover-target")); }
  };
}

it.each([null, ""])("does not publish an enter without an active source (%s)", (connectionSourceId) => {
  const context = inputs();
  const view = mount({ ...context, connectionSourceId });
  view.enter();
  expect(context.setConnectionTargetId).not.toHaveBeenCalled();
});

it("ignores the source placement but uses the exact target placement for a linked canonical node", () => {
  const context = inputs();
  const view = mount(context);
  view.enter({ ...target, id: "source-placement" });
  expect(context.setConnectionTargetId).not.toHaveBeenCalled();
  view.enter();
  expect(context.setConnectionTargetId).toHaveBeenCalledWith("target-placement");
});

it("does not clear a newer target when the previous target's leave arrives", () => {
  const context = inputs();
  const view = mount(context);
  view.enter();
  view.update({ ...context, connectionTargetId: target.id });
  const other = { ...target, id: "other-placement" };
  view.enter(other);
  view.update({ ...context, connectionTargetId: other.id });
  view.leave();
  expect(context.setConnectionTargetId.mock.calls).toEqual([[target.id], [other.id]]);
  view.leave(other);
  expect(context.setConnectionTargetId.mock.calls).toEqual([[target.id], [other.id], [null]]);
});

it("retains both adapters while adopting replacement project feedback ids and commands", () => {
  const original = inputs();
  const view = mount(original);
  const next = inputs();
  view.update({ ...next, connectionSourceId: target.id, connectionTargetId: "other-placement" });
  view.enter();
  view.leave();
  expect(next.setConnectionTargetId).not.toHaveBeenCalled();
  const other = { ...target, id: "other-placement" };
  view.enter(other);
  view.leave(other);
  expect(next.setConnectionTargetId.mock.calls).toEqual([[other.id], [null]]);
  expect(original.setConnectionTargetId).not.toHaveBeenCalled();
  expect(view.committed[1]).toBe(view.committed[0]);
});

it("does not resurrect cleared gesture feedback on a later enter or leave", () => {
  const context = inputs();
  const view = mount({ ...context, connectionTargetId: target.id });
  view.update({ ...context, connectionSourceId: null, connectionTargetId: null });
  view.leave();
  view.enter();
  expect(context.setConnectionTargetId).not.toHaveBeenCalled();
});

it("clears the matching target even when the source has already cleared", () => {
  const context = inputs();
  const view = mount({ ...context, connectionSourceId: null, connectionTargetId: target.id });
  view.leave();
  expect(context.setConnectionTargetId).toHaveBeenCalledWith(null);
});

it("ignores speculative inputs and adopts them only when the render commits", () => {
  const original = inputs();
  const view = mount({ ...original, connectionTargetId: target.id });
  const next = inputs();
  const pending = { ...next, connectionSourceId: null, connectionTargetId: target.id };
  view.update(pending, true);
  view.enter();
  view.leave();
  expect(original.setConnectionTargetId.mock.calls).toEqual([[target.id], [null]]);
  expect(next.setConnectionTargetId).not.toHaveBeenCalled();
  view.update(pending);
  view.enter();
  view.leave();
  expect(next.setConnectionTargetId.mock.calls).toEqual([[null]]);
  expect(view.committed.at(-1)).toBe(view.committed[0]);
});

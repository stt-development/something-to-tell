import type { Connection, Edge, FinalConnectionState } from "@xyflow/react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Suspense, useLayoutEffect } from "react";
import { expect, it, vi } from "vitest";
import type { FlowTransition } from "../../story-flow/contracts";
import type { NarrativeEdgeData } from "../../types";
import { useCanvasReconnectHandlers, type CanvasReconnectInputs } from "./useCanvasReconnectHandlers";

const event = new MouseEvent("mouseup");
const edge: Edge<NarrativeEdgeData> = {
  id: "relation", source: "source-placement", sourceHandle: "bottom", target: "target-placement", targetHandle: "left", data: { label: "Carries" }
};
const connection: Connection = { source: "new-source", sourceHandle: "right", target: "new-target", targetHandle: "top" };
const transition: FlowTransition = {
  transition_version: 1, id: "transition", flow_id: "flow-a", project_id: "project-a",
  source_node_id: "source", target_node_id: "target", kind: "next", label: "Continue", condition: "",
  priority: 0, is_default: true, metadata: {}, created_at: "2026-10-27T00:00:00Z", updated_at: "2026-10-27T00:00:00Z"
};
const flowEdge = { ...edge, id: `story-flow:${transition.id}` };

function inputs() {
  return {
    activeStoryFlow: { transitions: [transition] } as CanvasReconnectInputs["activeStoryFlow"],
    connectionTargetId: "hovered-placement" as string | null,
    reconnectFlowTransition: vi.fn<CanvasReconnectInputs["reconnectFlowTransition"]>().mockResolvedValue(undefined),
    reconnectEdge: vi.fn<CanvasReconnectInputs["reconnectEdge"]>(), deleteEdge: vi.fn<CanvasReconnectInputs["deleteEdge"]>(),
    setConnectionSourceId: vi.fn<CanvasReconnectInputs["setConnectionSourceId"]>(),
    setConnectionTargetId: vi.fn<CanvasReconnectInputs["setConnectionTargetId"]>()
  } satisfies CanvasReconnectInputs;
}

function endState(overrides: Partial<FinalConnectionState> = {}): FinalConnectionState {
  return {
    isValid: false, from: null, fromHandle: null, fromPosition: null, fromNode: null,
    to: null, toHandle: null, toPosition: null, toNode: null, pointer: null, ...overrides
  };
}

/** Retain committed event props independently of later or suspended renders. */
function mount(initial: CanvasReconnectInputs) {
  const committed: ReturnType<typeof useCanvasReconnectHandlers>[] = [];
  const pending = new Promise<void>(() => {});
  let startEdge = edge;
  let startHandle: "source" | "target" = "target";
  function Consumer({ context, suspend }: { context: CanvasReconnectInputs; suspend: boolean }) {
    const handlers = useCanvasReconnectHandlers(context);
    useLayoutEffect(() => { committed.push(handlers); });
    if (suspend) throw pending;
    return null;
  }
  const tree = (context: CanvasReconnectInputs, suspend = false) => <>
    <button onMouseDown={(mouseEvent) => committed[0]!.onReconnectStart(mouseEvent, startEdge, startHandle)}>Reconnect</button>
    <Suspense fallback={null}><Consumer context={context} suspend={suspend} /></Suspense>
  </>;
  const view = render(tree(initial));
  return {
    committed, handlers: committed[0]!,
    update: (next: CanvasReconnectInputs, suspend = false) => view.rerender(tree(next, suspend)),
    start: (currentEdge: typeof edge, handle: "source" | "target") => {
      startEdge = currentEdge;
      startHandle = handle;
      fireEvent.mouseDown(screen.getByRole("button", { name: "Reconnect" }));
    }
  };
}

function expectCleared(context: ReturnType<typeof inputs>, after?: { mock: { invocationCallOrder: number[] } }) {
  expect(context.setConnectionSourceId).toHaveBeenLastCalledWith(null);
  expect(context.setConnectionTargetId).toHaveBeenLastCalledWith(null);
  const sourceOrder = context.setConnectionSourceId.mock.invocationCallOrder.at(-1)!;
  expect(sourceOrder).toBeLessThan(context.setConnectionTargetId.mock.invocationCallOrder.at(-1)!);
  if (after) expect(after.mock.invocationCallOrder.at(-1)).toBeLessThan(sourceOrder);
}

it("forwards ordinary reconnections with exact edge identity, endpoints and handles", () => {
  const context = inputs();
  const { handlers } = mount(context);
  act(() => handlers.onReconnect(edge, connection));
  expect(context.reconnectEdge).toHaveBeenCalledWith(edge.id, connection);
  expect(context.reconnectEdge.mock.calls[0]![1]).toBe(connection);
  expect(context.reconnectFlowTransition).not.toHaveBeenCalled();
  expect(context.deleteEdge).not.toHaveBeenCalled();
  expect(context.setConnectionSourceId).not.toHaveBeenCalled();
});

it("resolves transitions only from the current active flow and preserves the current transition record", () => {
  const context = inputs();
  const view = mount(context);
  act(() => view.handlers.onReconnect(flowEdge, connection));
  expect(context.reconnectFlowTransition.mock.calls[0]![0]).toBe(transition);
  const changed = { ...transition, flow_id: "flow-b", label: "Updated transition" };
  view.update({ ...context, activeStoryFlow: { transitions: [changed] } });
  act(() => view.handlers.onReconnect(flowEdge, connection));
  expect(context.reconnectFlowTransition).toHaveBeenLastCalledWith(changed, connection.source, connection.target);
  expect(context.reconnectFlowTransition.mock.calls[1]![0]).toBe(changed);
  view.update({ ...context, activeStoryFlow: { transitions: [{ ...transition, id: "another" }] } });
  act(() => view.handlers.onReconnect(flowEdge, connection));
  expect(context.reconnectEdge).toHaveBeenLastCalledWith(flowEdge.id, connection);
  view.update({ ...context, activeStoryFlow: null });
  act(() => view.handlers.onReconnect(flowEdge, connection));
  expect(context.reconnectEdge).toHaveBeenCalledTimes(2);
});

it.each(["source", "target"] as const)("forwards an incomplete %s even for a matching flow transition", (endpoint) => {
  const context = inputs();
  const { handlers } = mount(context);
  const incomplete = { ...connection, [endpoint]: "" };
  act(() => handlers.onReconnect(flowEdge, incomplete));
  expect(context.reconnectEdge).toHaveBeenCalledWith(flowEdge.id, incomplete);
  expect(context.reconnectFlowTransition).not.toHaveBeenCalled();
});

it.each(["source", "target"] as const)("highlights the fixed endpoint when moving the %s handle", (handleType) => {
  const context = inputs();
  const { start } = mount(context);
  start(edge, handleType);
  expect(context.setConnectionSourceId).toHaveBeenCalledWith(handleType === "source" ? edge.target : edge.source);
  expect(context.setConnectionTargetId).not.toHaveBeenCalled();
});

it.each(["source", "target"] as const)("keeps the fixed endpoint and its handle on a %s body drop", (handleType) => {
  const context = inputs();
  const { handlers } = mount(context);
  act(() => handlers.onReconnectEnd(event, edge, handleType, endState()));
  expect(context.reconnectEdge).toHaveBeenCalledWith(edge.id, handleType === "source"
    ? { source: "hovered-placement", sourceHandle: null, target: edge.target, targetHandle: "left" }
    : { source: edge.source, sourceHandle: "bottom", target: "hovered-placement", targetHandle: null });
  expect(context.deleteEdge).not.toHaveBeenCalled();
  expectCleared(context, context.reconnectEdge);
});

it("prefers event target over hover feedback and retains the existing flow body-drop graph command", () => {
  const context = inputs();
  const { handlers } = mount(context);
  const node = { id: "event-placement", position: { x: 0, y: 0 }, data: {} };
  const toNode = { ...node, measured: {}, internals: { positionAbsolute: node.position, z: 0, userNode: node } };
  act(() => handlers.onReconnectEnd(event, flowEdge, "target", endState({ isValid: null, toNode })));
  expect(context.reconnectEdge).toHaveBeenCalledWith(flowEdge.id, { source: edge.source, sourceHandle: "bottom", target: node.id, targetHandle: null });
  expect(context.reconnectFlowTransition).not.toHaveBeenCalled();
  expectCleared(context, context.reconnectEdge);
});

it.each(["source", "target"] as const)("normalizes a missing fixed handle to null during a %s body drop", (handleType) => {
  const context = inputs();
  const { handlers } = mount(context);
  act(() => handlers.onReconnectEnd(event, { ...edge, sourceHandle: undefined, targetHandle: undefined }, handleType, endState()));
  expect(context.reconnectEdge.mock.calls[0]![1]).toMatchObject({ sourceHandle: null, targetHandle: null });
});

it.each([false, null])("deletes an empty drop with validity %s before clearing feedback", (isValid) => {
  const context = inputs();
  const { handlers } = mount({ ...context, connectionTargetId: null });
  act(() => handlers.onReconnectEnd(event, edge, "target", endState({ isValid })));
  expect(context.deleteEdge).toHaveBeenCalledWith(edge.id);
  expect(context.reconnectEdge).not.toHaveBeenCalled();
  expectCleared(context, context.deleteEdge);
});

it("does not reconnect again or delete at the end of a valid gesture", () => {
  const context = inputs();
  const { handlers } = mount({ ...context, connectionTargetId: null });
  act(() => { handlers.onReconnect(edge, connection); handlers.onReconnectEnd(event, edge, "target", endState({ isValid: true })); });
  expect(context.reconnectEdge).toHaveBeenCalledOnce();
  expect(context.deleteEdge).not.toHaveBeenCalled();
  expectCleared(context, context.reconnectEdge);
});

it("retains callback identity and adopts replacement project commands, flow and hover feedback", () => {
  const original = inputs();
  const view = mount(original);
  const next = inputs();
  view.update({ ...next, connectionTargetId: "new-hover" });
  act(() => {
    view.start(edge, "source");
    view.handlers.onReconnect(flowEdge, connection);
    view.handlers.onReconnectEnd(event, edge, "source", endState());
  });
  expect(next.setConnectionSourceId.mock.calls).toEqual([[edge.target], [null]]);
  expect(next.setConnectionTargetId).toHaveBeenCalledWith(null);
  expect(next.reconnectFlowTransition).toHaveBeenCalledWith(transition, connection.source, connection.target);
  expect(next.reconnectEdge).toHaveBeenCalledWith(edge.id, expect.objectContaining({ source: "new-hover" }));
  view.update({ ...next, connectionTargetId: null });
  act(() => view.handlers.onReconnectEnd(event, edge, "target", endState()));
  expect(next.deleteEdge).toHaveBeenCalledWith(edge.id);
  for (const callback of [original.reconnectEdge, original.reconnectFlowTransition, original.deleteEdge, original.setConnectionSourceId, original.setConnectionTargetId]) expect(callback).not.toHaveBeenCalled();
  expect(view.committed.every((handlers) => handlers === view.handlers)).toBe(true);
});

it("does not await an async flow reconnect before gesture-end feedback clearing", async () => {
  const context = inputs();
  let complete!: () => void;
  const pending = new Promise<void>((resolve) => { complete = resolve; });
  context.reconnectFlowTransition.mockReturnValue(pending);
  const { handlers } = mount(context);
  act(() => { handlers.onReconnect(flowEdge, connection); handlers.onReconnectEnd(event, flowEdge, "target", endState({ isValid: true })); });
  expectCleared(context, context.reconnectFlowTransition);
  expect(context.reconnectEdge).not.toHaveBeenCalled();
  complete();
  await pending;
});

it("ignores suspended input changes and adopts them only after commit", () => {
  const original = inputs();
  const view = mount(original);
  const next = inputs();
  const pending = { ...next, activeStoryFlow: null, connectionTargetId: null };
  view.update(pending, true);
  act(() => {
    view.start(edge, "target");
    view.handlers.onReconnect(flowEdge, connection);
    view.handlers.onReconnectEnd(event, edge, "target", endState());
  });
  expect(original.reconnectFlowTransition).toHaveBeenCalledOnce();
  expect(original.reconnectEdge).toHaveBeenCalledOnce();
  expect(original.setConnectionSourceId).toHaveBeenCalledTimes(2);
  expect(next.deleteEdge).not.toHaveBeenCalled();
  expect(next.reconnectEdge).not.toHaveBeenCalled();
  expect(next.reconnectFlowTransition).not.toHaveBeenCalled();
  expect(next.setConnectionSourceId).not.toHaveBeenCalled();
  view.update(pending);
  act(() => { view.handlers.onReconnect(flowEdge, connection); view.handlers.onReconnectEnd(event, edge, "target", endState()); });
  expect(next.reconnectEdge).toHaveBeenCalledWith(flowEdge.id, connection);
  expect(next.deleteEdge).toHaveBeenCalledWith(edge.id);
  expectCleared(next, next.deleteEdge);
  expect(view.committed.at(-1)).toBe(view.handlers);
});

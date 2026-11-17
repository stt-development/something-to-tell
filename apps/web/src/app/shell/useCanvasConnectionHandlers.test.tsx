import { Position, type Connection, type FinalConnectionState } from "@xyflow/react";
import { act, render } from "@testing-library/react";
import { Suspense, useLayoutEffect } from "react";
import { expect, it, vi } from "vitest";
import { useCanvasConnectionHandlers, type CanvasConnectionInputs } from "./useCanvasConnectionHandlers";

const event = new MouseEvent("mouseup");
const connection: Connection = { source: "source-placement", sourceHandle: "bottom", target: "target-placement", targetHandle: "left" };

function inputs() {
  return {
    workspaceMode: "relationships" as CanvasConnectionInputs["workspaceMode"],
    connectionSourceId: "source-fallback" as string | null,
    connectionTargetId: "target-fallback" as string | null,
    beginFlowConnection: vi.fn<CanvasConnectionInputs["beginFlowConnection"]>().mockResolvedValue(undefined),
    chooseGraphConnection: vi.fn<CanvasConnectionInputs["chooseGraphConnection"]>(),
    onConnect: vi.fn<CanvasConnectionInputs["onConnect"]>(),
    setConnectionSourceId: vi.fn<CanvasConnectionInputs["setConnectionSourceId"]>(),
    setConnectionTargetId: vi.fn<CanvasConnectionInputs["setConnectionTargetId"]>()
  } satisfies CanvasConnectionInputs;
}

function internalNode(id: string): NonNullable<FinalConnectionState["fromNode"]> {
  const node = { id, position: { x: 0, y: 0 }, data: {} };
  return { ...node, measured: {}, internals: { positionAbsolute: node.position, z: 0, userNode: node } };
}

function endState(overrides: Partial<FinalConnectionState> = {}): FinalConnectionState {
  return {
    isValid: false, from: null, fromHandle: null, fromPosition: null, fromNode: null,
    to: null, toHandle: null, toPosition: null, toNode: null, pointer: null, ...overrides
  };
}

/** Capture committed callbacks so rerenders cannot silently replace the tested gesture. */
function mount(initial: CanvasConnectionInputs) {
  const committed: ReturnType<typeof useCanvasConnectionHandlers>[] = [];
  const pending = new Promise<void>(() => {});
  function Consumer({ context, suspend }: { context: CanvasConnectionInputs; suspend: boolean }) {
    const handlers = useCanvasConnectionHandlers(context);
    useLayoutEffect(() => { committed.push(handlers); });
    if (suspend) throw pending;
    return null;
  }
  const tree = (context: CanvasConnectionInputs, suspend = false) =>
    <Suspense fallback={null}><Consumer context={context} suspend={suspend} /></Suspense>;
  const view = render(tree(initial));
  return { committed, handlers: committed[0]!, update: (next: CanvasConnectionInputs, suspend = false) => view.rerender(tree(next, suspend)) };
}

it.each(["flow", "relationships", "story"] as const)("routes direct connections in %s without changing handles or endpoints", (workspaceMode) => {
  const context = inputs();
  const { handlers } = mount({ ...context, workspaceMode });
  act(() => handlers.onConnect(connection));
  expect(context.beginFlowConnection.mock.calls).toEqual(workspaceMode === "flow" ? [[connection.source, connection.target]] : []);
  expect(context.chooseGraphConnection.mock.calls).toEqual(workspaceMode === "relationships" ? [[connection]] : []);
  expect(context.onConnect.mock.calls).toEqual(workspaceMode === "story" ? [[connection]] : []);
  if (workspaceMode === "story") expect(context.onConnect.mock.calls[0]![0]).toBe(connection);
  expect(context.setConnectionSourceId).not.toHaveBeenCalled();
  expect(context.setConnectionTargetId).not.toHaveBeenCalled();
});

it.each(["source", "target"] as const)("keeps direct incomplete %s connections on the existing fallback path", (endpoint) => {
  const context = inputs();
  const { handlers } = mount(context);
  const incomplete = { ...connection, [endpoint]: "", sourceHandle: null, targetHandle: null };
  act(() => handlers.onConnect(incomplete));
  expect(context.onConnect.mock.calls[0]![0]).toBe(incomplete);
  expect(context.chooseGraphConnection).not.toHaveBeenCalled();
  expect(context.beginFlowConnection).not.toHaveBeenCalled();
});

it.each(["flow", "relationships", "story"] as const)("routes body-drop fallback in %s then clears both feedback ids in order", (workspaceMode) => {
  const context = inputs();
  const { handlers } = mount({ ...context, workspaceMode });
  act(() => handlers.onConnectEnd(event, endState()));
  const fallback = { source: "source-fallback", target: "target-fallback", sourceHandle: null, targetHandle: null };
  const command = workspaceMode === "flow" ? context.beginFlowConnection : workspaceMode === "relationships" ? context.chooseGraphConnection : context.onConnect;
  expect(command.mock.calls).toEqual(workspaceMode === "flow" ? [[fallback.source, fallback.target]] : [[fallback]]);
  expect([context.beginFlowConnection, context.chooseGraphConnection, context.onConnect].filter((callback) => callback.mock.calls.length)).toEqual([command]);
  expect(command.mock.invocationCallOrder[0]).toBeLessThan(context.setConnectionSourceId.mock.invocationCallOrder[0]!);
  expect(context.setConnectionSourceId).toHaveBeenCalledWith(null);
  expect(context.setConnectionTargetId).toHaveBeenCalledWith(null);
  expect(context.setConnectionSourceId.mock.invocationCallOrder[0]).toBeLessThan(context.setConnectionTargetId.mock.invocationCallOrder[0]!);
});

it("prefers event nodes and exact starting handle while leaving target handle selection to the command", () => {
  const context = inputs();
  const { handlers } = mount(context);
  const handle = { id: "bottom", nodeId: connection.source, type: "source" as const, position: Position.Bottom, x: 0, y: 0, width: 8, height: 8 };
  act(() => handlers.onConnectEnd(event, endState({
    isValid: null, fromNode: internalNode(connection.source), toNode: internalNode(connection.target),
    fromHandle: handle, toHandle: { ...handle, id: "right", nodeId: connection.target }
  })));
  expect(context.chooseGraphConnection).toHaveBeenCalledWith({ ...connection, targetHandle: null });
});

it.each(["connectionSourceId", "connectionTargetId"] as const)("clears feedback without creating on a cancelled drop missing %s", (endpoint) => {
  const context = inputs();
  const { handlers } = mount({ ...context, [endpoint]: null });
  act(() => handlers.onConnectEnd(event, endState()));
  expect(context.chooseGraphConnection).not.toHaveBeenCalled();
  expect(context.onConnect).not.toHaveBeenCalled();
  expect(context.beginFlowConnection).not.toHaveBeenCalled();
  expect(context.setConnectionSourceId).toHaveBeenCalledWith(null);
  expect(context.setConnectionTargetId).toHaveBeenCalledWith(null);
});

it("does not repeat a valid handle connection at gesture end", () => {
  const context = inputs();
  const { handlers } = mount(context);
  act(() => { handlers.onConnect(connection); handlers.onConnectEnd(event, endState({ isValid: true })); });
  expect(context.chooseGraphConnection).toHaveBeenCalledOnce();
  expect(context.setConnectionSourceId).toHaveBeenCalledWith(null);
  expect(context.setConnectionTargetId).toHaveBeenCalledWith(null);
});

it("retains all callbacks but uses current project commands, mode and fallback feedback ids", () => {
  const original = inputs();
  const view = mount(original);
  const next = inputs();
  next.connectionSourceId = "new-source";
  next.connectionTargetId = "new-target";
  view.update({ ...next, workspaceMode: "flow" });
  expect(view.committed[1]).toBe(view.handlers);
  act(() => {
    view.handlers.onConnectStart(event, { nodeId: "start-placement", handleId: "bottom", handleType: "source" });
    view.handlers.onConnect(connection);
    view.handlers.onConnectEnd(event, endState());
  });
  expect(next.setConnectionSourceId.mock.calls).toEqual([["start-placement"], [null]]);
  expect(next.beginFlowConnection.mock.calls).toEqual([[connection.source, connection.target], ["new-source", "new-target"]]);
  expect(next.setConnectionTargetId).toHaveBeenCalledWith(null);
  expect(original.setConnectionSourceId).not.toHaveBeenCalled();
  expect(original.setConnectionTargetId).not.toHaveBeenCalled();
  expect(original.chooseGraphConnection).not.toHaveBeenCalled();
  view.update({ ...next, workspaceMode: "relationships" });
  act(() => view.handlers.onConnect(connection));
  expect(next.chooseGraphConnection).toHaveBeenCalledWith(connection);
  view.update({ ...next, workspaceMode: "story" });
  act(() => view.handlers.onConnect(connection));
  expect(next.onConnect).toHaveBeenCalledWith(connection);
});

it("starts feedback even with a null node id and does not reset target feedback early", () => {
  const context = inputs();
  const { handlers } = mount(context);
  act(() => handlers.onConnectStart(event, { nodeId: null, handleId: null, handleType: null }));
  expect(context.setConnectionSourceId).toHaveBeenCalledWith(null);
  expect(context.setConnectionTargetId).not.toHaveBeenCalled();
});

it("clears feedback immediately without awaiting the existing async flow command", async () => {
  const context = inputs();
  let complete!: () => void;
  const pending = new Promise<void>((resolve) => { complete = resolve; });
  context.beginFlowConnection.mockReturnValue(pending);
  const { handlers } = mount({ ...context, workspaceMode: "flow" });
  act(() => handlers.onConnectEnd(event, endState()));
  expect(context.setConnectionSourceId).toHaveBeenCalledWith(null);
  expect(context.setConnectionTargetId).toHaveBeenCalledWith(null);
  complete();
  await pending;
});

it("does not publish suspended mode or commands, then adopts them on commit", () => {
  const original = inputs();
  const view = mount(original);
  const next = inputs();
  const pending = { ...next, workspaceMode: "flow" as const };
  view.update(pending, true);
  act(() => {
    view.handlers.onConnectStart(event, { nodeId: "start", handleId: null, handleType: "source" });
    view.handlers.onConnect(connection);
    view.handlers.onConnectEnd(event, endState());
  });
  expect(original.chooseGraphConnection).toHaveBeenCalledTimes(2);
  expect(original.setConnectionSourceId).toHaveBeenCalledTimes(2);
  expect(next.beginFlowConnection).not.toHaveBeenCalled();
  expect(next.setConnectionSourceId).not.toHaveBeenCalled();
  expect(next.setConnectionTargetId).not.toHaveBeenCalled();
  view.update(pending);
  act(() => view.handlers.onConnect(connection));
  expect(next.beginFlowConnection).toHaveBeenCalledWith(connection.source, connection.target);
  expect(view.committed.at(-1)).toBe(view.handlers);
});

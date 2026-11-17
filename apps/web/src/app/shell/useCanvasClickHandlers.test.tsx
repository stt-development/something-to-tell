import type { Edge, Node, XYPosition } from "@xyflow/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Suspense, useLayoutEffect } from "react";
import { expect, it, vi } from "vitest";
import type { WorkspaceMode } from "../../story-flow/workspace";
import type { NarrativeEdgeData, NarrativeNodeData } from "../../types";
import { DEFAULT_FRAME_SIZE, type ToolMode } from "../workspaceShared";
import { useCanvasClickHandlers, type CanvasClickInputs } from "./useCanvasClickHandlers";

const node: Node<NarrativeNodeData> = {
  id: "placement", position: { x: 0, y: 0 },
  data: { kind: "Character", label: "Character", title: "Actor", summary: "", tags: [], canonicalNodeId: "canonical-a" }
};
const edge: Edge<NarrativeEdgeData> = {
  id: "route", source: node.id, target: "next",
  data: { label: "Next", flowTransition: { flowId: "flow-a", transitionId: "transition-a", kind: "next", priority: 0, isDefault: true, condition: "" } }
};

function inputs() {
  const groupDragActiveRef: CanvasClickInputs["groupDragActiveRef"] = { current: false };
  const suppressPaneClickRef: CanvasClickInputs["suppressPaneClickRef"] = { current: false };
  return {
    toolMode: "select" as ToolMode, workspaceMode: "relationships" as WorkspaceMode,
    nodes: [node], groupDragActiveRef, suppressPaneClickRef,
    selectCanvasElement: vi.fn(), selectItem: vi.fn(), setSelectedTemporalOwner: vi.fn(),
    setSelectedAnalysisOperation: vi.fn(), setContextMenu: vi.fn(), setCanvasSelection: vi.fn(),
    setToolMode: vi.fn(), addNodeAt: vi.fn(), addFrameAt: vi.fn(),
    openDialogueEditor: vi.fn(async () => {}), openQuestEditor: vi.fn(async () => {}),
    setDialog: vi.fn(), setSelectedInvocationId: vi.fn(),
    impactResourceForNode: vi.fn(() => ({ owner_type: "node", owner_id: "canonical-a", context_type: null, context_id: null })),
    impactResourceForEdge: vi.fn(() => ({ owner_type: "edge", owner_id: edge.id, context_type: null, context_id: null })),
    screenToFlowPosition: vi.fn(({ x, y }: XYPosition) => ({ x: x / 2, y: y / 2 }))
  } satisfies CanvasClickInputs;
}

/** Retain committed callbacks and invoke them with real React mouse events. */
function mount(initial: CanvasClickInputs, targetEdge = edge, targetNode = node) {
  const committed: ReturnType<typeof useCanvasClickHandlers>[] = [];
  const pending = new Promise<void>(() => {});
  function Consumer({ context, suspend }: { context: CanvasClickInputs; suspend: boolean }) {
    const handlers = useCanvasClickHandlers(context);
    useLayoutEffect(() => { committed.push(handlers); });
    if (suspend) throw pending;
    return null;
  }
  function Caller() {
    return <>
      <button onClick={(event) => committed[0]!.onNodeClick(event, targetNode)}
        onDoubleClick={(event) => committed[0]!.onNodeDoubleClick(event, targetNode)}
        onContextMenu={(event) => committed[0]!.onNodeContextMenu(event, targetNode)}>Node</button>
      <button onClick={(event) => committed[0]!.onEdgeClick(event, targetEdge)}
        onDoubleClick={(event) => committed[0]!.onEdgeDoubleClick(event, targetEdge)}
        onContextMenu={(event) => committed[0]!.onEdgeContextMenu(event, targetEdge)}>Edge</button>
      <button onClick={(event) => committed[0]!.onPaneClick(event)}
        onContextMenu={(event) => committed[0]!.onPaneContextMenu(event)}>Pane</button>
    </>;
  }
  const tree = (context: CanvasClickInputs, suspend = false) => <>
    <Caller /><Suspense fallback={<span>Pending</span>}><Consumer context={context} suspend={suspend} /></Suspense>
  </>;
  const view = render(tree(initial));
  return {
    committed,
    update: (next: CanvasClickInputs, suspend = false) => view.rerender(tree(next, suspend)),
    setEdge: (next: Edge<NarrativeEdgeData>) => { targetEdge = next; },
    setNode: (next: Node<NarrativeNodeData>) => { targetNode = next; }
  };
}

it("retains callback identity while reading current project commands, nodes, mode and Shift", () => {
  const first = inputs();
  const view = mount(first);
  fireEvent.click(screen.getByText("Node"), { shiftKey: true });
  expect(first.selectCanvasElement).toHaveBeenCalledWith("node", "placement", true);
  expect(first.setSelectedTemporalOwner).toHaveBeenCalledWith({ owner_version: 1, owner_kind: "node_entry", owner_id: "canonical-a" });
  const next = inputs();
  next.nodes = [{ ...node, data: { ...node.data, canonicalNodeId: "canonical-b" } }];
  view.update(next);
  expect(view.committed[1]).toBe(view.committed[0]);
  fireEvent.click(screen.getByText("Node"));
  expect(next.selectCanvasElement).toHaveBeenCalledWith("node", "placement", false);
  expect(next.setSelectedTemporalOwner).toHaveBeenCalledWith({ owner_version: 1, owner_kind: "node_entry", owner_id: "canonical-b" });
  expect(first.selectCanvasElement).toHaveBeenCalledOnce();
  view.update({ ...next, workspaceMode: "flow" });
  fireEvent.click(screen.getByText("Node"));
  expect(next.setSelectedTemporalOwner).toHaveBeenLastCalledWith(null);
});

it("reads live group-drag suppression and current Pan guards without swallowing later selection", () => {
  const context = inputs();
  const view = mount(context);
  context.groupDragActiveRef.current = true;
  fireEvent.click(screen.getByText("Node"));
  expect(context.selectCanvasElement).not.toHaveBeenCalled();
  context.groupDragActiveRef.current = false;
  view.update({ ...context, toolMode: "pan" });
  fireEvent.click(screen.getByText("Node"));
  fireEvent.click(screen.getByText("Edge"));
  expect(context.selectCanvasElement).not.toHaveBeenCalled();
  view.update(context);
  fireEvent.click(screen.getByText("Node"));
  expect(context.selectCanvasElement).toHaveBeenCalledOnce();
});

it("preserves current edge payload/temporal semantics and does not apply the node group guard", () => {
  const context = inputs();
  context.groupDragActiveRef.current = true;
  const view = mount(context);
  fireEvent.click(screen.getByText("Edge"), { shiftKey: true });
  expect(context.selectCanvasElement).toHaveBeenCalledWith("edge", edge.id, true);
  expect(context.setSelectedTemporalOwner).toHaveBeenCalledWith({ owner_version: 1, owner_kind: "flow_transition", owner_id: "transition-a" });
  view.setEdge({ ...edge, data: { label: "New flow call", flowInvocation: {
    invocationId: "call-b", sourceFlowId: "flow-b", targetFlowId: "flow-c",
    priority: 0, isDefault: true, condition: "", invalid: false
  } } });
  fireEvent.click(screen.getByText("Edge"));
  expect(context.setSelectedTemporalOwner).toHaveBeenLastCalledWith({ owner_version: 1, owner_kind: "flow_invocation", owner_id: "call-b" });
  view.update({ ...context, workspaceMode: "flow" });
  fireEvent.click(screen.getByText("Edge"));
  expect(context.setSelectedTemporalOwner).toHaveBeenLastCalledWith(null);
});

it("keeps analysis preview index zero separate from ordinary edge selection", () => {
  const context = inputs();
  mount(context, { ...edge, data: { label: "Preview", analysisOperationIndex: 0 } });
  fireEvent.click(screen.getByText("Edge"));
  expect(context.setSelectedAnalysisOperation).toHaveBeenCalledWith(0);
  expect(context.selectCanvasElement).not.toHaveBeenCalled();
  expect(context.setSelectedTemporalOwner).not.toHaveBeenCalled();
});

it.each(["scene-frame", "location-frame"] as const)("creates %s with current conversion and unchanged defaults", (toolMode) => {
  const context = inputs();
  const view = mount(context);
  const convert = vi.fn(() => ({ x: 0, y: 25 }));
  view.update({ ...context, toolMode, screenToFlowPosition: convert });
  fireEvent.click(screen.getByText("Pane"), { clientX: 100, clientY: 80 });
  expect(convert).toHaveBeenCalledWith({ x: 100, y: 80 });
  expect(context.addFrameAt).toHaveBeenCalledWith(expect.objectContaining({ kind: toolMode === "scene-frame" ? "Scene" : "Location" }), { x: 0, y: 25 }, DEFAULT_FRAME_SIZE);
  expect(context.addNodeAt).not.toHaveBeenCalled();
  expect(context.setToolMode).toHaveBeenCalledWith("select");
});

it("dismisses before consuming pane suppression, then creates a node on the next click", () => {
  const context = inputs();
  context.suppressPaneClickRef.current = true;
  mount({ ...context, toolMode: "Character" });
  fireEvent.click(screen.getByText("Pane"));
  expect(context.setContextMenu).toHaveBeenCalledWith(null);
  expect(context.setSelectedTemporalOwner).toHaveBeenCalledWith(null);
  expect(context.setContextMenu.mock.invocationCallOrder[0]).toBeLessThan(context.setSelectedTemporalOwner.mock.invocationCallOrder[0]!);
  expect(context.suppressPaneClickRef.current).toBe(false);
  expect(context.addNodeAt).not.toHaveBeenCalled();
  expect(context.setCanvasSelection).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Pane"), { clientX: 100, clientY: 80 });
  expect(context.addNodeAt).toHaveBeenCalledWith(expect.objectContaining({ kind: "Character" }), { x: 50, y: 40 });
  expect(context.setToolMode).toHaveBeenCalledWith("select");
});

it("clears selection in Select, but only dismisses transient UI in Pan", () => {
  const context = inputs();
  const view = mount({ ...context, toolMode: "pan" });
  fireEvent.click(screen.getByText("Pane"));
  expect(context.setContextMenu).toHaveBeenCalledOnce();
  expect(context.setSelectedTemporalOwner).toHaveBeenCalledOnce();
  expect(context.selectItem).not.toHaveBeenCalled();
  view.update(context);
  fireEvent.click(screen.getByText("Pane"));
  expect(context.setCanvasSelection).toHaveBeenCalledWith({ edgeIds: [], nodeIds: [] });
  expect(context.selectItem).toHaveBeenCalledWith(null);
});

it("does not publish inputs from a suspended render, then adopts them on commit", () => {
  const original = inputs();
  const view = mount(original);
  const next = inputs();
  const pending = { ...next, toolMode: "Character" as const };
  view.update(pending, true);
  expect(screen.getByText("Pending")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Pane"));
  expect(original.selectItem).toHaveBeenCalledWith(null);
  expect(next.addNodeAt).not.toHaveBeenCalled();
  view.update(pending);
  fireEvent.click(screen.getByText("Pane"));
  expect(next.addNodeAt).toHaveBeenCalledOnce();
  expect(view.committed.at(-1)).toBe(view.committed[0]);
});

it.each(["Dialogue", "Quest", "Scene", "Location", "Character"] as const)("opens current %s payload through its existing editor owner", (kind) => {
  const first = inputs(), view = mount(first), next = inputs();
  const current = { ...node, data: { ...node.data, kind, title: "Current title" } };
  view.setNode(current); view.update(next);
  fireEvent.doubleClick(screen.getByText("Node"));
  if (kind === "Dialogue" || kind === "Quest") {
    expect(kind === "Dialogue" ? next.openDialogueEditor : next.openQuestEditor).toHaveBeenCalledWith(current);
    expect(next.selectItem).not.toHaveBeenCalled(); expect(next.setDialog).not.toHaveBeenCalled();
  } else {
    expect(next.selectItem).toHaveBeenCalledWith({ type: "node", id: current.id });
    expect(next.setDialog).toHaveBeenCalledWith("edit-node");
  }
  expect(first.selectItem).not.toHaveBeenCalled();
  expect(first.openDialogueEditor).not.toHaveBeenCalled(); expect(first.openQuestEditor).not.toHaveBeenCalled();
  expect(view.committed.at(-1)).toBe(view.committed[0]);
});

it.each(["relationship", "transition", "invocation"] as const)("retains %s double-click routing and exact event identity", (kind) => {
  const context = inputs(), view = mount(context);
  const current: Edge<NarrativeEdgeData> = kind === "relationship" ? { ...edge, id: "current", data: { label: "Current" } }
    : kind === "transition" ? { ...edge, id: "current" }
    : { ...edge, id: "current", data: { label: "Current", flowInvocation: {
      invocationId: "call-current", sourceFlowId: "source", targetFlowId: "target", priority: 0, isDefault: false, condition: "", invalid: false
    } } };
  view.setEdge(current); fireEvent.doubleClick(screen.getByText("Edge"));
  expect(context.selectItem).toHaveBeenCalledWith({ type: "edge", id: "current" });
  expect(context.setDialog).toHaveBeenCalledWith(kind === "relationship" ? "edit-edge" : kind === "transition" ? "edit-flow-transition" : "flow-call-bindings");
  expect(context.selectItem.mock.invocationCallOrder[0]).toBeLessThan(context.setDialog.mock.invocationCallOrder[0]!);
  if (kind === "invocation") expect(context.setSelectedInvocationId).toHaveBeenCalledWith("call-current");
  else expect(context.setSelectedInvocationId).not.toHaveBeenCalled();
});

it("uses current context-menu resource resolvers, exact screen coordinates and additive selection", () => {
  const old = inputs(), view = mount(old), next = inputs(); view.update(next);
  expect(fireEvent.contextMenu(screen.getByText("Node"), { clientX: 120, clientY: 80, shiftKey: true })).toBe(false);
  expect(next.selectCanvasElement).toHaveBeenCalledWith("node", node.id, true);
  expect(next.impactResourceForNode).toHaveBeenCalledWith(node);
  expect(next.setContextMenu).toHaveBeenCalledWith({ x: 120, y: 80, impactResource: next.impactResourceForNode.mock.results[0]!.value });
  expect(fireEvent.contextMenu(screen.getByText("Edge"), { clientX: 60, clientY: 40 })).toBe(false);
  expect(next.selectCanvasElement).toHaveBeenCalledWith("edge", edge.id, false);
  expect(next.impactResourceForEdge).toHaveBeenCalledWith(edge);
  expect(next.setContextMenu).toHaveBeenLastCalledWith({ x: 60, y: 40, impactResource: next.impactResourceForEdge.mock.results[0]!.value });
  expect(old.setContextMenu).not.toHaveBeenCalled();
});

it("keeps pane coordinates and current screen-to-Flow conversion separate without creating content", () => {
  const context = inputs(), view = mount(context), next = inputs();
  next.screenToFlowPosition.mockImplementation(({ x, y }) => ({ x: x * 3, y: y * 4 })); view.update(next);
  expect(fireEvent.contextMenu(screen.getByText("Pane"), { clientX: 20, clientY: 10 })).toBe(false);
  expect(next.setContextMenu).toHaveBeenCalledWith({ x: 20, y: 10, flowX: 60, flowY: 40 });
  expect(next.addNodeAt).not.toHaveBeenCalled(); expect(next.addFrameAt).not.toHaveBeenCalled();
  expect(next.selectItem).not.toHaveBeenCalled();
});

it("keeps all inspection interactions inert in Pan while preventing the browser context menu", () => {
  const context = inputs(); mount({ ...context, toolMode: "pan" });
  for (const label of ["Node", "Edge", "Pane"]) {
    const button = screen.getByText(label);
    expect(fireEvent.contextMenu(button)).toBe(false);
    if (label !== "Pane") fireEvent.doubleClick(button);
  }
  for (const command of [context.setContextMenu, context.selectCanvasElement, context.selectItem, context.setDialog,
    context.openDialogueEditor, context.openQuestEditor, context.setSelectedInvocationId, context.impactResourceForNode,
    context.impactResourceForEdge, context.screenToFlowPosition]) expect(command).not.toHaveBeenCalled();
});

it("never exposes speculative inspection commands before a suspended replacement commits", () => {
  const original = inputs(), view = mount(original), next = inputs(); view.update(next, true);
  fireEvent.doubleClick(screen.getByText("Node")); fireEvent.contextMenu(screen.getByText("Pane"));
  expect(original.setDialog).toHaveBeenCalledWith("edit-node"); expect(original.setContextMenu).toHaveBeenCalledOnce();
  expect(next.setDialog).not.toHaveBeenCalled(); expect(next.setContextMenu).not.toHaveBeenCalled();
  view.update(next);
  fireEvent.doubleClick(screen.getByText("Node")); fireEvent.contextMenu(screen.getByText("Pane"));
  expect(next.setDialog).toHaveBeenCalledWith("edit-node"); expect(next.setContextMenu).toHaveBeenCalledOnce();
  expect(view.committed.at(-1)).toBe(view.committed[0]);
});

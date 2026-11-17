import { applyEdgeChanges, applyNodeChanges, Position, ReactFlowProvider, type Edge, type Node, type ReactFlowInstance } from "@xyflow/react";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { CanvasSelectableReactFlow, TARGET_SELECTABLE_EXPERIMENT_ENABLED } from "./CanvasSelectableReactFlow";

const handles = [
  { type: "source" as const, position: Position.Bottom, x: 125, y: 151, width: 10, height: 10 },
  { type: "target" as const, position: Position.Top, x: 125, y: -5, width: 10, height: 10 }
];
const originalNodes: Node[] = [
  { id: "a", position: { x: 0, y: 0 }, width: 260, height: 156, measured: { width: 260, height: 156 }, data: { label: <input aria-label="Draft" defaultValue="Text" /> } },
  { id: "b", position: { x: 600, y: 0 }, width: 260, height: 156, measured: { width: 260, height: 156 }, data: { label: "Second" } }
].map(node => ({ ...node, handles }));
const originalEdges: Edge[] = [{ id: "edge", source: "a", target: "b" }];

function scene() {
  const nodeChanges = vi.fn(), edgeChanges = vi.fn(), init = vi.fn();
  function Probe({ allow = false, enabled = true, scope = "one", keyCode }: {
    allow?: boolean; enabled?: boolean; scope?: string; keyCode?: string;
  }) {
    const [nodes, setNodes] = useState(originalNodes), [edges, setEdges] = useState(originalEdges);
    return <CanvasSelectableReactFlow nodes={nodes} edges={edges} width={800} height={600}
      elementsSelectable={allow} selectionOnDrag={allow} selectionKeyCode={keyCode}
      selectionExperimentEnabled={enabled} selectionScopeKey={scope} onInit={init}
      onNodesChange={changes => { nodeChanges(changes); setNodes(current => applyNodeChanges(changes, current)); }}
      onEdgesChange={changes => { edgeChanges(changes); setEdges(current => applyEdgeChanges(changes, current)); }} />;
  }
  const tree = (props = {}) => <ReactFlowProvider><Probe {...props} /></ReactFlowProvider>;
  const view = render(tree());
  return { view, nodeChanges, edgeChanges, init, update: (props = {}) => view.rerender(tree(props)) };
}

it("prevents node/edge selection before the real keyboard handler, with no ghost after Select", async () => {
  const { view, nodeChanges, edgeChanges, update } = scene(); await act(async () => {});
  const node = view.getByTestId("rf__node-a"), other = view.getByTestId("rf__node-b");
  const edge = view.container.querySelector(".react-flow__edge")!;
  nodeChanges.mockClear(); edgeChanges.mockClear();
  for (const element of [node, edge]) {
    fireEvent.keyDown(element, { key: "Enter" });
    expect(element).not.toHaveClass("selected");
  }
  expect(nodeChanges.mock.calls.flat(2).some(change => change.type === "select")).toBe(false);
  expect(edgeChanges.mock.calls.flat(2).some(change => change.type === "select")).toBe(false);
  expect(other).toHaveClass("selectable");
  update({ allow: true });
  fireEvent.keyDown(node, { key: "Enter" });
  await waitFor(() => expect(node).toHaveClass("selected"));
  fireEvent.keyDown(edge, { key: "Enter" });
  await waitFor(() => expect(edge).toHaveClass("selected"));
  expect(originalNodes.every(row => row.selectable === undefined && row.selected === undefined)).toBe(true);
});

it("preserves native window Space/Escape delivery and editable input", async () => {
  const { view } = scene(); await act(async () => {});
  const received = vi.fn(); window.addEventListener("keydown", received);
  try {
    const node = view.getByTestId("rf__node-a");
    for (const key of [" ", "Escape"]) fireEvent.keyDown(node, { key, code: key === " " ? "Space" : key });
    const input = view.getByLabelText("Draft");
    fireEvent.focus(input); fireEvent.keyDown(input, { key: "ArrowRight" });
    fireEvent.change(input, { target: { value: "Edited" } });
    expect(input).toHaveValue("Edited"); expect(node).not.toHaveClass("selected");
    const other = view.getByTestId("rf__node-b");
    fireEvent.touchStart(other, { touches: [], changedTouches: [] });
    expect(other).not.toHaveClass("selectable"); expect(input).toHaveValue("Edited");
    expect(received).toHaveBeenCalledTimes(3);
  } finally { window.removeEventListener("keydown", received); }
});

it("uses original global selection policy during Shift and for unsupported selection keys", async () => {
  const { view, update } = scene(); await act(async () => {});
  const node = view.getByTestId("rf__node-a"), other = view.getByTestId("rf__node-b");
  fireEvent.keyDown(node, { key: "Shift", shiftKey: true });
  expect(node).not.toHaveClass("selectable"); expect(other).not.toHaveClass("selectable");
  fireEvent.keyUp(node, { key: "Shift", shiftKey: false });
  expect(other).toHaveClass("selectable");
  update({ keyCode: "Control" });
  expect(node).not.toHaveClass("selectable"); expect(other).not.toHaveClass("selectable");
});

it("keeps the engine instance and whole arrays across scopes and rollback", async () => {
  const { view, update, init } = scene(); await waitFor(() => expect(init).toHaveBeenCalledOnce());
  const node = view.getByTestId("rf__node-a"); fireEvent.keyDown(node, { key: "Enter" });
  update({ scope: "two" }); await act(async () => {});
  expect(node).toHaveClass("selectable");
  update({ enabled: false });
  expect(TARGET_SELECTABLE_EXPERIMENT_ENABLED).toBe(true);
  expect(node).not.toHaveClass("selectable");
  expect(init).toHaveBeenCalledOnce();
  const api = init.mock.calls[0]![0] as ReactFlowInstance;
  expect(api.getNodes()).toHaveLength(2); expect(api.getEdges()).toHaveLength(1);
  expect(view.container.querySelectorAll(".react-flow__node")).toHaveLength(2);
});

it("unknown graph targets fall back instead of relying on an unverified permission", async () => {
  const { view } = scene(); await act(async () => {});
  const stale = document.createElement("div"); stale.className = "react-flow__node"; stale.dataset.id = "stale";
  view.getByTestId("rf__node-a").append(stale);
  fireEvent.keyDown(stale, { key: "Enter" });
  expect(view.getByTestId("rf__node-a")).not.toHaveClass("selectable");
  expect(view.getByTestId("rf__node-b")).not.toHaveClass("selectable");
});

import { ConnectionMode, Position, ReactFlowProvider, useNodes, type Edge, type Node, type ReactFlowInstance } from "@xyflow/react";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { NarrativeNodeRenderData } from "../workspaceShared";
import { CanvasDomReactFlow } from "./CanvasDomReactFlow";
import { CanvasNodePresentation, CanvasNodePresentationBridge } from "./CanvasNodePresentation";
import { useReportDomMiniMapReady } from "./CanvasDomSafety";
import { NARRATIVE_NODE_TYPES, STORY_FLOW_EDGE_TYPES } from "./GraphCanvasParts";
import * as stores from "./nodePresentationStore";

afterEach(() => vi.restoreAllMocks());
const node = (id: string, x: number, extra: Partial<Node<NarrativeNodeRenderData>> = {}): Node<NarrativeNodeRenderData> => ({
  id, type: "narrative", position: { x, y: 0 }, width: 260, height: 156, measured: { width: 260, height: 156 },
  handles: [{ id: "right", type: "source", position: Position.Right, x: 255, y: 73, width: 10, height: 10 },
    { id: "left", type: "source", position: Position.Left, x: -5, y: 73, width: 10, height: 10 }],
  data: { title: id, label: id, kind: "Character", summary: "Authored text", tags: [] }, ...extra });
const initial = [node("near", 0), node("far", 10000)];
const edges: Edge[] = [{ id: "boundary", type: "relationship", source: "near", target: "far", sourceHandle: "right", targetHandle: "left", data: { label: "Boundary" } }];
const scope = { projectId: "owned", workspaceMode: "relationships" as const, flowId: null, focusedFrameId: null };

function MiniMapSafety({ ready }: { ready: boolean }) {
  useReportDomMiniMapReady(ready);
  const nodes = useNodes();
  return <output data-testid="whole-count">{nodes.length}</output>;
}

function scene(options: { enabled?: boolean; suspended?: boolean; ready?: boolean; nodes?: typeof initial;
  mode?: "relationships" | "flow"; onInit?: (api: ReactFlowInstance<Node<NarrativeNodeRenderData>>) => void;
  onPointerDown?: () => void } = {}) {
  const nodes = options.nodes ?? initial, mode = options.mode ?? "relationships";
  return <ReactFlowProvider initialWidth={1440} initialHeight={900}>
    <CanvasNodePresentation enabled detailEnabled={false} workspaceMode={mode}>
      <CanvasDomReactFlow width={1440} height={900} nodes={nodes} edges={edges} nodeTypes={NARRATIVE_NODE_TYPES} edgeTypes={STORY_FLOW_EDGE_TYPES}
        connectionMode={ConnectionMode.Loose} domVirtualizationEnabled={options.enabled}
        domVirtualizationSuspended={options.suspended} onInit={options.onInit}
        onPointerDownCapture={options.onPointerDown}>
        <CanvasNodePresentationBridge nodes={nodes} scope={{ ...scope, workspaceMode: mode }} resetKey="doc" protectedOwnerIds={[]} edges={edges} />
        <MiniMapSafety ready={options.ready ?? true} />
      </CanvasDomReactFlow>
    </CanvasNodePresentation>
  </ReactFlowProvider>;
}

it("defaults Off without aggregate subscriptions and preserves original engine records", async () => {
  const original = stores.createNodePresentationStore;
  const subscribe = vi.fn();
  vi.spyOn(stores, "createNodePresentationStore").mockImplementation(() => {
    const store = original();
    const inner = store.reader.subscribeDom;
    store.reader.subscribeDom = (...args) => { subscribe(); return inner(...args); };
    return store;
  });
  const view = render(scene());
  await waitFor(() => expect(view.container.querySelector('[data-id="far"] article')).toHaveAttribute("data-node-presentation", "shell"));
  expect(view.container.querySelectorAll(".react-flow__node")).toHaveLength(2);
  expect(subscribe).not.toHaveBeenCalled();
  expect(initial[1]!.hidden).toBeUndefined();
});

it("elides offscreen DOM only, keeping complete engine nodes, boundary route and whole MiniMap inputs", async () => {
  let api!: ReactFlowInstance<Node<NarrativeNodeRenderData>>;
  const view = render(scene({ enabled: true, onInit: value => { api = value; } }));
  await waitFor(() => expect(view.container.querySelector('[data-id="far"]')).toBeNull());
  expect(view.container.querySelector('[data-id="near"]')).not.toBeNull();
  expect(view.getByTestId("whole-count")).toHaveTextContent("2");
  expect(api.getNodes().map(n => ({ id: n.id, position: n.position, width: n.width, height: n.height, data: n.data })))
    .toEqual(initial.map(n => ({ id: n.id, position: n.position, width: n.width, height: n.height, data: n.data })));
  expect(api.getEdges()).toHaveLength(1);
  const path = view.container.querySelector(".react-flow__edge-path")?.getAttribute("d");
  expect(path).toBeTruthy();
  await act(async () => { await api.setViewport({ x: -10000, y: 0, zoom: 1 }); });
  await waitFor(() => expect(view.container.querySelector('[data-id="far"]')).not.toBeNull());
  await waitFor(() => expect(view.container.querySelector('[data-id="near"]')).toBeNull());
  expect(view.container.querySelector(".react-flow__edge-path")?.getAttribute("d")).toBe(path);
  expect(initial.every(n => n.hidden === undefined)).toBe(true);
});

it("falls back full for dialog, MiniMap fallback, Flow and selected offscreen owners", async () => {
  const view = render(scene({ enabled: true }));
  await waitFor(() => expect(view.container.querySelector('[data-id="far"]')).toBeNull());
  for (const fallback of [{ suspended: true }, { ready: false }, { mode: "flow" as const },
    { nodes: [initial[0]!, { ...initial[1]!, selected: true }] }]) {
    view.rerender(scene({ enabled: true, ...fallback }));
    await waitFor(() => expect(view.container.querySelectorAll(".react-flow__node")).toHaveLength(2));
  }
});

it("suspends on native input/focus and restores Off without resetting the engine", async () => {
  const init = vi.fn(), pointer = vi.fn();
  const view = render(scene({ enabled: true, onInit: init, onPointerDown: pointer }));
  await waitFor(() => expect(view.container.querySelector('[data-id="far"]')).toBeNull());
  const root = view.container.querySelector(".react-flow")!;
  fireEvent.pointerDown(root);
  expect(pointer).toHaveBeenCalledOnce();
  expect(view.container.querySelectorAll(".react-flow__node")).toHaveLength(2);
  fireEvent.pointerUp(window);
  await waitFor(() => expect(view.container.querySelector('[data-id="far"]')).toBeNull());
  const article = view.container.querySelector("article")!;
  fireEvent.focus(article);
  expect(view.container.querySelectorAll(".react-flow__node")).toHaveLength(2);
  fireEvent.blur(article, { relatedTarget: document.body });
  await waitFor(() => expect(view.container.querySelector('[data-id="far"]')).toBeNull());
  view.rerender(scene({ enabled: false, onInit: init, onPointerDown: pointer }));
  expect(view.container.querySelectorAll(".react-flow__node")).toHaveLength(2);
  expect(init).toHaveBeenCalledOnce();
});

import React from "react";
import { createRoot } from "react-dom/client";
import { ReactFlow, ReactFlowProvider, type Node, type ReactFlowInstance } from "@xyflow/react";
import { CanvasNodePresentation, CanvasNodePresentationBridge } from "../src/app/graph/CanvasNodePresentation";
import { NARRATIVE_NODE_TYPES } from "../src/app/graph/GraphCanvasParts";
import type { NarrativeNodeRenderData } from "../src/app/workspaceShared";
import "@xyflow/react/dist/style.css";
import "../src/styles.css";

const scope = { projectId: "owned-detail-component", workspaceMode: "relationships" as const, flowId: null, focusedFrameId: null };
const nodes: Node<NarrativeNodeRenderData>[] = Array.from({ length: 8 }, (_, i) => ({
  id: `detail-${i}`, type: "narrative", parentId: i ? `detail-${i - 1}` : undefined, position: { x: i ? 20 : 0, y: i ? 70 : 0 },
  width: i === 7 ? 260 : 1800 - i * 220, height: i === 7 ? 156 : 1500 - i * 170,
  data: { kind: i === 0 ? "Scene" : i === 7 ? "Lore" : "Location", isFrame: i < 7, isLinkedInstance: i === 7,
    title: `Detail ${i}`, label: `Detail ${i}`, summary: `Owned component text ${i}`, tags: [], onFocusFrame: i < 7 ? () => {} : undefined }
}));

/** Component-only native zoom proof; public React Flow API, no runtime/project or app-state hook. */
export function mount(zoom: number) {
  const host = document.createElement("div"); host.style.cssText = "position:absolute;inset:0"; document.body.append(host);
  const root = createRoot(host); let api: ReactFlowInstance<Node<NarrativeNodeRenderData>> | null = null;
  const viewport = { zoom, x: innerWidth / 2 - 270 * zoom, y: innerHeight / 2 - 568 * zoom };
  const render = (detailEnabled: boolean) => root.render(<ReactFlowProvider>
    <CanvasNodePresentation enabled={false} detailEnabled={detailEnabled}>
      <ReactFlow nodes={nodes} nodeTypes={NARRATIVE_NODE_TYPES} minZoom={0.01} maxZoom={10} defaultViewport={viewport} onInit={(value) => { api = value; }}>
        <CanvasNodePresentationBridge nodes={nodes} scope={scope} resetKey={1} protectedOwnerIds={[]} />
      </ReactFlow>
    </CanvasNodePresentation>
  </ReactFlowProvider>);
  render(true);
  return { full: () => render(false), ready: () => Boolean(api), dispose: () => { root.unmount(); host.remove(); } };
}

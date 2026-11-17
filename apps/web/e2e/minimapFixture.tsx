import React from "react";
import { createRoot } from "react-dom/client";
import { ReactFlow, ReactFlowProvider, type Node, type ReactFlowInstance } from "@xyflow/react";
import { CanvasMiniMap } from "../src/app/graph/CanvasMiniMap";
import { setMiniMapExperimentEnabled } from "../src/app/graph/canvasRenderingExperiment";
import "@xyflow/react/dist/style.css";
import "../src/styles.css";

const graph: Node[] = [
  { id: "scene", position: { x: -1000, y: -500 }, width: 3000, height: 2000, data: { label: "Scene" } },
  { id: "location", parentId: "scene", position: { x: 100, y: 100 }, width: 1000, height: 1000, data: { label: "Location" } },
  { id: "linked", parentId: "location", position: { x: 100, y: 100 }, width: 200, height: 100, data: { label: "Linked instance" } },
  ...Array.from({ length: 997 }, (_, i) => ({ id: `node-${i}`, position: { x: i % 40 * 100, y: Math.floor(i / 40) * 100 }, width: 100, height: 60, data: { label: `Node ${i}` } })),
  { id: "far", position: { x: 10000, y: 10000 }, width: 500, height: 300, selected: true, data: { label: "Distant" } }
];

/** Owned native component fixture: public React Flow commands only; no project session. */
export function mount(zoom: number) {
  const host = document.createElement("div"); host.style.cssText = "position:absolute;inset:0"; document.body.append(host);
  const root = createRoot(host); let api: ReactFlowInstance | null = null;
  setMiniMapExperimentEnabled(true);
  root.render(<ReactFlowProvider><ReactFlow defaultNodes={graph} minZoom={0.01} maxZoom={10} defaultViewport={{ x: 0, y: 0, zoom }}
    onInit={(value) => { api = value; }}><CanvasMiniMap /></ReactFlow></ReactFlowProvider>);
  return { ready: () => Boolean(api), viewport: () => api!.getViewport(), nodes: () => api!.getNodes(),
    rollback: () => setMiniMapExperimentEnabled(false), dispose: () => { root.unmount(); host.remove(); } };
}

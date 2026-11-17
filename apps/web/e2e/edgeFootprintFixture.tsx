import React from "react";
import { createRoot } from "react-dom/client";
import { MarkerType, ReactFlow, ReactFlowProvider, type ReactFlowInstance, type Edge } from "@xyflow/react";
import { CanvasEdgeGeometryBridge } from "../src/app/graph/CanvasEdgeGeometryBridge";
import { STORY_FLOW_EDGE_TYPES } from "../src/app/graph/GraphCanvasParts";
import type { EdgeDomObservationSnapshot } from "../src/app/graph/edgeDomObservation";

const scope = { projectId: "owned-geometry-fixture", workspaceMode: "relationships" as const, flowId: null, focusedFrameId: null };
const nodes = [
  { id: "a", position: { x: 50, y: 100 }, data: { label: "Source" }, width: 100, height: 40 },
  { id: "b", position: { x: 650, y: 300 }, data: { label: "Target" }, width: 100, height: 40 }
];
const edges: Edge[] = [
  { id: "labelled", source: "a", target: "b", type: "relationship", label: "Current clipped relationship label" },
  { id: "absent", source: "b", target: "a", type: "relationship" },
  { id: "arc", source: "b", target: "a", type: "storyFlow", data: { label: "Return", flowRouteArc: true } }
].map((edge) => ({ ...edge, markerEnd: { type: MarkerType.ArrowClosed, color: "#475569" }, style: { strokeWidth: 3 } }));

/** Owned blank-page harness: real public portal/edge rendering, no runtime or project sessions. */
export function mount() {
  let api: ReactFlowInstance | null = null, latest: EdgeDomObservationSnapshot | null = null, publications = 0;
  const host = document.createElement("div"); host.style.cssText = "width:100%;height:100%;position:absolute;inset:0"; document.body.append(host);
  const root = createRoot(host);
  root.render(<ReactFlowProvider><ReactFlow nodes={nodes} edges={edges} edgeTypes={STORY_FLOW_EDGE_TYPES}
    minZoom={0.01} maxZoom={10} onInit={(value) => { api = value; }}>
    <CanvasEdgeGeometryBridge edges={edges} scope={scope} resetKey={1} enabled onMeasured={(value) => { latest = value; if (value) publications++; }} />
  </ReactFlow></ReactFlowProvider>);
  return {
    viewport: (zoom: number, x = 0, y = 0) => api?.setViewport({ zoom, x, y }),
    read: () => latest ? { edges: latest.footprints.edges, eligible: [...latest.eligibility.eligibleIds],
      unknown: [...latest.eligibility.unknownGeometryIds], publications } : null,
    unmount: () => { root.unmount(); host.remove(); }
  };
}

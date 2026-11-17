export const PROTECTED_BOUNDARY_SUITE = "viewport_standalone_scene_boundary_v1";
export const BOUNDARY_VARIANT = "standalone_scene_boundary_v1";
const gate = (condition) => { if (!condition) throw new Error("protected_flow_boundary_failed"); };

/** Resolve an original standalone boundary, never a surrogate transition. */
export function standaloneBoundaryTarget(document) {
  const main = document.story_flows.find((flow) => flow.kind === "main");
  const boundary = document.scene_flow_boundaries.find((row) => row.flow_id === main?.id);
  gate(boundary && !document.flow_transitions.some((row) => row.flow_id === boundary.flow_id
    && row.source_node_id === boundary.scene_node_id && row.target_node_id === boundary.entry_node_id));
  return { id: `story-boundary:${boundary.id}`, flowId: boundary.flow_id,
    source: boundary.scene_node_id, target: boundary.entry_node_id };
}

/** Public painted SVG marker and HTML label; runs inside page.evaluate. */
export function readBoundaryPaint(target) {
  const edges = [...document.querySelectorAll(".react-flow__edge")].filter((edge) => edge.dataset.id === target.id);
  const markerUrl = edges[0]?.querySelector(".react-flow__edge-path")?.getAttribute("marker-end");
  const marker = [...document.querySelectorAll("marker")].find((item) =>
    [`url(#${item.id})`, `url('#${item.id}')`, `url("#${item.id}")`].includes(markerUrl));
  return { edges: edges.length, arrow: Boolean(marker?.querySelector("path, polyline, polygon")),
    labels: [...document.querySelectorAll(".story-flow-edge-label")].filter((label) => label.textContent.trim() === "Scene entry").length };
}

/** Curve endpoints must still meet the original four-port cards in world units. */
export function verifyBoundarySnapshot(layout, target, paint, active = true) {
  const geometry = layout.geometry;
  const edges = geometry.edges.filter((edge) => edge.id === target.id);
  if (!active) {
    gate(edges.length === 0 && paint.edges === 0 && paint.labels === 0);
    return { absent_outside_scope: true };
  }
  gate(edges.length === 1 && paint.edges === 1 && paint.arrow && paint.labels === 1);
  gate(geometry.labels.filter((label) => label.text === "Scene entry").length === 1);
  const curve = geometry.curves.filter((edge) => edge.id === target.id);
  gate(curve.length === 1 && curve[0].points.length === 65);
  for (const [id, portId, point] of [[target.source, "right", curve[0].points[0]], [target.target, "left", curve[0].points[64]]]) {
    const nodes = geometry.nodes.filter((node) => node.id === id);
    gate(nodes.length === 1 && nodes[0].handles.length === 4
      && new Set(nodes[0].handles.map((port) => port.id)).size === 4
      && nodes[0].handles.every((port) => ["top", "right", "bottom", "left"].includes(port.id)));
    const bounds = nodes[0].handles.find((port) => port.id === portId)?.bounds;
    gate(bounds?.length === 4 && bounds.every(Number.isFinite) && bounds[2] > 0 && bounds[3] > 0
      && point?.every(Number.isFinite) && point[0] >= bounds[0] - 0.05 && point[0] <= bounds[0] + bounds[2] + 0.05
      && point[1] >= bounds[1] - 0.05 && point[1] <= bounds[1] + bounds[3] + 0.05);
  }
  return { original_route: true, arrow: true, unique_label: true, original_endpoint_ports: true };
}

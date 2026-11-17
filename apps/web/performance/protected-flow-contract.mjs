import { compareCardLayouts } from "./viewport-cards-contract.mjs";

export const PROTECTED_FLOW_SUITE = "viewport_protected_flow_scopes_v1";
export const FLOW_STAGES = ["main_fit", "main_panned", "main_restored", "side_fit", "main_reentered"];
const gate = (condition) => { if (!condition) throw new Error("protected_flow_scope_failed"); };

/** Public scope identities only; traversal/layout algorithms remain with the application. */
export function flowScopeRecords(document, flowId) {
  const canonical = new Set(document.nodes.map((node) => node.id));
  const flows = new Map(document.story_flows.map((flow) => [flow.id, flow]));
  gate(flows.has(flowId));
  const ids = new Set(document.story_flow_nodes.filter((member) => member.flow_id === flowId).map((member) => member.node_id));
  gate(ids.size > 0 && [...ids].every((id) => canonical.has(id)));
  const invocations = document.flow_invocations.filter((call) => call.source_flow_id === flowId);
  for (const call of invocations) {
    const entry = flows.get(call.target_flow_id)?.entry_node_id;
    if (entry && canonical.has(entry)) ids.add(entry);
  }
  const transitions = document.flow_transitions.filter((transition) => transition.flow_id === flowId);
  const edges = transitions.filter((transition) => ids.has(transition.source_node_id) && ids.has(transition.target_node_id))
    .map((transition) => `story-flow:${transition.id}`);
  for (const boundary of document.scene_flow_boundaries.filter((item) => item.flow_id === flowId)) {
    if (ids.has(boundary.scene_node_id) && ids.has(boundary.entry_node_id)
      && !transitions.some((transition) => transition.source_node_id === boundary.scene_node_id && transition.target_node_id === boundary.entry_node_id)) {
      edges.push(`story-boundary:${boundary.id}`);
    }
  }
  for (const call of invocations) {
    const entry = flows.get(call.target_flow_id)?.entry_node_id;
    if (ids.has(call.source_node_id) && entry && ids.has(entry)) edges.push(`flow-invocation:${call.id}`);
  }
  return { nodeIds: [...ids].sort(), edgeIds: edges.sort() };
}

/** Reject stale scope/alias membership and lost DOM geometry before comparing modes. */
export function verifyFlowScope(layout, expected, enabled) {
  const nodes = layout?.geometry?.nodes, edges = layout?.geometry?.edges;
  gate(Array.isArray(nodes) && Array.isArray(edges));
  gate(nodes.length === expected.nodeIds.length && new Set(nodes.map((node) => node.id)).size === nodes.length
    && nodes.every((node) => expected.nodeIds.includes(node.id)));
  gate(edges.length === expected.edgeIds.length && new Set(edges.map((edge) => edge.id)).size === edges.length
    && edges.every((edge) => expected.edgeIds.includes(edge.id) && typeof edge.path === "string" && edge.path.startsWith("M") && !/NaN|Infinity/.test(edge.path)));
  // Preserve historical raw SVG-shape counts. A bounded raster must explicitly
  // prove complete scope coverage instead of pretending it painted one shape per node.
  const mini = layout.minimap_coverage;
  const overviewComplete = mini ? layout.counts.minimap === 0 && mini.represented_nodes === nodes.length
    && mini.cells > 0 && mini.cells <= 512 && mini.dom === 3 : layout.counts.minimap === nodes.length;
  gate(layout.counts.wrappers === nodes.length && layout.counts.handles === nodes.length * 4
    && overviewComplete && layout.counts.edges === edges.length && layout.counts.labels === edges.length
    && layout.visible_shells === 0 && layout.invalid_handle_bounds === 0 && (enabled || layout.counts.shells === 0));
  const rectangle = (bounds) => Array.isArray(bounds) && bounds.length === 4 && bounds.every(Number.isFinite) && bounds[2] > 0 && bounds[3] > 0;
  for (const node of nodes) {
    gate(rectangle(node.bounds) && rectangle(node.card) && node.handles.length === 4
      && new Set(node.handles.map((port) => port.id)).size === 4
      && node.handles.every((port) => ["top", "right", "bottom", "left"].includes(port.id) && rectangle(port.bounds)));
  }
  gate(layout.geometry.labels.length === edges.length && layout.geometry.labels.every((label) => typeof label.text === "string" && label.text.length > 0 && rectangle(label.bounds)));
  gate(normalizedGeometry(layout) !== null);
  return { wrappers: nodes.length, handles: nodes.length * 4, edges: edges.length, labels: edges.length,
    shells: layout.counts.shells, exact_scope_membership: true };
}

/** Match actual curves and the complete label multiset, not SVG command spelling or portal insertion order. */
function normalizedGeometry(layout) {
  const curves = layout?.geometry?.curves, edges = layout?.geometry?.edges, labels = layout?.geometry?.labels;
  if (!Array.isArray(curves) || !Array.isArray(edges) || !Array.isArray(labels)
    || curves.length !== edges.length || new Set(curves.map((curve) => curve.id)).size !== curves.length
    || new Set(edges.map((edge) => edge.id)).size !== edges.length) return null;
  const ids = new Set(edges.map((edge) => edge.id));
  if (!curves.every((curve) => ids.has(curve.id) && Number.isFinite(curve.length) && curve.length >= 0
    && Array.isArray(curve.points) && curve.points.length === 65
    && curve.points.every((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)))
    || !labels.every((label) => typeof label.text === "string" && Array.isArray(label.bounds)
      && label.bounds.length === 4 && label.bounds.every(Number.isFinite))) return null;
  const byId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const byLabel = (a, b) => a.text < b.text ? -1 : a.text > b.text ? 1 : a.bounds.reduce((delta, value, index) => delta || value - b.bounds[index], 0);
  return { ...layout, geometry: { ...layout.geometry,
    edges: edges.map(({ id }) => ({ id })).sort(byId), curves: [...curves].sort(byId), labels: [...labels].sort(byLabel) } };
}

export function compareFlowGeometry(reference, candidate) {
  const before = normalizedGeometry(reference), after = normalizedGeometry(candidate);
  return before && after ? compareCardLayouts(before, after)
    : { equal: false, mismatches: 1, max_numeric_delta: 0, tolerance_world: 0.05 };
}

/** A fixed complete stage set prevents empty or partially failed matrices passing as equal. */
export function compareFlowScopes(reference, candidate) {
  for (const value of [reference, candidate]) gate(value && Object.keys(value).length === FLOW_STAGES.length
    && FLOW_STAGES.every((stage) => Object.hasOwn(value, stage)));
  return Object.fromEntries(FLOW_STAGES.map((stage) => [stage, compareFlowGeometry(reference[stage], candidate[stage])]));
}

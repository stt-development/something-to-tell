import { compareCardLayouts } from "./viewport-cards-contract.mjs";

export const PROTECTED_EXTREMES_SUITE = "viewport_protected_zoom_extremes_v1";
export const EXTREME_STAGES = ["graph", "flow"].flatMap((mode) =>
  ["fit", "min", "max_selected", "max_focused", "max_blurred", "recovered"].map((stage) => `${mode}_${stage}`));
const gate = (condition) => { if (!condition) throw new Error("protected_extremes_geometry_failed"); };

/** Card/port geometry and complete route/label identities, not SVG curve equality across zooms. */
export function compareExtremeGeometry(reference, candidate, camera = true) {
  const view = (value) => value?.geometry ? { ...value, geometry: {
    ...(camera ? { camera: value.geometry.camera } : {}), nodes: value.geometry.nodes,
    edges: value.geometry.edges?.map((edge) => edge.id).sort(),
    labels: value.geometry.labels?.map((label) => label.text).sort()
  } } : value;
  return compareCardLayouts(view(reference), view(candidate));
}

/** Every native endpoint must retain finite measured bodies, original ports and current membership. */
export function verifyExtremeSnapshot(baseline, current, zoom, enabled) {
  gate([0.01, 10].includes(zoom) && Array.isArray(current?.geometry?.camera)
    && current.geometry.camera.length === 3 && current.geometry.camera.every(Number.isFinite)
    && Math.abs(current.geometry.camera[2] - zoom) <= 1e-8);
  gate(current.visible_shells === 0 && current.invalid_handle_bounds === 0 && (enabled || current.counts.shells === 0));
  const rectangle = (value) => Array.isArray(value) && value.length === 4 && value.every(Number.isFinite) && value[2] > 0 && value[3] > 0;
  const nodes = current.geometry.nodes;
  gate(nodes.length > 0 && nodes.length === current.counts.wrappers && current.counts.handles === nodes.length * 4
    && new Set(nodes.map((node) => node.id)).size === nodes.length);
  for (const node of nodes) gate(rectangle(node.bounds) && rectangle(node.card) && node.handles.length === 4
    && new Set(node.handles.map((port) => port.id)).size === 4
    && node.handles.every((port) => ["left", "right", "top", "bottom"].includes(port.id) && rectangle(port.bounds)));
  gate(current.geometry.edges.length === current.counts.edges && new Set(current.geometry.edges.map((edge) => edge.id)).size === current.counts.edges
    && current.geometry.edges.every((edge) => typeof edge.path === "string" && edge.path.startsWith("M") && !/NaN|Infinity/.test(edge.path)));
  gate(current.geometry.labels.length === current.counts.labels && current.geometry.labels.every((label) => typeof label.text === "string" && rectangle(label.bounds)));
  const geometry = compareExtremeGeometry(baseline, current, false);
  gate(geometry.equal);
  return { zoom, wrappers: nodes.length, handles: current.counts.handles, edges: current.counts.edges,
    labels: current.counts.labels, minimap: current.counts.minimap, shells: current.counts.shells, geometry };
}

/** A full matrix must include both modes, both endpoints, focus release and Fit recovery. */
export function compareExtremeCases(reference, candidate) {
  for (const value of [reference, candidate]) gate(value && Object.keys(value).length === EXTREME_STAGES.length
    && EXTREME_STAGES.every((stage) => Object.hasOwn(value, stage)));
  return Object.fromEntries(EXTREME_STAGES.map((stage) => [stage, compareExtremeGeometry(reference[stage], candidate[stage])]));
}

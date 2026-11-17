import { sameFixtureValue } from "./protected-document-contract.mjs";

export const PROTECTED_LINKED_SUITE = "viewport_protected_graph_linked_v1";
const gate = (condition) => { if (!condition) throw new Error("protected_linked_readback_failed"); };

/** Resolve existing canonical/visual identities without relying on repeated titles. */
export function linkedFixtureTargets(document) {
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  const linked = document.placements.find((p) => !p.is_primary && nodes.get(p.canonical_node_id)?.type === "Character"
    && nodes.get(p.container_node_id)?.type === "Scene"
    && document.placements.some((primary) => primary.is_primary && primary.canonical_node_id === p.canonical_node_id && primary.container_node_id === null));
  const unplaced = document.nodes.find((node) => node.type === "Lore" && !document.placements.some((p) => p.canonical_node_id === node.id));
  gate(Boolean(linked && unplaced));
  return { canonical: nodes.get(linked.canonical_node_id), scene: nodes.get(linked.container_node_id),
    linkedId: `placement:${linked.id}`, unplaced };
}

/** Camera changes and scope round trips must preserve original world card/port geometry. */
export function verifyLinkedGeometry(baseline, current, id, tolerance = 0.05) {
  gate(Number.isFinite(tolerance) && tolerance >= 0);
  gate(Array.isArray(baseline?.geometry?.nodes) && Array.isArray(current?.geometry?.nodes));
  const find = (value) => value.geometry.nodes.filter((node) => node.id === id);
  const before = find(baseline), after = find(current);
  gate(before.length === 1 && after.length === 1);
  const rectangle = (a, b) => gate(Array.isArray(a) && Array.isArray(b) && a.length === 4 && b.length === 4
    && a.every((value, index) => Number.isFinite(value) && Number.isFinite(b[index]) && Math.abs(value - b[index]) <= tolerance));
  rectangle(before[0].bounds, after[0].bounds); rectangle(before[0].card, after[0].card);
  gate(before[0].handles.length === 4 && after[0].handles.length === 4);
  const ports = new Map(before[0].handles.map((handle) => [handle.id, handle.bounds]));
  gate(ports.size === 4 && new Set(after[0].handles.map((handle) => handle.id)).size === 4);
  for (const handle of after[0].handles) rectangle(ports.get(handle.id), handle.bounds);
  return true;
}

/** Closing an unsaved editor draft must not publish any authored document change. */
export function verifyLinkedDocument(before, after) {
  gate(typeof before?.manifest?.project_id === "string" && Array.isArray(before.nodes) && Array.isArray(before.placements));
  gate(sameFixtureValue(before, after));
  return true;
}

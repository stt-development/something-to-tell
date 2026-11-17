import { preservesBaselineDocument, sameFixtureValue } from "./protected-document-contract.mjs";

export const PROTECTED_CONNECTIONS_SUITE = "viewport_protected_graph_connections_v1";
const requireGate = (condition) => { if (!condition) throw new Error("protected_connections_readback_failed"); };
const tags = ["engine_tags", "engine_tag_definitions", "engine_tag_bindings"];

/** Verify stable edge/port identity through the public document, not a rendered curve. */
export function verifyProtectedConnections(before, created, connected, labeled, reconnected, deleted, ids, label) {
  requireGate(ids.length === 3 && new Set(ids).size === 3 && ids.every((id) => !before.nodes.some((node) => node.id === id)));
  requireGate(preservesBaselineDocument(before, created, ["nodes", ...tags]) && created.nodes.length === before.nodes.length + 3
    && ids.every((id) => created.nodes.some((node) => node.id === id)));
  const added = (current) => current.edges.filter((edge) => !created.edges.some((original) => original.id === edge.id));
  for (const current of [connected, labeled, reconnected, deleted]) {
    requireGate(preservesBaselineDocument(created, current, ["edges", ...tags]) && sameFixtureValue(current.nodes, created.nodes)
      && sameFixtureValue(current.placements, created.placements));
  }
  const stages = [connected, labeled, reconnected].map((current) => {
    const edges = added(current); requireGate(edges.length === 1); return edges[0];
  });
  requireGate(stages.every((edge) => edge.id === stages[0].id && edge.source_node_id === ids[0]
    && edge.metadata?.sourceHandle === "right" && edge.metadata?.targetHandle === "left"));
  requireGate(stages[0].target_node_id === ids[1] && stages[1].target_node_id === ids[1] && stages[2].target_node_id === ids[2]
    && stages[1].label === label && stages[2].label === label && added(deleted).length === 0
    && sameFixtureValue(deleted.edges, created.edges));
  return { baseline_nodes: before.nodes.length, canary_nodes: 3, baseline_collections_preserved: true,
    nodes_and_geometry_unchanged: true, same_edge_identity: true, source_port_preserved: true,
    target_port_verified: true, label_persisted: true, new_target_persisted: true, detached_edge_deleted: true };
}

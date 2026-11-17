import { preservesBaselineDocument, sameFixtureValue } from "./protected-document-contract.mjs";

export const PROTECTED_AUTHORING_SUITE = "viewport_protected_graph_authoring_v1";
const requireGate = (condition) => { if (!condition) throw new Error("protected_authoring_readback_failed"); };
const geometry = (placement) => ({ x: placement.x, y: placement.y, width: placement.width, height: placement.height,
  container: placement.container_node_id, placementId: placement.id ?? null });
const growing = ["nodes", "placements", "engine_tags", "engine_tag_definitions", "engine_tag_bindings"];

/** Compare complete public read-backs, never infer persistence from moved DOM. */
export function verifyProtectedAuthoring(before, created, moved, resized, edited, ids, text) {
  requireGate(ids.length === 3 && new Set(ids).size === 3 && ids.every((id) => !before.nodes.some((node) => node.id === id)));
  for (const current of [created, moved, resized, edited]) {
    requireGate(preservesBaselineDocument(before, current, growing));
    requireGate(current.nodes.length === before.nodes.length + 3);
    const baselineIds = new Set(before.placements.map((placement) => placement.id));
    requireGate(current.placements.filter((placement) => !baselineIds.has(placement.id))
      .every((placement) => ids.includes(placement.canonical_node_id) && placement.is_primary && placement.container_node_id === null));
  }
  const placements = (document) => ids.map((id) => {
    const matches = document.placements.filter((placement) => placement.canonical_node_id === id && placement.is_primary);
    requireGate(matches.length <= 1);
    if (matches.length) return geometry(matches[0]);
    // Newly created root cards use persisted node metadata until their first
    // move creates a placement through the existing legacy-compatible path.
    const metadata = document.nodes.find((node) => node.id === id)?.metadata;
    requireGate(metadata && Number.isFinite(metadata.position?.x) && Number.isFinite(metadata.position?.y)
      && Number.isFinite(metadata.width) && Number.isFinite(metadata.height));
    return geometry({ ...metadata.position, width: metadata.width, height: metadata.height, container_node_id: null });
  });
  const initial = placements(created), group = placements(moved), size = placements(resized), final = placements(edited);
  const dx = group[0].x - initial[0].x, dy = group[0].y - initial[0].y;
  requireGate(dx > 0.5 && dy > 0.5 && Math.abs(group[1].x - initial[1].x - dx) < 1e-6
    && Math.abs(group[1].y - initial[1].y - dy) < 1e-6 && sameFixtureValue(group[2], initial[2]));
  requireGate(size[0].width > group[0].width && size[0].height > group[0].height
    && size[0].x === group[0].x && size[0].y === group[0].y && size[0].container === group[0].container
    && size[0].placementId === group[0].placementId && group[0].placementId && group[1].placementId
    && sameFixtureValue(size[1], group[1]) && sameFixtureValue(size[2], group[2]) && sameFixtureValue(final, size));
  requireGate(edited.nodes.find((node) => node.id === ids[0])?.summary === text);
  for (const id of ids.slice(1)) requireGate(edited.nodes.find((node) => node.id === id)?.summary === created.nodes.find((node) => node.id === id)?.summary);
  return { canary_nodes: 3, baseline_nodes: before.nodes.length, baseline_collections_preserved: true,
    same_group_delta: true, unselected_placement_unchanged: true, resize_isolated: true, text_persisted: true };
}

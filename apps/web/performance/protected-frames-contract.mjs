export const PROTECTED_FRAMES_SUITE = "viewport_protected_graph_frames_v1";
const gate = (condition) => { if (!condition) throw new Error("protected_frames_geometry_failed"); };
const visualId = (placement) => placement.is_primary ? placement.canonical_node_id : `placement:${placement.id}`;

/** Expected visual membership from public placement ancestry, never rendered titles. */
export function frameScopeIds(document, frameId) {
  const primary = new Map(document.placements.filter((p) => p.is_primary).map((p) => [p.canonical_node_id, p]));
  gate(primary.has(frameId));
  const result = [];
  for (const placement of document.placements) {
    let current = placement, included = false;
    const seen = new Set();
    while (current) {
      gate(!seen.has(current.id)); seen.add(current.id);
      if (visualId(current) === frameId) included = true;
      if (current.container_node_id == null) break;
      current = primary.get(current.container_node_id); gate(Boolean(current));
    }
    if (included) result.push(visualId(placement));
  }
  return result.sort();
}

/** World geometry translates at the focus root; authored sizes/ports must not change. */
export function verifyFocusedFrameLayout(baseline, focused, frameId, ids, enabled, tolerance = 0.05) {
  gate(Number.isFinite(tolerance) && tolerance >= 0);
  const expected = new Set(ids), actual = focused?.geometry?.nodes;
  gate(expected.size === ids.length && expected.has(frameId) && Array.isArray(actual));
  gate(actual.length === expected.size && new Set(actual.map((node) => node.id)).size === expected.size
    && actual.every((node) => expected.has(node.id)));
  gate(focused.counts.wrappers === expected.size && focused.counts.handles === expected.size * 4
    && focused.visible_shells === 0 && focused.invalid_handle_bounds === 0
    && (enabled || focused.counts.shells === 0));
  const original = new Map(baseline.geometry.nodes.map((node) => [node.id, node]));
  const root = original.get(frameId); gate(Boolean(root));
  const translated = (before, after) => {
    gate(Array.isArray(before) && Array.isArray(after) && before.length === 4 && after.length === 4);
    const target = [before[0] - root.bounds[0], before[1] - root.bounds[1], before[2], before[3]];
    gate(target.every((value, index) => Number.isFinite(value) && Number.isFinite(after[index]) && Math.abs(value - after[index]) <= tolerance));
  };
  for (const node of actual) {
    const previous = original.get(node.id); gate(Boolean(previous));
    translated(previous.bounds, node.bounds); translated(previous.card, node.card);
    gate(node.handles.length === 4 && previous.handles.length === 4);
    const ports = new Map(previous.handles.map((handle) => [handle.id, handle.bounds]));
    gate(new Set(node.handles.map((handle) => handle.id)).size === 4);
    for (const handle of node.handles) translated(ports.get(handle.id), handle.bounds);
  }
  return { wrappers: actual.length, handles: actual.length * 4, exact_scope_membership: true, translated_geometry_preserved: true };
}

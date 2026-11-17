import type { Node } from "@xyflow/react";

/** Render-only copies. Never filter engine records or mutate the canonical graph. */
export function projectNodeDomVisibility<T extends Node>(nodes: T[], candidates: ReadonlySet<string>, enabled: boolean): T[] {
  if (!enabled || !candidates.size) return nodes;
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (byId.size !== nodes.length) return nodes;
  const protectedIds = new Set<string>();
  for (const node of nodes) {
    if (node.selected || node.dragging || node.resizing) protectedIds.add(node.id);
    if (node.parentId && !byId.has(node.parentId)) return nodes;
  }
  const validated = new Set<string>();
  for (const node of nodes) {
    const trail = new Set<string>();
    let current: T | undefined = node;
    while (current && !validated.has(current.id)) {
      if (trail.has(current.id)) return nodes;
      trail.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    for (const id of trail) validated.add(id);
  }
  for (const id of protectedIds) {
    const parent = byId.get(id)?.parentId;
    if (parent) protectedIds.add(parent);
  }
  let result: T[] | undefined;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    // A changed render copy must retain measured geometry, or React Flow resets
    // its endpoint bounds. Do not manufacture measurements or hide unknown sizes.
    if (!candidates.has(node.id) || node.hidden || protectedIds.has(node.id)
      || !Number.isFinite(node.width) || !Number.isFinite(node.height)
      || !node.width || !node.height || node.width < 0 || node.height < 0
      || node.measured?.width !== node.width || node.measured.height !== node.height) continue;
    result ??= nodes.slice();
    result[index] = { ...node, hidden: true };
  }
  return result ?? nodes;
}

import type { Node } from "@xyflow/react";
import { parentsBeforeChildren } from "../composition/layout";
import type { NarrativeNodeData } from "../types";

/** One hydration invocation owns depths; live drag/layout ordering keeps its existing owner. */
export function orderHydratedPlacements(nodes: Node<NarrativeNodeData>[]): Node<NarrativeNodeData>[] {
  const byId = new Map<string, Node<NarrativeNodeData>>();
  for (const node of nodes) {
    // Legacy find resolves the first duplicate; do not redefine that ambiguity here.
    if (byId.has(node.id)) return parentsBeforeChildren(nodes);
    byId.set(node.id, node);
  }
  const depths = new Map<string, number>();
  for (const node of nodes) {
    if (depths.has(node.id)) continue;
    const path: Node<NarrativeNodeData>[] = [], visiting = new Set<string>();
    let current: Node<NarrativeNodeData> | undefined = node;
    while (current && !depths.has(current.id)) {
      if (visiting.has(current.id)) return parentsBeforeChildren(nodes);
      visiting.add(current.id); path.push(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    for (let index = path.length - 1; index >= 0; index--) {
      const entry = path[index]!;
      // Legacy depth includes an unknown final parent once, even though it is not rendered.
      depths.set(entry.id, entry.parentId ? (depths.get(entry.parentId) ?? 0) + 1 : 0);
    }
  }
  // Native stable sort preserves the original order of siblings and linked placements.
  return [...nodes].sort((a, b) => depths.get(a.id)! - depths.get(b.id)!);
}

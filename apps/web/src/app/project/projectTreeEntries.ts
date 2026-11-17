import type { NarrativeNodeData } from "../../types";

/** View-only primary-placement preorder; linked parents resolve to their canonical owner. */
export function projectTreeEntries<TNode extends { data: NarrativeNodeData; id: string; parentId?: string }>(nodes: TNode[]) {
  const canonicalNodes = nodes.filter((node) => node.id === (node.data.canonicalNodeId ?? node.id));
  const byVisualId = new Map(nodes.map((node) => [node.id, node]));
  const byCanonicalId = new Map(canonicalNodes.map((node) => [node.data.canonicalNodeId ?? node.id, node]));
  const children = new Map<string, TNode[]>();
  const roots: TNode[] = [];
  for (const node of canonicalNodes) {
    const parentId = node.parentId;
    const parent = parentId ? byVisualId.get(parentId) : undefined;
    const parentCanonicalId = parent ? parent.data.canonicalNodeId ?? parent.id : undefined;
    if (parentCanonicalId && byCanonicalId.has(parentCanonicalId) && parentCanonicalId !== (node.data.canonicalNodeId ?? node.id)) {
      const bucket = children.get(parentCanonicalId);
      if (bucket) bucket.push(node);
      else children.set(parentCanonicalId, [node]);
    } else roots.push(node);
  }
  const entries: Array<{ depth: number; node: TNode }> = [];
  const visited = new Set<string>();
  const append = (node: TNode) => {
    const pending = [{ node, depth: 0 }];
    while (pending.length) {
      const entry = pending.pop()!;
      const canonicalId = entry.node.data.canonicalNodeId ?? entry.node.id;
      if (visited.has(canonicalId)) continue;
      visited.add(canonicalId);
      entries.push(entry);
      const descendants = children.get(canonicalId);
      // Reverse stack insertion preserves the old recursive sibling/input order.
      for (let index = (descendants?.length ?? 0) - 1; index >= 0; index--) {
        pending.push({ node: descendants![index]!, depth: entry.depth + 1 });
      }
    }
  };
  for (const root of roots) append(root);
  // Disconnected cycles retain the historical first-unvisited input fallback.
  for (const node of canonicalNodes) append(node);
  return entries;
}

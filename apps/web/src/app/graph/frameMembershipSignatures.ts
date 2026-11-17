import type { Node } from "@xyflow/react";
import type { NarrativeNodeData } from "../../types";

/** Invocation-local direct visual membership, not geometry or formatted header counts. */
export function buildFrameMembershipSignatures(
  nodes: readonly Node<NarrativeNodeData>[]
): ReadonlyMap<string, ReadonlyMap<string, NarrativeNodeData["kind"]>> {
  const byParent = new Map<string, Map<string, NarrativeNodeData["kind"]>>();
  for (const child of nodes) {
    const parentId = child.parentId;
    if (parentId === undefined) continue;
    let children = byParent.get(parentId);
    if (!children) {
      children = new Map();
      byParent.set(parentId, children);
    }
    // Match new Map(filter(...).map(...)): the last kind for a duplicate id wins.
    children.set(child.id, child.data.kind);
  }
  return byParent;
}

import type { Node } from "@xyflow/react";
import type { NarrativeNodeData } from "../types";

export interface FrameChildBounds {
  right: number;
  bottom: number;
}

/** Shared raw child-size rules; do not use recursively clamped frame outputs. */
function includeChild(bounds: FrameChildBounds, child: Node<NarrativeNodeData>): void {
  const { x, y } = child.position;
  bounds.right = Math.max(bounds.right, x + (child.width ?? 260));
  bounds.bottom = Math.max(bounds.bottom, y + (child.height ?? 156));
}

export function frameBoundsForChildren(children: readonly Node<NarrativeNodeData>[]): FrameChildBounds {
  const bounds = { right: 0, bottom: 0 };
  for (const child of children) includeChild(bounds, child);
  return bounds;
}

/** One invocation-local grouping by exact visual parent id, including hidden/linked children. */
export function buildFrameChildBounds(nodes: readonly Node<NarrativeNodeData>[]): ReadonlyMap<string, FrameChildBounds> {
  const byParent = new Map<string, FrameChildBounds>();
  for (const child of nodes) {
    const parentId = child.parentId;
    if (parentId === undefined) continue;
    let bounds = byParent.get(parentId);
    if (!bounds) {
      bounds = { right: 0, bottom: 0 };
      byParent.set(parentId, bounds);
    }
    includeChild(bounds, child);
  }
  return byParent;
}

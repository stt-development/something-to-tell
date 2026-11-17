import type { Node } from "@xyflow/react";
import type { NarrativeNodeData } from "../../types";
import { NODE_KINDS, type FrameContentCounts } from "../workspaceShared";

/** Shared formatter for raw direct-child records; duplicates count independently. */
export function countFrameChildren(children: readonly { data: Pick<NarrativeNodeData, "kind"> }[]): FrameContentCounts {
  const counts = new Map<NarrativeNodeData["kind"], number>();
  for (const child of children) counts.set(child.data.kind, (counts.get(child.data.kind) ?? 0) + 1);
  const unit = (value: number, kind: NarrativeNodeData["kind"]) => `${value} ${kind.toLocaleLowerCase()}${value === 1 ? "" : "s"}`;
  return {
    tooltip: NODE_KINDS.flatMap((kind) => counts.has(kind) ? [unit(counts.get(kind)!, kind)] : []).join(", ") || "No placements",
    total: children.length
  };
}

/** Invocation-local input grouping, never a retained raw graph or deduplicated signature. */
export function buildFrameCountInputs(
  nodes: readonly Node<NarrativeNodeData>[]
): ReadonlyMap<string, readonly Node<NarrativeNodeData>[]> {
  const byParent = new Map<string, Node<NarrativeNodeData>[]>();
  for (const child of nodes) {
    const parentId = child.parentId;
    if (parentId === undefined) continue;
    let children = byParent.get(parentId);
    if (!children) {
      children = [];
      byParent.set(parentId, children);
    }
    children.push(child);
  }
  return byParent;
}

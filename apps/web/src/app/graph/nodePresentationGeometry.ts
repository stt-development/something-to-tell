import type { Edge, Node } from "@xyflow/react";
import { createAbsoluteNodePositionResolver } from "../../composition/layout";
import type { NarrativeNodeRenderData } from "../workspaceShared";
import type { ViewportPlacement } from "./viewportEligibility";

/** Adapts complete current Graph/focused/Flow geometry, never canonical aliases or DOM extents. */
export function projectViewportPlacements(nodes: readonly Node<NarrativeNodeRenderData>[]): ViewportPlacement[] {
  const world = createAbsoluteNodePositionResolver(nodes);
  return nodes.map((node) => ({ id: node.id, parentId: node.parentId,
    // Auto-sized nodes stay full until their owner supplies explicit dimensions.
    worldBounds: node.width != null && node.height != null
      ? { ...world(node), width: node.width, height: node.height } : null }));
}

/** Current interaction/review paths only; never a visited-node or selection owner. */
export function protectedViewportPlacements(nodes: readonly Node<NarrativeNodeRenderData>[], ownerIds: readonly (string | null | undefined)[],
  edges: readonly Pick<Edge, "id" | "source" | "target" | "selected">[] = [], edgeIds: readonly (string | null | undefined)[] = []): ReadonlySet<string> {
  const owners = new Set(ownerIds.filter((id): id is string => Boolean(id)));
  const selectedEdges = new Set(edgeIds);
  for (const edge of edges) if (edge.selected || selectedEdges.has(edge.id)) { owners.add(edge.source); owners.add(edge.target); }
  const parents = new Map(nodes.map((node) => [node.id, node.parentId]));
  const protectedIds = new Set<string>();
  for (const node of nodes) {
    if (node.selected || node.dragging || node.data.isConnectionSource || node.data.isConnectionTarget
      || node.data.compositionDropState || node.data.analysisPreview || node.data.canonTarget || node.data.impactHighlight
      || owners.has(node.id) || owners.has(node.data.canonicalNodeId ?? node.id)) protectedIds.add(node.id);
  }
  for (const id of protectedIds) {
    const parent = parents.get(id);
    if (parent && parents.has(parent)) protectedIds.add(parent);
  }
  return protectedIds;
}

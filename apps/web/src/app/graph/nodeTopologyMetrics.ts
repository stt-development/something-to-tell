import type { Edge, Node } from "@xyflow/react";
import type { NarrativeEdgeData, NarrativeNodeData } from "../../types";
import type { NodePresentationMetrics } from "../workspaceShared";

/** One raw-graph pass per invocation; exact edge ids are not canonicalized or filtered. */
export function buildNodeTopologyMetrics(
  nodes: readonly Node<NarrativeNodeData>[],
  edges: readonly Edge<NarrativeEdgeData>[]
): ReadonlyMap<string, NodePresentationMetrics> {
  const metrics = new Map<string, NodePresentationMetrics>();
  const forId = (id: string) => {
    let value = metrics.get(id);
    if (!value) {
      value = { incoming: 0, outgoing: 0, instances: 0 };
      metrics.set(id, value);
    }
    return value;
  };
  for (const node of nodes) forId(node.data.canonicalNodeId ?? node.id).instances++;
  for (const edge of edges) {
    forId(edge.target).incoming++;
    forId(edge.source).outgoing++;
  }
  return metrics;
}

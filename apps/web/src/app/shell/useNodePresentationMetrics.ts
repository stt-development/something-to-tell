import type { Edge, Node } from "@xyflow/react";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { NarrativeEdgeData, NarrativeNodeData } from "../../types";
import { buildNodeTopologyMetrics } from "../graph/nodeTopologyMetrics";
import type { NodePresentationMetrics } from "../workspaceShared";

export interface NodeMetricInputs {
  projectId: string;
  rawNodes: readonly Node<NarrativeNodeData>[];
  rawEdges: readonly Edge<NarrativeEdgeData>[];
  nodes: readonly Node<NarrativeNodeData>[];
}
type Committed = Omit<NodeMetricInputs, "nodes"> & { metrics: ReadonlyMap<string, NodePresentationMetrics> };

/** Retains numeric topology values per live canonical owner, not labels or node data. */
export function useNodePresentationMetrics({ projectId, rawNodes, rawEdges, nodes }: NodeMetricInputs): ReadonlyMap<string, NodePresentationMetrics> {
  const committed = useRef<Committed | null>(null);
  const next = useMemo(() => {
    const previous = committed.current?.projectId === projectId ? committed.current : null;
    const unchangedGraph = previous?.rawNodes === rawNodes && previous.rawEdges === rawEdges;
    const metrics = new Map<string, NodePresentationMetrics>();
    const placements = new Map<string, NodePresentationMetrics>();
    let rawMetrics: ReadonlyMap<string, NodePresentationMetrics> | undefined;
    for (const node of nodes) {
      const canonicalId = node.data.canonicalNodeId ?? node.id;
      let value = metrics.get(canonicalId);
      if (!value) {
        const old = previous?.metrics.get(canonicalId);
        // Raw immutable inputs include hidden semantic edges and every placement.
        let measured = old;
        if (!unchangedGraph || !measured) {
          rawMetrics ??= buildNodeTopologyMetrics(rawNodes, rawEdges);
          measured = rawMetrics.get(canonicalId) ?? { incoming: 0, outgoing: 0, instances: 0 };
        }
        value = old && old.incoming === measured.incoming && old.outgoing === measured.outgoing && old.instances === measured.instances ? old : measured;
        metrics.set(canonicalId, value);
      }
      placements.set(node.id, value);
    }
    return { metrics, placements };
  }, [projectId, rawNodes, rawEdges, nodes]);
  // Only committed projections may publish values or retire canonical owners.
  useLayoutEffect(() => { committed.current = { projectId, rawNodes, rawEdges, metrics: next.metrics }; }, [projectId, rawNodes, rawEdges, next]);
  useEffect(() => () => { committed.current = null; }, []);
  return next.placements;
}

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";

interface Boundary { scene_node_id: string; entry_node_id: string; exit_node_ids: readonly string[] }
interface Summary { entry: string; exits: number }
export interface SceneBoundaryInputs {
  projectId: string;
  rawNodes: readonly { id: string; data: { canonicalNodeId?: string; title: string } }[];
  nodes: readonly { id: string; data: { canonicalNodeId?: string } }[];
  activeStoryFlow: { flow: { id: string }; scene_boundaries: readonly Boundary[] } | null;
}

/** Retains boundary presentation only; Flow membership, routing and actions remain independent. */
export function useSceneBoundarySummaries({ projectId, rawNodes, nodes, activeStoryFlow }: SceneBoundaryInputs): ReadonlyMap<string, Summary> {
  const committed = useRef<{ projectId: string; flowId: string | null; summaries: ReadonlyMap<string, Summary> } | null>(null);
  const flowId = activeStoryFlow?.flow.id ?? null;
  const next = useMemo(() => {
    const previous = committed.current?.projectId === projectId && committed.current.flowId === flowId ? committed.current.summaries : undefined;
    const summaries = new Map<string, Summary>();
    const placements = new Map<string, Summary>();
    for (const node of nodes) {
      const canonicalId = node.data.canonicalNodeId ?? node.id;
      let summary = summaries.get(canonicalId);
      if (!summary) {
        // Preserve first boundary/raw canonical match and the existing missing-entry fallback.
        const boundary = activeStoryFlow?.scene_boundaries.find((item) => item.scene_node_id === canonicalId);
        if (!boundary) continue;
        const entry = rawNodes.find((candidate) => (candidate.data.canonicalNodeId ?? candidate.id) === boundary.entry_node_id)?.data.title ?? boundary.entry_node_id;
        const exits = boundary.exit_node_ids.length;
        const old = previous?.get(canonicalId);
        summary = old?.entry === entry && old.exits === exits ? old : { entry, exits };
        summaries.set(canonicalId, summary);
      }
      placements.set(node.id, summary);
    }
    return { summaries, placements };
  }, [projectId, flowId, rawNodes, nodes, activeStoryFlow]);
  // Only committed projections may publish summaries or prune the current Flow scope.
  useLayoutEffect(() => { committed.current = { projectId, flowId, summaries: next.summaries }; }, [projectId, flowId, next]);
  useEffect(() => () => { committed.current = null; }, []);
  return next.placements;
}

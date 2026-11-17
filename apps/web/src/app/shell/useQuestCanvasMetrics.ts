import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { QuestDocument } from "../../quest/contracts";
import { questCanvasMetrics, type QuestCanvasMetrics } from "../../quest/presentation";

export interface QuestMetricInputs {
  projectId: string;
  nodes: readonly { id: string; data: { kind?: string; canonicalNodeId?: string; questDocument?: QuestDocument } }[];
}
type Owners = Map<string, Map<QuestDocument | undefined, QuestCanvasMetrics>>;

/** Reuses numeric metrics by immutable document, bounded to live canonical owners. */
export function useQuestCanvasMetrics({ projectId, nodes }: QuestMetricInputs): ReadonlyMap<string, QuestCanvasMetrics> {
  const committed = useRef<{ projectId: string; owners: Owners } | null>(null);
  const next = useMemo(() => {
    const previous = committed.current?.projectId === projectId ? committed.current.owners : undefined;
    const owners: Owners = new Map();
    const metrics = new Map<string, QuestCanvasMetrics>();
    for (const node of nodes) {
      if (node.data.kind !== "Quest") continue;
      const canonicalId = node.data.canonicalNodeId ?? node.id;
      const document = node.data.questDocument;
      let documents = owners.get(canonicalId);
      if (!documents) { documents = new Map(); owners.set(canonicalId, documents); }
      const value = documents.get(document) ?? previous?.get(canonicalId)?.get(document) ?? questCanvasMetrics(document);
      documents.set(document, value);
      metrics.set(node.id, value);
    }
    return { owners, metrics };
  }, [projectId, nodes]);
  // Never mutate/prune the committed registry from an abandoned or suspended render.
  useLayoutEffect(() => { committed.current = { projectId, owners: next.owners }; }, [projectId, next]);
  useEffect(() => () => { committed.current = null; }, []);
  return next.metrics;
}

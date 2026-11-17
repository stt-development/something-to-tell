import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { DialogueDocument } from "../../dialogue/contracts";
import { dialogueCanvasMetrics, type DialogueCanvasMetrics } from "../../dialogue/presentation";

export interface DialogueMetricInputs {
  projectId: string;
  nodes: readonly { id: string; data: { kind?: string; canonicalNodeId?: string; dialogueDocument?: DialogueDocument } }[];
  externalOrigins: ReadonlyMap<string, readonly string[]>;
}
interface Entry {
  canonicalId: string;
  document: DialogueDocument | undefined;
  origins: ReadonlySet<string>;
  value: DialogueCanvasMetrics;
}

/** Numeric Dialogue presentation only; origin lookup intentionally remains placement-specific. */
export function useDialogueCanvasMetrics({ projectId, nodes, externalOrigins }: DialogueMetricInputs): ReadonlyMap<string, DialogueCanvasMetrics> {
  const committed = useRef<{ projectId: string; entries: ReadonlyMap<string, Entry> } | null>(null);
  const next = useMemo(() => {
    const previous = committed.current?.projectId === projectId ? committed.current.entries : undefined;
    const entries = new Map<string, Entry>();
    const metrics = new Map<string, DialogueCanvasMetrics>();
    for (const node of nodes) {
      if (node.data.kind !== "Dialogue") continue;
      const canonicalId = node.data.canonicalNodeId ?? node.id;
      const document = node.data.dialogueDocument;
      // Match the helper's set semantics, not edge order or duplicate edge count.
      const origins = new Set(externalOrigins.get(node.id));
      const old = previous?.get(node.id);
      const retained = old?.canonicalId === canonicalId && old.document === document
        && old.origins.size === origins.size && [...origins].every((id) => old.origins.has(id));
      const entry: Entry = retained ? old : { canonicalId, document, origins, value: dialogueCanvasMetrics(document, origins) };
      entries.set(node.id, entry);
      metrics.set(node.id, entry.value);
    }
    return { entries, metrics };
  }, [projectId, nodes, externalOrigins]);
  // Publish/prune only after commit; Suspense must leave the current registry intact.
  useLayoutEffect(() => { committed.current = { projectId, entries: next.entries }; }, [projectId, next]);
  useEffect(() => () => { committed.current = null; }, []);
  return next.metrics;
}

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";

export interface OutcomeTitleInputs {
  projectId: string;
  rawNodes: readonly { id: string; data: { canonicalNodeId?: string; title: string } }[];
  nodes: readonly { id: string; data: { kind?: string; canonicalNodeId?: string; outcome?: { targetNodeIds: readonly string[] } } }[];
}
interface Entry { canonicalId: string; targetIds: readonly string[] | undefined; titles: string[] }
type Committed = Pick<OutcomeTitleInputs, "projectId" | "rawNodes"> & { entries: ReadonlyMap<string, Entry> };

/** Retains ordered Consequence card target titles; outcome data and commands stay independent. */
export function useOutcomeTargetTitles({ projectId, rawNodes, nodes }: OutcomeTitleInputs): ReadonlyMap<string, string[]> {
  const committed = useRef<Committed | null>(null);
  const next = useMemo(() => {
    const previous = committed.current?.projectId === projectId ? committed.current : null;
    const entries = new Map<string, Entry>();
    const titlesByPlacement = new Map<string, string[]>();
    for (const node of nodes) {
      if (node.data.kind !== "Consequence") continue;
      const canonicalId = node.data.canonicalNodeId ?? node.id;
      const targetIds = node.data.outcome?.targetNodeIds;
      const old = previous?.entries.get(node.id);
      const sameOwner = old?.canonicalId === canonicalId;
      // Preserve first raw canonical match, duplicate/order semantics and missing-id fallback.
      const measured = sameOwner && previous?.rawNodes === rawNodes && old.targetIds === targetIds ? old.titles
        : (targetIds ?? []).map((id) => rawNodes.find((candidate) => (candidate.data.canonicalNodeId ?? candidate.id) === id)?.data.title ?? id);
      const titles = sameOwner && old.titles.length === measured.length && measured.every((title, index) => old.titles[index] === title) ? old.titles : measured;
      entries.set(node.id, { canonicalId, targetIds, titles });
      titlesByPlacement.set(node.id, titles);
    }
    return { entries, titlesByPlacement };
  }, [projectId, rawNodes, nodes]);
  // Only committed projections may publish names or prune live Consequence owners.
  useLayoutEffect(() => { committed.current = { projectId, rawNodes, entries: next.entries }; }, [projectId, rawNodes, next]);
  useEffect(() => () => { committed.current = null; }, []);
  return next.titlesByPlacement;
}

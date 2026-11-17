import type { Edge, Node } from "@xyflow/react";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { NarrativeEdgeData, NarrativeNodeData } from "../../types";
import { factionMembers } from "../graph/graphProjection";

export interface FactionTitleInputs {
  projectId: string;
  rawNodes: readonly Node<NarrativeNodeData>[];
  rawEdges: readonly Edge<NarrativeEdgeData>[];
  nodes: readonly { id: string; data: { kind?: string } }[];
}
interface Entry { canonicalId: string; titles: string[] }
type Committed = Omit<FactionTitleInputs, "nodes"> & { entries: ReadonlyMap<string, Entry> };

/** Retains ordered card titles only; membership commands and editor node records stay separate. */
export function useFactionMemberTitles({ projectId, rawNodes, rawEdges, nodes }: FactionTitleInputs): ReadonlyMap<string, string[]> {
  const committed = useRef<Committed | null>(null);
  const next = useMemo(() => {
    const previous = committed.current?.projectId === projectId ? committed.current : null;
    const unchangedGraph = previous?.rawNodes === rawNodes && previous.rawEdges === rawEdges;
    const entries = new Map<string, Entry>();
    const titlesByPlacement = new Map<string, string[]>();
    for (const node of nodes) {
      if (node.data.kind !== "Faction") continue;
      // Preserve the helper's raw visual-id lookup, including its missing-node fallback.
      const faction = rawNodes.find((candidate) => candidate.id === node.id);
      const canonicalId = faction?.data.canonicalNodeId ?? faction?.id ?? node.id;
      const old = previous?.entries.get(node.id);
      const sameOwner = old?.canonicalId === canonicalId;
      const measured = unchangedGraph && sameOwner ? old.titles : factionMembers(rawNodes, rawEdges, node.id).map((member) => member.data.title);
      const titles = sameOwner && old.titles.length === measured.length && measured.every((title, index) => old.titles[index] === title) ? old.titles : measured;
      entries.set(node.id, { canonicalId, titles });
      titlesByPlacement.set(node.id, titles);
    }
    return { entries, titlesByPlacement };
  }, [projectId, rawNodes, rawEdges, nodes]);
  // Speculative renders cannot replace current titles or prune live Faction owners.
  useLayoutEffect(() => { committed.current = { projectId, rawNodes, rawEdges, entries: next.entries }; }, [projectId, rawNodes, rawEdges, next]);
  useEffect(() => () => { committed.current = null; }, []);
  return next.titlesByPlacement;
}

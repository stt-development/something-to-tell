import type { Node } from "@xyflow/react";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { NarrativeNodeData } from "../../types";
import { buildFrameCountInputs, countFrameChildren } from "../graph/frameContentCounts";
import { buildFrameMembershipSignatures } from "../graph/frameMembershipSignatures";
import type { FrameContentCounts } from "../workspaceShared";

export interface FrameCountInputs {
  projectId: string;
  rawNodes: readonly Node<NarrativeNodeData>[];
  nodes: readonly { id: string; data: { isFrame?: boolean; canonicalNodeId?: string; kind?: string } }[];
}
interface Entry {
  canonicalId: string;
  kind: string | undefined;
  children: ReadonlyMap<string, NarrativeNodeData["kind"]>;
  value: FrameContentCounts;
}

/** Retains direct-placement header counts; raw graph membership is the authority. */
export function useFrameContentCounts({ projectId, rawNodes, nodes }: FrameCountInputs): ReadonlyMap<string, FrameContentCounts> {
  const committed = useRef<{ projectId: string; entries: ReadonlyMap<string, Entry> } | null>(null);
  const next = useMemo(() => {
    const previous = committed.current?.projectId === projectId ? committed.current.entries : undefined;
    const entries = new Map<string, Entry>();
    const counts = new Map<string, FrameContentCounts>();
    let signatures: ReturnType<typeof buildFrameMembershipSignatures> | undefined;
    let countInputs: ReturnType<typeof buildFrameCountInputs> | undefined;
    for (const node of nodes) {
      if (!node.data.isFrame) continue;
      const canonicalId = node.data.canonicalNodeId ?? node.id;
      const kind = node.data.kind;
      // Hidden/filtered children still count; grandchildren and geometry do not.
      signatures ??= buildFrameMembershipSignatures(rawNodes);
      const children = signatures.get(node.id) ?? new Map<string, NarrativeNodeData["kind"]>();
      const old = previous?.get(node.id);
      const retained = old?.canonicalId === canonicalId && old.kind === kind && old.children.size === children.size
        && [...children].every(([id, childKind]) => old.children.get(id) === childKind);
      let entry: Entry;
      if (retained) {
        entry = old;
      } else {
        // Raw records retain duplicates; signature maps intentionally do not.
        countInputs ??= buildFrameCountInputs(rawNodes);
        entry = { canonicalId, kind, children, value: countFrameChildren(countInputs.get(node.id) ?? []) };
      }
      entries.set(node.id, entry);
      counts.set(node.id, entry.value);
    }
    return { entries, counts };
  }, [projectId, rawNodes, nodes]);
  // Suspended/abandoned projections must not publish or prune committed entries.
  useLayoutEffect(() => { committed.current = { projectId, entries: next.entries }; }, [projectId, next]);
  useEffect(() => () => { committed.current = null; }, []);
  return next.counts;
}

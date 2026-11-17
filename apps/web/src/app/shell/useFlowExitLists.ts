import { useEffect, useLayoutEffect, useMemo, useRef } from "react";

interface ExitRow { id: string; key: string; label: string }
export interface FlowExitListInputs {
  projectId: string;
  nodes: readonly { id: string; data: { canonicalNodeId?: string } }[];
  activeStoryFlow: { flow: { id: string }; exits?: readonly { id: string; source_node_id: string; key: string; label: string }[] } | null;
}

/** Exit card presentation only; authoring commands and terminal-exit validation stay separate. */
export function useFlowExitLists({ projectId, nodes, activeStoryFlow }: FlowExitListInputs): ReadonlyMap<string, ExitRow[]> {
  const committed = useRef<{ projectId: string; flowId: string | null; lists: ReadonlyMap<string, ExitRow[]> } | null>(null);
  const flowId = activeStoryFlow?.flow.id ?? null;
  const next = useMemo(() => {
    const previous = committed.current?.projectId === projectId && committed.current.flowId === flowId ? committed.current.lists : undefined;
    const lists = new Map<string, ExitRow[]>();
    const placements = new Map<string, ExitRow[]>();
    for (const node of nodes) {
      const sourceId = node.data.canonicalNodeId ?? node.id;
      let list = lists.get(sourceId);
      if (!list) {
        const old = previous?.get(sourceId);
        const oldRows = new Map(old?.map((row) => [row.id, row]));
        const rows = (activeStoryFlow?.exits ?? []).filter((exit) => exit.source_node_id === sourceId).map((exit) => {
          const retained = oldRows.get(exit.id);
          // Keep raw key/label values; the renderer still owns label-or-key fallback.
          return retained?.key === exit.key && retained.label === exit.label ? retained : { id: exit.id, key: exit.key, label: exit.label };
        });
        list = old && old.length === rows.length && rows.every((row, index) => row === old[index]) ? old : rows;
        lists.set(sourceId, list);
      }
      placements.set(node.id, list);
    }
    return { lists, placements };
  }, [projectId, flowId, nodes, activeStoryFlow]);
  // Suspended/abandoned projections cannot publish exit edits or prune committed sources.
  useLayoutEffect(() => { committed.current = { projectId, flowId, lists: next.lists }; }, [projectId, flowId, next]);
  useEffect(() => () => { committed.current = null; }, []);
  return next.placements;
}

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";

interface CallRow { id: string; label: string; onOpen: () => void }
export interface FlowCallListInputs {
  projectId: string;
  nodes: readonly { id: string; data: { canonicalNodeId?: string } }[];
  activeStoryFlow: { flow: { id: string }; invocations?: readonly { id: string; source_node_id: string; target_flow_id: string; label: string }[] } | null;
  projectStoryFlows: readonly { flow: { id: string; name: string } }[];
  openActions: ReadonlyMap<string, () => void>;
}

/** Call card presentation only; current open commands remain owned by useFlowCallOpenActions. */
export function useFlowCallLists({ projectId, nodes, activeStoryFlow, projectStoryFlows, openActions }: FlowCallListInputs): ReadonlyMap<string, CallRow[]> {
  const committed = useRef<{ projectId: string; flowId: string | null; lists: ReadonlyMap<string, CallRow[]> } | null>(null);
  const flowId = activeStoryFlow?.flow.id ?? null;
  const next = useMemo(() => {
    const previous = committed.current?.projectId === projectId && committed.current.flowId === flowId ? committed.current.lists : undefined;
    const lists = new Map<string, CallRow[]>();
    const placements = new Map<string, CallRow[]>();
    for (const node of nodes) {
      const sourceId = node.data.canonicalNodeId ?? node.id;
      let list = lists.get(sourceId);
      if (!list) {
        const old = previous?.get(sourceId);
        const oldRows = new Map(old?.map((row) => [row.id, row]));
        const rows = (activeStoryFlow?.invocations ?? []).filter((call) => call.source_node_id === sourceId).map((call) => {
          // Preserve truthy explicit/name/id fallback, including authored whitespace labels.
          const label = call.label || projectStoryFlows.find((target) => target.flow.id === call.target_flow_id)?.flow.name || call.target_flow_id;
          const onOpen = openActions.get(call.id)!;
          const retained = oldRows.get(call.id);
          return retained?.label === label && retained.onOpen === onOpen ? retained : { id: call.id, label, onOpen };
        });
        list = old && old.length === rows.length && rows.every((row, index) => row === old[index]) ? old : rows;
        lists.set(sourceId, list);
      }
      placements.set(node.id, list);
    }
    return { lists, placements };
  }, [projectId, flowId, nodes, activeStoryFlow, projectStoryFlows, openActions]);
  // Speculative labels, commands and projection pruning never enter the committed cache.
  useLayoutEffect(() => { committed.current = { projectId, flowId, lists: next.lists }; }, [projectId, flowId, next]);
  useEffect(() => () => { committed.current = null; }, []);
  return next.placements;
}

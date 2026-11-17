import { useEffect, useLayoutEffect, useMemo, useRef } from "react";

export interface FlowCallOpenInputs {
  projectId: string;
  nodes: readonly { id: string; data: { canonicalNodeId?: string } }[];
  activeStoryFlow: { flow: { id: string }; invocations?: readonly { id: string; source_node_id: string }[] } | null;
  setSelectedInvocationId: (id: string) => void;
  setDialog: (dialog: "flow-call-bindings") => void;
}
type Committed = Omit<FlowCallOpenInputs, "nodes" | "activeStoryFlow"> & {
  flowId: string | null;
  actions: ReadonlyMap<string, () => void>;
};

/** Call-id adapters only; selection and bindings dialog state remain in App. */
export function useFlowCallOpenActions({ projectId, nodes, activeStoryFlow, setSelectedInvocationId, setDialog }: FlowCallOpenInputs): ReadonlyMap<string, () => void> {
  const committed = useRef<Committed | null>(null);
  const flowId = activeStoryFlow?.flow.id ?? null;
  const actions = useMemo(() => {
    const previous = committed.current;
    const canonicalIds = new Set(nodes.map((node) => node.data.canonicalNodeId ?? node.id));
    const next = new Map<string, () => void>();
    for (const call of activeStoryFlow?.invocations ?? []) {
      if (!canonicalIds.has(call.source_node_id)) continue;
      const id = call.id;
      const retained = previous?.projectId === projectId && previous.flowId === flowId ? previous.actions.get(id) : undefined;
      const onOpen: () => void = retained ?? (() => {
        const current = committed.current;
        // A deleted or previous-scope call must not select an unrelated reused id.
        if (!current || current.actions.get(id) !== onOpen) return;
        current.setSelectedInvocationId(id);
        current.setDialog("flow-call-bindings");
      });
      next.set(id, onOpen);
    }
    return next;
  }, [projectId, flowId, nodes, activeStoryFlow]);
  // Speculative renders cannot publish commands or prune the current call scope.
  useLayoutEffect(() => {
    committed.current = { projectId, flowId, actions, setSelectedInvocationId, setDialog };
  }, [projectId, flowId, actions, setSelectedInvocationId, setDialog]);
  useEffect(() => () => { committed.current = null; }, []);
  return actions;
}

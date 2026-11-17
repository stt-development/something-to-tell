import type { Node } from "@xyflow/react";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { WorkspaceMode } from "../../story-flow/workspace";
import type { NarrativeNodeRenderData } from "../workspaceShared";

export interface NodeDataAssemblyInputs {
  projectId: string;
  flowId: string | null;
  workspaceMode: WorkspaceMode;
  nodes: readonly Node<NarrativeNodeRenderData>[];
}
type Committed = Omit<NodeDataAssemblyInputs, "nodes"> & { data: ReadonlyMap<string, NarrativeNodeRenderData> };

/** Exact own-field inputs only: immutable nested values and callbacks compare by reference. */
function equalDataFields(previous: NarrativeNodeRenderData, candidate: NarrativeNodeRenderData): boolean {
  if (previous === candidate) return true;
  const keys = Reflect.ownKeys(candidate);
  return Reflect.ownKeys(previous).length === keys.length && keys.every((key) =>
    Object.prototype.hasOwnProperty.call(previous, key) && Object.is(Reflect.get(previous, key), Reflect.get(candidate, key))
  );
}

/** Retains final data per live visual placement; never owns outer nodes or graph history. */
export function useNodeDataAssembly({ projectId, flowId, workspaceMode, nodes }: NodeDataAssemblyInputs): ReadonlyMap<string, NarrativeNodeRenderData> {
  const committed = useRef<Committed | null>(null);
  const data = useMemo(() => {
    const previous = committed.current?.projectId === projectId && committed.current.flowId === flowId
      && committed.current.workspaceMode === workspaceMode ? committed.current.data : undefined;
    const next = new Map<string, NarrativeNodeRenderData>();
    for (const node of nodes) {
      const retained = previous?.get(node.id);
      next.set(node.id, retained && equalDataFields(retained, node.data) ? retained : node.data);
    }
    return next;
  }, [projectId, flowId, workspaceMode, nodes]);
  // Publish/prune only after commit; Suspense must leave the current placement scope intact.
  useLayoutEffect(() => { committed.current = { projectId, flowId, workspaceMode, data }; }, [projectId, flowId, workspaceMode, data]);
  useEffect(() => () => { committed.current = null; }, []);
  return data;
}

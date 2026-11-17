import type { Node } from "@xyflow/react";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { NarrativeNodeRenderData } from "../workspaceShared";
import type { NodeDataAssemblyInputs } from "./useNodeDataAssembly";

type RenderNode = Node<NarrativeNodeRenderData>;
type Committed = Omit<NodeDataAssemblyInputs, "nodes"> & { nodes: ReadonlyMap<string, RenderNode>; ordered: RenderNode[] };

/** Geometry, styles and data are immutable inputs, compared by reference, not value. */
function equalNodeFields(previous: RenderNode, candidate: RenderNode): boolean {
  if (previous === candidate) return true;
  const keys = Reflect.ownKeys(candidate);
  return Reflect.ownKeys(previous).length === keys.length && keys.every((key) =>
    Object.prototype.hasOwnProperty.call(previous, key) && Object.is(Reflect.get(previous, key), Reflect.get(candidate, key))
  );
}

/** Retains live wrappers and only the latest committed equal ordered array in this scope. */
export function useNodeWrapperAssembly({ projectId, flowId, workspaceMode, nodes }: NodeDataAssemblyInputs): RenderNode[] {
  const committed = useRef<Committed | null>(null);
  const result = useMemo(() => {
    const previous = committed.current?.projectId === projectId && committed.current.flowId === flowId
      && committed.current.workspaceMode === workspaceMode ? committed.current : undefined;
    const next = new Map<string, RenderNode>();
    const ordered = nodes.map((candidate) => {
      const retained = previous?.nodes.get(candidate.id);
      const node = retained && equalNodeFields(retained, candidate) ? retained : candidate;
      next.set(node.id, node);
      return node;
    });
    // Compare final references, not ids/data alone; changed membership/order must stay live.
    const sameOrder = previous?.ordered.length === ordered.length
      && ordered.every((node, index) => node === previous.ordered[index]);
    return { nodes: next, ordered: sameOrder ? previous.ordered : ordered };
  }, [projectId, flowId, workspaceMode, nodes]);
  // Only committed renders may replace/prune live wrappers; Suspense leaves them intact.
  useLayoutEffect(() => { committed.current = { projectId, flowId, workspaceMode, ...result }; }, [projectId, flowId, workspaceMode, result]);
  useEffect(() => () => { committed.current = null; }, []);
  return result.ordered;
}

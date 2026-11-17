import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { Node } from "@xyflow/react";
import type { NarrativeNodeData } from "../../types";

export interface FramePlacementActions {
  onAddLinked: () => void;
  onFitContent: () => void;
  onToggleCollapse: () => void;
  onFocusFrame: () => void;
}

export interface FramePlacementActionInputs {
  projectId: string;
  nodes: readonly Node<NarrativeNodeData>[];
  setFrameAddMenuId: (id: string) => void;
  fitFrame: (id: string) => void;
  toggleFrameCollapse: (id: string) => void;
  openFrameWorkspace: (frame: Node<NarrativeNodeData>) => void;
}

type CommittedActions = Omit<FramePlacementActionInputs, "nodes"> & {
  actions: ReadonlyMap<string, FramePlacementActions>;
  frames: ReadonlyMap<string, Node<NarrativeNodeData>>;
};

/** Frame adapters only; App and the graph store retain UI/mutation authority. */
export function useFramePlacementActions({ projectId, nodes, setFrameAddMenuId, fitFrame, toggleFrameCollapse, openFrameWorkspace }: FramePlacementActionInputs): ReadonlyMap<string, FramePlacementActions> {
  const committed = useRef<CommittedActions | null>(null);
  const { actions, frames } = useMemo(() => {
    const previous = committed.current;
    const next = new Map<string, FramePlacementActions>();
    const frames = new Map<string, Node<NarrativeNodeData>>();
    for (const node of nodes) {
      if (!node.data.isFrame) continue;
      const id = node.id;
      frames.set(id, node);
      const retained = previous?.projectId === projectId ? previous.actions.get(id) : undefined;
      if (retained) { next.set(id, retained); continue; }
      // Detached/previous-project closures must never dispatch to a reused id.
      const current = () => committed.current?.actions.get(id) === bundle ? committed.current : null;
      const bundle: FramePlacementActions = {
        onAddLinked: () => current()?.setFrameAddMenuId(id),
        onFitContent: () => current()?.fitFrame(id),
        onToggleCollapse: () => current()?.toggleFrameCollapse(id),
        onFocusFrame: () => {
          const active = current();
          const frame = active?.frames.get(id);
          // Focus needs the latest projected node, not the snapshot that created this action.
          if (active && frame) active.openFrameWorkspace(frame);
        }
      };
      next.set(id, bundle);
    }
    return { actions: next, frames };
  }, [nodes, projectId]);
  // Publish/prune only after commit; speculative renders cannot change live adapters.
  useLayoutEffect(() => {
    committed.current = { projectId, actions, frames, setFrameAddMenuId, fitFrame, toggleFrameCollapse, openFrameWorkspace };
  }, [projectId, actions, frames, setFrameAddMenuId, fitFrame, toggleFrameCollapse, openFrameWorkspace]);
  // Suspense hides layout effects without unmounting; revoke only on passive teardown.
  useEffect(() => () => { committed.current = null; }, []);
  return actions;
}

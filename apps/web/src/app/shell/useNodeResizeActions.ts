import type { Node } from "@xyflow/react";
import { useLayoutEffect, useMemo, useRef, type MutableRefObject } from "react";
import type { NarrativeNodeData } from "../../types";

export interface NodeResizeInputs {
  getActiveGraph: () => { nodes: Node<NarrativeNodeData>[] };
  dragStartNodesRef: MutableRefObject<Node<NarrativeNodeData>[] | null>;
  completeNodeResize: (previousNodes: Node<NarrativeNodeData>[]) => void;
}

/** Shared placement actions only; the existing ref and store retain gesture/persistence ownership. */
export function useNodeResizeActions(inputs: NodeResizeInputs) {
  const committed = useRef(inputs);
  // Speculative renders must not replace commands used by mounted resizers.
  useLayoutEffect(() => { committed.current = inputs; }, [inputs]);
  return useMemo(() => ({
    onResizeStart() {
      const current = committed.current;
      current.dragStartNodesRef.current = current.getActiveGraph().nodes;
    },
    onResizeEnd() {
      const current = committed.current;
      if (current.dragStartNodesRef.current) current.completeNodeResize(current.dragStartNodesRef.current);
      // Clear only after successful dispatch, matching the original failure behavior.
      current.dragStartNodesRef.current = null;
    }
  }), []);
}

import type { Node, ReactFlowProps } from "@xyflow/react";
import { useCallback, useLayoutEffect, useRef, type MutableRefObject } from "react";
import { createCanvasSelection, type CanvasSelection, type NarrativeNodeData } from "../../types";

type DragStartHandler = NonNullable<ReactFlowProps<Node<NarrativeNodeData>>["onNodeDragStart"]>;

export interface CanvasDragStartInputs {
  canvasSelection: CanvasSelection;
  getActiveGraph: () => { nodes: Node<NarrativeNodeData>[] };
  dragStartNodesRef: MutableRefObject<Node<NarrativeNodeData>[] | null>;
  groupDragActiveRef: MutableRefObject<boolean>;
  groupDragSelectionRef: MutableRefObject<CanvasSelection | null>;
  suppressPaneClickRef: MutableRefObject<boolean>;
  compositionDropRef: MutableRefObject<{ frameId: string; message: string; valid: boolean } | null>;
  setCompositionDrop: (feedback: null) => void;
  setCanvasSelection: (selection: CanvasSelection) => void;
  selectItem: (selection: { type: "node"; id: string }) => void;
}

/** Drag-start adapter only; existing refs and commands retain gesture and selection ownership. */
export function useCanvasDragStartHandler(inputs: CanvasDragStartInputs): DragStartHandler {
  const committed = useRef(inputs);
  // A suspended render must not supply selection or commands to a live gesture.
  useLayoutEffect(() => { committed.current = inputs; }, [inputs]);
  return useCallback<DragStartHandler>((_, node) => {
    const current = committed.current;
    current.dragStartNodesRef.current = current.getActiveGraph().nodes;
    current.groupDragActiveRef.current = current.canvasSelection.nodeIds.length > 1 && current.canvasSelection.nodeIds.includes(node.id);
    current.groupDragSelectionRef.current = current.groupDragActiveRef.current
      ? createCanvasSelection(current.canvasSelection.nodeIds, current.canvasSelection.edgeIds)
      : null;
    if (current.groupDragActiveRef.current) current.suppressPaneClickRef.current = true;
    current.compositionDropRef.current = null;
    current.setCompositionDrop(null);
    if (!current.canvasSelection.nodeIds.includes(node.id)) {
      current.setCanvasSelection({ edgeIds: [], nodeIds: [node.id] });
    }
    current.selectItem({ type: "node", id: node.id });
  }, []);
}

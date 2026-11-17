import type { Node, ReactFlowProps } from "@xyflow/react";
import { useCallback, useLayoutEffect, useRef, type MutableRefObject } from "react";
import { isPlacementDescendant, moveNodePlacement } from "../../composition/layout";
import type { NarrativeNodeData } from "../../types";

type DragHandler = NonNullable<ReactFlowProps<Node<NarrativeNodeData>>["onNodeDrag"]>;
type DropFeedback = { frameId: string; message: string; valid: boolean };

export interface CanvasDragFeedbackInputs {
  groupDragActiveRef: MutableRefObject<boolean>;
  getActiveGraph: () => { nodes: Node<NarrativeNodeData>[] };
  getIntersectingNodes: (node: Node<NarrativeNodeData>, partially: boolean) => Node[];
  compositionDropRef: MutableRefObject<DropFeedback | null>;
  setCompositionDrop: (feedback: DropFeedback | null) => void;
}

/** Containment feedback only; validation stays pure and drop completion owns mutations. */
export function useCanvasDragFeedbackHandler(inputs: CanvasDragFeedbackInputs): DragHandler {
  const committed = useRef(inputs);
  // A suspended render must not replace queries or feedback commands for a live drag.
  useLayoutEffect(() => { committed.current = inputs; }, [inputs]);
  return useCallback<DragHandler>((_, node) => {
    const current = committed.current;
    if (current.groupDragActiveRef.current) return;
    const activeNodes = current.getActiveGraph().nodes;
    const frames = current.getIntersectingNodes(node, true)
      // Moving descendant frames cannot be destinations for their own ancestor.
      .filter((candidate) => candidate.id !== node.id
        && candidate.data.isFrame
        && !isPlacementDescendant(activeNodes, candidate.id, node.id))
      .sort((left, right) => ((left.width ?? 0) * (left.height ?? 0)) - ((right.width ?? 0) * (right.height ?? 0)));
    const frame = frames[0];
    if (!frame) {
      current.compositionDropRef.current = null;
      current.setCompositionDrop(null);
      return;
    }
    const validation = moveNodePlacement(activeNodes, node.id, frame.id);
    const feedback = { frameId: frame.id, message: validation.message, valid: validation.valid };
    current.compositionDropRef.current = feedback;
    current.setCompositionDrop(feedback);
  }, []);
}

import type { Node, ReactFlowProps, XYPosition } from "@xyflow/react";
import { useLayoutEffect, useMemo, useRef } from "react";
import type { NarrativeNodeData } from "../../types";
import { createLinkedInstanceFromDrop } from "../analysis/sceneAnalysis";

type DropHandlers = Required<Pick<ReactFlowProps, "onDragOver" | "onDrop">>;

export interface CanvasLinkedDropInputs {
  nodes: Node<NarrativeNodeData>[];
  screenToFlowPosition: (point: XYPosition) => XYPosition;
  addLinkedInstance: (canonicalNodeId: string, frameId: string) => { message: string; valid: boolean };
  setCompositionNotice: (message: string | null) => void;
}

/** Adapts canonical tree drops; the existing helper/command own frame choice and mutations. */
export function useCanvasLinkedDropHandlers(inputs: CanvasLinkedDropInputs): DropHandlers {
  const committed = useRef(inputs);
  useLayoutEffect(() => { committed.current = inputs; }, [inputs]);
  return useMemo<DropHandlers>(() => ({
    onDragOver(event) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDrop(event) {
      const current = committed.current;
      event.preventDefault();
      const point = current.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const result = createLinkedInstanceFromDrop(event.dataTransfer, point, current.nodes, current.addLinkedInstance);
      if (!result) return;
      current.setCompositionNotice(result.message);
      // Keep the event-time notice owner, not one supplied by a later commit.
      window.setTimeout(() => current.setCompositionNotice(null), 1800);
    }
  }), []);
}

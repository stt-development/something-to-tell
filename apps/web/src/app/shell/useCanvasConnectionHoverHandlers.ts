import type { Node, ReactFlowProps } from "@xyflow/react";
import { useLayoutEffect, useMemo, useRef } from "react";
import type { NarrativeNodeData } from "../../types";

type HoverHandlers = Required<Pick<ReactFlowProps<Node<NarrativeNodeData>>,
  "onNodeMouseEnter" | "onNodeMouseLeave">>;

export interface CanvasConnectionHoverInputs {
  connectionSourceId: string | null;
  connectionTargetId: string | null;
  setConnectionTargetId: (id: string | null) => void;
}

/** Adapts target hover only; workspace feedback state and connection commands remain separate. */
export function useCanvasConnectionHoverHandlers(inputs: CanvasConnectionHoverInputs): HoverHandlers {
  const committed = useRef(inputs);
  // An uncommitted render must not change which gesture receives hover feedback.
  useLayoutEffect(() => { committed.current = inputs; }, [inputs]);
  return useMemo<HoverHandlers>(() => ({
    onNodeMouseEnter(_, node) {
      const current = committed.current;
      if (current.connectionSourceId && node.id !== current.connectionSourceId) {
        current.setConnectionTargetId(node.id);
      }
    },
    onNodeMouseLeave(_, node) {
      const current = committed.current;
      if (current.connectionTargetId === node.id) {
        current.setConnectionTargetId(null);
      }
    }
  }), []);
}

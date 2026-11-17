import type { XYPosition } from "@xyflow/react";
import { useLayoutEffect, useMemo, useRef, type MutableRefObject } from "react";
import type { FrameDraft } from "../../types";
import { defaultFrameDraft } from "../graph/graphProjection";
import { calculateFrameBounds, FRAME_DRAG_THRESHOLD, type FrameDrawState, type ToolMode } from "../workspaceShared";

export interface FrameDrawCompletionInputs {
  frameDrawRef: MutableRefObject<FrameDrawState | null>;
  setFrameDraw: (draw: null) => void;
  addFrameAt: (draft: FrameDraft, position: XYPosition, size: { width: number; height: number }) => void;
  suppressPaneClickRef: MutableRefObject<boolean>;
  setToolMode: (mode: ToolMode) => void;
}

/** Completes/cancels the existing draw; App retains state and keyboard/tool listener ownership. */
export function useFrameDrawCompletion(inputs: FrameDrawCompletionInputs) {
  const committed = useRef(inputs);
  useLayoutEffect(() => { committed.current = inputs; }, [inputs]);
  return useMemo(() => {
    function cancelFrameDraw() {
      const current = committed.current;
      current.frameDrawRef.current = null;
      current.setFrameDraw(null);
    }
    function finishFrameDraw() {
      const current = committed.current;
      const draw = current.frameDrawRef.current;
      if (!draw) return;
      const dragged = Math.hypot(draw.currentScreen.x - draw.startScreen.x, draw.currentScreen.y - draw.startScreen.y) >= FRAME_DRAG_THRESHOLD;
      cancelFrameDraw();
      if (!dragged) return;
      const bounds = calculateFrameBounds(draw.startFlow, draw.currentFlow);
      current.addFrameAt(defaultFrameDraft(draw.kind), bounds.position, bounds.size);
      const suppression = current.suppressPaneClickRef;
      suppression.current = true;
      // Some mouseup sequences omit click; keep the reset bound to this event's ref.
      window.setTimeout(() => { suppression.current = false; }, 0);
      current.setToolMode("select");
    }
    return { cancelFrameDraw, finishFrameDraw };
  }, []);
}

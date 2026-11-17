import type { XYPosition } from "@xyflow/react";
import { useLayoutEffect, useMemo, useRef, type MouseEvent, type MutableRefObject } from "react";
import { frameKindForTool } from "../graph/graphProjection";
import type { FrameDrawState, ToolMode } from "../workspaceShared";

export interface FrameDrawPointerInputs {
  toolMode: ToolMode;
  frameDrawRef: MutableRefObject<FrameDrawState | null>;
  setFrameDraw: (draw: FrameDrawState) => void;
  screenToFlowPosition: (screen: XYPosition) => XYPosition;
}

/** Pointer adapters only; App retains draw state, completion and cancellation ownership. */
export function useFrameDrawPointerHandlers(inputs: FrameDrawPointerInputs) {
  const committed = useRef(inputs);
  useLayoutEffect(() => { committed.current = inputs; }, [inputs]);
  return useMemo(() => ({
    startFrameDraw(event: MouseEvent<HTMLDivElement>) {
      const current = committed.current;
      const kind = frameKindForTool(current.toolMode);
      if (!kind || event.button !== 0 || !(event.target as Element).classList.contains("react-flow__pane")) return;
      const screen = { x: event.clientX, y: event.clientY };
      const next = {
        currentFlow: current.screenToFlowPosition(screen), currentScreen: screen, kind,
        startFlow: current.screenToFlowPosition(screen), startScreen: screen
      };
      current.frameDrawRef.current = next;
      current.setFrameDraw(next);
    },
    continueFrameDraw(event: MouseEvent<HTMLDivElement>) {
      const latest = committed.current;
      const current = latest.frameDrawRef.current;
      if (!current) return;
      const screen = { x: event.clientX, y: event.clientY };
      const next = { ...current, currentFlow: latest.screenToFlowPosition(screen), currentScreen: screen };
      latest.frameDrawRef.current = next;
      latest.setFrameDraw(next);
    }
  }), []);
}

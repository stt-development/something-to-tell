import type { ReactFlowProps } from "@xyflow/react";
import { useLayoutEffect, useMemo, useRef, type MutableRefObject } from "react";

type PanCaptureHandlers = Required<Pick<ReactFlowProps,
  "onPointerDownCapture" | "onPointerUpCapture" | "onMoveStart">>;

export interface CanvasPanCaptureInputs {
  spacePanActiveRef: MutableRefObject<boolean>;
  alternatePanGestureRef: MutableRefObject<boolean>;
  suppressPaneClickRef: MutableRefObject<boolean>;
}

/** Alternate-pan capture only; keyboard listeners, selection and drag state keep their owners. */
export function useCanvasPanCaptureHandlers(inputs: CanvasPanCaptureInputs): PanCaptureHandlers {
  const committed = useRef(inputs);
  useLayoutEffect(() => { committed.current = inputs; }, [inputs]);
  return useMemo<PanCaptureHandlers>(() => ({
    onPointerDownCapture(event) {
      const current = committed.current;
      if (current.spacePanActiveRef.current || event.button === 1) {
        current.alternatePanGestureRef.current = true;
        current.suppressPaneClickRef.current = true;
      }
    },
    onPointerUpCapture() {
      // Keep the original event-time ref even if inputs change before this task runs.
      const alternatePanGestureRef = committed.current.alternatePanGestureRef;
      window.setTimeout(() => { alternatePanGestureRef.current = false; }, 0);
    },
    onMoveStart(event) {
      const current = committed.current;
      if (current.spacePanActiveRef.current || (event && "button" in event && event.button === 1)) {
        // React Flow can emit a pane click after an alternate-pan gesture.
        current.suppressPaneClickRef.current = true;
      }
    }
  }), []);
}

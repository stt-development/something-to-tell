import { Controls, useReactFlow, type FitViewOptions } from "@xyflow/react";
import { useCallback, useLayoutEffect, useState } from "react";
import { canvasFitPadding, INITIAL_CANVAS_FIT_PADDING } from "./canvasFitPadding";
import { useDomFitIncludesHidden } from "./CanvasDomSafety";

/** Read only the active workspace canvas; startup background graphs are unrelated. */
export function readCanvasFitPadding(padding: FitViewOptions["padding"] = 0.1) {
  const canvas = document.querySelector<HTMLElement>(".workspace-stage > .react-flow");
  if (!canvas) return padding;
  return canvasFitPadding(canvas.getBoundingClientRect(),
    canvas.parentElement?.querySelector(".tool-rail")?.getBoundingClientRect() ?? null,
    canvas.querySelector(".react-flow__minimap")?.getBoundingClientRect() ?? null, padding);
}

/** Event-time adapter shared by automatic Fits; exact-scale navigation is not Fit. */
export function useCanvasFitView(includeVirtualizedNodes = false) {
  const { fitView } = useReactFlow();
  return useCallback((options: FitViewOptions = {}) => {
    const complete = includeVirtualizedNodes ? { ...options, includeHiddenNodes: true } : options;
    return fitView(complete.minZoom !== undefined && complete.minZoom === complete.maxZoom ? complete
      : { ...complete, padding: readCanvasFitPadding(complete.padding) });
  }, [fitView, includeVirtualizedNodes]);
}

/** Keep the library's native controls, ordering and accessibility; only supply padding. */
export function CanvasFitControls({ onInteractiveChange }: { onInteractiveChange?: (interactive: boolean) => void } = {}) {
  const includeHiddenNodes = useDomFitIncludesHidden();
  const [padding, setPadding] = useState<FitViewOptions["padding"]>(INITIAL_CANVAS_FIT_PADDING);
  useLayoutEffect(() => {
    const canvas = document.querySelector<HTMLElement>(".workspace-stage > .react-flow");
    if (!canvas) return;
    const update = () => {
      const next = readCanvasFitPadding();
      setPadding((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    };
    update();
    const observer = new ResizeObserver(update);
    for (const element of [canvas, canvas.parentElement?.querySelector(".tool-rail"), canvas.querySelector(".react-flow__minimap")]) {
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, []);
  return <Controls onInteractiveChange={onInteractiveChange} fitViewOptions={{ padding, ...(includeHiddenNodes ? { includeHiddenNodes: true } : {}) }} />;
}

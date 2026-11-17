import { createContext, useContext, useLayoutEffect } from "react";

/** One render-safety signal, not a graph, geometry or viewport owner. */
export const CanvasDomSafetyContext = createContext<{
  reportMiniMapReady: (ready: boolean) => void;
} | null>(null);

/** A legacy/unavailable MiniMap must never lose unmounted records from its overview. */
export function useReportDomMiniMapReady(ready: boolean) {
  const report = useContext(CanvasDomSafetyContext)?.reportMiniMapReady;
  useLayoutEffect(() => {
    report?.(ready);
    return () => { report?.(false); };
  }, [report, ready]);
}

export const useDomFitIncludesHidden = () => useContext(CanvasDomSafetyContext) !== null;

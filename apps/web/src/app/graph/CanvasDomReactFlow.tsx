import { ReactFlow, useNodesInitialized, type Edge, type Node, type ReactFlowProps } from "@xyflow/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { NODE_DOM_VIRTUALIZATION_ENABLED } from "./canvasDomExperiment";
import { CanvasDomSafetyContext } from "./CanvasDomSafety";
import { useNodeDomPresentationReader } from "./CanvasNodePresentation";
import { projectNodeDomVisibility } from "./nodeDomProjection";

type Props<N extends Node, E extends Edge> = ReactFlowProps<N, E> & {
  domVirtualizationEnabled?: boolean;
  domVirtualizationSuspended?: boolean;
};
const initializedOptions = { includeHiddenNodes: true };
const empty = new Set<string>();
const serverSnapshot = () => empty;
const noSubscription = () => () => {};

/** Off is a literal passthrough: no aggregate subscription or camera/DOM lifetime. */
export function CanvasDomReactFlow<N extends Node, E extends Edge>({
  domVirtualizationEnabled = NODE_DOM_VIRTUALIZATION_ENABLED, domVirtualizationSuspended = false, ...props
}: Props<N, E>) {
  const reader = useNodeDomPresentationReader();
  const active = Boolean(domVirtualizationEnabled && reader && props.nodes);
  const candidates = useSyncExternalStore(active ? reader!.subscribeDom : noSubscription,
    active ? reader!.getDomHiddenIds : serverSnapshot, serverSnapshot);
  const [initialized, reportInitialized] = useState(false);
  const [pointerActive, setPointerActive] = useState(false);
  const [focusActive, setFocusActive] = useState(false);
  const [miniMapReady, reportMiniMapReady] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const safety = useMemo(() => ({ reportMiniMapReady }), []);
  const canElide = active && initialized && miniMapReady && !domVirtualizationSuspended && !pointerActive && !focusActive;
  const nodes = useMemo(() => props.nodes
    ? projectNodeDomVisibility(props.nodes, candidates, canElide) : props.nodes, [props.nodes, candidates, canElide]);
  const fitViewOptions = useMemo(() => active ? { ...props.fitViewOptions, includeHiddenNodes: true }
    : props.fitViewOptions, [active, props.fitViewOptions]);

  useLayoutEffect(() => {
    setPointerActive(false);
    setFocusActive(Boolean(active && root.current?.contains(document.activeElement)));
  }, [active]);

  useEffect(() => {
    if (!active || !pointerActive) return;
    const release = () => setPointerActive(false);
    const blur = () => { release(); setFocusActive(false); };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", blur);
    };
  }, [active, pointerActive]);

  // Keep the same React Flow instance when Off/Flow/fallback changes; a branch
  // swapping component types would reset the engine/camera during rollback.
  return <CanvasDomSafetyContext.Provider value={active ? safety : null}>
    <ReactFlow {...props} ref={active ? root : undefined} nodes={nodes} fitViewOptions={fitViewOptions}
      onPointerDownCapture={active ? event => { setPointerActive(true); props.onPointerDownCapture?.(event); } : props.onPointerDownCapture}
      onPointerUpCapture={active ? event => { setPointerActive(false); props.onPointerUpCapture?.(event); } : props.onPointerUpCapture}
      onPointerCancelCapture={active ? event => { setPointerActive(false); props.onPointerCancelCapture?.(event); } : props.onPointerCancelCapture}
      onFocusCapture={active ? event => { setFocusActive(true); props.onFocusCapture?.(event); } : props.onFocusCapture}
      onBlurCapture={active ? event => {
        setFocusActive(Boolean(event.relatedTarget && event.currentTarget.contains(event.relatedTarget)));
        props.onBlurCapture?.(event);
      } : props.onBlurCapture}
      onKeyDownCapture={active ? event => { setFocusActive(true); props.onKeyDownCapture?.(event); } : props.onKeyDownCapture}
      children={active ? <>{props.children}<InitializationGuard report={reportInitialized} /></> : props.children}
    />
  </CanvasDomSafetyContext.Provider>;
}

function InitializationGuard({ report }: { report: (ready: boolean) => void }) {
  const ready = useNodesInitialized(initializedOptions);
  useLayoutEffect(() => { report(ready); return () => report(false); }, [ready, report]);
  return null;
}

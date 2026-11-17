import { useStore, ViewportPortal, type Edge } from "@xyflow/react";
import { useLayoutEffect, useRef, useState } from "react";
import { createEdgeDomObservation, type EdgeDomObservationSnapshot } from "./edgeDomObservation";
import type { ViewportScope } from "./viewportEligibility";

// Diagnostic read-only collection is separate from the approved Graph card-body preference.
export const EDGE_GEOMETRY_OBSERVATION_ENABLED = false;
export interface CanvasEdgeGeometryInputs {
  readonly edges: readonly Pick<Edge, "id" | "selected">[];
  readonly scope: ViewportScope;
  readonly resetKey: unknown;
  readonly protectedEdgeIds?: readonly string[];
  readonly onMeasured?: (value: EdgeDomObservationSnapshot | null) => void;
  readonly enabled?: boolean;
}

/** Disabled observation adds no camera subscription, observer, frame or DOM read. */
export function CanvasEdgeGeometryBridge(props: CanvasEdgeGeometryInputs) {
  return (props.enabled ?? EDGE_GEOMETRY_OBSERVATION_ENABLED) ? <CommittedEdgeGeometryBridge {...props} /> : null;
}

function CommittedEdgeGeometryBridge({ edges, scope, resetKey, protectedEdgeIds, onMeasured }: CanvasEdgeGeometryInputs) {
  const root = useStore((state) => state.domNode);
  const transform = useStore((state) => state.transform);
  const width = useStore((state) => state.width), height = useStore((state) => state.height);
  const owner = useRef<ReturnType<typeof createEdgeDomObservation> | null>(null);
  const documentVersion = useRef(0);
  const [worldSpace, setWorldSpace] = useState<SVGGElement | null>(null);
  const listener = useRef(onMeasured);
  // Parent report state may recreate equal arrays; that must not schedule a new report forever.
  const protectionKey = JSON.stringify(protectedEdgeIds ?? []);
  useLayoutEffect(() => { listener.current = onMeasured; }, [onMeasured]);
  useLayoutEffect(() => {
    if (!root || !worldSpace) return;
    // The footprint owner receives only a primitive instance token, never the manifest.
    const observer = createEdgeDomObservation(root, { scope, resetKey: ++documentVersion.current },
      { request: (callback) => requestAnimationFrame(callback), cancel: (id) => cancelAnimationFrame(id) },
      (value) => listener.current?.(value), worldSpace);
    owner.current = observer;
    return () => { owner.current = null; observer.dispose(); listener.current?.(null); };
  }, [root, worldSpace, scope.projectId, scope.workspaceMode, scope.flowId, scope.focusedFrameId, resetKey]);
  useLayoutEffect(() => {
    owner.current?.update({ ids: edges.map((edge) => edge.id),
      protectedIds: new Set([...(protectedEdgeIds ?? []), ...edges.filter((edge) => edge.selected).map((edge) => edge.id)]),
      viewport: { x: transform[0], y: transform[1], zoom: transform[2], width, height } });
  }, [root, worldSpace, edges, protectionKey, transform, width, height, scope.projectId, scope.workspaceMode, scope.flowId, scope.focusedFrameId, resetKey]);
  return <ViewportPortal><svg aria-hidden="true" focusable="false" data-edge-world-anchor="true"
    style={{ position: "absolute", left: 0, top: 0, width: 0, height: 0, pointerEvents: "none" }}><g ref={setWorldSpace} /></svg></ViewportPortal>;
}

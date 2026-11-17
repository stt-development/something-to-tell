import { createEdgeFootprintStore, type EdgeFootprintContext } from "./edgeFootprintStore";
import { measureEdgeLabelBox } from "./edgeLabelDomMeasurement";
import { measureEdgeWorldFootprint } from "./edgeWorldFootprint";
import { createSvgMarkerReferenceReader } from "./svgMarkerReferences";
import { queryViewportEdgeEligibility, type ViewportEdgeEligibility } from "./viewportEdgeEligibility";
import type { CanvasViewport, WorldRectangle } from "./viewportEligibility";
import type { EligibilityFrameClock } from "./viewportEligibilityScheduler";

export interface EdgeDomObservationInputs {
  readonly ids: readonly string[];
  readonly viewport: CanvasViewport;
  readonly protectedIds?: ReadonlySet<string>;
}
export interface EdgeDomObservationSnapshot {
  readonly footprints: NonNullable<ReturnType<ReturnType<typeof createEdgeFootprintStore>["read"]>>;
  readonly eligibility: ViewportEdgeEligibility;
  /** Diagnostic layout boxes are NOT certified painted eligibility bounds. */
  readonly labelBoxes: readonly { readonly id: string; readonly bounds: WorldRectangle | null }[];
}

function uniqueElements<T extends Element>(root: HTMLElement, selector: string, attribute: string): Map<string, T | null> {
  const found = new Map<string, T | null>();
  for (const element of root.querySelectorAll<T>(selector)) {
    const id = element.getAttribute(attribute)!;
    found.set(id, found.has(id) ? null : element);
  }
  return found;
}

/** One mounted diagnostic view: DOM/frame lifetime only, never a graph or presentation owner. */
export function createEdgeDomObservation(root: HTMLElement, context: EdgeFootprintContext,
  frames: EligibilityFrameClock, onMeasured?: (value: EdgeDomObservationSnapshot | null) => void, worldSpace: SVGGraphicsElement | null = null) {
  const store = createEdgeFootprintStore();
  const scope = Object.freeze({ projectId: context.scope.projectId, workspaceMode: context.scope.workspaceMode,
    flowId: context.scope.flowId, focusedFrameId: context.scope.focusedFrameId });
  const resetKey = context.resetKey;
  let inputs: EdgeDomObservationInputs | null = null, version = 0, disposed = false;
  let pending: { id?: number } | null = null, snapshot: EdgeDomObservationSnapshot | null = null;
  let previous: ViewportEdgeEligibility | null = null;
  const document = root.ownerDocument, window = document.defaultView, fonts = document.fonts;
  const observedLabels = new Set<HTMLElement>();
  const resize = window?.ResizeObserver ? new window.ResizeObserver(invalidate) : null;
  const mutations = window?.MutationObserver ? new window.MutationObserver(invalidate) : null;

  function invalidate() {
    if (disposed || !inputs) return;
    version++;
    // Retire trust immediately; do not copy every edge on each event in a resize burst.
    store.commit(null);
    if (snapshot) { snapshot = null; onMeasured?.(null); }
    if (disposed || !inputs || pending) return;
    const ticket: { id?: number } = {}; pending = ticket;
    ticket.id = frames.request(() => {
      if (disposed || pending !== ticket || !inputs) return;
      pending = null;
      const current = inputs, currentVersion = version;
      store.commit({ scope, resetKey, edges: current.ids.map((id) => ({ id, geometryKey: currentVersion })) });
      const paths = uniqueElements<SVGPathElement>(root, "path[data-narrative-edge-route]", "data-narrative-edge-route");
      const labels = uniqueElements<HTMLElement>(root, "[data-narrative-edge-label]", "data-narrative-edge-label");
      const nextLabels = new Set(current.ids.map((id) => labels.get(id)).filter((label): label is HTMLElement => label != null));
      for (const label of observedLabels) if (!nextLabels.has(label)) { resize?.unobserve(label); observedLabels.delete(label); }
      for (const label of nextLabels) if (!observedLabels.has(label)) { resize?.observe(label); observedLabels.add(label); }
      const markers = createSvgMarkerReferenceReader(root);
      let labelBoxes: EdgeDomObservationSnapshot["labelBoxes"];
      try { labelBoxes = current.ids.map((id) => {
        const measurement = store.beginMeasurement({ scope, resetKey, id, geometryKey: currentVersion });
        const path = paths.get(id), label = labels.get(id);
        const absent = root.isConnected && path?.isConnected && path.getAttribute("data-narrative-edge-label-state") === "none" && !labels.has(id);
        const bounds = path && label ? measureEdgeLabelBox(label, path) : null;
        const footprint = worldSpace ? measureEdgeWorldFootprint({ id, root, worldSpace, route: path ?? null, label: label ?? null,
          labelAbsent: Boolean(absent), markerOutset: markers.measure }) : { id, routeBounds: null, label: { kind: absent ? "none" as const : "unknown" as const } };
        if (measurement) store.publish(measurement, footprint);
        return Object.freeze({ id, bounds });
      }); } finally { markers.dispose(); }
      // A measurement callback can synchronously replace the committed view.
      if (disposed || inputs !== current || version !== currentVersion) return;
      const footprints = store.read(); if (!footprints) return;
      const eligibility = queryViewportEdgeEligibility({ ...footprints, viewport: current.viewport, protectedIds: current.protectedIds, previous });
      previous = { ...eligibility, scope, eligibleIds: new Set(eligibility.eligibleIds), unknownGeometryIds: new Set(eligibility.unknownGeometryIds) };
      snapshot = Object.freeze({ footprints, eligibility, labelBoxes: Object.freeze(labelBoxes) });
      onMeasured?.(snapshot);
    });
  }

  mutations?.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
  resize?.observe(root);
  window?.addEventListener("scroll", invalidate, true);
  window?.addEventListener("resize", invalidate);
  for (const event of ["loading", "loadingdone", "loadingerror"]) fonts?.addEventListener(event, invalidate);

  return {
    update(next: EdgeDomObservationInputs) {
      if (disposed) return;
      const { x, y, width, height, zoom } = next.viewport;
      inputs = { ids: [...next.ids], viewport: { x, y, width, height, zoom }, protectedIds: new Set(next.protectedIds) };
      invalidate();
    },
    getSnapshot: () => snapshot,
    dispose() {
      if (disposed) return;
      disposed = true; inputs = null; snapshot = null; previous = null;
      const ticket = pending; pending = null;
      if (ticket?.id !== undefined) frames.cancel(ticket.id);
      mutations?.disconnect(); resize?.disconnect(); observedLabels.clear();
      window?.removeEventListener("scroll", invalidate, true); window?.removeEventListener("resize", invalidate);
      for (const event of ["loading", "loadingdone", "loadingerror"]) fonts?.removeEventListener(event, invalidate);
      store.dispose();
    }
  };
}

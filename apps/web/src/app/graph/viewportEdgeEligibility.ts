import {
  sameViewportScope, VIEWPORT_ENTRY_OVERSCAN_CSS_PX, VIEWPORT_RELEASE_OVERSCAN_CSS_PX,
  type CanvasViewport, type ViewportScope, type WorldRectangle
} from "./viewportEligibility";

export type ViewportEdgeLabel =
  | { readonly kind: "none" }
  | { readonly kind: "unknown" }
  | { readonly kind: "measured"; readonly bounds: WorldRectangle };

/** Caller-proven whole painted/hit footprint, never an endpoint-only rectangle. */
export interface ViewportEdgeFootprint {
  readonly id: string;
  readonly routeBounds?: WorldRectangle | null;
  readonly label: ViewportEdgeLabel;
}
export interface ViewportEdgeEligibility {
  readonly scope: ViewportScope;
  readonly eligibleIds: ReadonlySet<string>;
  readonly unknownGeometryIds: ReadonlySet<string>;
  readonly fallback: "none" | "viewport" | "identity";
}
export interface ViewportEdgeEligibilityInputs {
  readonly scope: ViewportScope;
  readonly edges: readonly ViewportEdgeFootprint[];
  readonly viewport: CanvasViewport;
  readonly previous?: ViewportEdgeEligibility | null;
  readonly protectedIds?: ReadonlySet<string>;
}

interface Bounds { left: number; top: number; right: number; bottom: number }
function bounds(rectangle: WorldRectangle | null | undefined): Bounds | null {
  if (!rectangle) return null;
  const { x, y, width, height } = rectangle;
  const right = x + width, bottom = y + height;
  // SVG line footprints may be degenerate; node-card positive-size rules do not apply.
  return [x, y, width, height, right, bottom].every(Number.isFinite) && width >= 0 && height >= 0
    ? { left: x, top: y, right, bottom } : null;
}
function bands(viewport: CanvasViewport): { entry: Bounds; release: Bounds } | null {
  const { x, y, width, height, zoom } = viewport;
  if (![x, y, width, height, zoom].every(Number.isFinite) || width <= 0 || height <= 0 || zoom < 0.01 || zoom > 10) return null;
  const band = (margin: number) => bounds({ x: (-x - margin) / zoom, y: (-y - margin) / zoom,
    width: (width + margin * 2) / zoom, height: (height + margin * 2) / zoom });
  const entry = band(VIEWPORT_ENTRY_OVERSCAN_CSS_PX), release = band(VIEWPORT_RELEASE_OVERSCAN_CSS_PX);
  return entry && release ? { entry, release } : null;
}
const intersects = (a: Bounds, b: Bounds) => a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;

/** Invocation-local candidate query only; App does not yet consume it or exclude any edges. */
export function queryViewportEdgeEligibility({ scope, viewport, edges, previous, protectedIds }: ViewportEdgeEligibilityInputs): ViewportEdgeEligibility {
  const currentScope: ViewportScope = { projectId: scope.projectId, workspaceMode: scope.workspaceMode,
    flowId: scope.flowId, focusedFrameId: scope.focusedFrameId };
  const regions = bands(viewport);
  const retained = previous && sameViewportScope(previous.scope, currentScope) ? previous.eligibleIds : undefined;
  const ids = new Set<string>(), eligibleIds = new Set<string>(), unknownGeometryIds = new Set<string>();
  let ambiguous = false;
  for (const { id, routeBounds, label } of edges) {
    if (!id || ids.has(id)) ambiguous = true;
    ids.add(id);
    if (!regions) continue;
    const route = bounds(routeBounds), measuredLabel = label?.kind === "measured" ? bounds(label.bounds) : null;
    const labelKnown = label?.kind === "none" || (measuredLabel !== null
      && measuredLabel.right > measuredLabel.left && measuredLabel.bottom > measuredLabel.top);
    const unknown = !route || !labelKnown;
    const protectedEdge = protectedIds?.has(id) ?? false;
    const region = retained?.has(id) ? regions.release : regions.entry;
    if (unknown) unknownGeometryIds.add(id);
    if (unknown || protectedEdge || (route && intersects(route, region)) || (measuredLabel && intersects(measuredLabel, region))) eligibleIds.add(id);
  }
  // Scope-wide uncertainty cannot selectively exclude an ambiguous current identity.
  const fallback = !regions ? "viewport" : ambiguous ? "identity" : "none";
  return { scope: currentScope, eligibleIds: fallback === "none" ? eligibleIds : ids, unknownGeometryIds, fallback };
}

export const VIEWPORT_ENTRY_OVERSCAN_CSS_PX = 240;
export const VIEWPORT_RELEASE_OVERSCAN_CSS_PX = 360;

export interface ViewportScope {
  readonly projectId: string;
  readonly workspaceMode: "relationships" | "flow";
  readonly flowId: string | null;
  readonly focusedFrameId: string | null;
}
export interface WorldRectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export interface ViewportPlacement {
  readonly id: string;
  readonly parentId?: string | null;
  readonly worldBounds?: WorldRectangle | null;
}
/** Canvas size and camera translation in CSS pixels, plus graph scale. */
export interface CanvasViewport {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly zoom: number;
}
export type EligibilityFallback = "none" | "viewport" | "geometry" | "identity" | "ancestry";
export interface ViewportEligibility {
  readonly scope: ViewportScope;
  readonly eligibleIds: ReadonlySet<string>;
  readonly fallback: EligibilityFallback;
}
export interface ViewportEligibilityInputs {
  readonly scope: ViewportScope;
  readonly placements: readonly ViewportPlacement[];
  readonly viewport: CanvasViewport;
  readonly previous?: ViewportEligibility | null;
  /** Union of current selected/edited/gesture/endpoint/navigation placement ids. */
  readonly protectedIds?: ReadonlySet<string>;
}

interface Bounds { left: number; top: number; right: number; bottom: number }
function rectangleBounds(rectangle: WorldRectangle | null | undefined): Bounds | null {
  if (!rectangle) return null;
  const { x, y, width, height } = rectangle;
  const right = x + width, bottom = y + height;
  return [x, y, width, height, right, bottom].every(Number.isFinite) && width > 0 && height > 0
    ? { left: x, top: y, right, bottom } : null;
}
/** Scope identity is shared by the pure query and its frame scheduler. */
export function sameViewportScope(a: ViewportScope, b: ViewportScope): boolean {
  return a.projectId === b.projectId && a.workspaceMode === b.workspaceMode
    && a.flowId === b.flowId && a.focusedFrameId === b.focusedFrameId;
}
function viewportBands(viewport: ViewportEligibilityInputs["viewport"]): { entry: Bounds; release: Bounds } | null {
  const { x, y, width, height, zoom } = viewport;
  if (![x, y, width, height, zoom].every(Number.isFinite) || width <= 0 || height <= 0 || zoom < 0.01 || zoom > 10) return null;
  const band = (margin: number) => rectangleBounds({ x: (-x - margin) / zoom, y: (-y - margin) / zoom,
    width: (width + margin * 2) / zoom, height: (height + margin * 2) / zoom });
  const entry = band(VIEWPORT_ENTRY_OVERSCAN_CSS_PX), release = band(VIEWPORT_RELEASE_OVERSCAN_CSS_PX);
  return entry && release ? { entry, release } : null;
}
const intersects = (a: Bounds, b: Bounds) => a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;

/** Shared conservative camera guard; a DOM adapter must not reuse an invalid viewport's old mask. */
export const hasUsableCanvasViewport = (viewport: CanvasViewport): boolean => viewportBands(viewport) !== null;

/** Pure membership query over current projected world geometry; never stores nodes or schedules work. */
export function queryViewportEligibility({ scope, placements, viewport, previous, protectedIds }: ViewportEligibilityInputs): ViewportEligibility {
  const currentScope: ViewportScope = { projectId: scope.projectId, workspaceMode: scope.workspaceMode,
    flowId: scope.flowId, focusedFrameId: scope.focusedFrameId };
  const bands = viewportBands(viewport);
  const retained = previous && sameViewportScope(previous.scope, currentScope) ? previous.eligibleIds : undefined;
  const parents = new Map<string, string | null>();
  const eligibleIds = new Set<string>();
  let duplicate = false, unknownGeometry = false;
  for (const placement of placements) {
    const { id, parentId, worldBounds } = placement;
    if (parents.has(id)) duplicate = true;
    parents.set(id, parentId ?? null);
    const bounds = rectangleBounds(worldBounds);
    if (!bounds) unknownGeometry = true;
    if (protectedIds?.has(id) || (bounds && bands && intersects(bounds, retained?.has(id) ? bands.release : bands.entry))) eligibleIds.add(id);
  }
  // Any incomplete model is conservative: no blank mask or selective loss of uncertain descendants.
  const all = (fallback: EligibilityFallback): ViewportEligibility => ({ scope: currentScope, eligibleIds: new Set(parents.keys()), fallback });
  if (!bands) return all("viewport");
  if (duplicate) return all("identity");
  if (unknownGeometry) return all("geometry");
  for (const parent of parents.values()) if (parent !== null && !parents.has(parent)) return all("ancestry");

  // Validate the complete chain once, including cycles outside the current viewport.
  const states = new Map<string, "visiting" | "done">();
  for (const id of parents.keys()) {
    let current: string | null = id;
    const trail: string[] = [];
    while (current !== null && states.get(current) !== "done") {
      if (states.get(current) === "visiting") return all("ancestry");
      states.set(current, "visiting");
      trail.push(current);
      current = parents.get(current) ?? null;
    }
    for (const visited of trail) states.set(visited, "done");
  }
  // Set iteration includes newly added ancestors, visiting each retained id at most once.
  for (const id of eligibleIds) {
    const parent = parents.get(id);
    if (parent != null) eligibleIds.add(parent);
  }
  return { scope: currentScope, eligibleIds, fallback: "none" };
}

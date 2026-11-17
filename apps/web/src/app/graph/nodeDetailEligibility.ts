import policy from "../../../performance/rendering-policy.v1.json";
import { sameViewportScope, type ViewportPlacement, type ViewportScope } from "./viewportEligibility";

export type NodeDetailBand = "overview" | "compact" | "full";
export type NodeDetailMode = NodeDetailBand | "folded";
export interface NodeDetailRow {
  readonly mode: NodeDetailMode;
  readonly depth: number | null;
  readonly foldedDirect: number;
  readonly foldedDescendants: number;
}
export interface NodeDetailEligibility {
  readonly scope: ViewportScope;
  readonly band: NodeDetailBand;
  readonly visibleLevels: number;
  readonly details: ReadonlyMap<string, NodeDetailRow>;
  readonly fallback: "none" | "zoom" | "identity" | "ancestry";
}
export interface NodeDetailEligibilityInputs {
  readonly scope: ViewportScope;
  readonly placements: readonly Pick<ViewportPlacement, "id" | "parentId">[];
  readonly zoom: number;
  /** Existing presentation/interaction owner supplies its ancestor-closed visual ids. */
  readonly protectedIds?: ReadonlySet<string>;
  readonly previous?: Pick<NodeDetailEligibility, "scope" | "band" | "visibleLevels" | "fallback"> | null;
}

function nominalLevels(zoom: number): number {
  return policy.base_visible_levels + (zoom < policy.extra_level_zoom ? 0 : 1 + Math.floor(Math.log2(zoom / policy.extra_level_zoom)));
}
function zoomState(zoom: number, previous: NodeDetailEligibilityInputs["previous"]): { band: NodeDetailBand; visibleLevels: number } {
  let band: NodeDetailBand = zoom >= policy.full_zoom ? "full" : zoom >= policy.compact_zoom ? "compact" : "overview";
  const nominal = nominalLevels(zoom);
  let visibleLevels = nominal;
  if (previous) {
    const full = policy.full_zoom * (1 + (previous.band === "full" ? -1 : 1) * policy.zoom_hysteresis_ratio);
    const compact = policy.compact_zoom * (1 + (previous.band === "overview" ? 1 : -1) * policy.zoom_hysteresis_ratio);
    band = zoom >= full ? "full" : zoom >= compact ? "compact" : "overview";
    if (zoom !== policy.max_zoom) visibleLevels = nominal > previous.visibleLevels
      ? Math.max(previous.visibleLevels, nominalLevels(zoom / (1 + policy.zoom_hysteresis_ratio)))
      : Math.min(previous.visibleLevels, nominalLevels(zoom / (1 - policy.zoom_hysteresis_ratio)));
  }
  return { band, visibleLevels };
}

/** Invocation-local detail policy only: no graph, renderer, DOM, cache or selection ownership. */
export function queryNodeDetailEligibility({ scope, placements, zoom, protectedIds, previous }: NodeDetailEligibilityInputs): NodeDetailEligibility {
  const currentScope = Object.freeze({ projectId: scope.projectId, workspaceMode: scope.workspaceMode,
    flowId: scope.flowId, focusedFrameId: scope.focusedFrameId });
  const parents = new Map<string, string | null>();
  const fallback = (reason: NodeDetailEligibility["fallback"]): NodeDetailEligibility => Object.freeze({ scope: currentScope,
    band: "full", visibleLevels: policy.base_visible_levels, fallback: reason,
    details: new Map(placements.map(({ id }) => [id, Object.freeze({ mode: "full" as const, depth: null, foldedDirect: 0, foldedDescendants: 0 })])) });
  for (const { id, parentId } of placements) {
    if (!id || parents.has(id)) return fallback("identity");
    parents.set(id, parentId ?? null);
  }
  if (!Number.isFinite(zoom) || zoom < policy.min_zoom || zoom > policy.max_zoom) return fallback("zoom");
  const prior = previous?.fallback === "none" && sameViewportScope(previous.scope, currentScope)
    && ["overview", "compact", "full"].includes(previous.band) && Number.isInteger(previous.visibleLevels)
    && previous.visibleLevels >= policy.base_visible_levels && previous.visibleLevels <= nominalLevels(policy.max_zoom) ? previous : null;
  const { band, visibleLevels } = zoomState(zoom, prior);
  const depths = new Map<string, number>(), order: string[] = [];
  // Memoized iterative chains visit each visual placement once, even for a very deep tree.
  for (const id of parents.keys()) {
    const chain: string[] = [], seen = new Set<string>();
    let current: string | null = id;
    while (current !== null && !depths.has(current)) {
      if (seen.has(current) || !parents.has(current)) return fallback("ancestry");
      seen.add(current); chain.push(current); current = parents.get(current)!;
    }
    let depth = current === null ? -1 : depths.get(current)!;
    for (let index = chain.length - 1; index >= 0; index--) { const child = chain[index]!; depths.set(child, ++depth); order.push(child); }
  }
  const modes = new Map(order.map((id) => [id, protectedIds?.has(id) ? "full" as const : depths.get(id)! >= visibleLevels ? "folded" as const : band]));
  const direct = new Map<string, number>(), descendants = new Map<string, number>();
  // Count visual rows, not canonical entities. Protected controls are not folded.
  for (let index = order.length - 1; index >= 0; index--) {
    const id = order[index]!, parent = parents.get(id);
    if (parent === null || parent === undefined) continue;
    const folded = modes.get(id) === "folded" ? 1 : 0;
    direct.set(parent, (direct.get(parent) ?? 0) + folded);
    descendants.set(parent, (descendants.get(parent) ?? 0) + folded + (descendants.get(id) ?? 0));
  }
  return Object.freeze({ scope: currentScope, band, visibleLevels, fallback: "none", details: new Map(placements.map(({ id }) => [id,
    Object.freeze({ mode: modes.get(id)!, depth: depths.get(id)!, foldedDirect: direct.get(id) ?? 0, foldedDescendants: descendants.get(id) ?? 0 })])) });
}

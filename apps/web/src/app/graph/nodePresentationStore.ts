import { hasUsableCanvasViewport, sameViewportScope, type ViewportEligibility, type ViewportPlacement } from "./viewportEligibility";
import type { CommittedEligibilityInputs } from "./viewportEligibilityScheduler";
import { queryNodeDetailEligibility, type NodeDetailEligibility, type NodeDetailRow } from "./nodeDetailEligibility";

export type NodePresentationRow = Omit<NodeDetailRow, "mode"> & { readonly mode: NodeDetailRow["mode"] | "shell" };
export const FULL_NODE_PRESENTATION: NodePresentationRow = Object.freeze({ mode: "full", depth: null, foldedDirect: 0, foldedDescendants: 0 });
const shell: NodePresentationRow = Object.freeze({ ...FULL_NODE_PRESENTATION, mode: "shell" });

export interface NodePresentationReader {
  isFull(id: string): boolean;
  getPresentation(id: string): NodePresentationRow;
  subscribe(id: string, listener: () => void): () => void;
  /** Default-Off DOM adapter only. The snapshot is derived, never another mask owner. */
  getDomHiddenIds(): ReadonlySet<string>;
  subscribeDom(listener: () => void): () => void;
}

function sameGeometry(a: ViewportPlacement | undefined, b: ViewportPlacement | undefined): boolean {
  return Boolean(a?.worldBounds && b?.worldBounds && a.parentId === b.parentId
    && a.worldBounds.x === b.worldBounds.x && a.worldBounds.y === b.worldBounds.y
    && a.worldBounds.width === b.worldBounds.width && a.worldBounds.height === b.worldBounds.height);
}

/** Single view-only spatial/detail owner. The canonical graph stays in Zustand. */
export function createNodePresentationStore() {
  let inputs: CommittedEligibilityInputs | null = null;
  let mask: ViewportEligibility | null = null;
  let geometry = new Map<string, ViewportPlacement>();
  let evaluatedGeometry = geometry;
  let spatialEnabled = true, detailEnabled = false;
  let detail: NodeDetailEligibility | null = null;
  let detailInputs: { placements: CommittedEligibilityInputs["placements"]; protectedIds: CommittedEligibilityInputs["protectedIds"];
    zoom: number; revealedPaths: ReadonlySet<string> } | null = null;
  const revealed = new Set<string>();
  let revealedPaths = new Set<string>();
  const listeners = new Map<string, Set<() => void>>();
  const domListeners = new Set<() => void>();
  const emptyDomIds: ReadonlySet<string> = new Set();
  let domIds = emptyDomIds, revision = 0, domRevision = -1;

  function readDomIds(): ReadonlySet<string> {
    if (domRevision === revision) return domIds;
    const next = new Set<string>();
    if (spatialEnabled && inputs && hasUsableCanvasViewport(inputs.viewport)) {
      for (const id of geometry.keys()) if (presentation(id).mode === "shell") next.add(id);
    }
    if (next.size !== domIds.size || [...next].some(id => !domIds.has(id))) domIds = next.size ? next : emptyDomIds;
    domRevision = revision;
    return domIds;
  }

  const presentation = (id: string): NodePresentationRow => {
    if (!inputs || !mask || mask.fallback !== "none" || !geometry.has(id)
      || !sameGeometry(geometry.get(id), evaluatedGeometry.get(id))) return FULL_NODE_PRESENTATION;
    // Explicit reveal affects detail only; it must not become an offscreen visited-card cache.
    const protectedId = inputs.protectedIds?.has(id);
    if (protectedId && detail?.details.get(id)?.mode !== "full") return FULL_NODE_PRESENTATION;
    if (spatialEnabled && !protectedId && !mask.eligibleIds.has(id)) return shell;
    return detailEnabled ? detail?.details.get(id) ?? FULL_NODE_PRESENTATION : FULL_NODE_PRESENTATION;
  };
  const isFull = (id: string): boolean => presentation(id).mode === "full";

  const detailIsCurrent = () => inputs !== null && detailInputs?.placements === inputs.placements
    && detailInputs.protectedIds === inputs.protectedIds && detailInputs.zoom === inputs.viewport.zoom && detailInputs.revealedPaths === revealedPaths;

  function evaluateDetail() {
    if (!detailEnabled || !inputs || !mask || mask.fallback !== "none") { detail = null; detailInputs = null; return; }
    // Pan-only frames change spatial membership, not depth, zoom band or folded counts.
    if (detail && detailIsCurrent()) return;
    const next = queryNodeDetailEligibility({ ...inputs, zoom: inputs.viewport.zoom,
      protectedIds: new Set([...(inputs.protectedIds ?? []), ...revealedPaths]), previous: detail });
    // useSyncExternalStore snapshots must remain referentially stable for equal rows.
    const rows = new Map(next.details);
    for (const [id, row] of rows) {
      const prior = detail?.details.get(id);
      if (prior && prior.mode === row.mode && prior.depth === row.depth && prior.foldedDirect === row.foldedDirect
        && prior.foldedDescendants === row.foldedDescendants) rows.set(id, prior);
    }
    detail = { ...next, details: rows };
    detailInputs = { placements: inputs.placements, protectedIds: inputs.protectedIds, zoom: inputs.viewport.zoom, revealedPaths };
  }

  function rebuildRevealPaths() {
    revealedPaths = new Set();
    for (const id of revealed) {
      let current: string | undefined = id;
      while (current && geometry.has(current) && !revealedPaths.has(current)) {
        revealedPaths.add(current); current = geometry.get(current)?.parentId ?? undefined;
      }
    }
  }

  function change(mutate: () => void) {
    const before = new Map([...listeners.keys()].map((id) => [id, presentation(id)]));
    const oldDomIds = domIds;
    mutate();
    revision++;
    if (domListeners.size) readDomIds();
    for (const [id, previous] of before) if (previous !== presentation(id)) {
      for (const listener of [...(listeners.get(id) ?? [])]) listener();
    }
    if (domIds !== oldDomIds) for (const listener of [...domListeners]) listener();
  }

  const reader: NodePresentationReader = {
    isFull,
    getPresentation: presentation,
    getDomHiddenIds: readDomIds,
    subscribeDom(listener) {
      domListeners.add(listener);
      return () => {
        domListeners.delete(listener);
        if (!domListeners.size) { domIds = emptyDomIds; domRevision = -1; }
      };
    },
    subscribe(id, listener) {
      const entry = listeners.get(id) ?? new Set();
      entry.add(listener);
      listeners.set(id, entry);
      return () => { entry.delete(listener); if (!entry.size) listeners.delete(id); };
    }
  };
  return {
    reader,
    configure(next: { spatialEnabled: boolean; detailEnabled: boolean }) {
      if (next.spatialEnabled === spatialEnabled && next.detailEnabled === detailEnabled) return;
      change(() => {
        spatialEnabled = next.spatialEnabled; detailEnabled = next.detailEnabled;
        detail = null; detailInputs = null; if (!detailEnabled) { revealed.clear(); revealedPaths.clear(); }
      });
    },
    /** Explicit view-only reveal, never authored Collapse or canonical selection. */
    reveal(id: string) {
      if (!detailEnabled || !geometry.has(id)) return;
      change(() => {
        revealed.add(id); rebuildRevealPaths();
        evaluateDetail();
      });
    },
    commit(next: CommittedEligibilityInputs | null) {
      if (inputs && next && sameViewportScope(inputs.scope, next.scope) && Object.is(inputs.resetKey, next.resetKey)
        && inputs.placements === next.placements && inputs.protectedIds === next.protectedIds) {
        if (domListeners.size && !hasUsableCanvasViewport(next.viewport)) change(() => { inputs = next; });
        else { inputs = next; revision++; }
        return;
      }
      change(() => {
        if (!inputs || !next || !sameViewportScope(inputs.scope, next.scope) || !Object.is(inputs.resetKey, next.resetKey)) {
          mask = null;
          detail = null; detailInputs = null; revealed.clear(); revealedPaths.clear();
          evaluatedGeometry = new Map();
        }
        if (inputs?.placements !== next?.placements) geometry = new Map(next?.placements.map((node) => [node.id, node]));
        for (const id of revealed) if (!geometry.has(id)) revealed.delete(id);
        rebuildRevealPaths();
        inputs = next;
      });
    },
    publish(next: ViewportEligibility | null) {
      if (next && (!inputs || !sameViewportScope(next.scope, inputs.scope))) return;
      if (mask === next && evaluatedGeometry === geometry && (!detailEnabled || detailIsCurrent())) return;
      change(() => { mask = next; evaluatedGeometry = next ? geometry : new Map(); evaluateDetail(); });
    }
  };
}

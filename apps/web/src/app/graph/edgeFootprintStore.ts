import type { ViewportEdgeFootprint, ViewportEdgeLabel } from "./viewportEdgeEligibility";
import { sameViewportScope, type ViewportScope, type WorldRectangle } from "./viewportEligibility";

/** Primitive committed-input versions, never authored records or DOM references. */
export type EdgeGeometryKey = string | number;
export interface EdgeFootprintContext {
  readonly scope: ViewportScope;
  readonly resetKey: EdgeGeometryKey;
}
export interface EdgeFootprintCommit extends EdgeFootprintContext {
  readonly edges: readonly { readonly id: string; readonly geometryKey: EdgeGeometryKey }[];
}
export interface EdgeMeasurementRequest extends EdgeFootprintContext {
  readonly id: string;
  readonly geometryKey: EdgeGeometryKey;
}
export interface EdgeMeasurementTicket { readonly id: string }

const validKey = (value: unknown): value is EdgeGeometryKey => typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
const copyScope = (scope: ViewportScope): ViewportScope => Object.freeze({ projectId: scope.projectId,
  workspaceMode: scope.workspaceMode, flowId: scope.flowId, focusedFrameId: scope.focusedFrameId });

function copyRectangle(value: WorldRectangle | null | undefined, positive = false): WorldRectangle | null {
  if (!value) return null;
  const { x, y, width, height } = value;
  if (![x, y, width, height, x + width, y + height].every(Number.isFinite)
    || (positive ? width <= 0 || height <= 0 || x + width <= x || y + height <= y : width < 0 || height < 0)) return null;
  return Object.freeze({ x, y, width, height });
}
function copyFootprint(id: string, value?: ViewportEdgeFootprint): ViewportEdgeFootprint {
  const routeBounds = copyRectangle(value?.routeBounds);
  let label: ViewportEdgeLabel = { kind: "unknown" };
  if (value?.label?.kind === "none") label = { kind: "none" };
  else if (value?.label?.kind === "measured") {
    const measured = copyRectangle(value.label.bounds, true);
    if (measured) label = { kind: "measured", bounds: measured };
  }
  return Object.freeze({ id, routeBounds, label: Object.freeze(label) });
}

interface Entry {
  geometryKey: EdgeGeometryKey | null;
  footprint: ViewportEdgeFootprint;
  ticket: EdgeMeasurementTicket | null;
}

/** View-local committed measurements only; never owns routes, graph records or presentation masks. */
export function createEdgeFootprintStore() {
  let context: { scope: ViewportScope; resetKey: EdgeGeometryKey | null } | null = null;
  let ids: string[] = [], entries = new Map<string, Entry>(), measurable = false, disposed = false;
  const retire = () => { context = null; ids = []; entries.clear(); measurable = false; };
  return {
    commit(next: EdgeFootprintCommit | null) {
      if (disposed) return;
      if (!next) { retire(); return; }
      // Snapshot just primitive descriptors; caller arrays/objects are not retained.
      const rows = next.edges.map(({ id, geometryKey }) => ({ id, geometryKey: validKey(geometryKey) ? geometryKey : null }));
      const resetKey = validKey(next.resetKey) ? next.resetKey : null;
      const nextIds = rows.map((row) => row.id);
      const nextMeasurable = resetKey !== null && nextIds.every(Boolean) && new Set(nextIds).size === nextIds.length;
      const sameContext = context && resetKey !== null && Object.is(resetKey, context.resetKey) && sameViewportScope(context.scope, next.scope);
      const retained = sameContext && measurable && nextMeasurable ? entries : new Map<string, Entry>();
      entries = new Map(rows.map(({ id, geometryKey }) => {
        const previous = retained.get(id);
        return [id, previous && geometryKey !== null && Object.is(previous.geometryKey, geometryKey) ? previous
          : { geometryKey, footprint: copyFootprint(id), ticket: null }];
      }));
      context = { scope: copyScope(next.scope), resetKey }; ids = nextIds; measurable = nextMeasurable;
    },
    beginMeasurement(request: EdgeMeasurementRequest): EdgeMeasurementTicket | null {
      const entry = entries.get(request.id);
      if (!context || !measurable || !entry || entry.geometryKey === null || !validKey(request.geometryKey)
        || !Object.is(context.resetKey, request.resetKey) || !sameViewportScope(context.scope, request.scope)
        || !Object.is(entry.geometryKey, request.geometryKey)) return null;
      // New reads supersede old reads even if renderer inputs have not changed.
      entry.footprint = copyFootprint(request.id);
      entry.ticket = Object.freeze({ id: request.id });
      return entry.ticket;
    },
    publish(ticket: EdgeMeasurementTicket, footprint: ViewportEdgeFootprint): boolean {
      const entry = entries.get(ticket.id);
      if (!context || !measurable || !entry || entry.ticket !== ticket || footprint.id !== ticket.id) return false;
      entry.footprint = copyFootprint(ticket.id, footprint);
      entry.ticket = null;
      return true;
    },
    read(): { readonly scope: ViewportScope; readonly edges: readonly ViewportEdgeFootprint[] } | null {
      return context ? Object.freeze({ scope: context.scope, edges: Object.freeze(ids.map((id) => entries.get(id)!.footprint)) }) : null;
    },
    dispose() { retire(); disposed = true; }
  };
}

import { sameFixtureValue } from "./protected-document-contract.mjs";
import { verifyProtectedConnections } from "./protected-connections-contract.mjs";

export const PROTECTED_AUTOPAN_SUITE = "viewport_active_graph_connections_v1";
// Deliberately beyond the frozen 360px retention band, not merely outside the viewport.
export const AUTOPAN_CLEARANCE = 600;
const gate = (condition) => { if (!condition) throw new Error("protected_autopan_readback_failed"); };

/** A live gesture, not selection, native focus or retention overscan, must protect the source. */
export function verifyLiveAutopan(value) {
  gate([value.camera_dx, value.source_right, value.canvas_left].every(Number.isFinite));
  gate(value.camera_dx < -50 && value.source_right < value.canvas_left - AUTOPAN_CLEARANCE
    && value.source_full && value.source_connecting && value.connection_paths === 1
    && value.selected_nodes === 0 && value.selected_edges === 0 && value.focus_within_source === false
    && value.handles === 12);
  return { auto_pan_moved: true, source_full_beyond_retention: true, selection_and_focus_independent: true, handles_retained: true };
}

/** Reuse the reviewed edge/port identity invariant; add cancellation without any authored change. */
export function verifyAutopanDocuments(before, created, cancelled, connected, reconnected, deleted, ids) {
  gate(sameFixtureValue(created, cancelled));
  const edge = connected.edges.find((item) => !created.edges.some((original) => original.id === item.id));
  gate(Boolean(edge));
  return { ...verifyProtectedConnections(before, created, connected, connected, reconnected, deleted, ids, edge.label),
    cancelled_gesture_document_unchanged: true };
}

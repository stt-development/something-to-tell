import { compareFlowGeometry } from "./protected-flow-contract.mjs";

export const EDGE_BOUNDARY_SUITE = "viewport_edge_boundary_observation_v1";
const modulePath = "/src/app/graph/CanvasEdgeGeometryBridge.tsx";

/** Build-only observation/report tap; no source-default or rendering-mask changes. */
export function edgeObservationPlugin() {
  let transformed = 0;
  return { name: "edge-boundary-observation", enforce: "pre",
    transform(code, id) {
      if (!id.endsWith(modulePath)) return null;
      const gate = "export const EDGE_GEOMETRY_OBSERVATION_ENABLED = false;";
      const bridge = "<CommittedEdgeGeometryBridge {...props} />";
      if (code.split(gate).length !== 2 || code.split(bridge).length !== 2) throw new Error("edge_observation_gate_changed");
      transformed++;
      // Public numeric callback only, no internal graph/store or camera mutation hook.
      return code.replace(gate, "export const EDGE_GEOMETRY_OBSERVATION_ENABLED = true;")
        .replace(bridge, '<CommittedEdgeGeometryBridge {...props} onMeasured={reportEdgeObservation} />')
        + '\nfunction reportEdgeObservation(value) { window.dispatchEvent(new CustomEvent("stt-edge-observation", {detail: value ? {edges:value.footprints.edges,eligible:[...value.eligibility.eligibleIds],unknown:[...value.eligibility.unknownGeometryIds],scope:value.footprints.scope}:null})); }\n';
    },
    buildEnd(error) { if (!error && transformed !== 1) throw new Error("edge_observation_gate_not_verified"); }
  };
}

/** Compare full public world geometry, not only candidate counts. */
export function compareEdgeBoundaries(reference, candidate) {
  const names = ["graph_crossing", "flow_return", "graph_restored"];
  return Object.fromEntries(names.map((name) => [name, compareFlowGeometry(reference?.[name], candidate?.[name])]));
}

/** Unknown paint is retained and a crossing route must never depend on endpoint-card visibility. */
export function verifyEdgeObservation(snapshot, targetId, mountedIds) {
  if (!snapshot || !snapshot.eligible.includes(targetId) || !snapshot.edges.some((edge) => edge.id === targetId)
    || new Set(mountedIds).size !== mountedIds.length || snapshot.edges.length !== mountedIds.length
    || snapshot.edges.some((edge) => !mountedIds.includes(edge.id))
    || snapshot.unknown.some((id) => !snapshot.eligible.includes(id))) throw new Error("edge_boundary_candidates_failed");
  return { footprint_visits: snapshot.edges.length, candidates: snapshot.eligible.length,
    unknown: snapshot.unknown.length, mounted_routes: mountedIds.length,
    path_exclusion: false, crossing_retained: true, unknown_retained: true };
}

export const NODE_DOM_SUITE = "protected_node_dom_v1";
export const APPROVED_NODE_DOM_DEFAULT = false;
import { compareCardLayouts } from "./viewport-cards-contract.mjs";
import { compareFlowGeometry } from "./protected-flow-contract.mjs";
const gate = "export const NODE_DOM_VIRTUALIZATION_ENABLED = false;";

/** Exact development build override; no environment flag or production preference. */
export function nodeDomGatePlugin(enabled) {
  if (typeof enabled !== "boolean") throw Error("node_dom_override_invalid");
  let transformed = 0;
  return { name: "stt-node-dom-test-gate", enforce: "pre", transform(code, id) {
    if (!id.replaceAll("\\", "/").endsWith("/app/graph/canvasDomExperiment.ts")) return;
    if (code.split(gate).length !== 2) throw Error("node_dom_gate_source_changed");
    transformed++;
    return code.replace(gate, `export const NODE_DOM_VIRTUALIZATION_ENABLED = ${enabled};`);
  }, buildEnd(error) { if (!error && transformed !== 1) throw Error("node_dom_override_not_verified"); } };
}

export const compareDomScopes = (reference, candidate) => Object.fromEntries(["initial", "fit_restored", "flow"].map(stage =>
  [stage, compareFlowGeometry(reference?.[stage], candidate?.[stage])]));

/** Edge-only geometry scope; excluded node/label counts here are not graph counts. */
export function compareDomBoundaryCurves(before, after) {
  const edgeScope = curves => ({ geometry: { nodes: [], edges: curves?.map(({ id }) => ({ id })), labels: [], curves },
    counts: { wrappers: 0, handles: 0, edges: curves?.length, labels: 0, minimap: 0 } });
  return compareFlowGeometry(edgeScope(before), edgeScope(after));
}

/** Complete graph authority and all boundary routes must survive DOM elision. */
export function verifyDomObservation(observation, enabled) {
  if (!observation || observation.full_nodes !== 1124 || observation.minimap_nodes !== 1124
    || observation.edge_routes !== 500 || observation.labels !== 500
    || !Number.isSafeInteger(observation.zoomed_nodes) || observation.zoomed_nodes < 0
    || observation.zoomed_nodes > observation.full_nodes) throw Error("node_dom_counts_invalid");
  if (enabled ? observation.zoomed_nodes >= observation.full_nodes : observation.zoomed_nodes !== observation.full_nodes) {
    throw Error("node_dom_activation_not_observed");
  }
  return observation;
}

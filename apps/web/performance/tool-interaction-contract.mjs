export const APPROVED_TOOL_INTERACTION_DEFAULT = true;
const gate = `export const STABLE_TOOL_INTERACTION_EXPERIMENT_ENABLED = ${APPROVED_TOOL_INTERACTION_DEFAULT};`;

/** Exact disposable-build gate, separate from Graph body and DOM visibility experiments. */
export function toolInteractionGatePlugin(enabled) {
  if (typeof enabled !== "boolean") throw Error("tool_interaction_override_invalid");
  let transformed = 0;
  return { name: "stt-tool-interaction-test-gate", enforce: "pre", transform(code, id) {
    if (!id.replaceAll("\\", "/").endsWith("/app/graph/canvasToolInteraction.ts")) return;
    if (code.split(gate).length !== 2) throw Error("tool_interaction_gate_source_changed");
    transformed++;
    return code.replace(gate, `export const STABLE_TOOL_INTERACTION_EXPERIMENT_ENABLED = ${enabled};`);
  }, buildEnd(error) { if (!error && transformed !== 1) throw Error("tool_interaction_override_not_verified"); } };
}

import { toolInteractionGatePlugin } from "./tool-interaction-contract.mjs";

export const APPROVED_TARGET_SELECTABLE_DEFAULT = true;
const gate = `export const TARGET_SELECTABLE_EXPERIMENT_ENABLED = ${APPROVED_TARGET_SELECTABLE_DEFAULT};`;

/** Incremental comparison:011p is fixed On in both builds; only011q varies. */
export function selectableGatePlugins(enabled) {
  if (typeof enabled !== "boolean") throw Error("selectable_override_invalid");
  let transformed = 0;
  return [toolInteractionGatePlugin(true), {
    name: "stt-target-selectable-test-gate", enforce: "pre", transform(code, id) {
      if (!id.replaceAll("\\", "/").endsWith("/app/graph/CanvasSelectableReactFlow.tsx")) return;
      if (code.split(gate).length !== 2) throw Error("selectable_gate_source_changed");
      transformed++;
      return code.replace(gate, `export const TARGET_SELECTABLE_EXPERIMENT_ENABLED = ${enabled};`);
    }, buildEnd(error) { if (!error && transformed !== 1) throw Error("selectable_override_not_verified"); }
  }];
}

import { preservesBaselineDocument, sameFixtureValue } from "./protected-document-contract.mjs";

export const PROTECTED_FLOW_AUTHORING_SUITE = "viewport_protected_flow_authoring_v1";
const gate = (condition) => { if (!condition) throw new Error("protected_flow_authoring_readback_failed"); };

/** Existing canonical members avoid membership/setup writes and tagged-owner side effects. */
export function flowAuthoringTargets(document) {
  const main = document.story_flows.find((row) => row.kind === "main");
  gate(main);
  const members = new Set(document.story_flow_nodes.filter((row) => row.flow_id === main.id).map((row) => row.node_id));
  const node = (kind) => document.nodes.find((row) => members.has(row.id) && row.type === kind);
  const source = node("Item"), target = node("Dialogue"), replacement = node("Event");
  gate(source && target && replacement && new Set([source.id, target.id, replacement.id]).size === 3);
  gate(!document.flow_transitions.some((row) => row.flow_id === main.id && row.source_node_id === source.id
    && [target.id, replacement.id].includes(row.target_node_id)));
  return { flowId: main.id, source, target, replacement };
}

/** Admit only one transition row; all baseline arrays, including tags and placements, stay exact. */
export function verifyFlowAuthoringDelta(before, current, expected) {
  gate(preservesBaselineDocument(before, current, ["flow_transitions"]));
  for (const [key, value] of Object.entries(before)) if (!["flow_transitions", "manifest", "checksum"].includes(key)) {
    gate(sameFixtureValue(value, current[key]));
  }
  gate(sameFixtureValue({ ...before.manifest, updated_at: current.manifest.updated_at }, current.manifest));
  const baselineIds = new Set(before.flow_transitions.map((row) => row.id));
  const added = current.flow_transitions.filter((row) => !baselineIds.has(row.id));
  gate(sameFixtureValue(current.flow_transitions.filter((row) => baselineIds.has(row.id)), before.flow_transitions));
  if (expected === null) {
    gate(added.length === 0);
    return { original_collections_exact: true, transition_removed: true };
  }
  gate(added.length === 1);
  const row = added[0];
  gate(row.id === expected.id && row.project_id === before.manifest.project_id && row.flow_id === expected.flow_id
    && row.source_node_id === expected.source_node_id && row.target_node_id === expected.target_node_id
    && row.kind === expected.kind && row.label === expected.label && row.condition === expected.condition
    && row.priority === expected.priority && row.is_default === expected.is_default
    && sameFixtureValue(row.metadata, expected.metadata) && row.created_at === expected.created_at);
  gate(typeof row.updated_at === "string" && Number.isFinite(Date.parse(row.updated_at)));
  gate(sameFixtureValue({ ...expected, updated_at: row.updated_at }, row));
  return { original_collections_exact: true, same_transition_identity: true, canonical_endpoints_exact: true,
    label_condition_exact: true, membership_and_tags_unchanged: true };
}

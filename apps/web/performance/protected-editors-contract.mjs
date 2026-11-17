import { sameFixtureValue } from "./protected-document-contract.mjs";

export const PROTECTED_EDITORS_SUITE = "viewport_protected_specialized_editors_v1";
const gate = (condition) => { if (!condition) throw new Error("protected_editors_readback_failed"); };

const compact = (owner) => Object.fromEntries(Object.entries(owner).filter(([, value]) => value != null));
/** Legacy aggregate Save may create initial nested tags, but may never rewrite
 * prior tags, tag another aggregate, duplicate a bound owner or add orphan definitions. */
function includeInitialOwnerTags(before, after, expected, target, document) {
  const owners = [], project = { project_id: before.manifest.project_id };
  if (target.collection === "dialogues") for (const element of document.elements) {
    const base = { ...project, dialogue_node_id: target.node.id };
    if (element.kind === "line") owners.push({ ...base, kind: "dialogue_line", line_id: element.id });
    else {
      owners.push({ ...base, kind: "dialogue_choice", choice_id: element.id });
      for (const option of element.options) owners.push({ ...base, kind: "dialogue_option", choice_id: element.id, option_id: option.id });
    }
  } else for (const stage of document.stages) {
    const base = { ...project, quest_node_id: target.node.id, stage_id: stage.id };
    owners.push({ ...base, kind: "quest_stage" });
    for (const branch of stage.branches) owners.push({ ...base, kind: "quest_branch", branch_id: branch.id });
  }
  const added = {};
  for (const key of ["engine_tag_definitions", "engine_tag_bindings"]) {
    const old = before[key] ?? [], next = after[key] ?? [], ids = new Set(old.map((row) => row.id));
    gate(new Set(next.map((row) => row.id)).size === next.length);
    gate(sameFixtureValue(old, next.filter((row) => ids.has(row.id))));
    added[key] = next.filter((row) => !ids.has(row.id));
    if (old.length || added[key].length) expected[key] = next;
  }
  const bindings = added.engine_tag_bindings, prior = before.engine_tag_bindings ?? [];
  const definitions = new Map((after.engine_tag_definitions ?? []).map((row) => [row.id, row]));
  for (const [index, binding] of bindings.entries()) {
    const owner = compact(binding.owner);
    gate(binding.project_id === project.project_id && definitions.get(binding.definition_id)?.project_id === project.project_id);
    gate(owners.some((allowed) => sameFixtureValue(owner, allowed)));
    gate(![...prior, ...bindings.slice(0, index)].some((row) => sameFixtureValue(compact(row.owner), owner)));
  }
  gate(added.engine_tag_definitions.every((row) => bindings.some((binding) => binding.definition_id === row.id)));
  return bindings.length;
}

/** Resolve canonical aggregates and a different Scene for disposable linked copies. */
export function specializedFixtureTargets(source) {
  const dialogue = source.nodes.find((n) => n.type === "Dialogue");
  const quest = source.nodes.find((n) => n.type === "Quest");
  const primary = source.placements.find((p) => p.is_primary && p.canonical_node_id === dialogue?.id);
  const scene = source.nodes.find((n) => n.type === "Scene" && n.id !== primary?.container_node_id);
  const line = source.dialogues.find((d) => d.node_id === dialogue?.id)?.document.elements.find((e) => e.kind === "line");
  gate(Boolean(dialogue && quest && scene && line && source.quests.some((q) => q.node_id === quest.id)));
  return { scene, targets: [{ node: dialogue, collection: "dialogues", elementId: line.id }, { node: quest, collection: "quests" }] };
}

/** One scalar in one canonical aggregate, not another owner or a placement copy. */
export function verifySpecializedEdit(before, after, target, text) {
  gate(["dialogues", "quests"].includes(target.collection) && typeof text === "string" && text.length > 0);
  const expected = structuredClone(before);
  const rows = expected[target.collection].filter((row) => row.node_id === target.node.id);
  gate(rows.length === 1);
  if (target.collection === "dialogues") {
    const lines = rows[0].document.elements.filter((e) => e.id === target.elementId && e.kind === "line");
    gate(lines.length === 1 && lines[0].text !== text); lines[0].text = text;
  } else { gate(rows[0].document.objective !== text); rows[0].document.objective = text; }
  const nodes = after.nodes.filter((n) => n.id === target.node.id);
  gate(nodes.length === 1 && Number.isFinite(Date.parse(nodes[0].updated_at)));
  expected.nodes.find((n) => n.id === target.node.id).updated_at = nodes[0].updated_at;
  gate(typeof after.checksum === "string" && /^[a-f0-9]{64}$/.test(after.checksum) && after.checksum !== before.checksum);
  expected.checksum = after.checksum;
  const initialTags = includeInitialOwnerTags(before, after, expected, target, rows[0].document);
  gate(sameFixtureValue(expected, after));
  return { canonical_owner_preserved: true, exact_aggregate_delta: true, unrelated_records_preserved: true, initial_nested_tags_created: initialTags };
}

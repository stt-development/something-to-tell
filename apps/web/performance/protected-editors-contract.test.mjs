import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { PROTECTED_EDITORS_SUITE, specializedFixtureTargets, verifySpecializedEdit } from "./protected-editors-contract.mjs";

function snapshots(collection = "dialogues") {
  const before = { checksum: "a".repeat(64), manifest: { project_id: "owned", settings: { ui_locale: "en" } },
    nodes: [{ id: "dialogue", type: "Dialogue", summary: "Original", updated_at: "2026-01-01T00:00:00Z" }, { id: "quest", type: "Quest", updated_at: "2026-01-01T00:00:00Z" }],
    placements: [{ id: "linked", canonical_node_id: "dialogue", x: 24, y: 58 }], edges: [],
    dialogues: [{ node_id: "dialogue", document: { elements: [{ id: "line", kind: "line", text: "Original", speaker_node_id: "actor" }] } }],
    quests: [{ node_id: "quest", document: { objective: "Original", stages: [] } }] };
  const target = { node: before.nodes[collection === "dialogues" ? 0 : 1], collection, ...(collection === "dialogues" ? { elementId: "line" } : {}) };
  const after = structuredClone(before); after.checksum = "b".repeat(64);
  if (collection === "dialogues") after.dialogues[0].document.elements[0].text = "Updated";
  else after.quests[0].document.objective = "Updated";
  return [before, after, target, "Updated"];
}

test("accepts one scalar change in either canonical aggregate with no placement or sibling mutation", () => {
  for (const kind of ["dialogues", "quests"]) assert.equal(verifySpecializedEdit(...snapshots(kind)).exact_aggregate_delta, true);
});
test("rejects missing persistence, wrong canonical owner, wrong line and unchanged/invalid checksum", () => {
  for (const mutate of [
    (v) => { v[1].dialogues[0].document.elements[0].text = "Original"; },
    (v) => { v[2].node = { id: "missing" }; }, (v) => { v[2].elementId = "missing"; },
    (v) => { v[1].checksum = v[0].checksum; }, (v) => { v[1].checksum = "invalid"; }
  ]) { const values = snapshots(); mutate(values); assert.throws(() => verifySpecializedEdit(...values), /readback_failed/); }
});
test("rejects unrelated canonical data, geometry, branches, speakers, settings, tags and row growth", () => {
  for (const mutate of [
    (v) => { v[1].nodes[0].summary = "Changed"; }, (v) => { v[1].placements[0].x++; },
    (v) => { v[1].dialogues[0].document.elements[0].speaker_node_id = "other"; },
    (v) => { v[1].quests[0].document.stages.push({ id: "unexpected" }); },
    (v) => { v[1].manifest.settings.ui_locale = "ru"; }, (v) => { v[1].engine_tag_definitions = []; },
    (v) => { v[1].nodes.push(v[1].nodes[0]); }, (v) => { v[1].nodes[0].updated_at = "invalid"; }
  ]) { const values = snapshots(); mutate(values); assert.throws(() => verifySpecializedEdit(...values), /readback_failed/); }
});
test("pinned targets have complete aggregates and a distinct Scene without altering the source", () => {
  const source = JSON.parse(gunzipSync(readFileSync(new URL("../../../fixtures/benchmarks/storage-scale-1000.v1.json.gz", import.meta.url))));
  const before = JSON.stringify(source), { scene, targets } = specializedFixtureTargets(source);
  assert.deepEqual(targets.map((t) => t.node.type), ["Dialogue", "Quest"]);
  assert.equal(source.placements.some((p) => p.is_primary && p.canonical_node_id === targets[0].node.id && p.container_node_id === scene.id), false);
  assert.equal(JSON.stringify(source), before);
  assert.throws(() => specializedFixtureTargets({ ...source, dialogues: [] }), /readback_failed/);
});

function tagged() {
  const values = snapshots();
  values[1].engine_tag_definitions = [{ id: "tag", project_id: "owned", key: "Line" }];
  values[1].engine_tag_bindings = [{ id: "binding", project_id: "owned", definition_id: "tag",
    owner: { project_id: "owned", kind: "dialogue_line", dialogue_node_id: "dialogue", line_id: "line", option_id: null } }];
  return values;
}
test("allows only initial tags for known unbound nested owners of the edited aggregate", () => {
  assert.equal(verifySpecializedEdit(...tagged()).initial_nested_tags_created, 1);
});
test("rejects orphan tags, foreign/invalid/already-bound owners, duplicate bindings and changed prior tags", () => {
  for (const mutate of [
    (v) => { v[1].engine_tag_bindings[0].owner.line_id = "missing"; },
    (v) => { v[1].engine_tag_bindings[0].owner.dialogue_node_id = "other"; },
    (v) => { v[1].engine_tag_bindings[0].owner.flow_id = "unexpected"; },
    (v) => { v[1].engine_tag_definitions[0].project_id = "other"; },
    (v) => { v[1].engine_tag_definitions.push({ id: "orphan" }); },
    (v) => { v[1].engine_tag_bindings.push({ ...v[1].engine_tag_bindings[0], id: "duplicate-owner" }); },
    (v) => { v[0].engine_tag_bindings = [{ ...v[1].engine_tag_bindings[0], id: "prior" }]; v[1].engine_tag_bindings.push(v[0].engine_tag_bindings[0]); },
    (v) => { v[0].engine_tag_definitions = [{ ...v[1].engine_tag_definitions[0], key: "Original" }]; }
  ]) { const values = tagged(); mutate(values); assert.throws(() => verifySpecializedEdit(...values), /readback_failed/); }
});

test("validates initial Quest stage/branch tags against the edited canonical Quest", () => {
  const values = snapshots("quests"), [before, after] = values;
  before.quests[0].document.stages = [{ id: "stage", branches: [{ id: "branch" }] }];
  after.quests[0].document.stages = structuredClone(before.quests[0].document.stages);
  after.engine_tag_definitions = ["stage", "branch"].map((id) => ({ id, project_id: "owned" }));
  after.engine_tag_bindings = [
    { id: "stage-binding", project_id: "owned", definition_id: "stage", owner: { kind: "quest_stage", project_id: "owned", quest_node_id: "quest", stage_id: "stage" } },
    { id: "branch-binding", project_id: "owned", definition_id: "branch", owner: { kind: "quest_branch", project_id: "owned", quest_node_id: "quest", stage_id: "stage", branch_id: "branch" } }
  ];
  assert.equal(verifySpecializedEdit(...values).initial_nested_tags_created, 2);
  after.engine_tag_bindings[1].owner.branch_id = "other";
  assert.throws(() => verifySpecializedEdit(...values), /readback_failed/);
});

test("the frozen specialized editor archive covers both sizes/modes, exact saves and owned cleanup", () => {
  const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
  const report = json("../../../docs/verification/baselines/p9-1-005b2c2b3g1-specialized-editors-v1.json");
  const manifest = json("../../../fixtures/benchmarks/manifest.v1.json");
  assert.equal(report.suite, PROTECTED_EDITORS_SUITE); assert.equal(report.workflow, "editors");
  assert.equal(report.status, "passed"); assert.equal(report.quick, false); assert.equal(report.source_gate_enabled, false);
  assert.equal(report.fixture_source_sha256, manifest.projects["1000"].gzip_sha256);
  assert.equal(report.cleanup, "released");
  assert.deepEqual(report.cases.map((c) => `${c.viewport.width}x${c.viewport.height}:${c.enabled}`).sort(),
    ["1024x768:false", "1024x768:true", "1440x900:false", "1440x900:true"]);
  for (const c of report.cases) {
    assert.equal(c.status, "ok"); assert.equal(c.step, "complete");
    assert.equal(c.page_errors, 0); assert.equal(c.unexpected_writes, 0); assert.equal(c.linked_setup_count, 2);
    assert.equal(c.saved_checkpoint_restored, true); assert.equal(c.session_released, true);
    assert.deepEqual(c.editors.map((e) => e.kind), ["Dialogue", "Quest"]);
    for (const e of c.editors) {
      assert.equal(e.saves, 2); assert.equal(e.initial_nested_tags_created, e.kind === "Dialogue" ? 6 : 4);
      for (const key of ["canonical_owner_preserved", "exact_aggregate_delta", "unrelated_records_preserved",
        "offscreen_retention_and_release", "rematerialized_value_preserved", "root_geometry_restored"]) assert.equal(e[key], true, key);
    }
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { PROTECTED_FLOW_AUTHORING_SUITE, flowAuthoringTargets, verifyFlowAuthoringDelta } from "./protected-flow-authoring-contract.mjs";

function snapshots() {
  const before = { manifest: { project_id: "owned", settings: { ui_locale: "en" }, saved_revision: 0 }, project_metadata: { fixture: true },
    nodes: [{ id: "a", summary: "Original" }], placements: [{ id: "placement", x: 10 }],
    flow_transitions: [{ id: "old", label: "Original" }], story_flow_nodes: [{ id: "member" }],
    engine_tag_definitions: [{ id: "tag" }], engine_tag_bindings: [{ id: "binding" }], edges: [],
    story_flows: [{ id: "main" }], scene_flow_boundaries: [], flow_invocations: [], dialogues: [], quests: [] };
  const row = { id: "new", project_id: "owned", flow_id: "main", source_node_id: "a", target_node_id: "b",
    kind: "next", label: "New", condition: "", priority: 1, is_default: false, metadata: {},
    created_at: "2026-11-01T10:00:00Z", updated_at: "2026-11-01T10:00:00Z" };
  const after = structuredClone(before); after.flow_transitions.push(structuredClone(row));
  return [before, after, row];
}
test("admits one exact transition without changing canonical nodes, memberships, tags or placements", () => {
  const values = snapshots();
  assert.equal(verifyFlowAuthoringDelta(...values).same_transition_identity, true);
  for (const field of ["label", "condition", "target_node_id"]) {
    values[2][field] = "edited"; values[1].flow_transitions[1][field] = "edited";
    assert.equal(verifyFlowAuthoringDelta(...values).canonical_endpoints_exact, true);
  }
  assert.equal(verifyFlowAuthoringDelta(values[0], structuredClone(values[0]), null).transition_removed, true);
});
test("rejects stale label/condition, endpoint/owner/identity drift and duplicate or missing additions", () => {
  for (const mutate of [
    (v) => { v[1].flow_transitions.pop(); }, (v) => { v[1].flow_transitions.push(v[1].flow_transitions[1]); },
    ...["id", "project_id", "flow_id", "source_node_id", "target_node_id", "label", "condition", "kind", "created_at"]
      .map((field) => (v) => { v[1].flow_transitions[1][field] = "wrong"; }),
    (v) => { v[1].flow_transitions[1].priority++; }, (v) => { v[1].flow_transitions[1].is_default = true; },
    (v) => { v[1].flow_transitions[1].metadata.extra = true; }, (v) => { v[1].flow_transitions[1].updated_at = "invalid"; }
  ]) { const values = snapshots(); mutate(values); assert.throws(() => verifyFlowAuthoringDelta(...values), /readback_failed/); }
});
test("rejects unrelated row updates, ordering, managed tags, settings and incomplete removal", () => {
  for (const mutate of [
    (v) => { v[1].nodes[0].summary = "changed"; }, (v) => { v[1].placements[0].x++; },
    (v) => { v[1].flow_transitions[0].label = "changed"; }, (v) => { v[1].story_flow_nodes.push({ id: "extra" }); },
    (v) => { v[1].engine_tag_definitions.push({ id: "extra" }); }, (v) => { v[1].engine_tag_bindings = []; },
    (v) => { v[1].manifest.settings.ui_locale = "ru"; }, (v) => { v[1].scene_flow_boundaries.push({ id: "extra" }); },
    (v) => { v[1].flow_invocations.push({ id: "extra" }); }, (v) => { v[1].edges.push({ id: "extra" }); },
    (v) => { v[1].project_metadata.fixture = false; }, (v) => { v[1].manifest.saved_revision++; },
    (v) => { v[1].flow_transitions[1].unexpected = true; }
  ]) { const values = snapshots(); mutate(values); assert.throws(() => verifyFlowAuthoringDelta(...values), /readback_failed/); }
  const [before, after] = snapshots();
  assert.throws(() => verifyFlowAuthoringDelta(before, after, null), /readback_failed/);
  before.nodes.push({ id: "b" }); after.nodes.push({ id: "b" }); after.nodes.reverse();
  assert.throws(() => verifyFlowAuthoringDelta(before, after, after.flow_transitions[1]), /readback_failed/);
});
test("pinned fixture targets are distinct existing canonical members with no duplicate canary route", () => {
  const source = JSON.parse(gunzipSync(readFileSync(new URL("../../../fixtures/benchmarks/storage-scale-1000.v1.json.gz", import.meta.url))));
  const original = JSON.stringify(source), targets = flowAuthoringTargets(source);
  assert.deepEqual([targets.source.type, targets.target.type, targets.replacement.type], ["Item", "Dialogue", "Event"]);
  for (const node of [targets.source, targets.target, targets.replacement]) {
    assert.ok(source.story_flow_nodes.some((row) => row.flow_id === targets.flowId && row.node_id === node.id));
  }
  assert.equal(JSON.stringify(source), original);
  assert.throws(() => flowAuthoringTargets({ ...source, nodes: [] }), /readback_failed/);
  source.flow_transitions.push({ flow_id: targets.flowId, source_node_id: targets.source.id, target_node_id: targets.target.id });
  assert.throws(() => flowAuthoringTargets(source), /readback_failed/);
});

test("frozen authoring matrix verifies both sizes/modes, exact changes and complete owned Discard", () => {
  const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
  const report = json("../../../docs/verification/baselines/p9-1-005b2c2b3g3-flow-authoring-v1.json");
  const manifest = json("../../../fixtures/benchmarks/manifest.v1.json");
  const boundary = json("../../../docs/verification/baselines/p9-1-005b2c2b3g2-standalone-boundary-v1.json");
  assert.equal(report.suite, PROTECTED_FLOW_AUTHORING_SUITE); assert.equal(report.workflow, "flow-authoring");
  assert.equal(report.status, "passed"); assert.equal(report.cleanup, "released");
  assert.equal(report.quick, false); assert.equal(report.source_gate_enabled, false);
  assert.equal(report.fixture_source_sha256, manifest.projects["1000"].gzip_sha256);
  assert.equal(report.app_source_sha256, boundary.app_source_sha256);
  assert.match(report.harness_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(report.cases.map((c) => `${c.viewport.width}x${c.viewport.height}:${c.enabled}`).sort(),
    ["1024x768:false", "1024x768:true", "1440x900:false", "1440x900:true"]);
  for (const c of report.cases) {
    assert.equal(c.status, "ok"); assert.equal(c.step, "complete"); assert.equal(c.commands, 5);
    assert.equal(c.page_errors, 0); assert.equal(c.unexpected_writes, 0);
    for (const flag of ["pending_cancel_document_unchanged", "old_endpoint_protection_released", "selected_offscreen_endpoints_full", "saved_checkpoint_restored", "session_released"]) assert.equal(c[flag], true);
    for (const name of ["created", "edited", "reconnected", "scope_return_readback"]) assert.deepEqual(c[name], {
      original_collections_exact: true, same_transition_identity: true, canonical_endpoints_exact: true,
      label_condition_exact: true, membership_and_tags_unchanged: true });
    assert.deepEqual(c.deleted, { original_collections_exact: true, transition_removed: true });
    assert.deepEqual(Object.keys(c.stages).sort(), ["created", "edited", "panned", "reconnected", "returned"]);
    for (const [name, stage] of Object.entries(c.stages)) {
      assert.equal(stage.wrappers, 7); assert.equal(stage.handles, 28); assert.equal(stage.edges, 6);
      assert.equal(stage.labels, 6); assert.equal(stage.exact_scope_membership, true);
      if (name === "panned" && c.enabled) assert.ok(stage.shells > 0 && stage.shells <= 5);
      else assert.equal(stage.shells, 0);
    }
  }
  assert.equal(JSON.stringify(report).includes("error_message"), false);
});

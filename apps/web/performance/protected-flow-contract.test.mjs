import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { PROTECTED_FLOW_SUITE, FLOW_STAGES, flowScopeRecords, verifyFlowScope, compareFlowScopes } from "./protected-flow-contract.mjs";
import { readFlowCurves } from "./protected-flow-dom.mjs";

test("the Fit correction archive preserves geometry and clears overlays on automatic and button Fits", () => {
  const report = JSON.parse(readFileSync(new URL("../../../docs/verification/baselines/p9-1-005b2c2b3d2-fit-overlays-v1.json", import.meta.url)));
  assert.equal(report.status, "passed"); assert.equal(report.cleanup, "released");
  assert.equal(report.quick, false); assert.equal(report.source_gate_enabled, false);
  assert.deepEqual(report.cases.map((c) => `${c.viewport.width}:${c.enabled}`).sort(), ["1024:false", "1024:true", "1440:false", "1440:true"]);
  for (const c of report.cases) {
    assert.equal(c.document_unchanged, true); assert.equal(c.session_released, true);
    assert.equal(c.write_attempts, 0); assert.equal(c.page_errors, 0);
    for (const key of ["graph_auto_fit_occlusion", "graph_fit_occlusion", "flow_auto_fit_occlusion"]) {
      assert.deepEqual(c[key], { nodes: key.startsWith("graph") ? 1124 : 7, outside: 0, overlaps: 0 });
    }
    for (const name of ["main_fit", "main_restored", "side_fit", "main_reentered"]) {
      assert.deepEqual(c.stages[name].fit_occlusion, { nodes: name === "side_fit" ? 5 : 7, outside: 0, overlaps: 0 });
    }
  }
  for (const comparison of report.comparisons) for (const stage of Object.values(comparison.stages)) {
    assert.equal(stage.equal, true); assert.equal(stage.mismatches, 0); assert.equal(stage.max_numeric_delta, 0);
  }
});

function document() {
  return { nodes: ["a", "b", "c"].map((id) => ({ id })), story_flows: [{ id: "main", entry_node_id: "a" }, { id: "side", entry_node_id: "c" }],
    story_flow_nodes: [{ flow_id: "main", node_id: "a" }, { flow_id: "main", node_id: "b" }, { flow_id: "side", node_id: "c" }],
    flow_transitions: [{ id: "ab", flow_id: "main", source_node_id: "a", target_node_id: "b" }],
    flow_invocations: [{ id: "call", source_flow_id: "main", source_node_id: "b", target_flow_id: "side" }],
    scene_flow_boundaries: [{ id: "boundary", flow_id: "main", scene_node_id: "a", entry_node_id: "b" }] };
}
function layout() {
  return { counts: { wrappers: 1, handles: 4, minimap: 1, edges: 1, labels: 1, shells: 0 }, visible_shells: 0, invalid_handle_bounds: 0,
    geometry: { camera: [0, 0, 1], nodes: [{ id: "a", bounds: [0, 0, 200, 156], card: [0, 0, 200, 156],
      handles: ["left", "right", "top", "bottom"].map((id) => ({ id, bounds: [0, 0, 10, 10] })) }],
    edges: [{ id: "route", path: "M0,0 L100,100" }], labels: [{ text: "Route", bounds: [20, 20, 100, 20] }],
    curves: [{ id: "route", length: 100, points: Array.from({ length: 65 }, (_, index) => [index * 100 / 64, 0]) }] } };
}
const expected = { nodeIds: ["a"], edgeIds: ["route"] };
test("resolves exact members, deduplicated called-entry portals and current route identities", () => {
  const source = document();
  assert.deepEqual(flowScopeRecords(source, "main"), { nodeIds: ["a", "b", "c"], edgeIds: ["flow-invocation:call", "story-flow:ab"] });
  source.story_flow_nodes.push({ flow_id: "main", node_id: "c" });
  assert.deepEqual(flowScopeRecords(source, "main").nodeIds, ["a", "b", "c"]);
  source.flow_transitions = [];
  assert.deepEqual(flowScopeRecords(source, "main").edgeIds, ["flow-invocation:call", "story-boundary:boundary"]);
});
test("rejects missing flows/members and keeps a different scope's routes out", () => {
  const source = document();
  assert.throws(() => flowScopeRecords(source, "missing"), /scope_failed/);
  assert.deepEqual(flowScopeRecords(source, "side"), { nodeIds: ["c"], edgeIds: [] });
  source.nodes.pop(); assert.throws(() => flowScopeRecords(source, "side"), /scope_failed/);
});
test("the pinned main/side workload includes real portals and only canonical Flow wrapper identities", () => {
  const source = JSON.parse(gunzipSync(readFileSync(new URL("../../../fixtures/benchmarks/storage-scale-1000.v1.json.gz", import.meta.url))));
  const before = JSON.stringify(source), main = source.story_flows.find((flow) => flow.kind === "main");
  const scope = flowScopeRecords(source, main.id);
  assert.equal(scope.nodeIds.length, 7); assert.equal(scope.edgeIds.length, 5);
  assert.equal(scope.nodeIds.some((id) => id.startsWith("placement:")), false);
  assert.equal(JSON.stringify(source), before);
});
test("accepts complete finite geometry while keeping body detail a separate observation", () => {
  const value = layout();
  assert.equal(verifyFlowScope(value, expected, false).exact_scope_membership, true);
  value.counts.shells = 1;
  assert.equal(verifyFlowScope(value, expected, true).shells, 1);
});
test("bounded MiniMap must prove complete current Flow coverage without redefining SVG shape counts", () => {
  const value = layout(); value.counts.minimap = 0;
  value.minimap_coverage = { represented_nodes: 1, cells: 12, dom: 3 };
  assert.equal(verifyFlowScope(value, expected, false).exact_scope_membership, true);
  for (const change of [{ represented_nodes: 0 }, { cells: 513 }, { cells: 0 }, { dom: 4 }]) {
    const invalid = structuredClone(value); Object.assign(invalid.minimap_coverage, change);
    assert.throws(() => verifyFlowScope(invalid, expected, false), /scope_failed/);
  }
});
test("rejects stale or duplicate scope membership, missing paths/labels and invalid original ports", () => {
  for (const mutate of [
    (v) => { v.geometry.nodes[0].id = "other"; }, (v) => { v.geometry.nodes.push(v.geometry.nodes[0]); },
    (v) => { v.geometry.edges[0].id = "stale-route"; }, (v) => { v.geometry.edges[0].path = "MNaN,0"; },
    (v) => { v.counts.labels = 0; }, (v) => { v.geometry.labels = []; }, (v) => { v.geometry.labels[0].text = ""; },
    (v) => { v.counts.minimap = 0; }, (v) => { v.geometry.nodes[0].card[2] = 0; },
    (v) => { v.geometry.nodes[0].bounds[0] = Infinity; }, (v) => { v.geometry.nodes[0].handles[0].id = "right"; },
    (v) => { v.geometry.nodes[0].handles[0].id = "changed"; }, (v) => { v.counts.handles--; },
    (v) => { v.visible_shells++; }, (v) => { v.invalid_handle_bounds++; }, (v) => { v.counts.shells++; }
  ]) { const value = layout(); mutate(value); assert.throws(() => verifyFlowScope(value, expected, false), /scope_failed/); }
});
test("comparison requires every named stage and detects path/label/card/camera changes between modes", () => {
  const stages = Object.fromEntries(FLOW_STAGES.map((name) => [name, layout()]));
  assert.equal(Object.values(compareFlowScopes(stages, structuredClone(stages))).every((entry) => entry.equal), true);
  assert.throws(() => compareFlowScopes({}, {}), /scope_failed/);
  const missing = structuredClone(stages); delete missing.main_fit;
  assert.throws(() => compareFlowScopes(stages, missing), /scope_failed/);
  for (const mutate of [
    (v) => { v.geometry.curves[0].points[32][1]++; }, (v) => { v.geometry.labels[0].bounds[0]++; },
    (v) => { v.geometry.nodes[0].card[2]++; }, (v) => { v.geometry.camera[0]++; }
  ]) { const changed = structuredClone(stages); mutate(changed.main_fit); assert.equal(compareFlowScopes(stages, changed).main_fit.equal, false); }
});
test("ignores portal insertion order and equivalent SVG command spelling without changing geometric tolerance", () => {
  const stages = Object.fromEntries(FLOW_STAGES.map((name) => [name, layout()]));
  stages.main_fit.geometry.labels.push({ text: "Another", bounds: [40, 50, 80, 20] });
  stages.main_fit.counts.labels = 2;
  const changed = structuredClone(stages);
  changed.main_fit.geometry.labels.reverse(); changed.main_fit.geometry.edges[0].path = "M0 0 L100 100";
  changed.main_fit.geometry.curves[0].points[32][1] += 0.0001;
  assert.equal(compareFlowScopes(stages, changed).main_fit.equal, true);
  changed.main_fit.geometry.curves[0].points[32][1] += 0.1;
  assert.equal(compareFlowScopes(stages, changed).main_fit.equal, false);
});
test("rejects missing, duplicate, aliased, nonfinite or undersampled route geometry", () => {
  const stages = Object.fromEntries(FLOW_STAGES.map((name) => [name, layout()]));
  for (const mutate of [
    (v) => { delete v.geometry.curves; }, (v) => { v.geometry.curves.push(v.geometry.curves[0]); },
    (v) => { v.geometry.curves[0].id = "different"; }, (v) => { v.geometry.curves[0].points.pop(); },
    (v) => { v.geometry.curves[0].points[0][0] = NaN; }, (v) => { v.geometry.curves[0].length = Infinity; }
  ]) {
    const changed = structuredClone(stages); mutate(changed.main_fit);
    assert.equal(compareFlowScopes(stages, changed).main_fit.equal, false);
    assert.throws(() => verifyFlowScope(changed.main_fit, expected, false), /scope_failed/);
  }
});
test("the DOM adapter samples both endpoints and 63 inner points using SVG APIs in world units", () => {
  const offsets = [], element = { getAttribute: () => "route", querySelector: () => ({
    getTotalLength: () => 128, getPointAtLength: (offset) => { offsets.push(offset); return { x: offset, y: 20 }; }
  }) };
  const [curve] = readFlowCurves({ querySelectorAll: () => [element] });
  assert.equal(curve.id, "route"); assert.equal(curve.length, 128); assert.equal(curve.points.length, 65);
  assert.deepEqual(curve.points[0], [0, 20]); assert.deepEqual(curve.points[64], [128, 20]);
  assert.equal(offsets[32], 64); assert.equal(offsets.length, 65);
});
test("the frozen Flow archive covers both sizes/modes, ten matched checkpoints and owned release", () => {
  const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
  const report = json("../../../docs/verification/baselines/p9-1-005b2c2b3a-protected-flow-v1.json");
  const manifest = json("../../../fixtures/benchmarks/manifest.v1.json");
  const geometry = json("../../../docs/verification/baselines/p9-1-005b2c1-graph-card-shells-v1.json");
  assert.equal(report.suite, PROTECTED_FLOW_SUITE); assert.equal(report.workflow, "flow");
  assert.equal(report.status, "passed"); assert.equal(report.quick, false); assert.equal(report.source_gate_enabled, false);
  assert.equal(report.app_source_sha256, geometry.app_source_sha256);
  assert.equal(report.fixture_source_sha256, manifest.projects["1000"].gzip_sha256);
  assert.equal(report.cases.length, 4); assert.equal(report.cleanup, "released");
  assert.deepEqual(report.cases.map((entry) => `${entry.viewport.width}x${entry.viewport.height}:${entry.enabled}`).sort(),
    ["1024x768:false", "1024x768:true", "1440x900:false", "1440x900:true"]);
  const equal = (value) => {
    assert.equal(value.equal, true); assert.equal(value.mismatches, 0); assert.equal(value.tolerance_world, 0.05);
    assert.ok(Number.isFinite(value.max_numeric_delta) && value.max_numeric_delta <= 0.05);
  };
  for (const entry of report.cases) {
    assert.equal(entry.status, "ok"); assert.equal(entry.step, "complete");
    assert.equal(entry.page_errors, 0); assert.equal(entry.write_attempts, 0);
    for (const key of ["selected_offscreen_member_full", "main_scope_restored", "document_unchanged", "session_released"]) assert.equal(entry[key], true, key);
    assert.equal(entry.offscreen_shells_observed, entry.enabled);
    equal(entry.main_geometry); equal(entry.graph_geometry);
    assert.deepEqual(Object.keys(entry.stages), FLOW_STAGES);
    for (const [name, stage] of Object.entries(entry.stages)) {
      assert.equal(stage.exact_scope_membership, true); assert.equal(stage.wrappers, name === "side_fit" ? 5 : 7);
      assert.equal(stage.handles, stage.wrappers * 4); assert.equal(stage.edges, 5); assert.equal(stage.labels, 5);
      if (name === "main_panned" && entry.enabled) assert.ok(stage.shells > 0 && stage.shells <= 6);
      else assert.equal(stage.shells, 0);
    }
  }
  assert.deepEqual(report.comparisons.map((entry) => entry.width).sort(), [1024, 1440]);
  for (const comparison of report.comparisons) {
    assert.deepEqual(Object.keys(comparison.stages), FLOW_STAGES);
    for (const stage of Object.values(comparison.stages)) equal(stage);
  }
});

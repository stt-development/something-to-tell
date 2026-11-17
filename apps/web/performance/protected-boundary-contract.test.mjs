import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROTECTED_BOUNDARY_SUITE, BOUNDARY_VARIANT, standaloneBoundaryTarget, readBoundaryPaint, verifyBoundarySnapshot } from "./protected-boundary-contract.mjs";
import { FLOW_STAGES } from "./protected-flow-contract.mjs";

const document = () => ({ story_flows: [{ id: "main", kind: "main" }], flow_transitions: [],
  scene_flow_boundaries: [{ id: "entry", flow_id: "main", scene_node_id: "scene", entry_node_id: "child" }] });
const target = standaloneBoundaryTarget(document());
const paint = { edges: 1, arrow: true, labels: 1 };
function layout() {
  return { geometry: { edges: [{ id: target.id }], labels: [{ text: "Scene entry" }],
    curves: [{ id: target.id, points: Array.from({ length: 65 }, (_, index) => [index + 5, 5]) }],
    nodes: ["scene", "child"].map((id, index) => ({ id,
      handles: ["top", "right", "bottom", "left"].map((id) => ({ id, bounds: [index * 64, 0, 10, 10] })) })) } };
}
test("requires an original standalone entry, not a duplicate ordinary transition", () => {
  assert.deepEqual(target, { id: "story-boundary:entry", flowId: "main", source: "scene", target: "child" });
  const value = document();
  value.flow_transitions.push({ flow_id: "main", source_node_id: "scene", target_node_id: "child" });
  assert.throws(() => standaloneBoundaryTarget(value), /boundary_failed/);
  value.scene_flow_boundaries = [];
  assert.throws(() => standaloneBoundaryTarget(value), /boundary_failed/);
});
test("verifies the exact route, arrow, unique label and original endpoint handles", () => {
  assert.deepEqual(verifyBoundarySnapshot(layout(), target, paint), {
    original_route: true, arrow: true, unique_label: true, original_endpoint_ports: true });
});
test("rejects missing, duplicate or redirected routes, labels and original ports", () => {
  for (const mutate of [
    (v) => { v.geometry.edges = []; }, (v) => { v.geometry.edges.push(v.geometry.edges[0]); },
    (v) => { v.geometry.curves = []; }, (v) => { v.geometry.curves[0].points.pop(); },
    (v) => { v.geometry.curves[0].points[0] = [100, 100]; }, (v) => { v.geometry.curves[0].points[64] = [0, 0]; },
    (v) => { v.geometry.labels[0].text = "Other"; }, (v) => { v.geometry.labels.push(v.geometry.labels[0]); },
    (v) => { v.geometry.nodes[0].handles.pop(); }, (v) => { v.geometry.nodes[0].handles[0].id = "right"; },
    (v) => { v.geometry.nodes[1].id = "different-entry"; }, (v) => { v.geometry.nodes[0].handles[1].bounds[0] = NaN; }
  ]) { const value = layout(); mutate(value); assert.throws(() => verifyBoundarySnapshot(value, target, paint), /boundary_failed/); }
  for (const badPaint of [{ ...paint, arrow: false }, { ...paint, labels: 2 }, { ...paint, edges: 0 }]) {
    assert.throws(() => verifyBoundarySnapshot(layout(), target, badPaint), /boundary_failed/);
  }
});
test("scope replacement must remove both the original route and label", () => {
  const value = layout(); value.geometry.edges = [];
  assert.deepEqual(verifyBoundarySnapshot(value, target, { edges: 0, labels: 0 }, false), { absent_outside_scope: true });
  assert.throws(() => verifyBoundarySnapshot(layout(), target, paint, false), /boundary_failed/);
  assert.throws(() => verifyBoundarySnapshot(value, target, { edges: 0, labels: 1 }, false), /boundary_failed/);
});

test("paint observation resolves the actual referenced arrow marker and exact HTML label", () => {
  const saved = globalThis.document;
  try {
    for (const markerUrl of ["url(#arrow)", "url('#arrow')", 'url("#arrow")']) {
      const elements = {
        ".react-flow__edge": [{ dataset: { id: target.id }, querySelector: () => ({ getAttribute: () => markerUrl }) }],
        "marker": [{ id: "arrow", querySelector: () => ({}) }],
        ".story-flow-edge-label": [{ textContent: " Scene entry " }, { textContent: "Another route" }]
      };
      globalThis.document = { querySelectorAll: (selector) => elements[selector] };
      assert.deepEqual(readBoundaryPaint(target), paint);
      elements.marker[0].id = "unreferenced";
      assert.equal(readBoundaryPaint(target).arrow, false);
      elements[".react-flow__edge"] = [];
      assert.equal(readBoundaryPaint(target).edges, 0);
    }
  } finally { globalThis.document = saved; }
});

test("the frozen standalone matrix covers both sizes/modes, every stage and released read-only sessions", () => {
  const report = JSON.parse(readFileSync(new URL("../../../docs/verification/baselines/p9-1-005b2c2b3g2-standalone-boundary-v1.json", import.meta.url)));
  const manifest = JSON.parse(readFileSync(new URL("../../../fixtures/benchmarks/manifest.v1.json", import.meta.url)));
  assert.equal(report.suite, PROTECTED_BOUNDARY_SUITE); assert.equal(report.fixture_variant, BOUNDARY_VARIANT);
  assert.equal(report.workflow, "boundary"); assert.equal(report.status, "passed"); assert.equal(report.cleanup, "released");
  assert.equal(report.quick, false); assert.equal(report.source_gate_enabled, false);
  assert.equal(report.fixture_source_sha256, manifest.projects["1000"].gzip_sha256);
  for (const key of ["harness_sha256", "app_source_sha256"]) assert.match(report[key], /^[a-f0-9]{64}$/);
  assert.deepEqual(report.cases.map((c) => `${c.viewport.width}x${c.viewport.height}:${c.enabled}`).sort(),
    ["1024x768:false", "1024x768:true", "1440x900:false", "1440x900:true"]);
  const original = { original_route: true, arrow: true, unique_label: true, original_endpoint_ports: true };
  for (const c of report.cases) {
    assert.equal(c.status, "ok"); assert.equal(c.step, "complete");
    assert.equal(c.page_errors, 0); assert.equal(c.write_attempts, 0);
    assert.equal(c.document_unchanged, true); assert.equal(c.session_released, true);
    assert.equal(c.selected_offscreen_member_full, true); assert.equal(c.offscreen_shells_observed, c.enabled);
    assert.equal(c.graph_geometry.equal, true); assert.equal(c.main_scope_restored, true);
    assert.deepEqual(c.boundary_after_graph_return, original);
    assert.deepEqual(Object.keys(c.stages).sort(), [...FLOW_STAGES].sort());
    for (const [name, stage] of Object.entries(c.stages)) {
      assert.equal(stage.exact_scope_membership, true);
      assert.equal(stage.wrappers, name === "side_fit" ? 5 : 7);
      assert.equal(stage.handles, stage.wrappers * 4);
      assert.equal(stage.edges, name === "side_fit" ? 5 : 6); assert.equal(stage.labels, stage.edges);
      assert.deepEqual(stage.boundary, name === "side_fit" ? { absent_outside_scope: true } : original);
      if (name !== "main_panned") assert.deepEqual(stage.fit_occlusion, { nodes: stage.wrappers, outside: 0, overlaps: 0 });
    }
    // Native hover/focus may protect another card; shell count is not a layout invariant.
    if (c.enabled) assert.ok(c.stages.main_panned.shells > 0 && c.stages.main_panned.shells <= 6);
    else assert.equal(c.stages.main_panned.shells, 0);
  }
  assert.deepEqual(report.comparisons.map((item) => item.width), [1440, 1024]);
  for (const comparison of report.comparisons) {
    assert.deepEqual(Object.keys(comparison.stages).sort(), [...FLOW_STAGES].sort());
    for (const value of Object.values(comparison.stages)) {
      assert.equal(value.equal, true); assert.equal(value.mismatches, 0); assert.equal(value.tolerance_world, 0.05);
      assert.ok(value.max_numeric_delta >= 0 && value.max_numeric_delta <= 0.05);
    }
  }
  assert.equal(JSON.stringify(report).includes("error_message"), false);
});

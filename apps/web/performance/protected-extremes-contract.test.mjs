import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROTECTED_EXTREMES_SUITE, EXTREME_STAGES, compareExtremeGeometry, verifyExtremeSnapshot, compareExtremeCases } from "./protected-extremes-contract.mjs";
import { readCardLayout } from "./viewport-cards-contract.mjs";

function observation(zoom = 1) {
  return { counts: { wrappers: 1, handles: 4, edges: 1, labels: 1, minimap: 1, shells: 0 }, visible_shells: 0, invalid_handle_bounds: 0,
    geometry: { camera: [0, 0, zoom], nodes: [{ id: "node", bounds: [0, 0, 260, 156], card: [0, 0, 260, 156],
      handles: ["left", "right", "top", "bottom"].map((id) => ({ id, bounds: [0, 0, 10, 10] })) }],
    edges: [{ id: "route", path: "M0,0 L100,100" }], labels: [{ text: "Route", bounds: [30, 40, 60, 20] }] } };
}
test("accepts measured 1% and 1000% cameras without mistaking rounded indicator values for actual bounds", () => {
  for (const zoom of [0.01, 10]) assert.equal(verifyExtremeSnapshot(observation(), observation(zoom), zoom, true).zoom, zoom);
  for (const zoom of [0.009, 0.0101, 9.99, 10.01]) {
    assert.throws(() => verifyExtremeSnapshot(observation(), observation(zoom), zoom < 1 ? 0.01 : 10, true), /geometry_failed/);
  }
});
test("compares world cards, original ports and route/label identities independently of camera only when requested", () => {
  const before = observation(), after = observation(10);
  assert.equal(compareExtremeGeometry(before, after).equal, false);
  assert.equal(compareExtremeGeometry(before, after, false).equal, true);
  after.geometry.edges[0].path = "M0 0 L100 100"; after.geometry.labels[0].bounds[0]++;
  assert.equal(compareExtremeGeometry(before, after, false).equal, true);
  after.geometry.labels[0].text = "Changed";
  assert.equal(compareExtremeGeometry(before, after, false).equal, false);
});
test("rejects lost/duplicate/aliased geometry, changed world dimensions and missing or changed ports", () => {
  for (const mutate of [
    (v) => { v.geometry.nodes[0].id = "other"; }, (v) => { v.geometry.nodes.push(v.geometry.nodes[0]); },
    (v) => { v.geometry.nodes[0].card[2]++; }, (v) => { v.geometry.nodes[0].bounds[1]++; },
    (v) => { v.geometry.nodes[0].handles.pop(); }, (v) => { v.geometry.nodes[0].handles[0].id = "right"; },
    (v) => { v.geometry.nodes[0].handles[0].id = "changed"; }, (v) => { v.geometry.nodes[0].handles[0].bounds[2] = 0; },
    (v) => { v.counts.handles--; }, (v) => { v.counts.minimap--; },
    (v) => { v.geometry.edges[0].id = "other"; }, (v) => { v.geometry.edges[0].path = "MNaN,0"; },
    (v) => { v.geometry.labels.pop(); }, (v) => { v.geometry.labels[0].text = "Changed"; }
  ]) { const current = observation(10); mutate(current); assert.throws(() => verifyExtremeSnapshot(observation(), current, 10, true), /geometry_failed/); }
});
test("rejects nonfinite cameras/rectangles, visible shells and shell presentation in the control", () => {
  for (const mutate of [
    (v) => { v.geometry.camera[0] = NaN; }, (v) => { v.geometry.nodes[0].bounds[0] = Infinity; },
    (v) => { v.geometry.labels[0].bounds[2] = 0; }, (v) => { v.visible_shells++; },
    (v) => { v.invalid_handle_bounds++; }, (v) => { v.counts.shells++; }
  ]) { const current = observation(10); mutate(current); assert.throws(() => verifyExtremeSnapshot(observation(), current, 10, false), /geometry_failed/); }
});
test("matched-build comparison requires all twelve Graph/Flow stages and detects structural/camera changes", () => {
  const stages = Object.fromEntries(EXTREME_STAGES.map((stage) => [stage, observation()]));
  assert.equal(Object.values(compareExtremeCases(stages, structuredClone(stages))).every((value) => value.equal), true);
  assert.throws(() => compareExtremeCases({}, {}), /geometry_failed/);
  const missing = structuredClone(stages); delete missing.flow_max_blurred;
  assert.throws(() => compareExtremeCases(stages, missing), /geometry_failed/);
  const changed = structuredClone(stages); changed.graph_max_focused.geometry.camera[0]++;
  assert.equal(compareExtremeCases(stages, changed).graph_max_focused.equal, false);
});
test("precise camera observation bypasses string serialization without changing historical default reads", () => {
  const keys = ["document", "getComputedStyle", "DOMMatrixReadOnly"];
  const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const viewport = { attributeStyleMap: { get: () => ({ toMatrix: () => ({ a: 0.01, e: 100.004, f: 0 }) }) } };
  try {
    // This camera-only DOM has no MiniMap; do not alias unrelated selectors to the viewport.
    globalThis.document = { querySelector: (selector) => selector === ".react-flow" ? { getBoundingClientRect: () => ({ x: 0, y: 0 }) }
      : selector === ".react-flow__viewport" ? viewport : null,
      querySelectorAll: () => [] };
    globalThis.getComputedStyle = () => ({ transform: "matrix(0.01, 0, 0, 0.01, 100, 0)" });
    globalThis.DOMMatrixReadOnly = class {
      constructor() { this.a = 0.01; this.f = 0; this.e = 100; }
    };
    assert.deepEqual(readCardLayout().geometry.camera, [100, 0, 0.01]);
    assert.deepEqual(readCardLayout({ preciseCamera: true }).geometry.camera, [100.004, 0, 0.01]);
    viewport.attributeStyleMap.get = () => null;
    assert.throws(() => readCardLayout({ preciseCamera: true }), /precise_camera_missing/);
    assert.deepEqual(readCardLayout().geometry.camera, [100, 0, 0.01]);
  } finally {
    keys.forEach((key, index) => previous[index] ? Object.defineProperty(globalThis, key, previous[index]) : delete globalThis[key]);
  }
});
test("the frozen extremes archive covers both modes, both bounds, 24 comparisons and owned release", () => {
  const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
  const report = json("../../../docs/verification/baselines/p9-1-005b2c2b3b-zoom-extremes-v1.json");
  const manifest = json("../../../fixtures/benchmarks/manifest.v1.json");
  const original = json("../../../docs/verification/baselines/p9-1-005b2c1-graph-card-shells-v1.json");
  assert.equal(report.suite, PROTECTED_EXTREMES_SUITE); assert.equal(report.workflow, "extremes");
  assert.equal(report.status, "passed"); assert.equal(report.quick, false); assert.equal(report.source_gate_enabled, false);
  assert.equal(report.app_source_sha256, original.app_source_sha256);
  assert.equal(report.fixture_source_sha256, manifest.projects["1000"].gzip_sha256);
  assert.equal(report.cleanup, "released"); assert.equal(report.cases.length, 4);
  assert.deepEqual(report.cases.map((entry) => `${entry.viewport.width}x${entry.viewport.height}:${entry.enabled}`).sort(),
    ["1024x768:false", "1024x768:true", "1440x900:false", "1440x900:true"]);
  const equal = (value) => {
    assert.equal(value.equal, true); assert.equal(value.mismatches, 0); assert.equal(value.tolerance_world, 0.05);
    assert.ok(Number.isFinite(value.max_numeric_delta) && value.max_numeric_delta <= 0.05);
  };
  for (const entry of report.cases) {
    assert.equal(entry.status, "ok"); assert.equal(entry.step, "complete");
    assert.equal(entry.page_errors, 0); assert.equal(entry.write_attempts, 0);
    assert.equal(entry.document_unchanged, true); assert.equal(entry.session_released, true);
    assert.deepEqual(Object.keys(entry.stages), EXTREME_STAGES);
    for (const [stage, value] of Object.entries(entry.stages)) {
      const graph = stage.startsWith("graph");
      assert.equal(value.wrappers, graph ? 1124 : 7); assert.equal(value.handles, graph ? 4496 : 28);
      assert.equal(value.edges, graph ? 500 : 5); assert.equal(value.labels, value.edges); assert.equal(value.minimap, value.wrappers);
      if (stage.endsWith("_min")) { assert.equal(value.zoom, 0.01); equal(value.geometry); }
      if (stage.includes("_max_")) { assert.equal(value.zoom, 10); equal(value.geometry); }
      if (!entry.enabled || !stage.includes("_max_")) assert.equal(value.shells, 0);
    }
    for (const mode of ["graph", "flow"]) {
      for (const gate of ["min_clamped", "max_clamped", "selected_offscreen_full", "native_focus_offscreen_full", "blur_releases_card"]) assert.equal(entry.modes[mode][gate], true);
      equal(entry.modes[mode].recovery);
      if (entry.enabled) assert.equal(entry.stages[`${mode}_max_blurred`].shells, entry.stages[`${mode}_max_focused`].shells + 1);
    }
  }
  assert.deepEqual(report.comparisons.map((entry) => entry.width).sort(), [1024, 1440]);
  for (const comparison of report.comparisons) {
    assert.deepEqual(Object.keys(comparison.stages), EXTREME_STAGES);
    for (const stage of Object.values(comparison.stages)) equal(stage);
  }
});

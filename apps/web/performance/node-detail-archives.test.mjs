import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const json = (name) => JSON.parse(readFileSync(new URL(`../../../docs/verification/baselines/${name}.json`, import.meta.url), "utf8"));
const depth = json("p9-1-005c3-node-detail-v1");
const defaults = json("p9-1-005c3-node-detail-default-v1");
const flags = ["deep_frame_focus", "deep_navigation_editor", "linked_focus_retained", "flow_unchanged",
  "pan_excludes_node_focus", "explicit_off_survives_reload", "live_rollback_independent", "document_unchanged"];

// Frozen evidence is deliberately historical; it is not compared to later source hashes.
function completed(report, count) {
  assert.equal(report.status, "passed"); assert.equal(report.quick, false); assert.equal(report.cleanup, "released");
  assert.equal(report.cases.length, count);
  for (const row of report.cases) {
    assert.equal(row.status, "ok"); assert.equal(row.step, "complete"); assert.equal(row.page_errors, 0);
  }
}
test("accepted detail matrix retains complete geometry while bounding body work and releases every session", () => {
  completed(depth, 4); assert.equal(depth.detail_source_gate_enabled, false);
  const manifest = JSON.parse(readFileSync(new URL("../../../fixtures/benchmarks/manifest.v1.json", import.meta.url)));
  assert.equal(depth.fixture_source_sha256, manifest.projects["1000"].gzip_sha256);
  assert.equal(depth.fixture_variant, "deep_detail_v1");
  assert.deepEqual(depth.cases.map((row) => `${row.viewport.width}:${row.enabled}`).sort(), ["1024:false", "1024:true", "1440:false", "1440:true"]);
  for (const row of depth.cases) {
    assert.equal(row.write_attempts, 0); assert.equal(row.released_sessions, 2);
    for (const field of flags) assert.equal(row[field], true, field);
    const root = row.stages.root_fit;
    assert.deepEqual([root.wrappers, root.handles, root.edges, root.labels, root.minimap], [1124, 4496, 501, 501, 1124]);
    assert.equal(root.total_dom, row.enabled ? 26112 : 49671);
    assert.equal(root.full_bodies, row.enabled ? 0 : 1124);
    if (row.enabled) { assert.equal(root.modes.compact, 1119); assert.equal(root.modes.folded, 5); assert.equal(row.deadband_observed, true); }
    for (const stage of Object.values(row.stages)) assert.equal(stage.original_handles, true);
  }
  assert.equal(depth.comparisons.length, 2);
  for (const comparison of depth.comparisons) {
    assert.equal(Object.keys(comparison.stages).length, 3);
    for (const stage of Object.values(comparison.stages)) {
      assert.equal(stage.equal, true); assert.equal(stage.mismatches, 0); assert.equal(stage.max_numeric_delta, 0);
    }
  }
});
test("unmodified production default retains explicit rollback at both sizes without a source override", () => {
  completed(defaults, 2); assert.equal(defaults.detail_source_gate_enabled, true);
  assert.equal(defaults.build_mode, "unoverridden_production_default");
  assert.equal(defaults.fixture_source_sha256, depth.fixture_source_sha256);
  assert.deepEqual(defaults.cases.map((row) => row.viewport.width).sort(), [1024, 1440]);
  for (const row of defaults.cases) {
    assert.equal(row.enabled, null); assert.equal(row.released_sessions, 2); assert.equal(row.write_attempts, 0);
    for (const field of flags) assert.equal(row[field], true, field);
  }
});
test("fresh authoring covers the same promoted source, group movement, resize, text and clean release", () => {
  const report = json("p9-1-005c3-authoring-v1"); completed(report, 4);
  assert.equal(report.app_source_sha256, defaults.app_source_sha256);
  assert.equal(report.fixture_source_sha256, defaults.fixture_source_sha256);
  assert.deepEqual(report.cases.map((row) => `${row.viewport.width}:${row.enabled}`).sort(), ["1024:false", "1024:true", "1440:false", "1440:true"]);
  for (const row of report.cases) for (const field of ["baseline_collections_preserved", "same_group_delta", "unselected_placement_unchanged",
    "resize_isolated", "text_persisted", "saved_checkpoint_restored", "session_released"]) assert.equal(row[field], true, field);
});

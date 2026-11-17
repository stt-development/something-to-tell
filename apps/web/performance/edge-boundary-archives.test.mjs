import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EDGE_BOUNDARY_SUITE } from "./edge-boundary-contract.mjs";

const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
test("fresh reconnect matrix matches the boundary application/fixture and preserves original ports and owned checkpoint", () => {
  const report = json("../../../docs/verification/baselines/p9-1-005b3c-reconnect-v1.json");
  const boundary = json("../../../docs/verification/baselines/p9-1-005b3c-edge-boundary-v1.json");
  assert.equal(report.status, "passed"); assert.equal(report.quick, false); assert.equal(report.cleanup, "released");
  assert.equal(report.app_source_sha256, boundary.app_source_sha256); assert.equal(report.fixture_source_sha256, boundary.fixture_source_sha256);
  assert.deepEqual(report.cases.map((entry) => `${entry.viewport.width}:${entry.enabled}`).sort(), ["1024:false", "1024:true", "1440:false", "1440:true"]);
  for (const entry of report.cases) {
    assert.equal(entry.status, "ok"); assert.equal(entry.step, "complete"); assert.equal(entry.page_errors, 0);
    for (const field of ["selected_edge_endpoints_protected", "old_endpoint_protection_released", "baseline_collections_preserved",
      "nodes_and_geometry_unchanged", "same_edge_identity", "source_port_preserved", "target_port_verified", "label_persisted",
      "new_target_persisted", "detached_edge_deleted", "deleted_edge_protection_released", "all_twelve_handles_retained",
      "pan_document_unchanged", "saved_checkpoint_restored", "session_released"]) assert.equal(entry[field], true, field);
  }
});
test("frozen edge-boundary matrix proves both sizes/modes, matching geometry, conservative candidates and owned release", () => {
  const report = json("../../../docs/verification/baselines/p9-1-005b3c-edge-boundary-v1.json");
  const manifest = json("../../../fixtures/benchmarks/manifest.v1.json");
  assert.equal(report.suite, EDGE_BOUNDARY_SUITE); assert.equal(report.quick, false);
  assert.equal(report.status, "passed"); assert.equal(report.cleanup, "released");
  assert.equal(report.source_gate_enabled, true); assert.equal(report.fixture_source_sha256, manifest.projects["1000"].gzip_sha256);
  assert.deepEqual(report.cases.map((entry) => `${entry.viewport.width}:${entry.enabled}`).sort(), ["1024:false", "1024:true", "1440:false", "1440:true"]);
  for (const entry of report.cases) {
    assert.equal(entry.status, "ok"); assert.equal(entry.step, "complete"); assert.equal(entry.page_errors, 0); assert.equal(entry.write_attempts, 0);
    assert.equal(entry.navigation_rematerialized, true); assert.equal(entry.document_unchanged, true); assert.equal(entry.session_released, true);
    assert.deepEqual(Object.keys(entry.stages), ["graph_crossing", "flow_return", "graph_restored"]);
    for (const stage of Object.values(entry.stages)) {
      for (const field of ["both_endpoints_offscreen", "arrow", "label", "crossing_retained", "unknown_retained"]) assert.equal(stage[field], true, field);
      assert.equal(stage.path_exclusion, false); assert.equal(stage.footprint_visits, stage.mounted_routes);
      assert.ok(stage.candidates > 0 && stage.candidates <= stage.mounted_routes && stage.unknown > 0 && stage.unknown <= stage.candidates);
      assert.ok(stage.handles > 0 && stage.paint.path_length > 0);
    }
    assert.equal(entry.stages.graph_crossing.footprint_visits, 500); assert.equal(entry.stages.graph_crossing.candidates, 376);
    assert.equal(entry.stages.graph_restored.footprint_visits, 501); assert.equal(entry.stages.graph_restored.candidates, 377);
    assert.equal(entry.stages.flow_return.footprint_visits, 5); assert.equal(entry.stages.flow_return.unknown, 5);
  }
  assert.deepEqual(report.comparisons.map((entry) => entry.width).sort(), [1024, 1440]);
  for (const comparison of report.comparisons) {
    assert.deepEqual(Object.keys(comparison.stages), ["graph_crossing", "flow_return", "graph_restored"]);
    for (const stage of Object.values(comparison.stages)) {
      assert.equal(stage.equal, true); assert.equal(stage.mismatches, 0); assert.equal(stage.max_numeric_delta, 0); assert.equal(stage.tolerance_world, 0.05);
    }
  }
  assert.deepEqual(report.post_run_geometry_checks.map((entry) => entry.name).sort(), report.cases.map((entry) => entry.name).sort());
  for (const value of report.post_run_geometry_checks) {
    assert.equal(value.return_raised, true); assert.equal(value.label_shifted, true); assert.equal(value.samples, 65); assert.equal(value.label_characters, 27);
  }
});

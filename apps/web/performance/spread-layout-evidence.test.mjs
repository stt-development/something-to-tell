import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { calibrationSummary } from "./calibration.mjs";

const read = suffix => JSON.parse(readFileSync(new URL(
  `../../../docs/verification/baselines/p9-1-011n-${suffix}.json`, import.meta.url), "utf8"));

test("dense and grid Fit calibrations retain identical production/probe sources and original targets", () => {
  const dense = read("original-fit"), grid = read("grid-fit");
  assert.equal(dense.fixture_variant, undefined);
  assert.equal(grid.fixture_variant, "root_grid_v1");
  for (const key of ["app_source_sha256", "probe_sha256", "commit"]) assert.equal(dense[key], grid[key]);
  assert.deepEqual(dense.environment, grid.environment);
  assert.ok(Date.parse(dense.completed_at) <= Date.parse(grid.started_at));
  for (const report of [dense, grid]) {
    assert.equal(report.worktree_dirty, false);
    assert.equal(report.instrumentation, "baseline_observers");
    assert.equal(report.phase_bundle_hooks_present, false);
    assert.deepEqual(report.targets, { menu_feedback_p95_ms: 100, pan_frame_p95_ms: 32, post_response_canvas_ms: 2000 });
    assert.equal(report.cases.length, 1);
    const row = report.cases[0];
    assert.equal(row.status, "ok"); assert.equal(row.cleanup, "released");
    assert.equal(row.fixture_nodes, 1000); assert.equal(row.samples.length, 21);
    assert.deepEqual(row.calibration, calibrationSummary(row));
    assert.equal(row.calibration.warm_count, 20);
    assert.equal(row.geometry.placements, 1116); assert.equal(row.geometry.root_placements, 682);
    assert.equal(row.calibration.criteria.filter(c => c.state === "exceeds_target").length, 5);
    assert.ok(row.samples.every(sample => sample.dom.nodes === 1124 && sample.dom.edges === 500 && sample.dom.labels === 500));
  }
  assert.equal(dense.cases[0].fixture_source_sha256, grid.cases[0].fixture_source_sha256);
  assert.equal(dense.cases[0].geometry.distinct_root_origins, 11);
  assert.equal(grid.cases[0].geometry.distinct_root_origins, 682);
  assert.equal(grid.cases[0].geometry.max_roots_at_one_origin, 1);
  assert.match(grid.cases[0].geometry.placement_geometry_sha256, /^[a-f0-9]{64}$/);
});

test("unmodified grid working views retain complete graph and truthful sparse timing evidence", () => {
  const report = read("grid-default-working");
  assert.equal(report.app_source_sha256, read("grid-fit").app_source_sha256);
  assert.equal(report.build_mode, "unoverridden_production_default");
  assert.equal(report.node_dom_source_gate_enabled, false);
  assert.equal(report.status, "passed"); assert.equal(report.cleanup, "released");
  assert.equal(report.fixture_variant, "root_grid_v1");
  assert.equal(report.fixture_geometry.distinct_root_origins, 682);
  assert.deepEqual(report.cases.map(row => row.viewport.width), [1440, 1024]);
  for (const row of report.cases) {
    assert.equal(row.enabled, null); assert.equal(row.status, "ok");
    assert.equal(row.working_zoom, 1.05); assert.equal(row.working_visible_nodes, 9);
    assert.equal(row.stages.zoomed_nodes, 1124); assert.equal(row.stages.minimap_nodes, 1124);
    assert.equal(row.stages.edge_routes, 500); assert.equal(row.stages.labels, 500);
    assert.equal(row.stages.flow_nodes, 7); assert.equal(row.page_errors, 0); assert.equal(row.write_attempts, 0);
    for (const key of ["document_unchanged", "session_released", "boundary_routes_unchanged",
      "distant_target_materialized", "editor_retained_and_cancelled", "selected_target_retained",
      "legacy_minimap_restores_complete_dom", "minimap_rollback_verified"]) assert.equal(row[key], true);
    for (const timing of [row.conditional_tool_feedback.select, row.conditional_tool_feedback.pan]) {
      assert.equal(timing.count, 8); assert.equal(timing.p95_ms, null);
      assert.ok(Number.isFinite(timing.median_ms) && timing.median_ms > 0);
    }
  }
});

test("grid DOM failure remains unaccepted without a widened geometry tolerance or invented timing", () => {
  const report = read("grid-working-unverified");
  assert.equal(report.status, "failed"); assert.equal(report.cleanup, "released");
  assert.equal(report.app_source_sha256, read("grid-fit").app_source_sha256);
  assert.equal(report.node_dom_source_gate_enabled, false);
  assert.equal(report.cases.length, 3);
  const row = report.cases[2];
  assert.equal(row.enabled, true); assert.equal(row.status, "failed");
  assert.equal(row.step, "spatial_elision"); assert.equal(row.stages.zoomed_nodes, 9);
  assert.equal(row.boundary_curve_comparison.equal, false);
  assert.equal(row.boundary_curve_comparison.tolerance_world, 0.05);
  assert.ok(row.boundary_curve_comparison.max_numeric_delta > 0.05);
  assert.equal(row.conditional_tool_feedback, undefined);
  assert.equal(row.page_errors, 0); assert.equal(row.write_attempts, 0);
  for (const suffix of ["original-fit", "grid-fit", "grid-working-unverified", "grid-default-working"]) {
    assert.doesNotMatch(JSON.stringify(read(suffix)), /session_id|api_key|error_message|\/private\/|postgresql:\/\//i);
  }
});

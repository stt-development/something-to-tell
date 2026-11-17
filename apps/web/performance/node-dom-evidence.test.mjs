import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (suffix) => JSON.parse(readFileSync(new URL(
  `../../../docs/verification/baselines/p9-1-011m-dom-${suffix}.json`, import.meta.url), "utf8"));
const states = [[1440, false], [1024, false], [1440, true], [1024, true]];

test("DOM experiment archives preserve default-Off, unchanged input and owned four-case provenance", () => {
  const reports = [read("final"), read("authoring")];
  assert.ok(Date.parse(reports[0].completed_at) <= Date.parse(reports[1].started_at));
  for (const report of reports) {
    assert.equal(report.status, "passed");
    assert.equal(report.cleanup, "released");
    assert.equal(report.quick, false);
    assert.equal(report.node_dom_source_gate_enabled, false);
    assert.equal(report.commit, "179cbefdf4491e261c2d17145686a8896d8f04ba");
    assert.equal(report.app_source_sha256, reports[0].app_source_sha256);
    assert.equal(report.fixture_source_sha256, reports[0].fixture_source_sha256);
    assert.match(report.harness_sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(report.cases.map(row => [row.viewport.width, row.enabled]), states);
    for (const row of report.cases) {
      assert.equal(row.status, "ok");
      assert.equal(row.step, "complete");
      assert.equal(row.page_errors, 0);
      assert.equal(row.session_released, true);
    }
    assert.doesNotMatch(JSON.stringify(report), /session_id|api_key|error_message|\/private\/|postgresql:\/\//i);
  }
});

test("native DOM reduction preserves initial Fit, whole MiniMap, all routes and unchanged document", () => {
  const report = read("final");
  assert.deepEqual(report.cases.map(row => row.stages.zoomed_nodes), [1124, 1124, 496, 248]);
  for (const row of report.cases) {
    assert.equal(row.write_attempts, 0);
    assert.equal(row.stages.initial_fit_nodes, 1124);
    assert.equal(row.stages.full_nodes, 1124);
    assert.equal(row.stages.minimap_nodes, 1124);
    assert.equal(row.stages.edge_routes, 500);
    assert.equal(row.stages.labels, 500);
    assert.equal(row.stages.flow_nodes, 7);
    for (const key of ["boundary_routes_unchanged", "legacy_minimap_restores_complete_dom",
      "minimap_rollback_verified", "distant_target_materialized", "editor_retained_and_cancelled",
      "selected_target_retained", "document_unchanged"]) assert.equal(row[key], true);
    assert.equal(row.boundary_curve_comparison.equal, true);
    assert.equal(row.boundary_curve_comparison.tolerance_world, 0.05);
  }
  assert.equal(report.comparisons.length, 2);
  for (const comparison of report.comparisons) {
    assert.deepEqual(Object.keys(comparison.stages), ["initial", "fit_restored", "flow"]);
    for (const stage of Object.values(comparison.stages)) {
      assert.equal(stage.equal, true);
      assert.equal(stage.mismatches, 0);
      assert.equal(stage.tolerance_world, 0.05);
    }
  }
});

test("conditional timing records a rejected regression, not a phase p95 acceptance", () => {
  const report = read("final");
  for (const row of report.cases) {
    assert.equal(row.conditional_tool_feedback.scope, "zoomed_panned_view");
    for (const key of ["select", "pan"]) {
      const timing = row.conditional_tool_feedback[key];
      assert.equal(timing.count, 8);
      assert.equal(timing.p95_ms, null);
      // Frozen observation integrity only; this is not a portable latency gate.
      assert.ok(timing.median_ms > (row.enabled ? 2500 : 100));
      assert.ok(timing.median_ms < (row.enabled ? 3000 : 300));
    }
  }
  const initial = read("initial-unverified");
  assert.equal(initial.status, "failed");
  assert.equal(initial.cleanup, "released");
  assert.equal(initial.app_source_sha256, report.app_source_sha256);
  assert.notEqual(initial.harness_sha256, report.harness_sha256);
});

test("native authoring preserves all original collections and releases dirty canaries through Discard", () => {
  for (const row of read("authoring").cases) {
    assert.equal(row.baseline_nodes, 1000);
    assert.equal(row.canary_nodes, 3);
    for (const key of ["all_canaries_offscreen", "offscreen_selected_full", "pan_document_unchanged",
      "baseline_collections_preserved", "same_group_delta", "unselected_placement_unchanged",
      "resize_isolated", "text_persisted", "close_cancel_retained_workspace", "saved_checkpoint_restored"]) {
      assert.equal(row[key], true);
    }
    assert.equal(row.offscreen_unselected_shell, !row.enabled);
    if (row.enabled) assert.equal(row.offscreen_unselected_elided, true);
  }
});

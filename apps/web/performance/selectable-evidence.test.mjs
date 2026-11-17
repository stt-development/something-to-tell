import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = suffix => JSON.parse(readFileSync(new URL(
  `../../../docs/verification/baselines/p9-1-011q-${suffix}.json`, import.meta.url), "utf8"));
const suffixes = ["working", "dense", "authoring", "connections"];

test("selectable cohort is incremental over fixed011p, not a production default comparison", () => {
  const reports = suffixes.map(read);
  for (const [index, report] of reports.entries()) {
    assert.equal(report.commit, "c0d44e7027e549ec0a0f2f9988bc6f031e53e029");
    assert.equal(report.app_source_sha256, reports[0].app_source_sha256);
    assert.equal(report.fixture_source_sha256, reports[0].fixture_source_sha256);
    assert.equal(report.tool_interaction_source_gate_enabled, false);
    assert.equal(report.target_selectable_source_gate_enabled, false);
    assert.equal(report.tool_interaction_build_override, true);
    assert.equal(report.quick, false); assert.equal(report.status, "passed");
    assert.equal(report.cleanup, "released"); assert.match(report.harness_sha256, /^[a-f0-9]{64}$/);
    if (index) assert.ok(Date.parse(reports[index - 1].completed_at) <= Date.parse(report.started_at));
    assert.deepEqual(report.cases.map(row => [row.viewport.width, row.enabled]),
      [[1440, false], [1024, false], [1440, true], [1024, true]]);
    for (const row of report.cases) {
      assert.equal(row.status, "ok"); assert.equal(row.page_errors, 0);
      assert.equal(row.step, "complete"); assert.equal(row.session_released, true);
    }
    assert.doesNotMatch(JSON.stringify(report), /session_id|api_key|error_message|\/private\/|postgresql:\/\//i);
  }
  assert.equal(reports[0].fixture_variant, "root_grid_v1");
  assert.equal(reports[1].fixture_variant, undefined);
});

test("selectable native cases preserve keyboard, Shift, edge choice, Lock and complete geometry", () => {
  for (const suffix of suffixes.slice(0, 2)) {
    const report = read(suffix);
    for (const row of report.cases) {
      assert.equal(row.write_attempts, 0); assert.equal(row.document_unchanged, true);
      for (const key of ["keyboard_parity", "native_lock_reset", "shift_hand_selection_blocked",
        "edge_keyboard_parity", "select_rubberband_restored", "boundary_routes_unchanged",
        "minimap_rollback_verified", "distant_target_materialized", "editor_retained_and_cancelled",
        "selected_target_retained"]) assert.equal(row[key], true);
      assert.equal(row.stages.full_nodes, 1124); assert.equal(row.stages.zoomed_nodes, 1124);
      assert.equal(row.stages.minimap_nodes, 1124); assert.equal(row.stages.edge_routes, 500);
      assert.equal(row.stages.labels, 500); assert.equal(row.stages.flow_nodes, 7);
      assert.equal(row.boundary_curve_comparison.equal, true);
      assert.equal(row.boundary_curve_comparison.tolerance_world, 0.05);
    }
    assert.equal(report.comparisons.length, 2);
    for (const comparison of report.comparisons) for (const stage of Object.values(comparison.stages)) {
      assert.equal(stage.equal, true); assert.equal(stage.mismatches, 0);
      assert.equal(stage.tolerance_world, 0.05);
    }
  }
});

test("sub100 working medians do not masquerade as p95 acceptance or erase slower observations", () => {
  for (const suffix of suffixes.slice(0, 2)) for (const row of read(suffix).cases) {
    for (const timing of [row.conditional_tool_feedback.select, row.conditional_tool_feedback.pan]) {
      assert.equal(timing.count, 8); assert.equal(timing.p95_ms, null);
    }
  }
  const candidate = read("working").cases.filter(row => row.enabled);
  // Frozen observed evidence, not a portable timing assertion for application tests.
  assert.ok(candidate.every(row => row.conditional_tool_feedback.select.median_ms < 100));
  assert.ok(candidate.some(row => row.conditional_tool_feedback.select.max_ms > 100));
});

test("selectable authoring and connections preserve original content and restore saved checkpoints", () => {
  for (const suffix of suffixes.slice(2)) for (const row of read(suffix).cases) {
    assert.equal(row.baseline_nodes, 1000); assert.equal(row.canary_nodes, 3);
    assert.equal(row.baseline_collections_preserved, true); assert.equal(row.saved_checkpoint_restored, true);
    if (suffix === "authoring") {
      for (const key of ["same_group_delta", "unselected_placement_unchanged", "resize_isolated",
        "text_persisted", "offscreen_selected_full", "close_cancel_retained_workspace"]) assert.equal(row[key], true);
    } else {
      for (const key of ["same_edge_identity", "source_port_preserved", "target_port_verified",
        "label_persisted", "new_target_persisted", "detached_edge_deleted", "nodes_and_geometry_unchanged",
        "selected_edge_endpoints_protected", "all_twelve_handles_retained"]) assert.equal(row[key], true);
    }
  }
});

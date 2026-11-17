import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = suffix => JSON.parse(readFileSync(new URL(
  `../../../docs/verification/baselines/p9-1-011p-${suffix}.json`, import.meta.url), "utf8"));
const suffixes = ["working-final", "dense", "authoring", "connections"];

test("stable-tool final cohort is four complete same-source Off/On matrices with default-Off and owned cleanup", () => {
  const reports = suffixes.map(read);
  for (const [index, report] of reports.entries()) {
    assert.equal(report.commit, "be02d16b633fee42d754d279b3f280b5af7314a5");
    assert.equal(report.app_source_sha256, reports[0].app_source_sha256);
    assert.equal(report.fixture_source_sha256, reports[0].fixture_source_sha256);
    assert.equal(report.tool_interaction_source_gate_enabled, false);
    assert.equal(report.quick, false); assert.equal(report.status, "passed");
    assert.equal(report.cleanup, "released");
    assert.match(report.harness_sha256, /^[a-f0-9]{64}$/);
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

test("stable-tool native evidence preserves keyboard/native lock, complete graph, curves and truthful sparse timings", () => {
  for (const suffix of suffixes.slice(0, 2)) {
    const report = read(suffix);
    for (const row of report.cases) {
      assert.equal(row.write_attempts, 0); assert.equal(row.document_unchanged, true);
      assert.equal(row.keyboard_parity, true); assert.equal(row.native_lock_reset, true);
      assert.equal(row.stages.full_nodes, 1124); assert.equal(row.stages.zoomed_nodes, 1124);
      assert.equal(row.stages.minimap_nodes, 1124); assert.equal(row.stages.edge_routes, 500);
      assert.equal(row.stages.labels, 500); assert.equal(row.stages.flow_nodes, 7);
      assert.equal(row.boundary_curve_comparison.equal, true);
      assert.equal(row.boundary_curve_comparison.tolerance_world, 0.05);
      for (const timing of [row.conditional_tool_feedback.select, row.conditional_tool_feedback.pan]) {
        assert.equal(timing.count, 8); assert.equal(timing.p95_ms, null);
      }
    }
    assert.equal(report.comparisons.length, 2);
    for (const comparison of report.comparisons) for (const stage of Object.values(comparison.stages)) {
      assert.equal(stage.equal, true); assert.equal(stage.mismatches, 0);
      assert.equal(stage.tolerance_world, 0.05);
    }
  }
  // The earlier limited pass did not test native Controls and is not final acceptance.
  const initial = read("working-initial");
  assert.notEqual(initial.app_source_sha256, read("working-final").app_source_sha256);
  assert.ok(initial.cases.every(row => row.native_lock_reset === undefined));
});

test("stable-tool authoring keeps baseline collections, group movement, resize and dirty-close behavior", () => {
  for (const row of read("authoring").cases) {
    assert.equal(row.baseline_nodes, 1000); assert.equal(row.canary_nodes, 3);
    for (const key of ["baseline_collections_preserved", "same_group_delta", "unselected_placement_unchanged",
      "resize_isolated", "text_persisted", "all_canaries_offscreen", "offscreen_selected_full",
      "offscreen_unselected_shell", "pan_document_unchanged", "close_cancel_retained_workspace",
      "saved_checkpoint_restored"]) assert.equal(row[key], true);
  }
});

test("stable-tool connection lifecycle preserves ports, identity and protected endpoints without baseline loss", () => {
  for (const row of read("connections").cases) {
    assert.equal(row.baseline_nodes, 1000); assert.equal(row.canary_nodes, 3);
    for (const key of ["baseline_collections_preserved", "nodes_and_geometry_unchanged", "same_edge_identity",
      "source_port_preserved", "target_port_verified", "label_persisted", "new_target_persisted",
      "detached_edge_deleted", "all_twelve_handles_retained", "pan_document_unchanged",
      "selected_edge_endpoints_protected", "old_endpoint_protection_released",
      "deleted_edge_protection_released", "saved_checkpoint_restored"]) assert.equal(row[key], true);
  }
});

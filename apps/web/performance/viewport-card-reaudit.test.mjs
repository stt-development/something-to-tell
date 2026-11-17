import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EXTREME_STAGES } from "./protected-extremes-contract.mjs";

const json = (name) => JSON.parse(readFileSync(new URL(`../../../docs/verification/baselines/${name}.json`, import.meta.url)));
const fresh = (name) => json(`p9-1-005b2c2b3e-${name}-reaudit-v1`);
const source = json("p9-1-005b2c2b3g3-flow-authoring-v1").app_source_sha256;
const fixture = JSON.parse(readFileSync(new URL("../../../fixtures/benchmarks/manifest.v1.json", import.meta.url))).projects["1000"].gzip_sha256;
const graphStages = ["focused", "panned", "zoom_round_trip", "distant_focus", "fit"];

/** Frozen evidence completeness, not a replacement application release authority. */
function matrix(report, suite, variants = [null]) {
  assert.equal(report.suite, suite); assert.equal(report.status, "passed");
  assert.equal(report.quick, false); assert.equal(report.source_gate_enabled, false);
  assert.equal(report.app_source_sha256, source); assert.equal(report.fixture_source_sha256, fixture);
  assert.match(report.harness_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(report.cleanup, variants[0] ? ["released", "released"] : "released");
  const key = (variant, width, height, enabled) => `${variant ?? ""}:${width}x${height}:${enabled}`;
  assert.deepEqual(report.cases.map((c) => key(c.variant, c.viewport.width, c.viewport.height, c.enabled)).sort(),
    variants.flatMap((variant) => [[1440, 900], [1024, 768]].flatMap(([w, h]) => [false, true].map((enabled) => key(variant, w, h, enabled)))).sort());
  for (const c of report.cases) {
    assert.equal(c.status, "ok"); assert.equal(c.step, "complete"); assert.equal(c.exit_code, 0);
    assert.equal(c.page_errors, 0); assert.equal(c.session_released, true);
  }
}
function comparisons(report, stages, variants) {
  const key = (variant, width) => `${variant ?? ""}:${width}`;
  assert.deepEqual(report.comparisons.map((c) => key(c.variant, c.viewport?.width ?? c.width)).sort(),
    variants.flatMap((variant) => [1440, 1024].map((width) => key(variant, width))).sort());
  for (const entry of report.comparisons) {
    assert.deepEqual(Object.keys(entry.stages).sort(), [...stages].sort());
    for (const value of Object.values(entry.stages)) {
      assert.equal(value.equal, true); assert.equal(value.mismatches, 0); assert.equal(value.tolerance_world, 0.05);
      assert.ok(Number.isFinite(value.max_numeric_delta) && value.max_numeric_delta >= 0 && value.max_numeric_delta <= 0.05);
    }
  }
}

test("fresh Graph proof includes eight dense/spread cases, twenty geometry comparisons and real body DOM reduction", () => {
  const report = fresh("graph"), variants = ["pinned_original_overlap", "root_grid_v1"];
  matrix(report, "viewport_card_shell_graph_v1", variants); comparisons(report, graphStages, variants);
  for (const c of report.cases) {
    assert.equal(c.write_attempts, 0); assert.equal(c.document_unchanged, true);
    assert.deepEqual(Object.keys(c.stages).sort(), [...graphStages].sort());
    let reduced = false;
    for (const [name, stage] of Object.entries(c.stages)) {
      assert.equal(stage.visible_shells, 0); assert.equal(stage.invalid_handle_bounds, 0);
      for (const [key, count] of Object.entries({ wrappers: 1124, handles: 4496, edges: 500, labels: 500, minimap: 1124 })) assert.equal(stage.counts[key], count);
      assert.equal(stage.counts.full_bodies + stage.counts.shells, 1124);
      assert.match(stage.geometry_sha256, /^[a-f0-9]{64}$/);
      if (!c.enabled) assert.equal(stage.counts.shells, 0);
      else {
        const control = report.cases.find((other) => other.variant === c.variant && other.viewport.width === c.viewport.width && !other.enabled).stages[name];
        reduced ||= stage.counts.shells > 0 && stage.counts.total_dom < control.counts.total_dom;
      }
    }
    if (c.enabled) assert.equal(reduced, true);
  }
});
test("fresh authoring proves group/resize/Text and dirty Cancel/Discard in all modes/sizes", () => {
  const report = fresh("authoring"); matrix(report, "viewport_protected_graph_authoring_v1");
  for (const c of report.cases) {
    assert.equal(c.baseline_nodes, 1000); assert.equal(c.canary_nodes, 3);
    for (const name of ["all_canaries_offscreen", "offscreen_selected_full", "pan_document_unchanged", "baseline_collections_preserved",
      "same_group_delta", "unselected_placement_unchanged", "resize_isolated", "text_persisted", "close_cancel_retained_workspace", "saved_checkpoint_restored"]) assert.equal(c[name], true);
    assert.equal(c.offscreen_unselected_shell, c.enabled);
  }
});
test("fresh zoom proof retains all twelve stages and twenty-four complete matched comparisons", () => {
  const report = fresh("extremes"); matrix(report, "viewport_protected_zoom_extremes_v1");
  comparisons(report, EXTREME_STAGES, [null]);
  for (const c of report.cases) {
    assert.equal(c.write_attempts, 0); assert.equal(c.document_unchanged, true);
    assert.deepEqual(Object.keys(c.stages).sort(), [...EXTREME_STAGES].sort());
    for (const [name, stage] of Object.entries(c.stages)) {
      const graph = name.startsWith("graph_");
      assert.equal(stage.wrappers, graph ? 1124 : 7); assert.equal(stage.handles, graph ? 4496 : 28);
      assert.equal(stage.edges, graph ? 500 : 5); assert.equal(stage.labels, stage.edges);
      if (name.endsWith("_min")) assert.equal(stage.zoom, 0.01);
      if (name.includes("_max_")) assert.equal(stage.zoom, 10);
    }
    for (const mode of ["graph", "flow"]) {
      for (const flag of ["min_clamped", "max_clamped", "selected_offscreen_full", "native_focus_offscreen_full", "blur_releases_card"]) assert.equal(c.modes[mode][flag], true);
      assert.equal(c.modes[mode].recovery.equal, true); assert.equal(c.modes[mode].recovery.mismatches, 0);
    }
  }
});
test("fresh live connection proof retains independent active sources, cancellation, reconnect and detach", () => {
  const report = fresh("autopan"); matrix(report, "viewport_active_graph_connections_v1");
  for (const c of report.cases) {
    for (const name of ["cancel_releases_source", "cancelled_gesture_document_unchanged", "detach_releases_source", "detached_edge_deleted",
      "nodes_and_geometry_unchanged", "return_target_materialized", "same_edge_identity", "saved_checkpoint_restored", "baseline_collections_preserved",
      "source_port_preserved", "target_port_verified", "new_target_persisted"]) assert.equal(c[name], true);
    assert.equal(c.target_previews_verified, 2);
    assert.deepEqual(c.gestures.map((g) => g.name), ["create_cancel", "reconnect", "detach"]);
    for (const gesture of c.gestures) for (const name of ["auto_pan_moved", "source_full_beyond_retention", "selection_and_focus_independent", "handles_retained"]) assert.equal(gesture[name], true);
  }
});
test("audit completeness rejects stale/failed, missing/duplicate, unreleased and partial geometry evidence", () => {
  for (const mutate of [
    (r) => { r.status = "failed"; }, (r) => { r.app_source_sha256 = "stale"; }, (r) => { r.quick = true; },
    (r) => { r.cleanup = "retained_locked_fixture"; }, (r) => { r.cases.pop(); }, (r) => { r.cases[1] = r.cases[0]; },
    (r) => { r.cases[0].session_released = false; }
  ]) { const report = fresh("authoring"); mutate(report); assert.throws(() => matrix(report, "viewport_protected_graph_authoring_v1")); }
  for (const mutate of [
    (r) => { r.comparisons = []; }, (r) => { delete r.comparisons[0].stages.graph_min; },
    (r) => { r.comparisons[0].stages.graph_min.equal = false; }, (r) => { r.comparisons[0].stages.graph_min.max_numeric_delta = NaN; }
  ]) { const report = fresh("extremes"); mutate(report); assert.throws(() => comparisons(report, EXTREME_STAGES, [null])); }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calibrationSummary } from "./calibration.mjs";

const load = (suffix) => JSON.parse(readFileSync(new URL(
  `../../../docs/verification/baselines/p9-1-011h-calibration-${suffix}.json`, import.meta.url), "utf8"));
const names = ["postgresql-1000", "sqlite-1000", "sqlite-small", "postgresql-small"];

test("post-R2 recheck preserves matching source/probe, sequential workers and owned cleanup", () => {
  const reports = names.map(load);
  assert.equal(new Set(reports.map((row) => row.app_source_sha256)).size, 1);
  assert.equal(new Set(reports.map((row) => row.probe_sha256)).size, 1);
  for (let index = 0; index < reports.length; index += 1) {
    const report = reports[index];
    assert.equal(report.mode, "production");
    assert.equal(report.instrumentation, "baseline_observers");
    assert.equal(report.guard_ms, 300000);
    assert.equal(report.phase_bundle_hooks_present, false);
    assert.equal(report.worktree_dirty, false);
    assert.deepEqual(report.targets, { menu_feedback_p95_ms: 100, pan_frame_p95_ms: 32, post_response_canvas_ms: 2000 });
    assert.equal(report.cases[0].cleanup, "released");
    assert.deepEqual(report.cases[0].calibration, calibrationSummary(report.cases[0]));
    if (report.storage_mode === "postgresql") assert.equal(report.database_cleanup, "released");
    if (index) assert.ok(Date.parse(reports[index - 1].completed_at) <= Date.parse(report.started_at));
    for (const secret of ["password", "postgresql://", "/Users/", "session_id", "127.0.0.1"]) {
      assert.ok(!JSON.stringify(report).includes(secret));
    }
  }
});

test("same-current-source large PostgreSQL failure stays unavailable, not hidden by small success", () => {
  const large = load("postgresql-1000").cases[0], small = load("postgresql-small").cases[0];
  assert.equal(large.status, "preparation_failed");
  assert.equal(large.step, "storage-migrations");
  assert.equal(large.error_code, "remote_storage_timeout");
  assert.deepEqual(large.samples, []);
  assert.equal(large.calibration.state, "unavailable");
  assert.equal(small.status, "ok");
  assert.equal(small.samples.length, 21);
  assert.equal(small.calibration.state, "within_measured_targets");
});

test("large SQLite retains all observations/graph and the five original failed criteria", () => {
  const entry = load("sqlite-1000").cases[0];
  assert.equal(entry.samples.length, 21);
  assert.equal(entry.calibration.first_count, 1);
  assert.equal(entry.calibration.warm_count, 20);
  assert.deepEqual(entry.samples[0].dom, { total: 26598, nodes: 1124, edges: 500, minimap_shapes: 0, labels: 500 });
  assert.deepEqual(entry.calibration.criteria.filter((row) => row.state === "exceeds_target").map((row) => row.name),
    ["menu_close_p95", "menu_open_p95", "tool_select_p95", "tool_pan_p95", "worst_gesture_frame_p95"]);
  assert.equal(load("sqlite-small").cases[0].calibration.state, "within_measured_targets");
});

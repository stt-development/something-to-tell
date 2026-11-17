import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { calibrationSummary } from "./calibration.mjs";

const load = (kind) => JSON.parse(readFileSync(new URL(`../../../docs/verification/baselines/p9-1-011-calibration-${kind}.json`, import.meta.url), "utf8"));
const sqlite = load("sqlite"), postgres = load("postgresql");
test("exit observations are sequential, same-source production protocol and retain every admitted sample", () => {
  assert.equal(sqlite.app_source_sha256, postgres.app_source_sha256);
  assert.equal(sqlite.probe_sha256, postgres.probe_sha256);
  assert.ok(Date.parse(sqlite.completed_at) <= Date.parse(postgres.started_at));
  let count = 0;
  for (const report of [sqlite, postgres]) {
    assert.equal(report.mode, "production"); assert.equal(report.interaction_suite, "calibration_v1");
    assert.equal(report.instrumentation, "baseline_observers"); assert.equal(report.phase_bundle_hooks_present, false);
    assert.equal(report.cases.length, 2);
    for (const row of report.cases) {
      assert.equal(row.cleanup, "released"); assert.deepEqual(calibrationSummary(row), row.calibration);
      if (row.status !== "ok") continue;
      assert.equal(row.samples.length, 21); count += row.samples.length;
      assert.equal(row.calibration.first_count, 1); assert.equal(row.calibration.warm_count, 20);
      assert.deepEqual(row.calibration.criteria.map((criterion) => criterion.limit_ms), [100, 100, 100, 100, 2000, 2000, 32]);
      for (const sample of row.samples) {
        assert.equal(sample.dom.nodes, row.fixture_nodes === 1000 ? 1124 : 18);
        assert.ok(sample.pan_frames.count >= 20 && sample.pan_frames.p95_ms !== null);
      }
    }
    for (const marker of ["password", "session_id", "http://", "127.0.0.1", "/Users/"]) assert.ok(!JSON.stringify(report).includes(marker));
  }
  assert.equal(count, 63);
});
test("improved large SQLite work is not relabeled as performance acceptance", () => {
  assert.equal(sqlite.cases[0].calibration.state, "within_measured_targets");
  const large = sqlite.cases[1].calibration;
  assert.equal(large.state, "baseline_exceeds_targets");
  assert.deepEqual(large.criteria.filter((row) => row.state === "exceeds_target").map((row) => row.name),
    ["menu_close_p95", "menu_open_p95", "tool_select_p95", "tool_pan_p95", "worst_gesture_frame_p95"]);
  assert.ok(large.criteria.filter((row) => row.name.endsWith("canvas_max")).every((row) => row.state === "within_target"));
});
test("large PostgreSQL preparation failure remains unavailable with all owned resources released", () => {
  assert.equal(postgres.database_cleanup, "released");
  assert.equal(postgres.cases[0].calibration.state, "within_measured_targets");
  const failed = postgres.cases[1];
  assert.equal(failed.fixture_nodes, 1000); assert.equal(failed.status, "preparation_failed");
  assert.equal(failed.step, "storage-migrations"); assert.equal(failed.error_code, "remote_storage_timeout");
  assert.deepEqual(failed.samples, []); assert.equal(failed.calibration.state, "unavailable");
});

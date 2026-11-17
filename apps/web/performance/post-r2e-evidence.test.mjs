import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calibrationSummary } from "./calibration.mjs";

// Freeze the admitted PostgreSQL case without rewriting earlier failed evidence.
test("post-R2e browser evidence admits complete PG1000 and preserves client failures", () => {
  const read = name => JSON.parse(readFileSync(new URL(`../../../docs/verification/baselines/${name}`, import.meta.url)));
  const pg = read("p9-1-011i-postgresql-1000.json");
  const sqlite = read("p9-1-011i-sqlite.json");
  assert.equal(pg.app_source_sha256, sqlite.app_source_sha256);
  assert.equal(pg.probe_sha256, sqlite.probe_sha256);
  assert.equal(pg.commit, sqlite.commit);
  assert.ok(Date.parse(pg.completed_at) <= Date.parse(sqlite.started_at));
  assert.equal(pg.database_cleanup, "released");
  const rows = [...pg.cases, ...sqlite.cases];
  assert.equal(rows.length, 3);
  for (const report of [pg, sqlite]) {
    assert.equal(report.worktree_dirty, false);
    assert.equal(report.guard_ms, 300000);
    assert.equal(report.instrumentation, "baseline_observers");
    assert.equal(report.phase_bundle_hooks_present, false);
    assert.deepEqual(report.targets, { menu_feedback_p95_ms: 100, pan_frame_p95_ms: 32, post_response_canvas_ms: 2000 });
  }
  for (const row of rows) {
    assert.equal(row.status, "ok"); assert.equal(row.cleanup, "released");
    assert.equal(row.samples.length, 21);
    assert.deepEqual(row.calibration, calibrationSummary(row));
    assert.equal(row.calibration.first_count, 1); assert.equal(row.calibration.warm_count, 20);
    if (row.fixture_nodes === 1000) {
      assert.deepEqual(row.calibration.criteria.filter(c => c.state === "exceeds_target").map(c => c.name),
        ["menu_close_p95", "menu_open_p95", "tool_select_p95", "tool_pan_p95", "worst_gesture_frame_p95"]);
      assert.ok(row.samples.every(sample => sample.dom.nodes === 1124 && sample.dom.edges === 500 && sample.dom.labels === 500));
    } else assert.equal(row.calibration.state, "within_measured_targets");
  }
  assert.equal(pg.cases[0].storage_mode, "postgresql");
  const previous = read("p9-1-011h-calibration-postgresql-1000.json");
  assert.equal(previous.cases[0].status, "preparation_failed");
  for (const secret of ["postgresql+psycopg", "stt_test_password", "/Users/", '"session_id"']) {
    assert.ok(!JSON.stringify([pg, sqlite]).includes(secret));
  }
});

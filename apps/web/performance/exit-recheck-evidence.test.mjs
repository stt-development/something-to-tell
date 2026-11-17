import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { calibrationSummary } from "./calibration.mjs";
import { summarizeRetention } from "./retention-contract.mjs";

const read = (path) => JSON.parse(readFileSync(new URL(`../../../docs/verification/${path}.json`, import.meta.url), "utf8"));
const matrix = () => [read("baselines/p9-1-011e-calibration-sqlite"),
  read("baselines/p9-1-011g-calibration-sqlite-small"), read("baselines/p9-1-011g-calibration-postgresql")];

test("current exit matrix admits63 same-source observations and preserves failed client gates", () => {
  const reports = matrix(); let admitted = 0;
  for (const [index, report] of reports.entries()) {
    assert.equal(report.app_source_sha256, reports[0].app_source_sha256);
    assert.equal(report.probe_sha256, reports[0].probe_sha256);
    assert.deepEqual(report.environment, reports[0].environment);
    assert.equal(report.interaction_suite, "calibration_v1"); assert.equal(report.instrumentation, "baseline_observers");
    if (index) assert.ok(Date.parse(reports[index - 1].completed_at) <= Date.parse(report.started_at));
    for (const row of report.cases.filter((row) => row.status === "ok")) {
      assert.equal(row.cleanup, "released"); assert.equal(row.samples.length, 21); admitted += row.samples.length;
      assert.deepEqual(row.calibration, calibrationSummary(row));
      assert.deepEqual(row.calibration.criteria.map((entry) => entry.limit_ms), [100, 100, 100, 100, 2000, 2000, 32]);
      assert.equal(row.calibration.state, row.fixture_nodes === 1000 ? "baseline_exceeds_targets" : "within_measured_targets");
    }
  }
  assert.equal(admitted, 63);
  assert.equal(reports[0].cases[0].calibration.criteria.filter((row) => row.state === "exceeds_target").length, 5);
});

test("PostgreSQL1000 preparation remains unavailable, with owned database and fixture released", () => {
  const report = matrix()[2], row = report.cases.find((row) => row.fixture_nodes === 1000);
  assert.equal(report.database_cleanup, "released"); assert.equal(row.cleanup, "released");
  assert.equal(row.status, "preparation_failed"); assert.equal(row.step, "storage-migrations");
  assert.equal(row.error_code, "remote_storage_timeout"); assert.equal(row.samples.length, 0);
  assert.equal(row.calibration.state, "unavailable"); assert.equal(row.calibration.criteria.length, 0);
});

test("current retention recheck releases16 owned sessions with complete closed-state observations", () => {
  const report = read("frontend-performance/p9-1-011g-retention");
  assert.equal(report.app_source_sha256, matrix()[0].app_source_sha256);
  assert.equal(report.status, "passed"); assert.equal(report.cleanup, "released"); assert.equal(report.switch_cleanup, "released");
  assert.deepEqual(report.cases.map((row) => row.viewport.width), [1440, 1024]);
  for (const row of report.cases) {
    assert.equal(row.status, "ok"); assert.equal(row.released_sessions, 8);
    assert.equal(row.page_errors, 0); assert.equal(row.unexpected_writes, 0);
    assert.equal(row.cycles.length, 8);
    assert.ok(row.cycles.every((cycle) => cycle.document_unchanged && cycle.old_history_missing && cycle.locale_round_trip));
    assert.deepEqual(summarizeRetention(row.checkpoints), row.retained_changes);
    assert.ok(row.checkpoints.every((checkpoint) => checkpoint.detached_roots === 0));
    // Report heap growth honestly; only DOM/listener equivalence is asserted here.
    for (const key of ["dom_nodes", "documents", "listeners"]) assert.equal(row.retained_changes[key].range, 0);
  }
});

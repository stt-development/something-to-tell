import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calibrationSummary } from "./calibration.mjs";

test("secondary Hand barrier trial preserves all unmet thresholds and owned release", () => {
  const read = name => JSON.parse(readFileSync(new URL(`../../../docs/verification/baselines/${name}.json`, import.meta.url)));
  const report = read("p9-1-011l-rejected-pointer-rule");
  const previous = read("p9-1-011i-sqlite").cases.find(row => row.fixture_nodes === 1000);
  const row = report.cases[0];
  assert.equal(report.worktree_dirty, false);
  assert.equal(row.status, "ok"); assert.equal(row.cleanup, "released");
  assert.equal(row.samples.length, 21); assert.deepEqual(row.geometry, previous.geometry);
  assert.deepEqual(row.calibration, calibrationSummary(row));
  assert.equal(row.calibration.criteria.filter(item => item.state === "exceeds_target").length, 5);
  assert.ok(row.samples.every(sample => sample.dom.nodes === 1124 && sample.dom.edges === 500));
});

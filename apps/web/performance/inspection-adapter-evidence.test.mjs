import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { calibrationSummary } from "./calibration.mjs";

test("inspection adapter observations preserve source distinction, protocol and every target", () => {
  const read = (name) => JSON.parse(readFileSync(new URL(`../../../docs/verification/baselines/${name}.json`, import.meta.url), "utf8"));
  const before = read("p9-1-011-calibration-sqlite"), after = read("p9-1-011a-calibration-sqlite");
  assert.notEqual(before.app_source_sha256, after.app_source_sha256);
  assert.equal(before.probe_sha256, after.probe_sha256);
  assert.deepEqual(before.environment, after.environment);
  assert.ok(Date.parse(before.completed_at) <= Date.parse(after.started_at));
  assert.equal(after.interaction_suite, "calibration_v1"); assert.equal(after.instrumentation, "baseline_observers");
  assert.equal(after.cases.length, 1);
  const row = after.cases[0];
  assert.equal(row.fixture_nodes, 1000); assert.equal(row.status, "ok"); assert.equal(row.cleanup, "released");
  assert.equal(row.fixture_source_sha256, before.cases[1].fixture_source_sha256);
  assert.equal(row.samples.length, 21); assert.equal(row.calibration.warm_count, 20);
  assert.deepEqual(row.calibration, calibrationSummary(row));
  assert.equal(row.calibration.state, "baseline_exceeds_targets");
  assert.deepEqual(row.calibration.criteria.map((criterion) => criterion.limit_ms), [100, 100, 100, 100, 2000, 2000, 32]);
  assert.equal(row.calibration.criteria.filter((criterion) => criterion.state === "exceeds_target").length, 5);
  assert.ok(row.samples.every((sample) => sample.dom.nodes === 1124 && sample.dom.edges === 500 && sample.pan_frames.count >= 20));
});

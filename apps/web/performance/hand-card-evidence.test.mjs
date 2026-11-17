import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { calibrationSummary } from "./calibration.mjs";

test("Hand card observations retain the original workload, protocol and release gates", () => {
  const read = (name) => JSON.parse(readFileSync(new URL(`../../../docs/verification/baselines/${name}.json`, import.meta.url), "utf8"));
  const before = read("p9-1-011a-calibration-sqlite"), after = read("p9-1-011b-calibration-sqlite");
  assert.notEqual(after.app_source_sha256, before.app_source_sha256);
  assert.equal(after.probe_sha256, before.probe_sha256);
  assert.deepEqual(after.environment, before.environment);
  assert.ok(Date.parse(before.completed_at) <= Date.parse(after.started_at));
  assert.equal(after.interaction_suite, "calibration_v1");
  assert.equal(after.instrumentation, "baseline_observers");
  assert.equal(after.cases.length, 1);
  const row = after.cases[0];
  assert.equal(row.status, "ok"); assert.equal(row.cleanup, "released");
  assert.equal(row.fixture_nodes, 1000);
  assert.equal(row.fixture_source_sha256, before.cases[0].fixture_source_sha256);
  assert.deepEqual(row.geometry, before.cases[0].geometry);
  assert.equal(row.samples.length, 21);
  assert.deepEqual(row.calibration, calibrationSummary(row));
  assert.deepEqual(row.calibration.criteria.map((entry) => entry.limit_ms), [100, 100, 100, 100, 2000, 2000, 32]);
  assert.ok(row.samples.every((sample) => sample.dom.nodes === 1124 && sample.dom.edges === 500 && sample.pan_frames.count >= 20));
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { calibrationSummary } from "./calibration.mjs";

const read = (name) => JSON.parse(readFileSync(new URL(`../../../docs/verification/baselines/${name}.json`, import.meta.url), "utf8"));

test("Hand plane observations preserve complete graph and protocol without a gate waiver", () => {
  const before = read("p9-1-011d-browser-work-sqlite"), trace = read("p9-1-011e-browser-work"), calibration = read("p9-1-011e-calibration-sqlite");
  assert.notEqual(trace.app_source_sha256, before.app_source_sha256);
  assert.equal(trace.probe_sha256, before.probe_sha256);
  assert.equal(trace.app_source_sha256, calibration.app_source_sha256);
  assert.equal(trace.probe_sha256, calibration.probe_sha256);
  assert.deepEqual(trace.environment, before.environment);
  const row = calibration.cases[0];
  assert.equal(row.status, "ok"); assert.equal(row.cleanup, "released");
  assert.equal(row.fixture_source_sha256, before.cases[0].fixture_source_sha256);
  assert.deepEqual(row.geometry, before.cases[0].geometry);
  assert.equal(row.samples.length, 21);
  assert.deepEqual(row.calibration, calibrationSummary(row));
  assert.deepEqual(row.calibration.criteria.map((entry) => entry.limit_ms), [100, 100, 100, 100, 2000, 2000, 32]);
  assert.ok(row.samples.every((sample) => sample.dom.nodes === 1124 && sample.dom.edges === 500 && sample.pan_frames.count >= 20));
  assert.equal(trace.cases[0].cleanup, "released");
  for (const sample of trace.cases[0].samples) {
    assert.deepEqual(sample.dom, before.cases[0].samples[0].dom);
    assert.equal(sample.browser_work.open.state, "unavailable");
    const pan = sample.browser_work.pan;
    assert.equal(pan.state, "observed");
    // Frozen evidence assertion only, not a portable production latency target.
    assert.ok(pan.events.find((event) => event.name === "HitTest").union_ms < 5);
  }
});

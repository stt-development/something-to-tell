import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name) => JSON.parse(readFileSync(new URL(`../../../docs/verification/baselines/${name}.json`, import.meta.url), "utf8"));

test("residual CPU evidence matches current source and conserves every sampled action", () => {
  const control = read("p9-1-011b-calibration-sqlite"), report = read("p9-1-011c-cpu-sqlite");
  assert.equal(report.app_source_sha256, control.app_source_sha256);
  assert.equal(report.probe_sha256, control.probe_sha256);
  assert.deepEqual(report.environment, control.environment);
  assert.equal(report.instrumentation, "sampled_cpu_1000us_with_sourcemaps");
  assert.equal(report.cases.length, 1);
  const row = report.cases[0];
  assert.equal(row.fixture_source_sha256, control.cases[0].fixture_source_sha256);
  assert.deepEqual(row.geometry, control.cases[0].geometry);
  assert.equal(row.status, "ok"); assert.equal(row.cleanup, "released");
  assert.equal(row.samples.length, 2);
  for (const sample of row.samples) {
    assert.deepEqual(sample.dom, control.cases[0].samples[0].dom);
    assert.deepEqual(Object.keys(sample.cpu), ["open", "menu", "pan", "flow"]);
    for (const profile of Object.values(sample.cpu)) {
      assert.equal(profile.accounting_consistent, true);
      assert.ok(profile.main_thread.TaskDuration_ms > 0);
      assert.ok(Math.abs(profile.by_category.reduce((sum, row) => sum + row.self_ms, 0) - profile.sampled_ms) < 1e-6);
      assert.ok(Math.abs(profile.top_sources.reduce((sum, row) => sum + row.self_ms, profile.other_sources_ms) - profile.sampled_ms) < 1e-6);
    }
  }
});

test("invalid first profile remains rejected and released, not counted as a CPU observation", () => {
  const rejected = read("p9-1-011c-cpu-rejected"), accepted = read("p9-1-011c-cpu-sqlite");
  assert.equal(rejected.app_source_sha256, accepted.app_source_sha256);
  assert.equal(rejected.probe_sha256, accepted.probe_sha256);
  const row = rejected.cases[0];
  assert.equal(row.status, "failed"); assert.equal(row.cleanup, "released");
  assert.equal(row.step, "open_canvas_0"); assert.equal(row.samples.length, 0);
  assert.ok(Date.parse(rejected.completed_at) <= Date.parse(accepted.started_at));
});

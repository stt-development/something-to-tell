import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("rejected compositing observation retains provenance and is not reported as shipped calibration", () => {
  const read = (name) => JSON.parse(readFileSync(new URL(`../../../docs/verification/baselines/${name}.json`, import.meta.url), "utf8"));
  const before = read("p9-1-011e-browser-work"), rejected = read("p9-1-011f-rejected-compositing");
  assert.equal(rejected.instrumentation, "browser_timeline_main_thread");
  assert.notEqual(rejected.app_source_sha256, before.app_source_sha256);
  assert.equal(rejected.probe_sha256, before.probe_sha256);
  assert.equal(rejected.cases[0].cleanup, "released");
  assert.equal(rejected.cases[0].status, "ok");
  assert.equal(rejected.cases[0].samples.length, 2);
  assert.deepEqual(rejected.cases[0].geometry, before.cases[0].geometry);
  for (const sample of rejected.cases[0].samples) {
    assert.deepEqual(sample.dom, before.cases[0].samples[0].dom);
    assert.equal(sample.browser_work.pan.state, "observed");
    assert.ok(sample.browser_work.pan.events.find((event) => event.name === "Layerize").union_ms > 200);
  }
  assert.ok(!("calibration" in rejected.cases[0]));
});

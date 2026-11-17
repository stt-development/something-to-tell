import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BROWSER_WORK_EVENTS } from "./browser-work.mjs";

test("browser timeline preserves full source/fixture and truthful available versus unsupported action evidence", () => {
  const read = (name) => JSON.parse(readFileSync(new URL(`../../../docs/verification/baselines/${name}.json`, import.meta.url), "utf8"));
  const report = read("p9-1-011d-browser-work-sqlite"), control = read("p9-1-011b-calibration-sqlite");
  assert.equal(report.app_source_sha256, control.app_source_sha256);
  assert.notEqual(report.probe_sha256, control.probe_sha256);
  assert.equal(report.interaction_suite, "browser_timeline_v1");
  assert.equal(report.instrumentation, "browser_timeline_main_thread");
  const row = report.cases[0];
  assert.equal(row.status, "ok"); assert.equal(row.cleanup, "released");
  assert.equal(row.fixture_source_sha256, control.cases[0].fixture_source_sha256);
  assert.deepEqual(row.geometry, control.cases[0].geometry);
  assert.equal(row.samples.length, 2);
  for (const sample of row.samples) {
    assert.deepEqual(sample.dom, control.cases[0].samples[0].dom);
    assert.equal(sample.browser_work.open.state, "unavailable");
    assert.equal(sample.browser_work.open.reason, "unsupported_event");
    for (const name of ["menu", "tool_select", "tool_pan", "pan", "flow"]) {
      const action = sample.browser_work[name];
      assert.equal(action.state, "observed");
      assert.ok(action.allowlisted_union_ms > 0);
      assert.equal(action.main_event_count, action.events.reduce((sum, event) => sum + event.count, 0));
      for (const event of action.events) {
        assert.ok(BROWSER_WORK_EVENTS.includes(event.name));
        assert.equal(event.count, event.timed_count + event.instant_count);
        if (!event.timed_count) assert.equal(event.union_ms, null);
        else {
          assert.ok(event.max_ms <= event.union_ms + 1e-9);
          assert.ok(event.union_ms <= event.inclusive_ms + 1e-9);
          assert.ok(event.union_ms <= action.allowlisted_union_ms + 1e-9);
        }
      }
    }
  }
  const text = JSON.stringify(report);
  for (const token of ["password", "session_id", "/Users/", "http://", "https://", '"args"']) assert.ok(!text.includes(token));
});

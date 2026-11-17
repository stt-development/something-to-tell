import { test } from "node:test";
import assert from "node:assert/strict";
import { calibrationSummary, activeCanvasTool } from "./calibration.mjs";
import { readFileSync } from "node:fs";
const rows = () => Array.from({ length: 21 }, (_, index) => ({ cache: index ? "warm_same_page" : "first_project_install",
  open_canvas_ms: 300, post_response_canvas_ms: 200, menu_close_feedback_ms: 30, menu_open_feedback_ms: 40,
  tool_select_feedback_ms: 20, tool_pan_feedback_ms: 25, pan_frames: { count: 32, p95_ms: 16 },
  resources: [{ route: "/api/project-sessions/open", wait_ms: 100 }] }));
test("calibration separates cold/warm observations and preserves frozen thresholds", () => {
  const result = calibrationSummary({ status: "ok", samples: rows() });
  assert.equal(result.state, "within_measured_targets"); assert.equal(result.first_count, 1); assert.equal(result.warm_count, 20);
  assert.equal(result.metrics.open_first.p95_ms, null); assert.equal(result.metrics.open_warm.p95_ms, 300);
  const slow = rows(); slow[0].post_response_canvas_ms = 2500; slow[20].menu_open_feedback_ms = 300;
  assert.equal(calibrationSummary({ status: "ok", samples: slow }).state, "baseline_exceeds_targets");
});
test("failed preparation, missing tail samples and sparse frames cannot pass", () => {
  assert.deepEqual(calibrationSummary({ status: "preparation_failed", error_code: "remote_storage_timeout" }),
    { state: "unavailable", reason: "remote_storage_timeout", criteria: [] });
  assert.equal(calibrationSummary({ status: "ok", samples: rows().slice(0, 19) }).state, "incomplete");
  const sparse = rows(); sparse[0].pan_frames = { count: 12, p95_ms: null };
  assert.equal(calibrationSummary({ status: "ok", samples: sparse }).criteria.at(-1).state, "unavailable");
});
test("tool feedback assertion requires the intended active button", () => {
  assert.equal(activeCanvasTool("Select", { querySelector: () => null }), false);
  assert.equal(activeCanvasTool("Select", { querySelector: () => ({ classList: { contains: () => true } }) }), true);
});

test("frozen calibration contains twenty warm samples per admitted case without pooled frame fiction", () => {
  const load = (kind) => JSON.parse(readFileSync(new URL(`../../../docs/verification/baselines/p9-1-calibration-${kind}-v1.json`, import.meta.url), "utf8"));
  const sqlite = load("sqlite"), pg = load("postgresql");
  assert.equal(sqlite.probe_sha256, pg.probe_sha256);
  assert.equal(sqlite.app_source_sha256, pg.app_source_sha256);
  assert.ok(Date.parse(sqlite.completed_at) <= Date.parse(pg.started_at));
  assert.equal(pg.database_cleanup, "released");
  let count = 0;
  for (const report of [sqlite, pg]) {
    assert.equal(report.interaction_suite, "calibration_v1");
    assert.equal(report.instrumentation, "baseline_observers");
    assert.equal(report.phase_bundle_hooks_present, false);
    assert.equal(report.cases.length, 2);
    for (const item of report.cases) {
      assert.equal(item.cleanup, "released");
      if (item.status !== "ok") {
        assert.equal(item.error_code, "remote_storage_timeout"); assert.deepEqual(item.samples, []);
        assert.equal(item.calibration.state, "unavailable"); continue;
      }
      assert.equal(item.samples.length, 21); count += 21;
      assert.equal(item.calibration.first_count, 1); assert.equal(item.calibration.warm_count, 20);
      assert.equal(item.calibration.metrics.open_first.p95_ms, null);
      assert.ok(item.calibration.metrics.open_warm.p95_ms > 0);
      assert.deepEqual(item.calibration.criteria.map((row) => row.limit_ms), [100, 100, 100, 100, 2000, 2000, 32]);
      for (const sample of item.samples) {
        assert.ok(sample.pan_frames.count >= 20 && sample.pan_frames.p95_ms !== null);
        assert.equal(sample.dom.nodes, item.fixture_nodes === 1000 ? 1124 : 18);
        assert.equal(sample.dom.minimap_shapes, sample.dom.nodes);
      }
    }
    for (const marker of ["password", "session_id", "http://", "127.0.0.1", "/Users/"]) assert.ok(!JSON.stringify(report).includes(marker));
  }
  assert.equal(count, 63);
  assert.equal(sqlite.cases[0].calibration.state, "within_measured_targets");
  assert.equal(sqlite.cases[1].calibration.state, "baseline_exceeds_targets");
  assert.equal(pg.cases[0].calibration.state, "within_measured_targets");
});

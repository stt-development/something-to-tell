import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("tool CPU archive preserves isolated actions, accounting and full input", () => {
  const read = name => JSON.parse(readFileSync(new URL(`../../../docs/verification/baselines/${name}.json`, import.meta.url)));
  const report = read("p9-1-011j-tool-cpu"), control = read("p9-1-011i-sqlite");
  assert.equal(report.app_source_sha256, control.app_source_sha256);
  assert.notEqual(report.probe_sha256, control.probe_sha256);
  assert.equal(report.worktree_dirty, false);
  assert.equal(report.instrumentation, "sampled_cpu_1000us_with_sourcemaps");
  const row = report.cases[0];
  assert.equal(row.status, "ok"); assert.equal(row.cleanup, "released");
  assert.equal(row.samples.length, 2); assert.ok(!("calibration" in row));
  for (const sample of row.samples) {
    assert.equal(sample.dom.nodes, 1124); assert.equal(sample.dom.edges, 500);
    assert.deepEqual(Object.keys(sample.cpu), ["open", "menu", "tool_select", "tool_pan", "pan", "flow"]);
    for (const cpu of Object.values(sample.cpu)) {
      assert.equal(cpu.accounting_consistent, true);
      assert.ok(Math.abs(cpu.by_category.reduce((sum, item) => sum + item.self_ms, 0) - cpu.sampled_ms) < 1e-6);
      assert.ok(Math.abs(cpu.top_sources.reduce((sum, item) => sum + item.self_ms, cpu.other_sources_ms) - cpu.sampled_ms) < 1e-6);
      assert.ok(cpu.main_thread.TaskDuration_ms > 0);
    }
  }
  for (const secret of ["http://", "/Users/", '"session_id"', '"callFrame"', '"functionName"']) {
    assert.ok(!JSON.stringify(report).includes(secret));
  }
});

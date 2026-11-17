import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BROWSER_WORK_EVENTS } from "./browser-work.mjs";

const read = suffix => JSON.parse(readFileSync(new URL(
  `../../../docs/verification/baselines/p9-1-011o-working-tool-${suffix}.json`, import.meta.url), "utf8"));
const control = JSON.parse(readFileSync(new URL(
  "../../../docs/verification/baselines/p9-1-011n-grid-default-working.json", import.meta.url), "utf8"));

test("working tool profilers are separate diagnostics with exact ordinary-source and owned compatibility evidence", () => {
  const trace = read("trace"), cpu = read("cpu");
  assert.equal(trace.instrumentation, "browser_timeline_main_thread");
  assert.equal(cpu.instrumentation, "sampled_cpu_1000us_with_sourcemaps");
  assert.ok(Date.parse(trace.completed_at) <= Date.parse(cpu.started_at));
  assert.notEqual(trace.harness_sha256, cpu.harness_sha256);
  for (const report of [trace, cpu]) {
    assert.equal(report.app_source_sha256, control.app_source_sha256);
    assert.equal(report.fixture_source_sha256, control.fixture_source_sha256);
    assert.equal(report.fixture_variant, "root_grid_v1");
    assert.equal(report.build_mode, "unoverridden_production_default");
    assert.equal(report.node_dom_source_gate_enabled, false);
    assert.equal(report.quick, false); assert.equal(report.status, "passed");
    assert.equal(report.cleanup, "released");
    assert.deepEqual(report.cases.map(row => row.viewport.width), [1440, 1024]);
    for (const row of report.cases) {
      assert.equal(row.enabled, null); assert.equal(row.status, "ok");
      assert.equal(row.working_zoom, 1.05); assert.equal(row.working_visible_nodes, 9);
      assert.equal(row.stages.zoomed_nodes, 1124); assert.equal(row.stages.minimap_nodes, 1124);
      assert.equal(row.stages.edge_routes, 500); assert.equal(row.stages.labels, 500);
      assert.equal(row.stages.flow_nodes, 7); assert.equal(row.page_errors, 0); assert.equal(row.write_attempts, 0);
      assert.equal(row.document_unchanged, true); assert.equal(row.session_released, true);
      assert.equal(row.boundary_curve_comparison.equal, true);
      for (const timing of [row.conditional_tool_feedback.select, row.conditional_tool_feedback.pan]) {
        assert.equal(timing.count, 3); assert.equal(timing.p95_ms, null);
      }
    }
    assert.doesNotMatch(JSON.stringify(report), /session_id|api_key|error_message|\/private\/|callFrame|functionName|postgresql:\/\//i);
  }
});

test("twelve working-view timelines retain allowlisted interval accounting rather than additive stage CPU", () => {
  for (const row of read("trace").cases) {
    assert.equal(row.tool_cpu, undefined); assert.equal(row.tool_browser_work.length, 3);
    for (const pair of row.tool_browser_work) for (const trace of Object.values(pair)) {
      assert.equal(trace.state, "observed");
      assert.ok(trace.events.every(event => BROWSER_WORK_EVENTS.includes(event.name)));
      assert.ok(trace.events.find(event => event.name === "EventDispatch").union_ms > 0);
      assert.ok(trace.events.find(event => event.name === "UpdateLayoutTree").union_ms > 0);
      assert.ok(trace.allowlisted_union_ms > 0);
    }
  }
});

test("twelve working-view CPU profiles preserve leaf accounting and do not mix tracing", () => {
  for (const row of read("cpu").cases) {
    assert.equal(row.tool_browser_work, undefined); assert.equal(row.tool_cpu.length, 3);
    for (const pair of row.tool_cpu) for (const cpu of Object.values(pair)) {
      assert.equal(cpu.accounting_consistent, true);
      assert.ok(Math.abs(cpu.by_category.reduce((sum, item) => sum + item.self_ms, 0) - cpu.sampled_ms) < 1e-6);
      assert.ok(Math.abs(cpu.top_sources.reduce((sum, item) => sum + item.self_ms, cpu.other_sources_ms) - cpu.sampled_ms) < 1e-6);
      assert.ok(cpu.main_thread.ScriptDuration_ms > 0);
      assert.ok(cpu.main_thread.RecalcStyleDuration_ms > 0);
    }
  }
});

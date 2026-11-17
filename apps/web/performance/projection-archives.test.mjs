import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (name) => JSON.parse(readFileSync(new URL(`../../../docs/verification/baselines/${name}`, import.meta.url), "utf8"));
const observer = read("p9-1-003f-selection-production-v1.json");
const profiled = read("p9-1-003f-selection-phases-v1.json");
const previous = read("p9-1-002e5j4-selection-production-v1.json");

/** Preserve attribution limits: identical probes/workloads are not a paired causal experiment. */
test("projection archives share captured sources and separate sequential instrumentation", () => {
  assert.equal(observer.commit, profiled.commit);
  assert.equal(observer.app_source_sha256, profiled.app_source_sha256);
  assert.equal(observer.probe_sha256, profiled.probe_sha256);
  assert.deepEqual(observer.environment, profiled.environment);
  assert.ok(Date.parse(observer.completed_at) <= Date.parse(profiled.started_at));
  assert.equal(observer.instrumentation, "baseline_observers");
  assert.equal(profiled.instrumentation, "production_react_profiler_and_sync_phases");
  assert.equal(observer.phase_bundle_hooks_present, false);
  assert.equal(profiled.phase_bundle_hooks_present, true);
});

test("projection comparison preserves historical workload without hiding dense geometry", () => {
  assert.notEqual(observer.app_source_sha256, previous.app_source_sha256);
  assert.equal(observer.probe_sha256, previous.probe_sha256);
  assert.deepEqual(observer.environment, previous.environment);
  for (const report of [observer, profiled]) {
    const entry = report.cases[0], old = previous.cases[0];
    assert.equal(entry.fixture_source_sha256, old.fixture_source_sha256);
    assert.deepEqual(entry.geometry, old.geometry);
    assert.equal(entry.geometry.variant, "pinned_original_overlap");
    for (const sample of entry.samples) assert.deepEqual(sample.dom, old.samples[0].dom);
  }
});

for (const [report, samples, phases] of [[observer, 2, false], [profiled, 1, true]]) {
  test(`projection archive retains exact selection, owned cleanup and sanitized evidence with profiling=${phases}`, () => {
    assert.equal(report.mode, "production");
    assert.equal(report.storage_mode, "local_sqlite");
    assert.equal(report.interaction_suite, "selection_v1");
    assert.equal(report.guard_ms, 120000);
    for (const key of ["app_source_sha256", "probe_sha256"]) assert.match(report[key], /^[a-f0-9]{64}$/);
    assert.equal(report.cases.length, 1);
    const entry = report.cases[0];
    assert.equal(entry.fixture_nodes, 1000);
    assert.equal(entry.status, "ok");
    assert.equal(entry.cleanup, "released");
    assert.equal(entry.samples.length, samples);
    assert.deepEqual(entry.viewport, { width: 1440, height: 900 });
    assert.equal(entry.dpr, 1);
    for (const sample of entry.samples) {
      assert.equal(sample.flow_dom_nodes, 7);
      assert.equal(sample.dom.nodes, 1124);
      assert.equal(sample.dom.minimap_shapes, 1124);
      for (const mode of ["graph", "flow"]) {
        const selection = sample.selection[mode];
        assert.equal(selection.blocked_mutations, 0);
        for (const [action, expected] of [["single", 1], ["multi", 2], ["clear", 0]]) {
          const value = selection[action];
          assert.equal(value.selected_count, expected);
          assert.ok(Number.isFinite(value.feedback_ms) && value.feedback_ms >= 0);
          if (!phases) { assert.equal(value.phases, undefined); continue; }
          const { react, phases: scopes } = value.phases;
          assert.ok(Number.isInteger(react.commits) && react.commits > 0);
          assert.equal(Object.values(react.by_phase).reduce((sum, count) => sum + count, 0), react.commits);
          assert.ok(Number.isFinite(react.render_actual_ms) && react.render_actual_ms >= 0);
          for (const name of ["snapshot_projection", "store_prepare"]) assert.equal(scopes[name].count, 0);
          for (const name of ["workspace_projection", "view_filter", "frame_projection"]) assert.equal(scopes[name].count, 1);
        }
      }
    }
    for (const marker of ["/Users/", "/var/folders/", "127.0.0.1", "session_id", "password", "http://", '"id":']) {
      assert.ok(!JSON.stringify(report).includes(marker), `private archive marker: ${marker}`);
    }
  });
}

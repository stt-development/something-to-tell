import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (name) => JSON.parse(readFileSync(new URL(`../../../docs/verification/baselines/${name}`, import.meta.url), "utf8"));
const observer = read("p9-1-002e5j4-selection-production-v1.json");
const profiled = read("p9-1-002e5j4-selection-phases-v1.json");

/** Reviewed reference evidence is separate from aggregate commits and instrumented latency. */
test("assembly exit archives share source/workload provenance but separate instrumentation", () => {
  assert.equal(observer.app_source_sha256, profiled.app_source_sha256);
  assert.equal(observer.probe_sha256, profiled.probe_sha256);
  assert.equal(observer.commit, profiled.commit);
  assert.deepEqual(observer.environment, profiled.environment);
  assert.equal(observer.instrumentation, "baseline_observers");
  assert.equal(profiled.instrumentation, "production_react_profiler_and_sync_phases");
  assert.equal(observer.phase_bundle_hooks_present, false);
  assert.equal(profiled.phase_bundle_hooks_present, true);
});

for (const [report, count, phases] of [[observer, 2, false], [profiled, 1, true]]) {
  test(`assembly selection archive preserves owned observations with profiling=${phases}`, () => {
    assert.equal(report.mode, "production");
    assert.equal(report.storage_mode, "local_sqlite");
    assert.equal(report.interaction_suite, "selection_v1");
    assert.equal(report.guard_ms, 120000);
    assert.equal(report.cases.length, 1);
    const entry = report.cases[0];
    const baseline = read("p9-1-000b3a-selection-production-v1.json").cases.find((item) => item.fixture_nodes === 1000);
    assert.equal(entry.fixture_source_sha256, baseline.fixture_source_sha256);
    assert.deepEqual(entry.geometry, baseline.geometry);
    assert.equal(entry.fixture_nodes, 1000);
    assert.equal(entry.status, "ok");
    assert.equal(entry.cleanup, "released");
    assert.equal(entry.samples.length, count);
    assert.deepEqual(entry.viewport, { width: 1440, height: 900 });
    assert.equal(entry.dpr, 1);
    for (const sample of entry.samples) {
      assert.equal(sample.dom.nodes, 1124);
      assert.equal(sample.dom.minimap_shapes, 1124);
      assert.equal(sample.flow_dom_nodes, 7);
      for (const mode of ["graph", "flow"]) {
        const selection = sample.selection[mode];
        assert.equal(selection.blocked_mutations, 0);
        for (const [action, selected] of [["single", 1], ["multi", 2], ["clear", 0]]) {
          const value = selection[action];
          assert.equal(value.selected_count, selected);
          assert.ok(Number.isFinite(value.feedback_ms) && value.feedback_ms >= 0);
          if (phases) {
            const react = value.phases.react;
            assert.ok(Number.isInteger(react.commits) && react.commits > 0);
            assert.equal(Object.values(react.by_phase).reduce((sum, number) => sum + number, 0), react.commits);
            assert.ok(Number.isFinite(react.render_actual_ms) && react.render_actual_ms >= 0);
          } else assert.equal(value.phases, undefined);
        }
      }
    }
    for (const marker of ["/Users/", "/var/folders/", "127.0.0.1", "session_id", "password", "http://", '"id":']) {
      assert.ok(!JSON.stringify(report).includes(marker), `private archive marker: ${marker}`);
    }
  });
}

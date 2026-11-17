import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("search phase evidence is sequential, source-matched and distinguishes filtering from rendering", () => {
  const read = (name) => JSON.parse(readFileSync(new URL(`../../../docs/verification/frontend-performance/${name}`, import.meta.url)));
  const phases = read("p9-1-007c-search-phases.json"), control = read("p9-1-007c-search-control.json");
  assert.equal(phases.app_source_sha256, control.app_source_sha256);
  assert.equal(phases.probe_sha256, control.probe_sha256);
  assert.ok(Date.parse(phases.completed_at) < Date.parse(control.started_at));
  assert.equal(phases.phase_bundle_hooks_present, true); assert.equal(control.phase_bundle_hooks_present, false);
  for (const report of [phases, control]) {
    assert.equal(report.interaction_suite, "navigation_v3");
    assert.equal(report.cases.length, 1); const row = report.cases[0];
    assert.equal(row.status, "ok"); assert.equal(row.cleanup, "released"); assert.equal(row.samples.length, 2);
    for (const sample of row.samples) {
      assert.equal(sample.workflow.blocked_mutations, 0);
      assert.equal(sample.workflow.nodes_before, 1124); assert.equal(sample.workflow.nodes_after, 1124);
      for (const action of ["search_empty", "search_restore"]) {
        const observation = sample.workflow[action]; assert.ok(observation.settled_ms > 0);
        if (report === control) assert.equal(Object.hasOwn(observation, "phases"), false);
        else {
          assert.equal(observation.phases.phases.view_filter.count, 1);
          assert.equal(observation.phases.phases.snapshot_projection.count, 0);
          assert.ok(observation.phases.react.commits > 0);
        }
      }
    }
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const json = (name) => JSON.parse(readFileSync(new URL(`../../../docs/verification/baselines/${name}.json`, import.meta.url)));
const phases = json("p9-1-006a-current-phases-v1"), control = json("p9-1-006a-current-control-v1"), offline = json("p9-1-006a-offline-work-v1");
test("current hydration profiles and control are sequential, source-matched and complete owned cases", () => {
  assert.equal(phases.app_source_sha256, control.app_source_sha256); assert.equal(phases.probe_sha256, control.probe_sha256);
  assert.ok(Date.parse(phases.completed_at) <= Date.parse(control.started_at));
  assert.equal(phases.phase_bundle_hooks_present, true); assert.equal(control.phase_bundle_hooks_present, false);
  for (const report of [phases, control]) {
    assert.deepEqual(report.cases.map((row) => row.fixture_nodes), [16, 1000]);
    assert.deepEqual(report.app_static_sources, ["apps/web/performance/rendering-policy.v1.json"]);
    for (const row of report.cases) {
      assert.equal(row.status, "ok"); assert.equal(row.cleanup, "released"); assert.equal(row.samples.length, 2);
      assert.deepEqual(row.samples.map((sample) => sample.cache), ["first_project_install", "warm_same_page"]);
      for (const sample of row.samples) {
        assert.equal(sample.dom.nodes, row.fixture_nodes === 1000 ? 1124 : 18);
        assert.equal(sample.dom.minimap_shapes, 0); assert.ok(sample.post_response_canvas_ms > 0);
      }
    }
  }
});
test("profile retains one DTO/store preparation, absent client validation and independent projection counts", () => {
  for (const row of phases.cases) for (const sample of row.samples) {
    const open = sample.phases.open;
    assert.equal(open.client_document_validation, "not_present_in_open_path");
    assert.equal(open.phases.snapshot_projection.count, 1); assert.equal(open.phases.store_prepare.count, 1);
    for (const key of ["workspace_projection", "view_filter", "frame_projection"]) assert.equal(open.phases[key].count, 2);
    assert.ok(open.react.commits > 0);
  }
});
test("isolated offline parse and original parent-order work retain pinned input and complete projection", () => {
  assert.equal(offline.status, "passed"); assert.equal(offline.app_source_sha256, control.app_source_sha256);
  const row = offline.cases[0], manifest = JSON.parse(readFileSync(new URL("../../../fixtures/benchmarks/manifest.v1.json", import.meta.url)));
  assert.equal(row.fixture_sha256, manifest.projects["1000"].gzip_sha256); assert.equal(row.source_nodes, 1000);
  assert.equal(row.input_unchanged, true); assert.equal(row.parse_samples.length, 5);
  assert.ok(row.parse_samples.every((sample) => sample.nodes === 1000 && sample.milliseconds >= 0));
  assert.deepEqual(row.parent_order, { id_reads: 4123529, parent_reads: 18921, projected_nodes: 1124, exact_order: true });
});

test("optimized conversion retains source-matched sequential phase/control coverage and unchanged scope sizes", () => {
  const profile = json("p9-1-006b-current-phases-v1"), comparison = json("p9-1-006b-current-control-v1");
  assert.equal(profile.app_source_sha256, comparison.app_source_sha256); assert.notEqual(profile.app_source_sha256, phases.app_source_sha256);
  assert.equal(profile.probe_sha256, comparison.probe_sha256); assert.equal(profile.probe_sha256, phases.probe_sha256);
  assert.ok(Date.parse(profile.completed_at) <= Date.parse(comparison.started_at));
  for (const report of [profile, comparison]) {
    assert.equal(report.cases.length, 2);
    for (const [index, row] of report.cases.entries()) {
      assert.equal(row.fixture_source_sha256, phases.cases[index].fixture_source_sha256);
      assert.equal(row.status, "ok"); assert.equal(row.cleanup, "released"); assert.equal(row.samples.length, 2);
      for (const sample of row.samples) {
        assert.equal(sample.dom.nodes, row.fixture_nodes === 1000 ? 1124 : 18);
        assert.equal(sample.dom.edges, row.fixture_nodes === 1000 ? 500 : 12); assert.equal(sample.dom.minimap_shapes, 0);
        if (sample.phases) {
          assert.equal(sample.phases.open.phases.snapshot_projection.count, 1); assert.equal(sample.phases.open.phases.store_prepare.count, 1);
        }
      }
    }
  }
});
test("optimized parent-order work is bounded and exact on the unchanged complete pinned input", () => {
  const result = json("p9-1-006b-offline-work-v1"), profile = json("p9-1-006b-current-phases-v1");
  assert.equal(result.status, "passed"); assert.equal(result.app_source_sha256, profile.app_source_sha256);
  const row = result.cases[0], old = offline.cases[0];
  assert.equal(row.fixture_sha256, old.fixture_sha256); assert.equal(row.input_bytes, old.input_bytes); assert.equal(row.input_unchanged, true);
  assert.deepEqual(row.parent_order, { id_reads: 19610, parent_reads: 3116, projected_nodes: 1124, exact_order: true });
  assert.ok(row.parent_order.id_reads < old.parent_order.id_reads / 100);
});

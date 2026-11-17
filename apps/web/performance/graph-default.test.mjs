import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the unoverridden production default archive proves rollback, reload, Flow fallback and owned release", () => {
  const report = JSON.parse(readFileSync(new URL("../../../docs/verification/baselines/p9-1-005b2c2b3g4-graph-default-v1.json", import.meta.url)));
  const manifest = JSON.parse(readFileSync(new URL("../../../fixtures/benchmarks/manifest.v1.json", import.meta.url)));
  assert.equal(report.suite, "viewport_graph_default_activation_v1"); assert.equal(report.workflow, "defaults");
  assert.equal(report.build_mode, "unoverridden_production_default"); assert.equal(report.source_gate_enabled, true);
  assert.equal(report.status, "passed"); assert.equal(report.quick, false); assert.equal(report.cleanup, "released");
  assert.equal(report.fixture_source_sha256, manifest.projects["1000"].gzip_sha256);
  for (const key of ["harness_sha256", "app_source_sha256"]) assert.match(report[key], /^[a-f0-9]{64}$/);
  assert.deepEqual(report.cases.map((c) => `${c.viewport.width}x${c.viewport.height}`).sort(), ["1024x768", "1440x900"]);
  for (const c of report.cases) {
    assert.equal(c.enabled, null); assert.equal(c.status, "ok"); assert.equal(c.step, "complete");
    assert.equal(c.page_errors, 0); assert.equal(c.write_attempts, 0); assert.equal(c.released_sessions, 2);
    assert.equal(c.document_unchanged, true); assert.equal(c.offscreen_flow_full, true);
    assert.deepEqual(Object.keys(c.stages).sort(), ["explicit_off", "explicit_on", "inherited_on", "off_before_reload", "on_after_reload", "persisted_off"]);
    for (const [name, stage] of Object.entries(c.stages)) {
      assert.equal(stage.wrappers, 1124); assert.equal(stage.handles, 4496); assert.equal(stage.minimap, 1124);
      assert.equal(stage.edges, 500); assert.equal(stage.labels, 500);
      assert.equal(stage.no_visible_shells, true); assert.equal(stage.original_handles, true);
      assert.equal(stage.full_bodies + stage.shells, 1124);
      if (["inherited_on", "explicit_on", "on_after_reload"].includes(name)) assert.ok(stage.shells > 0);
      else assert.equal(stage.shells, 0);
    }
    for (const name of ["off_geometry", "on_geometry", "reload_geometry"]) {
      assert.equal(c[name].equal, true); assert.equal(c[name].mismatches, 0); assert.equal(c[name].tolerance_world, 0.05);
      assert.ok(Number.isFinite(c[name].max_numeric_delta) && c[name].max_numeric_delta >= 0 && c[name].max_numeric_delta <= 0.05);
    }
  }
  assert.equal(JSON.stringify(report).includes("error_message"), false);
});

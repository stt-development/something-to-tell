import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const json = (name) => JSON.parse(readFileSync(new URL(`../../../docs/verification/baselines/${name}.json`, import.meta.url)));
for (const [suffix, active] of [["gate", false], ["default", true]]) test(`frozen MiniMap ${suffix} covers complete projections, exact navigation, unchanged documents and release`, () => {
  const report = json(`p9-1-005d-minimap-${suffix}-v1`);
  assert.equal(report.status, "passed"); assert.equal(report.quick, false); assert.equal(report.cleanup, "released");
  assert.equal(report.minimap_source_gate_enabled, active); assert.equal(report.build_mode, "unoverridden_production_default");
  assert.equal(report.fixture_variant, "deep_detail_v1");
  const manifest = JSON.parse(readFileSync(new URL("../../../fixtures/benchmarks/manifest.v1.json", import.meta.url)));
  assert.equal(report.fixture_source_sha256, manifest.projects["1000"].gzip_sha256);
  assert.deepEqual(report.cases.map((row) => row.viewport.width).sort(), [1024, 1440]);
  for (const row of report.cases) {
    assert.equal(row.status, "ok"); assert.equal(row.step, "complete"); assert.equal(row.enabled, null);
    assert.equal(row.page_errors, 0); assert.equal(row.write_attempts, 0); assert.equal(row.released_sessions, 2);
    for (const key of ["pan_does_not_repaint", "global_domain_stable", "scoped_navigation", "rollback_reload", "document_unchanged"]) assert.equal(row[key], true, key);
    assert.ok(row.pan_domain_delta_world < 0.05);
    assert.deepEqual(Object.keys(row.stages), ["graph_fit", "graph_distant", "focused_frame", "flow_fit", "flow_panned", "graph_restored", "reloaded_live_on"]);
    for (const [name, stage] of Object.entries(row.stages)) {
      const expected = name === "focused_frame" ? [6, 512] : name.startsWith("flow") ? [7, 92] : [1124, 472];
      assert.equal(stage.projection_nodes, expected[0]); assert.equal(stage.represented_nodes, expected[0]);
      assert.equal(stage.painted_cells, expected[1]); assert.equal(stage.last_raster_cells, expected[1]);
      assert.equal(stage.minimap_dom, 3); assert.equal(stage.legacy_shapes, 0); assert.ok(stage.painted_pixels > 0);
      assert.ok(stage.viewport_delta_css_px < 0.05); assert.ok(stage.instrumented_clear_to_last_fill_ms >= 0);
    }
    assert.equal(row.stages.graph_fit.raster_paints, row.stages.graph_distant.raster_paints);
    assert.equal(row.stages.flow_fit.raster_paints, row.stages.flow_panned.raster_paints);
  }
});

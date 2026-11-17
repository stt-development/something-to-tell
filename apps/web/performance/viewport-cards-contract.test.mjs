import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVED_GRAPH_CARD_DEFAULT, compareCardLayouts, viewportCardGatePlugin, RELEASE_MODULE, VIEWPORT_CARD_SUITE } from "./viewport-cards-contract.mjs";

const sourceGate = 'export const VIEWPORT_CARD_PRESENTATION_ENABLED = true;\nfunction CanvasNodePresentation({ children, enabled, detailEnabled, workspaceMode = "relationships" }) {}';

test("build metadata agrees with the approved production Graph default", () => {
  const source = readFileSync(new URL("../src/app/graph/CanvasNodePresentation.tsx", import.meta.url), "utf8");
  assert.equal(APPROVED_GRAPH_CARD_DEFAULT, true);
  assert.equal(source.split(`export const VIEWPORT_CARD_PRESENTATION_ENABLED = ${APPROVED_GRAPH_CARD_DEFAULT};`).length, 2);
});

test("the test override applies to one exact module without changing the production default", () => {
  assert.equal(VIEWPORT_CARD_SUITE, "viewport_card_shell_graph_v1");
  for (const enabled of [false, true]) {
    const plugin = viewportCardGatePlugin(enabled);
    assert.equal(plugin.transform("anything", "/other.ts"), null);
    const transformed = plugin.transform(sourceGate, `/web${RELEASE_MODULE}`);
    assert.ok(transformed.startsWith("export const VIEWPORT_CARD_PRESENTATION_ENABLED = true;"));
    assert.ok(transformed.includes(`{ children, enabled = ${enabled}, detailEnabled, workspaceMode = "relationships" }`));
    plugin.buildEnd();
  }
});
test("a missing, renamed or multiply transformed gate cannot silently pass", () => {
  assert.throws(() => viewportCardGatePlugin(true).buildEnd(), /gate_not_verified/);
  assert.throws(() => viewportCardGatePlugin(true).transform("changed", RELEASE_MODULE), /gate_changed/);
  const plugin = viewportCardGatePlugin(true);
  assert.throws(() => viewportCardGatePlugin(true).transform(sourceGate.replace("= true;", "= false;"), RELEASE_MODULE), /gate_changed/);
  assert.throws(() => viewportCardGatePlugin(true).transform("export const VIEWPORT_CARD_PRESENTATION_ENABLED = true;", RELEASE_MODULE), /test_override_changed/);
  assert.throws(() => viewportCardGatePlugin(true).transform(sourceGate + sourceGate, RELEASE_MODULE), /gate_changed/);
  for (let i = 0; i < 2; i++) plugin.transform(sourceGate, RELEASE_MODULE);
  assert.throws(() => plugin.buildEnd(), /gate_not_verified/);
});
test("comparison ignores intentional body/DOM counts, but preserves geometry and structural counts", () => {
  const reference = { geometry: { nodes: [{ id: "a", bounds: [0, 0, 260, 156] }], path: "M0 0" },
    counts: { wrappers: 1, handles: 4, edges: 1, labels: 1, minimap: 1, full_bodies: 1, shells: 0, total_dom: 100 } };
  const candidate = structuredClone(reference); Object.assign(candidate.counts, { full_bodies: 0, shells: 1, total_dom: 10 });
  assert.equal(compareCardLayouts(reference, candidate).equal, true);
  candidate.geometry.nodes[0].bounds[0] = 0.02;
  assert.equal(compareCardLayouts(reference, candidate).equal, true);
  candidate.geometry.nodes[0].bounds[0] = 1;
  assert.equal(compareCardLayouts(reference, candidate).equal, false);
  candidate.geometry = reference.geometry; candidate.counts.handles--;
  assert.equal(compareCardLayouts(reference, candidate).equal, false);
});
test("missing ids, paths, labels, nonfinite or removed geometry fail comparison", () => {
  const reference = { geometry: { id: "a", bounds: [1, 2, 3, 4], path: "M0 0", label: "Label" },
    counts: { wrappers: 1, handles: 4, edges: 1, labels: 1, minimap: 1 } };
  for (const geometry of [{ ...reference.geometry, id: "b" }, { ...reference.geometry, path: null },
    { ...reference.geometry, label: "Changed" }, { ...reference.geometry, bounds: [NaN, 2, 3, 4] }, {}]) {
    assert.equal(compareCardLayouts(reference, { ...reference, geometry }).equal, false);
  }
});
test("empty or malformed observations cannot pass as equal layouts", () => {
  assert.equal(compareCardLayouts({}, {}).equal, false);
  assert.equal(compareCardLayouts({ geometry: {}, counts: {} }, { geometry: {}, counts: {} }).equal, false);
});
test("the frozen Graph browser archive proves geometry, read-only data and owned cleanup without wrapper-culling claims", () => {
  const report = JSON.parse(readFileSync(new URL("../../../docs/verification/baselines/p9-1-005b2c1-graph-card-shells-v1.json", import.meta.url)));
  assert.equal(report.suite, VIEWPORT_CARD_SUITE); assert.equal(report.status, "passed");
  assert.equal(report.quick, false); assert.equal(report.source_gate_enabled, false);
  assert.equal(report.cases.length, 8); assert.equal(report.comparisons.length, 4);
  const manifest = JSON.parse(readFileSync(new URL("../../../fixtures/benchmarks/manifest.v1.json", import.meta.url)));
  assert.equal(report.fixture_source_sha256, manifest.projects["1000"].gzip_sha256);
  assert.equal(new Set(report.cases.map((entry) => `${entry.variant}:${entry.viewport.width}:${entry.enabled}`)).size, 8);
  assert.deepEqual([...new Set(report.cases.map((entry) => entry.viewport.width))].sort(), [1024, 1440]);
  assert.deepEqual([...new Set(report.cases.map((entry) => entry.variant))].sort(), ["pinned_original_overlap", "root_grid_v1"]);
  assert.deepEqual(report.cleanup, ["released", "released"]);
  for (const entry of report.cases) {
    assert.equal(entry.status, "ok"); assert.equal(entry.step, "complete");
    assert.equal(entry.document_unchanged, true); assert.equal(entry.session_released, true);
    assert.equal(entry.page_errors, 0); assert.equal(entry.write_attempts, 0);
    assert.equal(Object.keys(entry.stages).length, 5);
    for (const value of Object.values(entry.stages)) {
      assert.equal(value.counts.wrappers, 1124); assert.equal(value.counts.handles, 4496);
      assert.equal(value.counts.edges, 500); assert.equal(value.counts.labels, 500); assert.equal(value.counts.minimap, 1124);
      assert.equal(value.counts.full_bodies + value.counts.shells, 1124);
      assert.equal(value.visible_shells, 0); assert.equal(value.invalid_handle_bounds, 0);
    }
    if (entry.enabled && entry.variant === "root_grid_v1") assert.equal(entry.stages.focused.counts.full_bodies, 8);
    assert.equal(entry.stages.fit.counts.full_bodies, 1124);
  }
  for (const comparison of report.comparisons) {
    assert.equal(Object.keys(comparison.stages).length, 5);
    for (const stage of Object.values(comparison.stages)) {
      assert.equal(stage.equal, true); assert.equal(stage.mismatches, 0); assert.equal(stage.max_numeric_delta, 0);
    }
  }
});

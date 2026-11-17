import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROTECTED_AUTHORING_SUITE, verifyProtectedAuthoring } from "./protected-authoring-contract.mjs";

function snapshots() {
  const before = { manifest: { project_id: "owned", settings: { ui_locale: "en" } }, nodes: [{ id: "baseline", summary: "Original" }], placements: [], edges: [], engine_tag_definitions: [] };
  const ids = ["a", "b", "c"], text = "Edited canary";
  const created = { ...structuredClone(before), nodes: [...before.nodes, ...ids.map((id) => ({ id, summary: "New" }))],
    placements: ids.map((id, index) => ({ id: `p-${id}`, canonical_node_id: id, is_primary: true, x: index * 400, y: 0, width: 260, height: 156, container_node_id: null })) };
  const moved = structuredClone(created);
  for (const placement of moved.placements.slice(0, 2)) { placement.x += 40; placement.y += 20; }
  const resized = structuredClone(moved); resized.placements[0].width += 40; resized.placements[0].height += 30;
  const edited = structuredClone(resized); edited.nodes.find((node) => node.id === "a").summary = text;
  return [before, created, moved, resized, edited, ids, text];
}
test("accepts matching public group/resize/text read-backs and harmless object-key order", () => {
  const values = snapshots();
  values[4].nodes[0] = { summary: "Original", id: "baseline" };
  assert.equal(verifyProtectedAuthoring(...values).baseline_collections_preserved, true);
});
test("rejects rollback, asymmetric group delta and movement of the unselected canary", () => {
  for (const mutate of [
    (v) => { v[2].placements[0].x -= 40; }, (v) => { v[2].placements[1].y++; }, (v) => { v[2].placements[2].x++; }
  ]) { const values = snapshots(); mutate(values); assert.throws(() => verifyProtectedAuthoring(...values), /readback_failed/); }
});
test("rejects resize rollback, unrelated resize or a text edit that never persisted", () => {
  for (const mutate of [
    (v) => { v[3].placements[0].width -= 40; }, (v) => { v[3].placements[1].width++; }, (v) => { v[4].nodes[1].summary = "Not saved"; }
  ]) { const values = snapshots(); mutate(values); assert.throws(() => verifyProtectedAuthoring(...values), /readback_failed/); }
});
test("rejects baseline content/settings mutations, extra edges, missing canaries or project mismatch", () => {
  for (const mutate of [
    (v) => { v[4].nodes[0].summary = "Changed baseline"; }, (v) => { v[4].manifest.settings.ui_locale = "ru"; },
    (v) => { v[4].edges.push({ id: "unexpected" }); }, (v) => { v[4].nodes.pop(); }, (v) => { v[4].manifest.project_id = "wrong"; },
    (v) => { v[5][2] = "b"; }, (v) => { v[4].placements[0].canonical_node_id = "missing"; }
  ]) { const values = snapshots(); mutate(values); assert.throws(() => verifyProtectedAuthoring(...values), /readback_failed/); }
});
test("accepts first-move placement allocation while preserving an unplaced third canary", () => {
  const values = snapshots();
  for (const [index, id] of values[5].entries()) {
    const node = values[1].nodes.find((item) => item.id === id);
    node.metadata = { position: { x: index * 400, y: 0 }, width: 260, height: 156 };
    for (const document of values.slice(2, 5)) document.nodes.find((item) => item.id === id).metadata = structuredClone(node.metadata);
  }
  values[1].placements = [];
  for (const document of values.slice(2, 5)) document.placements.pop();
  assert.equal(verifyProtectedAuthoring(...values).unselected_placement_unchanged, true);
  values[2].placements[1].canonical_node_id = "missing";
  assert.throws(() => verifyProtectedAuthoring(...values), /readback_failed/);
});
test("the frozen authoring archive covers both viewport sizes/modes and restored owned sessions", () => {
  const report = JSON.parse(readFileSync(new URL("../../../docs/verification/baselines/p9-1-005b2c2a-protected-authoring-v1.json", import.meta.url)));
  const manifest = JSON.parse(readFileSync(new URL("../../../fixtures/benchmarks/manifest.v1.json", import.meta.url)));
  const geometryReport = JSON.parse(readFileSync(new URL("../../../docs/verification/baselines/p9-1-005b2c1-graph-card-shells-v1.json", import.meta.url)));
  assert.equal(report.suite, PROTECTED_AUTHORING_SUITE);
  assert.equal(report.app_source_sha256, geometryReport.app_source_sha256);
  assert.equal(report.status, "passed"); assert.equal(report.quick, false); assert.equal(report.source_gate_enabled, false);
  assert.equal(report.fixture_source_sha256, manifest.projects["1000"].gzip_sha256);
  assert.equal(report.cases.length, 4); assert.equal(report.cleanup, "released");
  assert.equal(new Set(report.cases.map((entry) => `${entry.viewport.width}:${entry.enabled}`)).size, 4);
  assert.deepEqual([...new Set(report.cases.map((entry) => entry.viewport.width))].sort(), [1024, 1440]);
  for (const entry of report.cases) {
    assert.equal(entry.status, "ok"); assert.equal(entry.step, "complete"); assert.equal(entry.page_errors, 0);
    assert.equal(entry.canary_nodes, 3); assert.equal(entry.baseline_nodes, 1000);
    for (const gate of ["all_canaries_offscreen", "offscreen_selected_full", "pan_document_unchanged", "baseline_collections_preserved",
      "same_group_delta", "unselected_placement_unchanged", "resize_isolated", "text_persisted",
      "close_cancel_retained_workspace", "saved_checkpoint_restored", "session_released"]) assert.equal(entry[gate], true);
    assert.equal(entry.offscreen_unselected_shell, entry.enabled);
  }
});

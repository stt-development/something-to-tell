import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROTECTED_AUTOPAN_SUITE, AUTOPAN_CLEARANCE, verifyLiveAutopan, verifyAutopanDocuments } from "./protected-autopan-contract.mjs";

const live = () => ({ camera_dx: -1400, source_right: -700, canvas_left: 0, source_full: true, source_connecting: true,
  connection_paths: 1, selected_nodes: 0, selected_edges: 0, focus_within_source: false, handles: 12 });
function documents() {
  const before = { manifest: { project_id: "owned", settings: {} }, nodes: [{ id: "seed" }], placements: [], edges: [], engine_tag_definitions: [] };
  const created = { ...structuredClone(before), nodes: [...before.nodes, ...["a", "b", "c"].map((id) => ({ id }))] };
  const cancelled = structuredClone(created);
  const connected = { ...structuredClone(created), edges: [{ id: "edge", source_node_id: "a", target_node_id: "b", label: "lore link",
    metadata: { sourceHandle: "right", targetHandle: "left" } }] };
  const reconnected = structuredClone(connected); reconnected.edges[0].target_node_id = "c";
  const deleted = structuredClone(created);
  return [before, created, cancelled, connected, reconnected, deleted, ["a", "b", "c"]];
}
test("requires actual camera motion and full live source beyond retention without selection/focus", () => {
  assert.equal(verifyLiveAutopan(live()).source_full_beyond_retention, true);
  const policy = JSON.parse(readFileSync(new URL("./rendering-policy.v1.json", import.meta.url)));
  assert.ok(AUTOPAN_CLEARANCE > policy.release_overscan_css_px);
});
test("rejects a stationary camera, a source retained only by overscan, or a non-live gesture", () => {
  for (const mutate of [
    (v) => { v.camera_dx = 0; }, (v) => { v.camera_dx = NaN; }, (v) => { v.source_right = -AUTOPAN_CLEARANCE; },
    (v) => { v.source_right = -10; }, (v) => { v.canvas_left = Infinity; }, (v) => { v.source_full = false; },
    (v) => { v.source_connecting = false; }, (v) => { v.connection_paths = 0; }
  ]) { const value = live(); mutate(value); assert.throws(() => verifyLiveAutopan(value), /readback_failed/); }
});
test("selection, focused descendants or missing Handles cannot masquerade as live protection", () => {
  for (const mutate of [
    (v) => { v.selected_nodes = 1; }, (v) => { v.selected_edges = 1; },
    (v) => { v.focus_within_source = true; }, (v) => { v.handles = 11; }
  ]) { const value = live(); mutate(value); assert.throws(() => verifyLiveAutopan(value), /readback_failed/); }
});
test("public cancellation changes nothing and persisted reconnect/delete reuse the reviewed edge invariant", () => {
  const result = verifyAutopanDocuments(...documents());
  assert.equal(result.cancelled_gesture_document_unchanged, true);
  assert.equal(result.same_edge_identity, true); assert.equal(result.detached_edge_deleted, true);
});
test("rejects phantom cancelled edges, replaced identities, wrong ports, unrelated geometry and failed deletion", () => {
  for (const mutate of [
    (v) => { v[2].edges.push({ id: "phantom" }); }, (v) => { v[2].nodes[1].title = "Changed"; },
    (v) => { v[4].edges[0].id = "replacement"; }, (v) => { v[4].edges[0].target_node_id = "b"; },
    (v) => { v[3].edges[0].metadata.targetHandle = "top"; }, (v) => { v[4].placements.push({ id: "moved" }); },
    (v) => { v[5].edges.push(v[4].edges[0]); }, (v) => { v[3].edges = []; }
  ]) { const value = documents(); mutate(value); assert.throws(() => verifyAutopanDocuments(...value), /readback_failed/); }
});
test("the frozen live-gesture archive covers both sizes/modes, independent auto-pan and owned release", () => {
  const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
  const report = json("../../../docs/verification/baselines/p9-1-005b2c2b3c-active-connections-v1.json");
  const manifest = json("../../../fixtures/benchmarks/manifest.v1.json");
  const original = json("../../../docs/verification/baselines/p9-1-005b2c1-graph-card-shells-v1.json");
  assert.equal(report.suite, PROTECTED_AUTOPAN_SUITE); assert.equal(report.workflow, "autopan");
  assert.equal(report.status, "passed"); assert.equal(report.quick, false); assert.equal(report.source_gate_enabled, false);
  assert.equal(report.app_source_sha256, original.app_source_sha256);
  assert.equal(report.fixture_source_sha256, manifest.projects["1000"].gzip_sha256);
  assert.equal(report.cleanup, "released"); assert.equal(report.cases.length, 4);
  assert.deepEqual(report.cases.map((entry) => `${entry.viewport.width}x${entry.viewport.height}:${entry.enabled}`).sort(),
    ["1024x768:false", "1024x768:true", "1440x900:false", "1440x900:true"]);
  for (const entry of report.cases) {
    assert.equal(entry.status, "ok"); assert.equal(entry.step, "complete"); assert.equal(entry.page_errors, 0);
    assert.equal(entry.baseline_nodes, 1000); assert.equal(entry.canary_nodes, 3); assert.equal(entry.target_previews_verified, 2);
    assert.deepEqual(entry.gestures.map((gesture) => gesture.name), ["create_cancel", "reconnect", "detach"]);
    for (const gesture of entry.gestures) {
      for (const gate of ["auto_pan_moved", "source_full_beyond_retention", "selection_and_focus_independent", "handles_retained"]) assert.equal(gesture[gate], true, gate);
    }
    for (const gate of ["cancel_releases_source", "return_target_materialized", "detach_releases_source", "baseline_collections_preserved",
      "nodes_and_geometry_unchanged", "same_edge_identity", "source_port_preserved", "target_port_verified", "label_persisted",
      "new_target_persisted", "detached_edge_deleted", "cancelled_gesture_document_unchanged", "saved_checkpoint_restored", "session_released"]) assert.equal(entry[gate], true, gate);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROTECTED_FRAMES_SUITE, frameScopeIds, verifyFocusedFrameLayout } from "./protected-frames-contract.mjs";

const node = (id, x, y, width = 260, height = 156) => ({ id, bounds: [x, y, width, height], card: [x, y, width, height],
  handles: ["left", "right", "top", "bottom"].map((id, index) => ({ id, bounds: [x + index * 4, y + 10, 10, 10] })) });
function snapshots() {
  const baseline = { geometry: { nodes: [node("frame", 400, 60, 600, 500), node("child", 424, 118), node("other", 1000, 1000)] } };
  const focused = { geometry: { nodes: [node("frame", 0, 0, 600, 500), node("child", 24, 58)] },
    counts: { wrappers: 2, handles: 8, shells: 0 }, visible_shells: 0, invalid_handle_bounds: 0 };
  return [baseline, focused, "frame", ["frame", "child"], true];
}
test("derives exact nested visual membership including linked instances, not their primary sibling", () => {
  const document = { placements: [
    { id: "pf", canonical_node_id: "frame", is_primary: true, container_node_id: null },
    { id: "pi", canonical_node_id: "inner", is_primary: true, container_node_id: "frame" },
    { id: "pc", canonical_node_id: "child", is_primary: true, container_node_id: "inner" },
    { id: "hero-primary", canonical_node_id: "hero", is_primary: true, container_node_id: null },
    { id: "hero-linked", canonical_node_id: "hero", is_primary: false, container_node_id: "frame" }
  ] };
  assert.deepEqual(frameScopeIds(document, "frame"), ["child", "frame", "inner", "placement:hero-linked"]);
  assert.deepEqual(frameScopeIds(document, "inner"), ["child", "inner"]);
  assert.throws(() => frameScopeIds(document, "missing"), /geometry_failed/);
  document.placements[0].container_node_id = "absent";
  assert.throws(() => frameScopeIds(document, "inner"), /geometry_failed/);
});
test("cyclic public ancestry fails rather than hanging the scope verifier", () => {
  const placements = [
    { id: "pa", canonical_node_id: "a", is_primary: true, container_node_id: "b" },
    { id: "pb", canonical_node_id: "b", is_primary: true, container_node_id: "a" },
    { id: "pf", canonical_node_id: "frame", is_primary: true, container_node_id: null }
  ];
  assert.throws(() => frameScopeIds({ placements }, "frame"), /geometry_failed/);
  assert.throws(() => frameScopeIds({ placements }, "a"), /geometry_failed/);
});
test("accepts a temporary focus root while preserving child sizes and all original port identities", () => {
  assert.deepEqual(verifyFocusedFrameLayout(...snapshots()), { wrappers: 2, handles: 8, exact_scope_membership: true, translated_geometry_preserved: true });
});
test("rejects wrong or duplicate membership, missing wrappers and changed relative geometry", () => {
  for (const mutate of [
    (v) => { v[1].geometry.nodes[1].id = "other"; }, (v) => { v[1].geometry.nodes[1].id = "frame"; },
    (v) => { v[1].counts.wrappers--; }, (v) => { v[1].geometry.nodes[1].bounds[0]++; },
    (v) => { v[1].geometry.nodes[0].card[2]++; }, (v) => { v[1].geometry.nodes[1].bounds[1] = NaN; },
    (v) => { v[3].push("child"); }, (v) => { v.push(-1); }
  ]) { const values = snapshots(); mutate(values); assert.throws(() => verifyFocusedFrameLayout(...values), /geometry_failed/); }
});
test("rejects lost or changed Handles, visible shells, invalid bounds and masked controls", () => {
  for (const mutate of [
    (v) => { v[1].counts.handles--; }, (v) => { v[1].geometry.nodes[1].handles.pop(); },
    (v) => { v[1].geometry.nodes[1].handles[0].id = "changed"; },
    (v) => { v[1].geometry.nodes[1].handles[0].bounds[2]++; },
    (v) => { v[1].geometry.nodes[1].handles[0].id = "right"; },
    (v) => { v[1].visible_shells++; }, (v) => { v[1].invalid_handle_bounds++; },
    (v) => { v[4] = false; v[1].counts.shells++; }
  ]) { const values = snapshots(); mutate(values); assert.throws(() => verifyFocusedFrameLayout(...values), /geometry_failed/); }
});
test("the frozen frame archive covers both viewport sizes/modes and read-only released sessions", () => {
  const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
  const report = json("../../../docs/verification/baselines/p9-1-005b2c2b2a-protected-frames-v1.json");
  const manifest = json("../../../fixtures/benchmarks/manifest.v1.json");
  const geometry = json("../../../docs/verification/baselines/p9-1-005b2c1-graph-card-shells-v1.json");
  assert.equal(report.suite, PROTECTED_FRAMES_SUITE); assert.equal(report.workflow, "frames");
  assert.equal(report.status, "passed"); assert.equal(report.quick, false); assert.equal(report.source_gate_enabled, false);
  assert.equal(report.app_source_sha256, geometry.app_source_sha256);
  assert.equal(report.fixture_source_sha256, manifest.projects["1000"].gzip_sha256);
  assert.equal(report.cases.length, 4); assert.equal(report.cleanup, "released");
  assert.deepEqual(report.cases.map((entry) => `${entry.viewport.width}x${entry.viewport.height}:${entry.enabled}`).sort(),
    ["1024x768:false", "1024x768:true", "1440x900:false", "1440x900:true"]);
  for (const entry of report.cases) {
    assert.equal(entry.status, "ok"); assert.equal(entry.step, "complete");
    assert.equal(entry.page_errors, 0); assert.equal(entry.write_attempts, 0);
    for (const key of ["offscreen_child_and_ancestor_full", "unselected_ancestor_protection_released",
      "root_membership_restored", "document_unchanged", "session_released"]) assert.equal(entry[key], true, key);
    assert.deepEqual(entry.scopes.map((scope) => scope.name), ["scene_scope", "location_scope", "location_fit", "scene_reentered", "location_reentered"]);
    for (const scope of entry.scopes) {
      assert.equal(scope.exact_scope_membership, true); assert.equal(scope.translated_geometry_preserved, true);
      assert.equal(scope.wrappers, scope.name.startsWith("scene") ? 8 : 2);
      assert.equal(scope.handles, scope.wrappers * 4);
    }
  }
});

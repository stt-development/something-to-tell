import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { PROTECTED_LINKED_SUITE, linkedFixtureTargets, verifyLinkedDocument, verifyLinkedGeometry } from "./protected-linked-contract.mjs";

function fixture() {
  return { manifest: { project_id: "owned" }, nodes: [
    { id: "scene", type: "Scene", title: "Scene" }, { id: "actor", type: "Character", title: "Actor" },
    { id: "unplaced", type: "Lore", title: "Unplaced" }
  ], placements: [
    { id: "primary", canonical_node_id: "actor", is_primary: true, container_node_id: null },
    { id: "linked", canonical_node_id: "actor", is_primary: false, container_node_id: "scene" }
  ] };
}
function layout() {
  return { geometry: { nodes: [{ id: "placement:linked", bounds: [10, 20, 260, 156], card: [10, 20, 260, 156],
    handles: ["left", "right", "top", "bottom"].map((id, index) => ({ id, bounds: [10 + index, 20, 10, 10] })) }] } };
}
test("resolves canonical, exact linked visual identity and unplaced target from public records", () => {
  const targets = linkedFixtureTargets(fixture());
  assert.equal(targets.canonical.id, "actor"); assert.equal(targets.scene.id, "scene");
  assert.equal(targets.linkedId, "placement:linked"); assert.equal(targets.unplaced.id, "unplaced");
});
test("rejects missing linked siblings, invalid frame kind and absent unplaced fallbacks", () => {
  for (const mutate of [
    (d) => { d.placements.pop(); }, (d) => { d.placements[0].container_node_id = "scene"; },
    (d) => { d.nodes[0].type = "Location"; }, (d) => { d.nodes[2].type = "Item"; },
    (d) => { d.placements.push({ canonical_node_id: "unplaced", is_primary: true }); }
  ]) { const document = fixture(); mutate(document); assert.throws(() => linkedFixtureTargets(document), /readback_failed/); }
});
test("the pinned workload supplies real linked/primary and unplaced targets without fixture edits", () => {
  const bytes = readFileSync(new URL("../../../fixtures/benchmarks/storage-scale-1000.v1.json.gz", import.meta.url));
  const document = JSON.parse(gunzipSync(bytes)), before = JSON.stringify(document);
  const targets = linkedFixtureTargets(document);
  assert.equal(targets.canonical.type, "Character"); assert.equal(targets.scene.type, "Scene");
  assert.equal(document.placements.some((p) => p.canonical_node_id === targets.unplaced.id), false);
  assert.equal(JSON.stringify(document), before);
});
test("preserves card dimensions and exact four port identities across camera-only round trips", () => {
  const before = layout(), after = structuredClone(before);
  after.geometry.nodes[0].bounds[0] += 0.01;
  assert.equal(verifyLinkedGeometry(before, after, "placement:linked"), true);
});
test("rejects missing/duplicate/aliased placements, geometry changes and missing/replaced ports", () => {
  for (const mutate of [
    (v) => { v.geometry.nodes.pop(); }, (v) => { v.geometry.nodes.push(v.geometry.nodes[0]); },
    (v) => { v.geometry.nodes[0].id = "actor"; }, (v) => { v.geometry.nodes[0].bounds[0]++; },
    (v) => { v.geometry.nodes[0].card[2]++; }, (v) => { v.geometry.nodes[0].card[3] = NaN; },
    (v) => { v.geometry.nodes[0].handles.pop(); }, (v) => { v.geometry.nodes[0].handles[0].id = "other"; },
    (v) => { v.geometry.nodes[0].handles[0].id = "right"; }, (v) => { v.geometry.nodes[0].handles[0].bounds[2]++; }
  ]) { const before = layout(), after = structuredClone(before); mutate(after); assert.throws(() => verifyLinkedGeometry(before, after, "placement:linked"), /readback_failed/); }
  assert.throws(() => verifyLinkedGeometry(layout(), null, "placement:linked"), /readback_failed/);
  assert.throws(() => verifyLinkedGeometry(layout(), layout(), "placement:linked", -1), /readback_failed/);
});
test("requires complete unchanged public records, not only an unchanged supplied checksum", () => {
  const before = fixture(), after = structuredClone(before);
  after.manifest = { project_id: "owned" };
  assert.equal(verifyLinkedDocument(before, after), true);
  after.nodes[1].title = "Unpublished draft";
  assert.throws(() => verifyLinkedDocument(before, after), /readback_failed/);
  assert.throws(() => verifyLinkedDocument(undefined, undefined), /readback_failed/);
});
test("the frozen linked archive covers both viewport sizes/modes and read-only released sessions", () => {
  const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
  const report = json("../../../docs/verification/baselines/p9-1-005b2c2b2b-protected-linked-v1.json");
  const manifest = json("../../../fixtures/benchmarks/manifest.v1.json");
  const geometry = json("../../../docs/verification/baselines/p9-1-005b2c1-graph-card-shells-v1.json");
  assert.equal(report.suite, PROTECTED_LINKED_SUITE); assert.equal(report.workflow, "linked");
  assert.equal(report.status, "passed"); assert.equal(report.quick, false); assert.equal(report.source_gate_enabled, false);
  assert.equal(report.app_source_sha256, geometry.app_source_sha256);
  assert.equal(report.fixture_source_sha256, manifest.projects["1000"].gzip_sha256);
  assert.equal(report.cases.length, 4); assert.equal(report.cleanup, "released");
  assert.deepEqual(report.cases.map((entry) => `${entry.viewport.width}x${entry.viewport.height}:${entry.enabled}`).sort(),
    ["1024x768:false", "1024x768:true", "1440x900:false", "1440x900:true"]);
  for (const entry of report.cases) {
    assert.equal(entry.status, "ok"); assert.equal(entry.step, "complete");
    assert.equal(entry.page_errors, 0); assert.equal(entry.write_attempts, 0);
    for (const key of ["editor_draft_retained_across_blur", "linked_primary_selection_independent", "cancelled_draft_not_published",
      "offscreen_native_focus_retained", "blur_releases_unselected_card", "unplaced_navigation_preserves_geometry",
      "root_and_unplaced_restored", "document_unchanged", "session_released"]) assert.equal(entry[key], true, key);
  }
});

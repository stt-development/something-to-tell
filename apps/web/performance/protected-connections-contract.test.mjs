import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { PROTECTED_CONNECTIONS_SUITE, verifyProtectedConnections } from "./protected-connections-contract.mjs";
import { preservesBaselineDocument } from "./protected-document-contract.mjs";

function snapshots() {
  const before = { manifest: { project_id: "owned", settings: { ui_locale: "en" } }, nodes: [{ id: "seed" }],
    placements: [], edges: [{ id: "original" }], engine_tag_definitions: [], engine_tag_bindings: [], story_flows: [] };
  const ids = ["a", "b", "c"], label = "Connection label";
  const created = { ...structuredClone(before), nodes: [...before.nodes, ...ids.map((id) => ({ id, metadata: { position: { x: 0, y: 0 } } }))] };
  const edge = { id: "new-edge", source_node_id: "a", target_node_id: "b", label: "lore link", metadata: { sourceHandle: "right", targetHandle: "left" } };
  const connected = { ...structuredClone(created), edges: [...before.edges, edge] };
  const labeled = structuredClone(connected); labeled.edges[1].label = label;
  const reconnected = structuredClone(labeled); reconnected.edges[1].target_node_id = "c";
  const deleted = structuredClone(created);
  return [before, created, connected, labeled, reconnected, deleted, ids, label];
}
test("accepts stable edge/ports, label, target change, deletion and derived tag growth", () => {
  const values = snapshots(); values[5].engine_tag_definitions.push({ id: "retained-edge-definition" });
  assert.equal(verifyProtectedConnections(...values).same_edge_identity, true);
});
test("rejects wrong source/target/ports or replacing the edge instead of reconnecting it", () => {
  for (const mutate of [
    (v) => { v[4].edges[1].id = "replacement"; }, (v) => { v[4].edges[1].source_node_id = "b"; },
    (v) => { v[4].edges[1].target_node_id = "b"; }, (v) => { v[2].edges[1].metadata.sourceHandle = "bottom"; },
    (v) => { v[4].edges[1].metadata.targetHandle = "top"; }
  ]) { const values = snapshots(); mutate(values); assert.throws(() => verifyProtectedConnections(...values), /readback_failed/); }
});
test("rejects lost label, failed deletion or an extra relationship", () => {
  for (const mutate of [
    (v) => { v[4].edges[1].label = "Lost"; }, (v) => { v[5].edges.push(v[4].edges[1]); },
    (v) => { v[3].edges.push({ id: "unexpected" }); }
  ]) { const values = snapshots(); mutate(values); assert.throws(() => verifyProtectedConnections(...values), /readback_failed/); }
});
test("rejects baseline mutations, node/placement changes and wrong canary or project identities", () => {
  for (const mutate of [
    (v) => { v[4].edges[0].id = "changed-original"; }, (v) => { v[4].nodes[1].metadata.position.x++; },
    (v) => { v[4].placements.push({ id: "unexpected" }); }, (v) => { v[4].story_flows.push({ id: "unexpected" }); },
    (v) => { v[4].manifest.project_id = "other"; }, (v) => { v[4].manifest.settings.ui_locale = "ru"; },
    (v) => { v[6][2] = "b"; }, (v) => { v[1].nodes.pop(); }
  ]) { const values = snapshots(); mutate(values); assert.throws(() => verifyProtectedConnections(...values), /readback_failed/); }
});
test("shared baseline comparison rejects missing data and only permits explicitly declared collection growth", () => {
  const [before] = snapshots();
  assert.equal(preservesBaselineDocument(before, null), false);
  const changed = structuredClone(before); changed.edges = null;
  assert.equal(preservesBaselineDocument(before, changed), false);
  changed.edges = [...before.edges, { id: "extra" }];
  assert.equal(preservesBaselineDocument(before, changed), false);
  assert.equal(preservesBaselineDocument(before, changed, ["edges"]), true);
});
test("an unknown write-capable workflow is rejected before fixture creation/runtime access", () => {
  const result = spawnSync(process.execPath, [new URL("./protected-authoring-run.mjs", import.meta.url).pathname, "--workflow", "typo"], { encoding: "utf8" });
  assert.equal(result.status, 1); assert.match(result.stderr, /unsupported_protected_workflow/);
  assert.equal(result.stdout, "");
});
test("the frozen connection archive covers both sizes/modes, original geometry and released owned sessions", () => {
  const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
  const report = json("../../../docs/verification/baselines/p9-1-005b2c2b1-protected-connections-v1.json");
  const manifest = json("../../../fixtures/benchmarks/manifest.v1.json");
  const geometry = json("../../../docs/verification/baselines/p9-1-005b2c1-graph-card-shells-v1.json");
  const authoring = json("../../../docs/verification/baselines/p9-1-005b2c2a-protected-authoring-v1.json");
  assert.equal(report.suite, PROTECTED_CONNECTIONS_SUITE); assert.equal(report.workflow, "connections");
  assert.equal(report.status, "passed"); assert.equal(report.quick, false); assert.equal(report.source_gate_enabled, false);
  assert.equal(report.app_source_sha256, geometry.app_source_sha256);
  assert.equal(report.app_source_sha256, authoring.app_source_sha256);
  assert.equal(report.fixture_source_sha256, manifest.projects["1000"].gzip_sha256);
  assert.equal(report.cases.length, 4); assert.equal(report.cleanup, "released");
  assert.deepEqual(report.cases.map((entry) => `${entry.viewport.width}x${entry.viewport.height}:${entry.enabled}`).sort(),
    ["1024x768:false", "1024x768:true", "1440x900:false", "1440x900:true"]);
  for (const entry of report.cases) {
    assert.equal(entry.status, "ok"); assert.equal(entry.step, "complete"); assert.equal(entry.page_errors, 0);
    assert.equal(entry.baseline_nodes, 1000); assert.equal(entry.canary_nodes, 3);
    for (const gate of ["selected_edge_endpoints_protected", "old_endpoint_protection_released", "baseline_collections_preserved",
      "nodes_and_geometry_unchanged", "same_edge_identity", "source_port_preserved", "target_port_verified", "label_persisted",
      "new_target_persisted", "detached_edge_deleted", "deleted_edge_protection_released", "all_twelve_handles_retained",
      "pan_document_unchanged", "saved_checkpoint_restored", "session_released"]) assert.equal(entry[gate], true, gate);
  }
});

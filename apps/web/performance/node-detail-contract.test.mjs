import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVED_NODE_DETAIL_DEFAULT, nodeDetailGatePlugin, detailFixtureTargets, compareDetailLayouts } from "./node-detail-contract.mjs";

const source = readFileSync(new URL("../src/app/graph/CanvasNodePresentation.tsx", import.meta.url), "utf8");
test("exact build-only detail override preserves unrelated spatial default and device override", () => {
  assert.ok(source.includes(`export const NODE_DETAIL_PRESENTATION_ENABLED = ${APPROVED_NODE_DETAIL_DEFAULT};`));
  for (const enabled of [false, true]) {
    const plugin = nodeDetailGatePlugin(enabled); assert.equal(plugin.transform(source, "/other.tsx"), null);
    const result = plugin.transform(source, "/src/app/graph/CanvasNodePresentation.tsx"); plugin.buildEnd();
    assert.ok(result.includes(`export const NODE_DETAIL_PRESENTATION_ENABLED = ${enabled};`));
    assert.ok(result.includes("export const VIEWPORT_CARD_PRESENTATION_ENABLED = true;"));
    assert.ok(result.includes('workspaceMode === "relationships" && detailPreference'));
  }
});
test("missing/changed/repeated detail gate cannot silently pass", () => {
  const plugin = nodeDetailGatePlugin(true); assert.throws(() => plugin.buildEnd(), /not_verified/);
  assert.throws(() => plugin.transform("changed", "/src/app/graph/CanvasNodePresentation.tsx"), /gate_changed/);
  plugin.transform(source, "/src/app/graph/CanvasNodePresentation.tsx");
  plugin.transform(source, "/src/app/graph/CanvasNodePresentation.tsx"); assert.throws(() => plugin.buildEnd(), /not_verified/);
});
test("detail targets require an exact current five-location chain, Scene ancestor and Lore leaf", () => {
  const nodes = [{ id: "scene", type: "Scene" }, { id: "harbor", type: "Location" }, { id: "leaf", type: "Lore" },
    ...Array.from({ length: 5 }, (_, i) => ({ id: `s${i}-node-customs-office`, type: "Location" }))];
  const placements = [{ canonical_node_id: "harbor", container_node_id: "scene", is_primary: true },
    ...nodes.slice(3).map((node, i) => ({ canonical_node_id: node.id, container_node_id: i ? nodes[i + 2].id : "harbor", is_primary: true })),
    { canonical_node_id: "leaf", container_node_id: nodes[7].id, is_primary: true }];
  assert.equal(detailFixtureTargets({ nodes, placements }).leaf.id, "leaf");
  for (const changed of [{ nodes: nodes.slice(0, -1), placements }, { nodes, placements: placements.slice(0, -1) },
    { nodes, placements: placements.map((row) => ({ ...row, container_node_id: "missing" })) }]) assert.throws(() => detailFixtureTargets(changed), /shape_failed/);
});
test("detail comparison requires all actual curve/card/label checkpoints", () => {
  const layout = { geometry: { nodes: [], edges: [], curves: [], labels: [] }, counts: { wrappers: 0, handles: 0, edges: 0, labels: 0, minimap: 0 } };
  const values = { root_fit: layout, scene_nominal: layout, root_restored: layout };
  assert.ok(Object.values(compareDetailLayouts(values, values)).every((row) => row.equal));
  assert.equal(compareDetailLayouts(values, { ...values, scene_nominal: null }).scene_nominal.equal, false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { edgeObservationPlugin, compareEdgeBoundaries, verifyEdgeObservation } from "./edge-boundary-contract.mjs";

test("observation instrumentation changes only an exact test bundle and reports numeric public callbacks", () => {
  const source = readFileSync(new URL("../src/app/graph/CanvasEdgeGeometryBridge.tsx", import.meta.url), "utf8");
  const plugin = edgeObservationPlugin();
  assert.equal(plugin.transform(source, "/unrelated.tsx"), null);
  const result = plugin.transform(source, "/src/app/graph/CanvasEdgeGeometryBridge.tsx");
  assert.match(result, /EDGE_GEOMETRY_OBSERVATION_ENABLED = true/);
  assert.match(result, /onMeasured=\{reportEdgeObservation\}/);
  assert.match(source, /EDGE_GEOMETRY_OBSERVATION_ENABLED = false/); plugin.buildEnd();
});
test("instrumentation rejects missing, changed and repeated gates", () => {
  const plugin = edgeObservationPlugin(); assert.throws(() => plugin.buildEnd(), /not_verified/);
  assert.throws(() => plugin.transform("changed", "/src/app/graph/CanvasEdgeGeometryBridge.tsx"), /gate_changed/);
  const source = readFileSync(new URL("../src/app/graph/CanvasEdgeGeometryBridge.tsx", import.meta.url), "utf8");
  plugin.transform(source, "/src/app/graph/CanvasEdgeGeometryBridge.tsx");
  plugin.transform(source, "/src/app/graph/CanvasEdgeGeometryBridge.tsx"); assert.throws(() => plugin.buildEnd(), /not_verified/);
});
test("candidate checks reject lost unknown, crossing and original identities", () => {
  const snapshot = { edges: [{ id: "cross" }, { id: "unknown" }, { id: "far" }], eligible: ["cross", "unknown"], unknown: ["unknown"] };
  assert.deepEqual(verifyEdgeObservation(snapshot, "cross", ["cross", "unknown", "far"]), {
    footprint_visits: 3, candidates: 2, unknown: 1, mounted_routes: 3, path_exclusion: false, crossing_retained: true, unknown_retained: true });
  for (const invalid of [null, { ...snapshot, eligible: ["cross"] }, { ...snapshot, eligible: ["unknown"] },
    { ...snapshot, edges: [{ id: "other" }] }]) assert.throws(() => verifyEdgeObservation(invalid, "cross", ["cross", "unknown", "far"]));
  assert.throws(() => verifyEdgeObservation(snapshot, "cross", ["cross", "cross", "unknown"]));
});
test("all three boundary stages require equivalent actual geometry", () => {
  const layout = { geometry: { nodes: [], edges: [], labels: [], curves: [] }, counts: { wrappers: 0, handles: 0, edges: 0, labels: 0, minimap: 0 } };
  const value = { graph_crossing: layout, flow_return: layout, graph_restored: layout };
  assert.ok(Object.values(compareEdgeBoundaries(value, value)).every((entry) => entry.equal));
  assert.equal(compareEdgeBoundaries(value, { ...value, flow_return: null }).flow_return.equal, false);
});

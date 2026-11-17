import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { compareDomBoundaryCurves, nodeDomGatePlugin, verifyDomObservation, APPROVED_NODE_DOM_DEFAULT } from "./node-dom-contract.mjs";

test("DOM experiment defaults Off and only an exact test module may override it", () => {
  const source = readFileSync(new URL("../src/app/graph/canvasDomExperiment.ts", import.meta.url), "utf8");
  const id = "/src/app/graph/canvasDomExperiment.ts";
  assert.equal(APPROVED_NODE_DOM_DEFAULT, false);
  assert.ok(source.includes("export const NODE_DOM_VIRTUALIZATION_ENABLED = false;"));
  assert.ok(nodeDomGatePlugin(true).transform(source, id).includes("ENABLED = true;"));
  assert.equal(nodeDomGatePlugin(false).transform(source, id), source);
  assert.equal(nodeDomGatePlugin(true).transform(source, "/src/app/other.ts"), undefined);
  assert.throws(() => nodeDomGatePlugin(true).transform(source.repeat(2), id));
  assert.throws(() => nodeDomGatePlugin(true).transform("renamed", id));
  assert.throws(() => nodeDomGatePlugin("true"));
});

test("boundary curves use the established native geometry tolerance and reject missing or shifted routes", () => {
  const curve = { id: "route", length: 100, points: Array.from({ length: 65 }, (_, index) => [index, index]) };
  assert.equal(compareDomBoundaryCurves([curve], [{ ...curve, points: curve.points.map(([x, y]) => [x + 0.0006, y]) }]).equal, true);
  assert.equal(compareDomBoundaryCurves([curve], [{ ...curve, points: curve.points.map(([x, y]) => [x + 1, y]) }]).equal, false);
  assert.equal(compareDomBoundaryCurves([curve], []).equal, false);
  assert.equal(compareDomBoundaryCurves([curve], [{ ...curve, points: [] }]).equal, false);
});

test("activation proof requires real DOM reduction without changing complete counts or edges", () => {
  const full = { full_nodes: 1124, minimap_nodes: 1124, edge_routes: 500, labels: 500, zoomed_nodes: 1124 };
  assert.equal(verifyDomObservation(full, false), full);
  assert.throws(() => verifyDomObservation(full, true));
  assert.equal(verifyDomObservation({ ...full, zoomed_nodes: 100 }, true).zoomed_nodes, 100);
  for (const invalid of [{ full_nodes: 1000 }, { minimap_nodes: 100 }, { edge_routes: 499 },
    { labels: 499 }, { zoomed_nodes: -1 }, { zoomed_nodes: 0.1 }]) {
    assert.throws(() => verifyDomObservation({ ...full, zoomed_nodes: 100, ...invalid }, true));
  }
});

test("a spread baseline must be explicit, correctly named and isolated from authoring workflows", () => {
  for (const args of [["--fixture-variant", "typo", "--size", "1000"],
    ["--fixture-variant", "root_grid_v1", "--size", "small"],
    ["--fixture-variant", "root_grid_v1"],
    ["--fixture-variant", "root_grid_v1", "--size", "1000", "--workflow", "node-authoring"]]) {
    const result = spawnSync(process.execPath, [new URL("./run.mjs", import.meta.url).pathname, ...args], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid_fixture_variant/);
  }
});

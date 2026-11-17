import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVED_MINIMAP_DEFAULT, verifyMiniMapObservation } from "./minimap-contract.mjs";

const observation = { nodes: 1124, represented: 1124, cells: 472, minimap_dom: 3,
  legacy_shapes: 0, paintedPixels: 21058, viewport_delta: 0.00002, bounds: { x: 42 }, camera: { x: 42 } };
test("default metadata matches the independently approved production gate", () => {
  const source = readFileSync(new URL("../src/app/graph/CanvasMiniMap.tsx", import.meta.url), "utf8");
  assert.ok(source.includes(`export const BOUNDED_MINIMAP_ENABLED = ${APPROVED_MINIMAP_DEFAULT};`));
});
test("MiniMap proof requires all projected nodes, bounded paint, constant DOM and actual camera rectangle", () => {
  const result = verifyMiniMapObservation(observation);
  assert.equal(result.projection_nodes, 1124); assert.equal(result.painted_cells, 472);
  assert.equal(Object.hasOwn(result, "bounds"), false); assert.equal(Object.hasOwn(result, "camera"), false);
});
test("MiniMap proof rejects missing projection, blank raster, per-node DOM and wrong letterbox", () => {
  for (const change of [{ nodes: 0 }, { represented: 1123 }, { cells: 513 }, { cells: 0 }, { minimap_dom: 1124 },
    { legacy_shapes: 1124 }, { paintedPixels: 0 }, { viewport_delta: 0.05 }, { viewport_delta: NaN }]) {
    assert.throws(() => verifyMiniMapObservation({ ...observation, ...change }), /minimap_projection_or_paint_failed/);
  }
});

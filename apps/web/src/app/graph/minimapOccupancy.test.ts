import { describe, expect, it } from "vitest";
import { minimapOccupancy, minimapTransform, minimapViewport, minimapWorldPoint, type MiniMapNode } from "./minimapOccupancy";

const node = (id: string, x = 0, y = 0, width = 100, height = 100): MiniMapNode => ({ id, position: { x, y }, width, height });
it("includes full distant/negative/nested/linked geometry without canonical deduplication", () => {
  const nodes = [node("root", -1000, -500, 800, 600), { ...node("child", 700, 500, 200, 200), parentId: "root" },
    node("linked", 10000, 8000, 300, 150)];
  const before = structuredClone(nodes), model = minimapOccupancy(nodes)!;
  expect(model.bounds).toEqual({ x: -1000, y: -500, width: 11300, height: 8650 });
  expect(model.nodeCount).toBe(3); expect(model.cells).toHaveLength(512);
  expect(model.cells[511]).toBe(1); expect(nodes).toEqual(before);
});
it("every rectangle contributes all intersected cells; selection tints those same cells", () => {
  const model = minimapOccupancy([node("frame", 0, 0, 3200, 1600), { ...node("selected", 0, 0, 100, 100), selected: true }])!;
  expect(model.occupiedCells).toBe(512); expect(model.contributions).toBe(513);
  expect(model.cells[0]).toBe(3); expect(model.cells.slice(1).every((value) => value === 1)).toBe(true);
});
it("uses measured dimensions and current parent-relative origins", () => {
  const model = minimapOccupancy([{ ...node("parent", 100, 100), origin: [0.5, 0.5] },
    { ...node("child", 20, 30), parentId: "parent", measured: { width: 20, height: 40 } }], [0.5, 0.5])!;
  expect(model.bounds).toEqual({ x: 50, y: 50, width: 100, height: 100 });
  expect(model.nodeCount).toBe(2);
});
describe("conservative fallback", () => {
  it.each([
    [node("duplicate"), node("duplicate")], [{ ...node("orphan"), parentId: "missing" }],
    [{ ...node("a"), parentId: "b" }, { ...node("b"), parentId: "a" }],
    [{ ...node("self"), parentId: "self" }], [node("bad", Infinity)], [node("bad", 0, 0, 0)],
    [{ ...node("unmeasured"), width: undefined }], [{ ...node("bad"), origin: [NaN, 0] as const }],
    [node("overflow", -Number.MAX_VALUE), node("far", Number.MAX_VALUE)]
  ])("returns null rather than omit invalid geometry (%#)", (...nodes) => {
    // it.each supplies each member as a separate argument for array rows.
    expect(minimapOccupancy(nodes as MiniMapNode[])).toBeNull();
  });
});
it("empty projection has a stable nonzero domain and no invented nodes/cells", () => {
  const model = minimapOccupancy([])!;
  expect(model.nodeCount).toBe(0); expect(model.occupiedCells).toBe(0); expect(model.cells.every((value) => value === 0)).toBe(true);
  expect(minimapTransform(model.bounds, 200, 150).scale).toBeGreaterThan(0);
});
it("bounds paint independently of arbitrarily large overlap and resolves reversed deep inputs iteratively", () => {
  let reads = 0;
  const nodes = Array.from({ length: 10000 }, (_, i) => {
    const value = node(String(i), 1, 1);
    Object.defineProperty(value, "parentId", { get: () => { reads++; return i ? String(i - 1) : undefined; } });
    return value;
  }).reverse();
  const model = minimapOccupancy(nodes)!;
  expect(model.nodeCount).toBe(10000); expect(model.bounds).toEqual({ x: 1, y: 1, width: 10099, height: 10099 });
  expect(model.occupiedCells).toBeLessThanOrEqual(512); expect(reads).toBeLessThanOrEqual(70000);
  const overlap = minimapOccupancy(Array.from({ length: 10000 }, (_, i) => node(String(i))))!;
  expect(overlap.occupiedCells).toBe(512); expect(overlap.contributions).toBe(5120000);
});
it.each([{ x: -500, y: 200, width: 10000, height: 100 }, { x: 0, y: -1000, width: 30, height: 9000 }])("letterboxes exact global bounds and inverts empty unsnapped locations", (bounds) => {
  const transform = minimapTransform(bounds, 200, 150);
  const point = { x: bounds.x + bounds.width * 0.731, y: bounds.y + bounds.height * 0.293 };
  const inverted = minimapWorldPoint(transform, { x: transform.x + point.x * transform.scale, y: transform.y + point.y * transform.scale });
  expect(inverted.x).toBeCloseTo(point.x, 8); expect(inverted.y).toBeCloseTo(point.y, 8);
  expect(transform.x + bounds.x * transform.scale).toBeGreaterThanOrEqual(8);
  expect(transform.y + bounds.y * transform.scale).toBeGreaterThanOrEqual(8);
});
it.each([0.01, 1, 10])("viewport uses the same continuous transform at zoom %s", (zoom) => {
  const transform = minimapTransform({ x: -100, y: -500, width: 10000, height: 5000 }, 200, 150);
  const view = minimapViewport(transform, { x: -700, y: 400, zoom }, 1024, 768);
  const origin = minimapWorldPoint(transform, view);
  expect(origin.x).toBeCloseTo(700 / zoom); expect(origin.y).toBeCloseTo(-400 / zoom);
  expect(view.width / transform.scale).toBeCloseTo(1024 / zoom);
});

import { afterEach, expect, it, vi } from "vitest";
import { queryViewportEligibility, VIEWPORT_ENTRY_OVERSCAN_CSS_PX, VIEWPORT_RELEASE_OVERSCAN_CSS_PX,
  type ViewportPlacement, type ViewportScope, type WorldRectangle } from "./viewportEligibility";

const scope: ViewportScope = { projectId: "project", workspaceMode: "relationships", flowId: "main", focusedFrameId: null };
const viewport = { x: 0, y: 0, width: 100, height: 100, zoom: 1 };
const node = (id: string, x = 0, parentId?: string): ViewportPlacement => ({ id, parentId,
  worldBounds: { x, y: 0, width: 10, height: 10 } });
const query = (placements: readonly ViewportPlacement[], extra: Partial<Parameters<typeof queryViewportEligibility>[0]> = {}) =>
  queryViewportEligibility({ scope, viewport, placements, ...extra });
const ids = (value: ReturnType<typeof query>) => [...value.eligibleIds].sort();
afterEach(() => vi.restoreAllMocks());

it("uses the frozen CSS bands and returns membership, not reordered/reparented graph records", () => {
  expect([VIEWPORT_ENTRY_OVERSCAN_CSS_PX, VIEWPORT_RELEASE_OVERSCAN_CSS_PX]).toEqual([240, 360]);
  expect(ids(query([node("inside"), node("far", 10000)]))).toEqual(["inside"]);
  expect(query([])).toEqual({ scope, eligibleIds: new Set(), fallback: "none" });
});

it.each([
  { x: 340, visible: true }, { x: 341, visible: false }, { x: -250, visible: true }, { x: -251, visible: false }
])("includes exact horizontal entry borders at x=$x: $visible", ({ x, visible }) => {
  expect(query([node("a", x)]).eligibleIds.has("a")).toBe(visible);
});

it.each([0.01, 1, 10])("converts camera/CSS bounds at zoom=%s without using world-space overscan constants", (zoom) => {
  const make = (x: number) => ({ id: "a", worldBounds: { x: x / zoom, y: 0, width: 10 / zoom, height: 10 / zoom } });
  const camera = { ...viewport, x: 40, y: -10, zoom };
  expect(ids(query([make(300)], { viewport: camera }))).toEqual(["a"]);
  expect(ids(query([make(301)], { viewport: camera }))).toEqual([]);
});

it("tests whole rectangles and vertical borders, including large frames with offscreen origins", () => {
  expect(ids(query([{ id: "large", worldBounds: { x: -2000, y: -1000, width: 4000, height: 2000 } }]))).toEqual(["large"]);
  const edge = { id: "top", worldBounds: { x: 0, y: -250, width: 10, height: 10 } };
  expect(ids(query([edge]))).toEqual(["top"]);
  expect(ids(query([{ ...edge, worldBounds: { ...edge.worldBounds, y: -251 } }]))).toEqual([]);
});

it("retains only the latest eligible fringe ids, releasing outside 360px without a visited-node history", () => {
  const initial = query([node("a", 330)]);
  const fringe = query([node("a", 450)], { previous: initial });
  expect(ids(fringe)).toEqual(["a"]);
  expect(ids(query([node("a", 460)], { previous: fringe }))).toEqual(["a"]);
  const released = query([node("a", 461)], { previous: fringe });
  expect(ids(released)).toEqual([]);
  expect(ids(query([node("a", 450)], { previous: released }))).toEqual([]);
  expect(ids(initial)).toEqual(["a"]);
});

it.each([
  { projectId: "other" }, { workspaceMode: "flow" as const }, { flowId: "other" }, { focusedFrameId: "frame" }
])("ignores previous masks after scope replacement: %o", (changed) => {
  const previous = query([node("a", 330)]);
  const has = vi.spyOn(previous.eligibleIds, "has");
  expect(ids(query([node("a", 450)], { previous, scope: { ...scope, ...changed } }))).toEqual([]);
  expect(has).not.toHaveBeenCalled();
});

it("snapshots scope values without retaining a mutable caller scope object", () => {
  const current = { ...scope, unrelatedData: { authored: "Must not escape in the mask" } };
  const previous = query([node("a", 330)], { scope: current });
  expect(previous.scope).toEqual(scope);
  current.projectId = "replacement";
  expect(previous.scope.projectId).toBe("project");
  expect(ids(query([node("a", 450)], { scope: current, previous }))).toEqual([]);
});

it("supports an explicit same-scope reset by omitting/nulling the previous snapshot", () => {
  const previous = query([node("a", 330)]);
  expect(ids(query([node("a", 450)], { previous }))).toEqual(["a"]);
  expect(ids(query([node("a", 450)], { previous: null }))).toEqual([]);
  expect(ids(query([node("a", 450)]))).toEqual([]);
});

it("protects distant navigation/editor/gesture ids and ancestor shells using exact visual placement ids", () => {
  const placements = [node("root", 10000), node("nested", 10000, "root"), node("primary", 10000),
    node("placement:linked", 10000, "nested")];
  const value = query(placements, { protectedIds: new Set(["placement:linked", "filtered-away"]) });
  expect(ids(value)).toEqual(["nested", "placement:linked", "root"]);
  expect(value.fallback).toBe("none");
  expect(ids(query(placements, { previous: value }))).toEqual([]);
});

it("materializes ancestors of spatially eligible children without assuming child rectangles fit their frames", () => {
  expect(ids(query([node("root", 10000), node("child", 0, "root")]))).toEqual(["child", "root"]);
  expect(ids(query([node("", 10000), node("child", 0, "")]))).toEqual(["", "child"]);
});

it("uses current moves, resized bounds and reparenting instead of prior geometry or ancestor paths", () => {
  const initial = query([node("old", 10000), node("new", 10000), node("child", 0, "old")]);
  const moved = [node("old", 10000), node("new", 10000), node("child", 10000, "new")];
  expect(ids(query(moved, { previous: initial }))).toEqual([]);
  expect(ids(query(moved, { previous: initial, protectedIds: new Set(["child"]) }))).toEqual(["child", "new"]);
  const wide = { ...node("child", 10000, "new"), worldBounds: { x: -1000, y: 0, width: 1200, height: 10 } };
  expect(ids(query([...moved.slice(0, 2), wide], { previous: initial }))).toEqual(["child", "new"]);
});

it("prunes removed ids and ignores unknown protected ids instead of recreating old/filtered nodes", () => {
  const previous = query([node("removed")]);
  expect(ids(query([node("current", 10000)], { previous, protectedIds: new Set(["removed"]) }))).toEqual([]);
  expect(ids(query([], { previous, protectedIds: new Set(["removed"]) }))).toEqual([]);
});

it.each([
  { width: 0 }, { height: 0 }, { zoom: 0 }, { zoom: 0.009 }, { zoom: 10.1 }, { x: NaN }, { width: Infinity },
  { width: Number.MAX_VALUE, zoom: 0.01 }
])("falls back to all current placements when viewport bounds cannot be trusted: %o", (changed) => {
  const value = query([node("a"), node("far", 10000)], { viewport: { ...viewport, ...changed } });
  expect(ids(value)).toEqual(["a", "far"]);
  expect(value.fallback).toBe("viewport");
});

it.each([
  undefined, null, { x: 0, y: 0, width: 0, height: 10 }, { x: NaN, y: 0, width: 10, height: 10 },
  { x: 0, y: 0, width: 10, height: -1 }, { x: Number.MAX_VALUE, y: 0, width: Number.MAX_VALUE, height: 10 }
] satisfies (WorldRectangle | null | undefined)[])("falls back conservatively for unknown or invalid world bounds: %o", (worldBounds) => {
  const value = query([node("far", 10000), { id: "uncertain", worldBounds }]);
  expect(ids(value)).toEqual(["far", "uncertain"]);
  expect(value.fallback).toBe("geometry");
});

it.each([
  [node("orphan", 10000, "missing")], [node("self", 10000, "self")],
  [node("a", 10000, "b"), node("b", 10000, "a")]
])("validates offscreen ancestry too, without silently dropping malformed chains", (...placements) => {
  const value = query(placements);
  expect(ids(value)).toEqual(placements.map((p) => p.id).sort());
  expect(value.fallback).toBe("ancestry");
});

it("retains every current id on ambiguous duplicate visual identity", () => {
  const value = query([node("same", 10000), node("same"), node("other", 10000)]);
  expect(ids(value)).toEqual(["other", "same"]);
  expect(value.fallback).toBe("identity");
});

it.each([20, 80])("reads each of %s placement records once even for a protected deep ancestor path", (count) => {
  const reads = { ids: 0, parents: 0, bounds: 0, coordinates: 0 };
  const placements = Array.from({ length: count }, (_, index) => {
    const item = node(`node-${index}`, 10000, index ? `node-${index - 1}` : undefined);
    const worldBounds = new Proxy(item.worldBounds!, { get(target, key, receiver) {
      if (["x", "y", "width", "height"].includes(String(key))) reads.coordinates++;
      return Reflect.get(target, key, receiver);
    } });
    return new Proxy({ ...item, worldBounds }, { get(target, key, receiver) {
      if (key === "id") reads.ids++;
      if (key === "parentId") reads.parents++;
      if (key === "worldBounds") reads.bounds++;
      return Reflect.get(target, key, receiver);
    } });
  });
  const protectedIds = new Set([`node-${count - 1}`]);
  const has = vi.spyOn(protectedIds, "has");
  const value = query(placements, { protectedIds });
  expect(value.eligibleIds.size).toBe(count);
  expect(value.fallback).toBe("none");
  expect(has).toHaveBeenCalledTimes(count);
  expect(reads).toEqual({ ids: count, parents: count, bounds: count, coordinates: count * 4 });
});

it("does not cap a 1000-placement multi-selection or mutate frozen geometry/previous masks", () => {
  const placements = Object.freeze(Array.from({ length: 1000 }, (_, index) => Object.freeze({ ...node(`node-${index}`, 10000),
    worldBounds: Object.freeze({ x: 10000, y: 0, width: 10, height: 10 }) })));
  const protectedIds = new Set(placements.map((p) => p.id));
  const previous = query(placements);
  const value = query(placements, { previous, protectedIds });
  expect(value.eligibleIds.size).toBe(1000);
  expect(previous.eligibleIds.size).toBe(0);
  expect(protectedIds.size).toBe(1000);
  expect(value.eligibleIds).not.toBe(protectedIds);
  expect(value.eligibleIds).not.toBe(previous.eligibleIds);
  expect(ids(query(placements, { previous: value }))).toEqual([]);
});

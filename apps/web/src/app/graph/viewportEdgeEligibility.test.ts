import { expect, it, vi } from "vitest";
import { queryViewportEdgeEligibility, type ViewportEdgeFootprint } from "./viewportEdgeEligibility";
import type { ViewportScope, WorldRectangle } from "./viewportEligibility";

const scope: ViewportScope = { projectId: "project", workspaceMode: "relationships", flowId: "main", focusedFrameId: null };
const viewport = { x: 0, y: 0, width: 100, height: 100, zoom: 1 };
const rect = (x: number, y = 0, width = 10, height = 10): WorldRectangle => ({ x, y, width, height });
const edge = (id: string, x = 0): ViewportEdgeFootprint => ({ id, routeBounds: rect(x), label: { kind: "none" } });
const query = (edges: readonly ViewportEdgeFootprint[], extra: Partial<Parameters<typeof queryViewportEdgeEligibility>[0]> = {}) =>
  queryViewportEdgeEligibility({ scope, viewport, edges, ...extra });
const ids = (value: ReturnType<typeof query>) => [...value.eligibleIds];

it("returns current original ids in input order, not graph records or synthetic endpoints", () => {
  expect(ids(query([edge("z"), edge("far", 10000), edge("a")]))).toEqual(["z", "a"]);
  expect(query([])).toEqual({ scope, eligibleIds: new Set(), unknownGeometryIds: new Set(), fallback: "none" });
});

it("retains crossing routes and raised arcs even when endpoint-only rectangles would be outside", () => {
  const crossing = { ...edge("crossing"), routeBounds: rect(-2000, 40, 4000, 0) };
  const raised = { ...edge("return-arc"), routeBounds: rect(-2000, -1000, 4000, 3000) };
  expect(ids(query([crossing, raised, edge("disjoint", 10000)]))).toEqual(["crossing", "return-arc"]);
  // The supplied conservative footprint, not a chord between endpoints below the view, is authoritative.
  expect(ids(query([{ ...raised, routeBounds: rect(-2000, 2000, 4000, 0) }]))).toEqual([]);
});

it("keeps a label-only intersection independently of its offscreen route", () => {
  const value = { ...edge("label-only", 10000), label: { kind: "measured" as const, bounds: rect(30, 30, 500, 20) } };
  expect(ids(query([value]))).toEqual(["label-only"]);
  expect(ids(query([{ ...value, label: { kind: "measured", bounds: rect(10000) } }]))).toEqual([]);
  expect(ids(query([{ ...value, label: { kind: "none" } }]))).toEqual([]);
});

it.each([
  [340, 0, 0, 0, true], [341, 0, 0, 0, false], [-240, 0, 0, 10, true], [-241, 0, 0, 10, false],
  [0, 340, 10, 0, true], [0, 341, 10, 0, false], [0, -240, 10, 0, true], [0, -241, 10, 0, false]
])("includes exact entry borders and finite line/point bounds %s,%s,%s,%s", (x, y, width, height, included) => {
  expect(query([{ ...edge("route"), routeBounds: rect(x, y, width, height) }]).eligibleIds.has("route")).toBe(included);
});

it.each([0.01, 1, 10])("converts CSS overscan with the current translated camera at zoom %s", (zoom) => {
  const make = (x: number) => ({ ...edge("route"), routeBounds: rect(x / zoom, 0, 0, 10 / zoom) });
  const camera = { ...viewport, x: 40, y: -10, zoom };
  expect(ids(query([make(300)], { viewport: camera }))).toEqual(["route"]);
  expect(ids(query([make(301)], { viewport: camera }))).toEqual([]);
});

it("uses current route OR label geometry with latest-mask hysteresis and no visited history", () => {
  const initial = query([edge("route", 330)]);
  const fringe = query([edge("route", 450)], { previous: initial });
  expect(ids(fringe)).toEqual(["route"]);
  expect(ids(query([edge("route", 460)], { previous: fringe }))).toEqual(["route"]);
  const released = query([edge("route", 461)], { previous: fringe });
  expect(ids(released)).toEqual([]);
  expect(ids(query([edge("route", 450)], { previous: released }))).toEqual([]);
  expect(ids(query([edge("route", 450)], { previous: null }))).toEqual([]);
  const labelFringe = { ...edge("route", 10000), label: { kind: "measured" as const, bounds: rect(450) } };
  expect(ids(query([labelFringe], { previous: initial }))).toEqual(["route"]);
  expect(ids(query([labelFringe]))).toEqual([]);
  expect(ids(initial)).toEqual(["route"]);
});

it.each([{ projectId: "next" }, { workspaceMode: "flow" as const }, { flowId: "next" }, { focusedFrameId: "frame" }])(
  "does not reuse retained membership across scope replacement %o", (change) => {
    const previous = query([edge("route", 330)]), has = vi.spyOn(previous.eligibleIds, "has");
    expect(ids(query([edge("route", 450)], { previous, scope: { ...scope, ...change } }))).toEqual([]);
    expect(has).not.toHaveBeenCalled();
  }
);

it("copies scope fields and prunes removed/unknown protected ids without recreating edges", () => {
  const mutable = { ...scope, metadata: { narrative: "not a query output" } };
  const previous = query([edge("removed")], { scope: mutable });
  mutable.projectId = "replacement";
  expect(previous.scope).toEqual(scope);
  expect(previous.scope).not.toHaveProperty("metadata");
  expect(ids(query([edge("current", 10000)], { previous, protectedIds: new Set(["removed"]) }))).toEqual([]);
  expect(ids(query([], { previous, protectedIds: new Set(["removed"]) }))).toEqual([]);
  expect(ids(query([edge("current", 10000)], { protectedIds: new Set(["current"]) }))).toEqual(["current"]);
});

it.each([undefined, null, rect(NaN), rect(0, Infinity), rect(0, 0, -1), rect(0, 0, 10, -1), rect(Number.MAX_VALUE, 0, Number.MAX_VALUE)])(
  "retains only the uncertain edge for missing/nonfinite/invalid route bounds %o", (routeBounds) => {
    const value = query([edge("known-far", 10000), { ...edge("uncertain"), routeBounds }]);
    expect(ids(value)).toEqual(["uncertain"]);
    expect([...value.unknownGeometryIds]).toEqual(["uncertain"]);
    expect(value.fallback).toBe("none");
  }
);

it("treats unknown or invalid label geometry as unknown, never as a proven absent label", () => {
  for (const label of [{ kind: "unknown" as const }, ...[rect(NaN), rect(10000, 0, 0, 10), rect(10000, 0, 10, 0)]
    .map((bounds) => ({ kind: "measured" as const, bounds }))]) {
    const value = query([{ ...edge("uncertain", 10000), label }, edge("known-far", 10000)]);
    expect(ids(value)).toEqual(["uncertain"]);
    expect([...value.unknownGeometryIds]).toEqual(["uncertain"]);
  }
  const current = query([{ ...edge("route", 10000), label: { kind: "unknown" } }]);
  expect(ids(query([edge("route", 10000)], { previous: current }))).toEqual([]);
});

it.each([{ width: 0 }, { height: -1 }, { zoom: 0 }, { zoom: 0.009 }, { zoom: 10.1 }, { x: NaN }, { height: Infinity }, { width: Number.MAX_VALUE, zoom: 0.01 }])(
  "retains all current ids when camera/band geometry is invalid %o", (change) => {
    const value = query([edge("a"), edge("far", 10000)], { viewport: { ...viewport, ...change } });
    expect(ids(value)).toEqual(["a", "far"]); expect(value.fallback).toBe("viewport");
  }
);

it("retains all current ids for duplicate or empty identity without mutating caller inputs", () => {
  for (const edges of [[edge("same", 10000), edge("same"), edge("other", 10000)], [edge("", 10000), edge("other", 10000)]]) {
    const value = query(edges);
    expect(ids(value)).toEqual([...new Set(edges.map((row) => row.id))]); expect(value.fallback).toBe("identity");
  }
  const edges = Object.freeze([Object.freeze({ ...edge("fixed", 10000), routeBounds: Object.freeze(rect(10000)), label: Object.freeze({ kind: "none" as const }) })]);
  const previous = query(edges), protectedIds = new Set(["fixed"]);
  const result = query(edges, { previous, protectedIds });
  expect(ids(result)).toEqual(["fixed"]); expect(ids(previous)).toEqual([]);
  expect(result.eligibleIds).not.toBe(protectedIds); expect(protectedIds.size).toBe(1);
});

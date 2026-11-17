import { expect, it } from "vitest";
import { queryViewportEdgeEligibility, type ViewportEdgeFootprint } from "./viewportEdgeEligibility";

it.each([10, 1000, 10000])("visits %s footprints once and reports candidates without constructing route paths", (count) => {
  const reads = { ids: 0, route: 0, label: 0, coordinates: 0 };
  const rectangle = (x: number) => new Proxy({ x, y: 0, width: 10, height: 10 }, {
    get(target, key, receiver) {
      if (["x", "y", "width", "height"].includes(String(key))) reads.coordinates++;
      return Reflect.get(target, key, receiver);
    }
  });
  const edges: ViewportEdgeFootprint[] = Array.from({ length: count }, (_, index) => {
    const routeBounds = rectangle(index ? 10000 : 0), label = { kind: "measured" as const, bounds: rectangle(10000) };
    return {
      get id() { reads.ids++; return `edge-${index}`; },
      get routeBounds() { reads.route++; return routeBounds; },
      get label() { reads.label++; return label; },
      // A candidate query must not inspect persisted content or rebuild SVG geometry.
      get path() { throw Error("unexpected_path_construction"); },
      get metadata() { throw Error("unexpected_authored_record_read"); }
    };
  });
  const result = queryViewportEdgeEligibility({
    scope: { projectId: "project", workspaceMode: "relationships", flowId: null, focusedFrameId: null },
    viewport: { x: 0, y: 0, width: 100, height: 100, zoom: 1 }, edges
  });
  expect([...result.eligibleIds]).toEqual(["edge-0"]);
  expect(result.unknownGeometryIds.size).toBe(0); expect(result.fallback).toBe("none");
  expect(reads).toEqual({ ids: count, route: count, label: count, coordinates: count * 8 });
});

it("retains all 1000 unmeasured edges rather than manufacturing precise exclusions", () => {
  const result = queryViewportEdgeEligibility({
    scope: { projectId: "project", workspaceMode: "relationships", flowId: null, focusedFrameId: null },
    viewport: { x: 0, y: 0, width: 100, height: 100, zoom: 1 },
    edges: Array.from({ length: 1000 }, (_, index) => ({ id: `edge-${index}`, label: { kind: "unknown" as const } }))
  });
  expect(result.eligibleIds.size).toBe(1000); expect(result.unknownGeometryIds.size).toBe(1000);
});

it("does not cap a 1000-edge protected selection or reuse its caller-owned set", () => {
  const protectedIds = new Set(Array.from({ length: 1000 }, (_, index) => `edge-${index}`));
  const result = queryViewportEdgeEligibility({
    scope: { projectId: "project", workspaceMode: "relationships", flowId: null, focusedFrameId: null },
    viewport: { x: 0, y: 0, width: 100, height: 100, zoom: 1 }, protectedIds,
    edges: [...protectedIds].map((id) => ({ id, routeBounds: { x: 10000, y: 10000, width: 10, height: 10 }, label: { kind: "none" as const } }))
  });
  expect(result.eligibleIds.size).toBe(1000); expect(result.unknownGeometryIds.size).toBe(0);
  expect(result.eligibleIds).not.toBe(protectedIds); expect(protectedIds.size).toBe(1000);
});

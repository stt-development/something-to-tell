import { expect, it } from "vitest";
import { createEdgeFootprintStore, type EdgeFootprintCommit, type EdgeGeometryKey } from "./edgeFootprintStore";
import { queryViewportEdgeEligibility, type ViewportEdgeFootprint } from "./viewportEdgeEligibility";
import type { ViewportScope, WorldRectangle } from "./viewportEligibility";

const scope: ViewportScope = { projectId: "project", workspaceMode: "relationships", flowId: "main", focusedFrameId: null };
const rect = (x = 10000, width = 10, height = 10): WorldRectangle => ({ x, y: 0, width, height });
const commit = (geometryKey: EdgeGeometryKey = 1, extra: Partial<EdgeFootprintCommit> = {}): EdgeFootprintCommit =>
  ({ scope, resetKey: "document-1", edges: [{ id: "edge", geometryKey }], ...extra });
const request = (geometryKey: EdgeGeometryKey = 1, extra: Partial<EdgeFootprintCommit> = {}) =>
  ({ ...commit(geometryKey, extra), id: "edge", geometryKey });
const footprint = (extra: Partial<ViewportEdgeFootprint> = {}): ViewportEdgeFootprint =>
  ({ id: "edge", routeBounds: rect(), label: { kind: "none" }, ...extra });
const candidates = (store: ReturnType<typeof createEdgeFootprintStore>) => {
  const snapshot = store.read()!;
  return queryViewportEdgeEligibility({ ...snapshot, viewport: { x: 0, y: 0, width: 100, height: 100, zoom: 1 } });
};

it("starts inactive, keeps unmeasured rows conservative, and accepts only an original-id current measurement", () => {
  const store = createEdgeFootprintStore(); expect(store.read()).toBeNull();
  expect(store.beginMeasurement(request())).toBeNull();
  store.commit(commit());
  expect([...candidates(store).eligibleIds]).toEqual(["edge"]);
  expect([...candidates(store).unknownGeometryIds]).toEqual(["edge"]);
  const ticket = store.beginMeasurement(request())!;
  expect(store.publish({ ...ticket }, footprint())).toBe(false);
  expect(store.publish(ticket, footprint({ id: "other" }))).toBe(false);
  expect(store.publish(ticket, footprint())).toBe(true);
  expect([...candidates(store).eligibleIds]).toEqual([]);
  expect(store.publish(ticket, footprint({ routeBounds: rect(0) }))).toBe(false);
});

it("retires a prior known result immediately and rejects older/out-of-order reads of unchanged inputs", () => {
  const store = createEdgeFootprintStore(); store.commit(commit());
  const first = store.beginMeasurement(request())!;
  expect(store.publish(first, footprint())).toBe(true);
  const older = store.beginMeasurement(request())!;
  expect([...candidates(store).eligibleIds]).toEqual(["edge"]);
  const latest = store.beginMeasurement(request())!;
  expect(store.publish(older, footprint())).toBe(false);
  expect(store.publish(latest, footprint({ routeBounds: rect(0) }))).toBe(true);
  expect(store.publish(older, footprint())).toBe(false);
  expect(store.read()!.edges[0]!.routeBounds!.x).toBe(0);
});

it.each(["path", "label", "lane", "marker", "hit-area", "font-layout", "paint-zoom"])(
  "retires the footprint/ticket when the committed %s version changes, not when the array reference changes", (version) => {
    const store = createEdgeFootprintStore(); store.commit(commit());
    const original = store.beginMeasurement(request())!; store.publish(original, footprint());
    store.commit(commit(version));
    expect(store.read()!.edges[0]!.routeBounds).toBeNull();
    expect(store.beginMeasurement(request())).toBeNull();
    expect([...candidates(store).eligibleIds]).toEqual(["edge"]);
    const pending = store.beginMeasurement(request(version))!;
    const nextVersion = `${version}:next`; store.commit(commit(nextVersion));
    expect(store.publish(pending, footprint())).toBe(false);
    const current = store.beginMeasurement(request(nextVersion))!;
    store.commit(commit(nextVersion));
    expect(store.publish(current, footprint())).toBe(true);
    store.commit(commit(nextVersion));
    expect([...candidates(store).eligibleIds]).toEqual([]);
  }
);

it.each([{ projectId: "next" }, { workspaceMode: "flow" as const }, { flowId: "next" }, { focusedFrameId: "frame" }])(
  "isolates tickets and snapshots across scope replacement and ABA reuse %o", (change) => {
    const store = createEdgeFootprintStore(); store.commit(commit());
    const original = store.beginMeasurement(request())!;
    const next = { ...scope, ...change }; store.commit(commit(1, { scope: next }));
    expect(store.publish(original, footprint())).toBe(false);
    expect(store.beginMeasurement(request())).toBeNull();
    const foreign = store.beginMeasurement(request(1, { scope: next }))!;
    store.commit(commit());
    expect(store.publish(foreign, footprint())).toBe(false);
    expect(store.publish(original, footprint())).toBe(false);
    expect(store.read()!.scope).toEqual(scope);
    expect([...candidates(store).unknownGeometryIds]).toEqual(["edge"]);
  }
);

it("invalidates document replacements, removed/re-added identities, key ABA and suspension", () => {
  const store = createEdgeFootprintStore(); store.commit(commit());
  const oldDocument = store.beginMeasurement(request())!;
  store.commit(commit(1, { resetKey: "document-2" }));
  expect(store.publish(oldDocument, footprint())).toBe(false);
  expect(store.beginMeasurement(request())).toBeNull();
  store.commit(commit());
  expect(store.publish(oldDocument, footprint())).toBe(false);
  const removed = store.beginMeasurement(request())!;
  store.commit(commit(1, { edges: [] })); expect(store.read()!.edges).toEqual([]);
  store.commit(commit()); expect(store.publish(removed, footprint())).toBe(false);
  const oldKey = store.beginMeasurement(request())!;
  store.commit(commit(2)); store.commit(commit());
  expect(store.publish(oldKey, footprint())).toBe(false);
  const suspended = store.beginMeasurement(request())!;
  store.commit(null); expect(store.read()).toBeNull();
  store.commit(commit()); expect(store.publish(suspended, footprint())).toBe(false);
});

it("retains pending/known entries across equivalent commits and current row reordering, not old rows", () => {
  const store = createEdgeFootprintStore();
  const rows = [{ id: "edge", geometryKey: 1 }, { id: "other", geometryKey: 2 }];
  store.commit(commit(1, { edges: rows }));
  const pending = store.beginMeasurement(request())!;
  store.commit(commit(1, { edges: [...rows].reverse() }));
  expect(store.publish(pending, footprint())).toBe(true);
  expect(store.read()!.edges.map((row) => row.id)).toEqual(["other", "edge"]);
  expect([...candidates(store).eligibleIds]).toEqual(["other"]);
  store.commit(commit());
  expect(store.read()!.edges.map((row) => row.id)).toEqual(["edge"]);
  expect([...candidates(store).eligibleIds]).toEqual([]);
});

it.each([null, rect(NaN), rect(0, -1), rect(0, 10, -1), rect(Number.MAX_VALUE, Number.MAX_VALUE)])(
  "publishes invalid route geometry as unknown instead of resurrecting a prior valid result %o", (routeBounds) => {
    const store = createEdgeFootprintStore(); store.commit(commit());
    store.publish(store.beginMeasurement(request())!, footprint());
    expect(store.publish(store.beginMeasurement(request())!, footprint({ routeBounds }))).toBe(true);
    expect(store.read()!.edges[0]!.routeBounds).toBeNull();
    expect([...candidates(store).unknownGeometryIds]).toEqual(["edge"]);
  }
);

it("preserves line geometry but treats unmeasured/zero/nonfinite label bounds conservatively", () => {
  const store = createEdgeFootprintStore(); store.commit(commit());
  store.publish(store.beginMeasurement(request())!, footprint({ routeBounds: rect(10000, 100, 0) }));
  expect([...candidates(store).eligibleIds]).toEqual([]);
  for (const bounds of [rect(0, 0), rect(0, 10, 0), rect(NaN), rect(Number.MAX_VALUE)]) {
    store.publish(store.beginMeasurement(request())!, footprint({ label: { kind: "measured", bounds } }));
    expect(store.read()!.edges[0]!.label).toEqual({ kind: "unknown" });
    expect([...candidates(store).eligibleIds]).toEqual(["edge"]);
  }
  store.publish(store.beginMeasurement(request())!, footprint({ label: { kind: "measured", bounds: rect(0) } }));
  expect([...candidates(store).eligibleIds]).toEqual(["edge"]);
});

it("does not resurrect trusted geometry after an ambiguous commit recovers", () => {
  const store = createEdgeFootprintStore(); store.commit(commit());
  store.publish(store.beginMeasurement(request())!, footprint());
  expect([...candidates(store).eligibleIds]).toEqual([]);
  store.commit(commit(1, { edges: [{ id: "edge", geometryKey: 1 }, { id: "edge", geometryKey: 1 }] }));
  expect(store.read()!.edges.every((row) => row.routeBounds === null)).toBe(true);
  store.commit(commit());
  expect([...candidates(store).unknownGeometryIds]).toEqual(["edge"]);
});

it("keeps a bad version unknown without retiring an unrelated valid current measurement", () => {
  const store = createEdgeFootprintStore();
  store.commit(commit(1, { edges: [{ id: "edge", geometryKey: 1 }, { id: "other", geometryKey: 2 }] }));
  store.publish(store.beginMeasurement(request())!, footprint());
  store.publish(store.beginMeasurement({ ...request(2), id: "other" })!, footprint({ id: "other" }));
  store.commit(commit(NaN, { edges: [{ id: "edge", geometryKey: NaN }, { id: "other", geometryKey: 2 }] }));
  expect([...candidates(store).unknownGeometryIds]).toEqual(["edge"]);
  expect([...candidates(store).eligibleIds]).toEqual(["edge"]);
});

it("refuses object-valued keys instead of retaining graph or DOM objects as versions", () => {
  const bad = { authored: { text: "not a geometry version" } } as unknown as EdgeGeometryKey;
  const store = createEdgeFootprintStore();
  store.commit(commit(1, { resetKey: bad }));
  expect(store.beginMeasurement(request(1, { resetKey: bad }))).toBeNull();
  store.commit(commit(bad)); expect(store.beginMeasurement(request(bad))).toBeNull();
  expect([...candidates(store).unknownGeometryIds]).toEqual(["edge"]);
});

it("rejects ambiguous identity and nonfinite keys conservatively without losing current rows", () => {
  const store = createEdgeFootprintStore(); store.commit(commit());
  const pending = store.beginMeasurement(request())!;
  store.commit(commit(1, { edges: [{ id: "edge", geometryKey: 1 }, { id: "edge", geometryKey: 1 }] }));
  expect(store.read()!.edges).toHaveLength(2); expect(candidates(store).fallback).toBe("identity");
  expect(store.publish(pending, footprint())).toBe(false); expect(store.beginMeasurement(request())).toBeNull();
  store.commit(commit(1, { edges: [{ id: "", geometryKey: 1 }, { id: "edge", geometryKey: 1 }] }));
  expect(candidates(store).fallback).toBe("identity"); expect(store.beginMeasurement(request())).toBeNull();
  for (const resetKey of [NaN, Infinity]) {
    store.commit(commit(1, { resetKey }));
    expect([...candidates(store).unknownGeometryIds]).toEqual(["edge"]);
    expect(store.beginMeasurement(request(1, { resetKey }))).toBeNull();
  }
  store.commit(commit(NaN)); expect(store.beginMeasurement(request(NaN))).toBeNull();
  expect([...candidates(store).unknownGeometryIds]).toEqual(["edge"]);
});

it("copies only primitive inputs and numeric footprints, exposing immutable snapshots", () => {
  const store = createEdgeFootprintStore(); const context = { ...scope, metadata: { authored: true } };
  const rows = [{ id: "edge", geometryKey: 1 }]; store.commit(commit(1, { scope: context, edges: rows }));
  context.projectId = "changed"; rows[0]!.geometryKey = 2; rows[0]!.id = "changed";
  const routeBounds = { ...rect(), metadata: { authored: true } }, labelBounds = { ...rect(0) };
  const input = footprint({ routeBounds, label: { kind: "measured", bounds: labelBounds } });
  expect(store.publish(store.beginMeasurement(request())!, input)).toBe(true);
  routeBounds.x = 20; labelBounds.x = 10000;
  const snapshot = store.read()!;
  expect(snapshot.scope).toEqual(scope); expect(snapshot.scope).not.toHaveProperty("metadata");
  expect(snapshot.edges[0]!.routeBounds).toEqual(rect());
  expect(snapshot.edges[0]!.routeBounds).not.toHaveProperty("metadata");
  expect(snapshot.edges[0]!.label).toEqual({ kind: "measured", bounds: rect(0) });
  expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.isFrozen(snapshot.scope)).toBe(true);
  expect(Object.isFrozen(snapshot.edges)).toBe(true); expect(Object.isFrozen(snapshot.edges[0]!.routeBounds)).toBe(true);
});

it("keeps stores isolated and disposal terminal, rejecting late callbacks after attempted recommit", () => {
  const first = createEdgeFootprintStore(), second = createEdgeFootprintStore();
  first.commit(commit()); second.commit(commit());
  const ticket = first.beginMeasurement(request())!;
  second.beginMeasurement(request()); expect(second.publish(ticket, footprint())).toBe(false);
  first.dispose(); first.commit(commit()); first.commit(null); first.dispose();
  expect(first.publish(ticket, footprint())).toBe(false); expect(first.read()).toBeNull();
  expect(first.beginMeasurement(request())).toBeNull();
  expect(second.read()!.edges).toHaveLength(1);
});

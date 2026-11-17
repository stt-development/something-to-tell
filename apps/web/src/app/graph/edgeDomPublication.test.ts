import { afterEach, expect, it, vi } from "vitest";
import { createEdgeDomObservation } from "./edgeDomObservation";
import { measureEdgeWorldFootprint } from "./edgeWorldFootprint";
import type { ViewportEdgeFootprint } from "./viewportEdgeEligibility";

// Isolate publication/hysteresis ownership; the real composer has unit/native coverage.
vi.mock("./edgeWorldFootprint", () => ({ measureEdgeWorldFootprint: vi.fn() }));
const scope = { projectId: "project", workspaceMode: "relationships" as const, flowId: null, focusedFrameId: null };
const viewport = { x: 0, y: 0, width: 100, height: 100, zoom: 1 };
function fixture() {
  vi.stubGlobal("MutationObserver", undefined); vi.stubGlobal("ResizeObserver", undefined);
  const root = document.createElement("div"), world = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  root.append(world); document.body.append(root);
  let scheduled: (() => void) | null = null;
  const frames = { request: vi.fn((callback: () => void) => { scheduled = callback; return 1; }), cancel: vi.fn() };
  const flush = () => { const current = scheduled; scheduled = null; current?.(); };
  let x = 320;
  vi.mocked(measureEdgeWorldFootprint).mockImplementation(({ id }) => ({ id, routeBounds: { x, y: 0, width: 10, height: 10 }, label: { kind: "none" } }));
  const owner = createEdgeDomObservation(root, { scope, resetKey: 1 }, frames, undefined, world);
  return { owner, frames, flush, root, world, move: (next: number) => { x = next; },
    update: (ids = ["edge"], protectedIds?: ReadonlySet<string>) => { owner.update({ ids, viewport, protectedIds }); flush(); } };
}
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

it("publishes certified components through the lifetime store and retains release-band membership", () => {
  const f = fixture(); f.update(); expect([...f.owner.getSnapshot()!.eligibility.eligibleIds]).toEqual(["edge"]);
  expect(measureEdgeWorldFootprint).toHaveBeenCalledWith(expect.objectContaining({ root: f.root, worldSpace: f.world, id: "edge" }));
  f.move(400); f.update(); expect([...f.owner.getSnapshot()!.eligibility.eligibleIds]).toEqual(["edge"]);
  f.move(470); f.update(); expect([...f.owner.getSnapshot()!.eligibility.eligibleIds]).toEqual([]);
  f.move(400); f.update(); expect([...f.owner.getSnapshot()!.eligibility.eligibleIds]).toEqual([]);
  f.owner.dispose();
});

it("copies callback-visible membership and discards removed ids and old owner retention", () => {
  const f = fixture(); f.update();
  (f.owner.getSnapshot()!.eligibility.eligibleIds as Set<string>).clear();
  f.move(400); f.update(); expect([...f.owner.getSnapshot()!.eligibility.eligibleIds]).toEqual(["edge"]);
  f.update([]); f.update(); expect([...f.owner.getSnapshot()!.eligibility.eligibleIds]).toEqual([]);
  f.move(320); f.update(); f.owner.dispose();
  const next = createEdgeDomObservation(f.root, { scope: { ...scope, projectId: "other" }, resetKey: 2 }, f.frames, undefined, f.world);
  f.move(400); next.update({ ids: ["edge"], viewport }); f.flush();
  expect([...next.getSnapshot()!.eligibility.eligibleIds]).toEqual([]); next.dispose();
});

it("retains incomplete, protected and invalid-camera inputs without exposing mutable source rectangles", () => {
  const f = fixture(); const footprint: ViewportEdgeFootprint = { id: "edge", routeBounds: { x: 1000, y: 0, width: 10, height: 10 }, label: { kind: "unknown" } };
  vi.mocked(measureEdgeWorldFootprint).mockReturnValue(footprint); f.update();
  expect([...f.owner.getSnapshot()!.eligibility.unknownGeometryIds]).toEqual(["edge"]);
  (footprint.routeBounds as { x: number }).x = 2000;
  expect(f.owner.getSnapshot()!.footprints.edges[0]!.routeBounds!.x).toBe(1000);
  vi.mocked(measureEdgeWorldFootprint).mockReturnValue({ ...footprint, label: { kind: "none" } });
  f.update(["edge"], new Set(["edge"])); expect([...f.owner.getSnapshot()!.eligibility.eligibleIds]).toEqual(["edge"]);
  f.owner.update({ ids: ["edge"], viewport: { ...viewport, zoom: NaN } }); f.flush();
  expect(f.owner.getSnapshot()!.eligibility.fallback).toBe("viewport"); f.owner.dispose();
});

it("cannot publish a completed composition after synchronous replacement or disposal", () => {
  const f = fixture(); let replace = true;
  vi.mocked(measureEdgeWorldFootprint).mockImplementation(({ id }) => {
    if (replace) { replace = false; f.owner.update({ ids: ["replacement"], viewport }); }
    return { id, routeBounds: null, label: { kind: "unknown" } };
  });
  f.owner.update({ ids: ["edge"], viewport }); f.flush(); expect(f.owner.getSnapshot()).toBeNull();
  f.flush(); expect(f.owner.getSnapshot()!.footprints.edges[0]!.id).toBe("replacement");
  vi.mocked(measureEdgeWorldFootprint).mockImplementation(({ id }) => { f.owner.dispose(); return { id, routeBounds: null, label: { kind: "unknown" } }; });
  f.update(); expect(f.owner.getSnapshot()).toBeNull();
});

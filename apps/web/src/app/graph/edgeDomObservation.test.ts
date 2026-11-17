import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEdgeDomObservation, type EdgeDomObservationInputs } from "./edgeDomObservation";

const scope = { projectId: "project", workspaceMode: "relationships" as const, flowId: null, focusedFrameId: null };
const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
const mutations: Array<{ callback: () => void; disconnect: ReturnType<typeof vi.fn> }> = [];
const resizes: Array<{ callback: () => void; observe: ReturnType<typeof vi.fn>; unobserve: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];

beforeEach(() => {
  mutations.length = 0; resizes.length = 0;
  vi.stubGlobal("MutationObserver", class {
    disconnect = vi.fn(); observe = vi.fn();
    constructor(callback: () => void) { mutations.push({ callback, disconnect: this.disconnect }); }
  });
  vi.stubGlobal("ResizeObserver", class {
    disconnect = vi.fn(); observe = vi.fn(); unobserve = vi.fn();
    constructor(callback: () => void) { resizes.push({ callback, observe: this.observe, unobserve: this.unobserve, disconnect: this.disconnect }); }
  });
});
afterEach(() => {
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (originalFonts) Object.defineProperty(document, "fonts", originalFonts); else Reflect.deleteProperty(document, "fonts");
});

function clock() {
  let next = 0;
  const callbacks = new Map<number, () => void>();
  return { callbacks, request: vi.fn((callback: () => void) => { callbacks.set(++next, callback); return next; }),
    cancel: vi.fn(), flush() { const all = [...callbacks.values()]; callbacks.clear(); all.forEach((callback) => callback()); } };
}
function fixture(id = "edge") {
  const root = document.createElement("div"), portal = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"), path = document.createElementNS(svg.namespaceURI, "path") as SVGPathElement;
  const label = document.createElement("div");
  path.setAttribute("data-narrative-edge-route", id); path.setAttribute("data-narrative-edge-label-state", "present");
  label.setAttribute("data-narrative-edge-label", id);
  svg.append(path); portal.append(label); root.append(svg, portal); document.body.append(root);
  Object.defineProperty(path, "getScreenCTM", { value: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) });
  const bounds = vi.spyOn(label, "getBoundingClientRect").mockReturnValue({ left: 20, top: 30, width: 120, height: 24 } as DOMRect);
  vi.spyOn(label, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  return { root, path, label, portal, bounds };
}
const inputs = (ids = ["edge"], extra: Partial<EdgeDomObservationInputs> = {}): EdgeDomObservationInputs =>
  ({ ids, viewport: { x: 0, y: 0, width: 100, height: 100, zoom: 1 }, ...extra });

it("coalesces current committed reads, copies inputs, and never certifies layout boxes or routes", () => {
  const { root, bounds } = fixture(), frames = clock(), listener = vi.fn();
  const owner = createEdgeDomObservation(root, { scope, resetKey: 1 }, frames, listener);
  const value = inputs(); owner.update(value); owner.update(value);
  expect(owner.getSnapshot()).toBeNull(); expect(bounds).not.toHaveBeenCalled(); expect(frames.request).toHaveBeenCalledOnce();
  (value.ids as string[]).push("foreign"); (value.viewport as { width: number }).width = NaN;
  frames.flush();
  const snapshot = owner.getSnapshot()!;
  expect(snapshot.labelBoxes).toEqual([{ id: "edge", bounds: { x: 20, y: 30, width: 120, height: 24 } }]);
  expect(snapshot.footprints.edges).toEqual([{ id: "edge", routeBounds: null, label: { kind: "unknown" } }]);
  expect([...snapshot.eligibility.eligibleIds]).toEqual(["edge"]);
  expect([...snapshot.eligibility.unknownGeometryIds]).toEqual(["edge"]);
  expect(listener).toHaveBeenCalledOnce(); owner.dispose();
});

it("invalidates immediately for mutations, resize, scroll and font lifecycle, but reads only once per frame", () => {
  const { root, bounds, label } = fixture(), frames = clock(), fonts = new EventTarget();
  Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
  const owner = createEdgeDomObservation(root, { scope, resetKey: 1 }, frames);
  owner.update(inputs()); frames.flush(); const old = owner.getSnapshot()!;
  expect(resizes[0]!.observe).toHaveBeenCalledWith(label);
  for (const invalidate of [mutations[0]!.callback, resizes[0]!.callback, () => window.dispatchEvent(new Event("scroll")),
    () => window.dispatchEvent(new Event("resize")), ...["loading", "loadingdone", "loadingerror"].map((event) => () => fonts.dispatchEvent(new Event(event)))]) {
    invalidate(); expect(owner.getSnapshot()).toBeNull(); invalidate(); frames.flush(); expect(owner.getSnapshot()).not.toBeNull();
  }
  expect(old.labelBoxes[0]!.bounds!.x).toBe(20); expect(bounds).toHaveBeenCalledTimes(8);
  label.remove(); mutations[0]!.callback(); frames.flush(); expect(resizes[0]!.unobserve).toHaveBeenCalledWith(label);
  expect(owner.getSnapshot()!.labelBoxes[0]!.bounds).toBeNull(); owner.dispose();
});

it("requires explicit committed label absence, not a missing portal or duplicate DOM identity", () => {
  const { root, label, path } = fixture(), frames = clock();
  const owner = createEdgeDomObservation(root, { scope, resetKey: 1 }, frames);
  label.remove(); owner.update(inputs()); frames.flush(); expect(owner.getSnapshot()!.footprints.edges[0]!.label.kind).toBe("unknown");
  path.setAttribute("data-narrative-edge-label-state", "none"); owner.update(inputs()); frames.flush();
  expect(owner.getSnapshot()!.footprints.edges[0]!.label.kind).toBe("none");
  root.append(label); owner.update(inputs()); frames.flush(); expect(owner.getSnapshot()!.footprints.edges[0]!.label.kind).toBe("unknown");
  root.append(label.cloneNode(true)); owner.update(inputs()); frames.flush(); expect(owner.getSnapshot()!.labelBoxes[0]!.bounds).toBeNull();
  label.remove(); root.querySelector("[data-narrative-edge-label]")!.remove();
  path.parentElement!.append(path.cloneNode(true)); owner.update(inputs()); frames.flush();
  expect(owner.getSnapshot()!.footprints.edges[0]!.label.kind).toBe("unknown"); owner.dispose();
});

it("uses root-scoped raw ids without selector interpolation, drops removed ids and preserves ambiguous input fallback", () => {
  const id = 'edge"[# unusual]', local = fixture(id), foreign = fixture(id), frames = clock();
  const owner = createEdgeDomObservation(local.root, { scope, resetKey: 1 }, frames);
  owner.update(inputs([id])); frames.flush(); expect(local.bounds).toHaveBeenCalledOnce(); expect(foreign.bounds).not.toHaveBeenCalled();
  owner.update(inputs([id, id])); frames.flush(); expect(owner.getSnapshot()!.eligibility.fallback).toBe("identity");
  owner.update(inputs([])); frames.flush(); expect(owner.getSnapshot()!.footprints.edges).toEqual([]);
  owner.update(inputs([""])); frames.flush(); expect(owner.getSnapshot()!.eligibility.fallback).toBe("identity"); owner.dispose();
});

it("rejects reads invalidated during measurement and uses the newest camera/protection without stale callbacks", () => {
  const { root, bounds } = fixture(), frames = clock(), listener = vi.fn();
  const owner = createEdgeDomObservation(root, { scope, resetKey: 1 }, frames, listener);
  owner.update(inputs()); bounds.mockImplementationOnce(() => { owner.update(inputs(["next"])); return {} as DOMRect; });
  frames.flush(); expect(owner.getSnapshot()).toBeNull(); expect(listener).not.toHaveBeenCalled();
  frames.flush(); expect(owner.getSnapshot()!.footprints.edges.map((edge) => edge.id)).toEqual(["next"]);
  owner.update(inputs(["edge"], { viewport: { x: 500, y: 300, zoom: 10, width: 0, height: 100 }, protectedIds: new Set(["edge"]) }));
  frames.flush(); expect(owner.getSnapshot()!.eligibility.fallback).toBe("viewport"); owner.dispose();
});

it("disposes observers/listeners, terminally cancels pending work and isolates scope/document reuse", () => {
  const { root, bounds } = fixture(), frames = clock(), listener = vi.fn(), fonts = new EventTarget();
  Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
  const owner = createEdgeDomObservation(root, { scope, resetKey: 1 }, frames, listener);
  owner.update(inputs()); const late = [...frames.callbacks.values()][0]!;
  owner.dispose(); owner.dispose(); owner.update(inputs()); late();
  expect(bounds).not.toHaveBeenCalled(); expect(listener).not.toHaveBeenCalled(); expect(frames.cancel).toHaveBeenCalledOnce();
  expect(mutations[0]!.disconnect).toHaveBeenCalledOnce(); expect(resizes[0]!.disconnect).toHaveBeenCalledOnce();
  mutations[0]!.callback(); resizes[0]!.callback(); fonts.dispatchEvent(new Event("loadingdone")); window.dispatchEvent(new Event("scroll"));
  expect(frames.request).toHaveBeenCalledOnce();
  const next = createEdgeDomObservation(root, { scope: { ...scope, projectId: "next" }, resetKey: 2 }, frames);
  next.update(inputs()); frames.flush(); expect(next.getSnapshot()!.footprints.scope.projectId).toBe("next");
  expect(owner.getSnapshot()).toBeNull(); next.dispose();
});

it("retains all ids when the canvas disconnects or observer capabilities are absent", () => {
  vi.stubGlobal("MutationObserver", undefined); vi.stubGlobal("ResizeObserver", undefined);
  const { root } = fixture(), frames = clock(), owner = createEdgeDomObservation(root, { scope, resetKey: 1 }, frames);
  root.remove(); owner.update(inputs()); frames.flush();
  expect([...owner.getSnapshot()!.eligibility.eligibleIds]).toEqual(["edge"]); owner.dispose();
});

it("honors reentrant suspension from invalidation and latest-input replacement from publication", () => {
  const { root } = fixture(), frames = clock();
  let action: "none" | "replace" | "dispose" = "none";
  const owner = createEdgeDomObservation(root, { scope, resetKey: 1 }, frames, (snapshot) => {
    if (snapshot && action === "replace") { action = "none"; owner.update(inputs(["replacement"])); }
    if (!snapshot && action === "dispose") owner.dispose();
  });
  owner.update(inputs()); action = "replace"; frames.flush(); expect(owner.getSnapshot()).toBeNull();
  frames.flush(); expect(owner.getSnapshot()!.footprints.edges[0]!.id).toBe("replacement");
  action = "dispose"; const scheduled = frames.request.mock.calls.length;
  owner.update(inputs()); expect(owner.getSnapshot()).toBeNull(); expect(frames.request).toHaveBeenCalledTimes(scheduled);
});

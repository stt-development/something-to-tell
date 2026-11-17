import { afterEach, expect, it, vi } from "vitest";
import { createEdgeFootprintStore } from "./edgeFootprintStore";
import { measureEdgeLabelBox } from "./edgeLabelDomMeasurement";
import { queryViewportEdgeEligibility } from "./viewportEdgeEligibility";

// jsdom has no layout/SVG CTM. Stub only browser geometry; use connected real DOM trees.
const rectangle = (left = 100, top = 50, width = 120, height = 30) => ({ left, top, width, height }) as DOMRect;
const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, is2D: true };
const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
function fixture(transform = identity) {
  const host = document.createElement("div"), portal = document.createElement("div"), label = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const space = document.createElementNS(svg.namespaceURI, "g") as SVGGElement;
  host.append(svg, portal); svg.append(space); portal.append(label); document.body.append(host);
  const screenMatrix = vi.fn(() => ({ ...transform }) as DOMMatrix);
  Object.defineProperty(space, "getScreenCTM", { configurable: true, value: screenMatrix });
  const bounds = vi.spyOn(label, "getBoundingClientRect").mockReturnValue(rectangle());
  vi.spyOn(label, "getClientRects").mockReturnValue([rectangle()] as unknown as DOMRectList);
  return { host, label, space, screenMatrix, bounds };
}
afterEach(() => {
  document.body.replaceChildren(); vi.restoreAllMocks();
  if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
  else Reflect.deleteProperty(document, "fonts");
});

it("measures a label in a separate portal without assuming the SVG is its ancestor", () => {
  const { label, space, bounds, screenMatrix } = fixture();
  expect(space.contains(label)).toBe(false);
  const first = measureEdgeLabelBox(label, space)!;
  expect(first).toEqual({ x: 100, y: 50, width: 120, height: 30 });
  expect(Object.isFrozen(first)).toBe(true);
  bounds.mockReturnValue(rectangle(300, 400, 240, 90));
  screenMatrix.mockReturnValue({ ...identity, a: 2, d: 2, e: 100, f: 200 } as DOMMatrix);
  expect(measureEdgeLabelBox(label, space)).toEqual({ x: 100, y: 100, width: 120, height: 45 });
  expect(first).toEqual({ x: 100, y: 50, width: 120, height: 30 });
});

it.each([0.01, 1, 10])("converts client offsets/pan and actual screen scale at %s without device-pixel multiplication", (zoom) => {
  const { label, space, bounds } = fixture({ ...identity, a: zoom, d: zoom, e: 125, f: -75 });
  bounds.mockReturnValue(rectangle(125 + 200 * zoom, -75 + 400 * zoom, 180 * zoom, 40 * zoom));
  const actual = measureEdgeLabelBox(label, space)!;
  expect(actual.x).toBeCloseTo(200); expect(actual.y).toBeCloseTo(400);
  expect(actual.width).toBeCloseTo(180); expect(actual.height).toBeCloseTo(40);
});

it("supports unequal positive outer CSS scaling and unions overflowing descendant badges", () => {
  const { label, space } = fixture({ ...identity, a: 2, d: 4, e: -20, f: 10 });
  const badge = document.createElement("small"), empty = document.createElement("span");
  label.append(badge, empty);
  vi.spyOn(badge, "getBoundingClientRect").mockReturnValue(rectangle(80, 40, 180, 60));
  vi.spyOn(empty, "getBoundingClientRect").mockReturnValue(rectangle(0, 0, 0, 0));
  expect(measureEdgeLabelBox(label, space)).toEqual({ x: 50, y: 7.5, width: 90, height: 15 });
});

it.each([
  { a: 0 }, { a: -1 }, { d: 0 }, { d: -1 }, { a: NaN }, { e: Infinity },
  { b: 0.1 }, { c: 0.1 }, { is2D: false }
])("keeps unsupported or invalid world-space transforms unknown: %o", (change) => {
  const { label, space } = fixture({ ...identity, ...change });
  expect(measureEdgeLabelBox(label, space)).toBeNull();
});

it.each([
  rectangle(0, 0, 0), rectangle(0, 0, 10, 0), rectangle(0, 0, -1), rectangle(NaN),
  rectangle(0, Infinity), rectangle(Number.MAX_VALUE, 0, Number.MAX_VALUE), rectangle(Number.MAX_VALUE)
])("keeps invalid/collapsed root rectangles unknown: %o", (value) => {
  const { label, space, bounds } = fixture(); bounds.mockReturnValue(value);
  expect(measureEdgeLabelBox(label, space)).toBeNull();
});

it("keeps missing, disconnected and cross-document elements unknown, never absent", () => {
  const { label, space, host } = fixture();
  expect(measureEdgeLabelBox(null, space)).toBeNull(); expect(measureEdgeLabelBox(label, null)).toBeNull();
  host.remove(); expect(measureEdgeLabelBox(label, space)).toBeNull();
  document.body.append(host); space.remove(); expect(measureEdgeLabelBox(label, space)).toBeNull();
  host.querySelector("svg")!.append(space);
  const foreign = document.implementation.createHTMLDocument("foreign").createElement("div");
  foreign.ownerDocument.body.append(foreign);
  expect(measureEdgeLabelBox(foreign, space)).toBeNull();
});

it("keeps missing layout/capabilities, thrown reads and malformed descendants unknown", () => {
  const { label, space, screenMatrix, bounds } = fixture();
  vi.spyOn(label, "getClientRects").mockReturnValue([] as unknown as DOMRectList);
  expect(measureEdgeLabelBox(label, space)).toBeNull();
  vi.spyOn(label, "getClientRects").mockReturnValue([rectangle()] as unknown as DOMRectList);
  screenMatrix.mockReturnValueOnce(null as unknown as DOMMatrix);
  expect(measureEdgeLabelBox(label, space)).toBeNull();
  screenMatrix.mockImplementationOnce(() => { throw new Error("unsupported"); });
  expect(measureEdgeLabelBox(label, space)).toBeNull();
  const child = document.createElement("small"); label.append(child);
  vi.spyOn(child, "getBoundingClientRect").mockReturnValue(rectangle(NaN));
  expect(measureEdgeLabelBox(label, space)).toBeNull(); child.remove();
  bounds.mockImplementationOnce(() => { throw new Error("portal unavailable"); });
  expect(measureEdgeLabelBox(label, space)).toBeNull();
  Object.defineProperty(space, "getScreenCTM", { value: undefined });
  expect(measureEdgeLabelBox(label, space)).toBeNull();
});

it("rejects mapping changes, mid-read detach and pending font layout", () => {
  const { label, space, bounds, screenMatrix } = fixture();
  screenMatrix.mockReturnValueOnce(identity as DOMMatrix).mockReturnValueOnce({ ...identity, e: 100 } as DOMMatrix);
  expect(measureEdgeLabelBox(label, space)).toBeNull();
  bounds.mockImplementationOnce(() => { label.remove(); return rectangle(); });
  expect(measureEdgeLabelBox(label, space)).toBeNull(); document.body.append(label);
  const fonts = { status: "loading" };
  Object.defineProperty(document, "fonts", { configurable: true, get: () => fonts });
  expect(measureEdgeLabelBox(label, space)).toBeNull();
  fonts.status = "loaded"; expect(measureEdgeLabelBox(label, space)).not.toBeNull();
  bounds.mockImplementationOnce(() => { fonts.status = "loading"; return rectangle(); });
  expect(measureEdgeLabelBox(label, space)).toBeNull();
});

it.each([Number.MIN_VALUE, Number.MAX_VALUE])("rejects nonfinite or collapsed inverse-projected boxes at scale %s", (scale) => {
  const { label, space } = fixture({ ...identity, a: scale, d: scale, e: -Number.MAX_VALUE });
  expect(measureEdgeLabelBox(label, space)).toBeNull();
});

it("reads offscreen labels without clipping to a viewport and rejects lost transforms on the final read", () => {
  const { label, space, bounds, screenMatrix } = fixture();
  bounds.mockReturnValue(rectangle(-100000, 100000, 500, 20));
  expect(measureEdgeLabelBox(label, space)).toEqual({ x: -100000, y: 100000, width: 500, height: 20 });
  screenMatrix.mockReturnValueOnce(identity as DOMMatrix).mockReturnValueOnce(null as unknown as DOMMatrix);
  expect(measureEdgeLabelBox(label, space)).toBeNull();
});

it("rejects a label adopted into another connected document during a read", () => {
  const { label, space, bounds } = fixture();
  const foreign = document.implementation.createHTMLDocument("foreign");
  bounds.mockImplementationOnce(() => { foreign.body.append(foreign.adoptNode(label)); return rectangle(); });
  expect(measureEdgeLabelBox(label, space)).toBeNull();
});

it("feeds numeric label boxes through the lifetime owner without making unknown routes excludable", () => {
  const { label, space } = fixture();
  const scope = { projectId: "p", workspaceMode: "relationships" as const, flowId: null, focusedFrameId: null };
  const store = createEdgeFootprintStore(), context = { scope, resetKey: "doc" };
  store.commit({ ...context, edges: [{ id: "edge", geometryKey: 1 }] });
  const ticket = store.beginMeasurement({ ...context, id: "edge", geometryKey: 1 })!;
  const measured = measureEdgeLabelBox(label, space)!;
  expect(store.publish(ticket, { id: "edge", routeBounds: null, label: { kind: "measured", bounds: measured } })).toBe(true);
  const result = queryViewportEdgeEligibility({ ...store.read()!, viewport: { x: 0, y: 0, width: 100, height: 100, zoom: 1 } });
  expect([...result.eligibleIds]).toEqual(["edge"]); expect([...result.unknownGeometryIds]).toEqual(["edge"]);
  store.commit({ ...context, edges: [{ id: "edge", geometryKey: 2 }] });
  expect(store.publish(ticket, { id: "edge", label: { kind: "measured", bounds: measured } })).toBe(false);
  expect(store.read()!.edges[0]!.label.kind).toBe("unknown");
});

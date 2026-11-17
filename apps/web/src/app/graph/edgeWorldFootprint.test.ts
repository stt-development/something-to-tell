import { afterEach, expect, it, vi } from "vitest";
import { measureEdgeWorldFootprint, type EdgeWorldFootprintInputs } from "./edgeWorldFootprint";
import { measureSvgRouteGeometry } from "./svgRouteGeometryEnvelope";
import { measureClippedEdgeLabelPaint } from "./clippedEdgeLabelPaint";

vi.mock("./svgRouteGeometryEnvelope", () => ({ measureSvgRouteGeometry: vi.fn() }));
vi.mock("./clippedEdgeLabelPaint", () => ({ measureClippedEdgeLabelPaint: vi.fn() }));
const matrix = { a: 2, b: 0, c: 0, d: 2, e: 40, f: 60 };
const supported = { filter: "none", perspective: "none", animationName: "none", transitionDuration: "0s", boxShadow: "none",
  outlineStyle: "none", backgroundImage: "none", backgroundColor: "rgba(0, 0, 0, 0)",
  borderTopWidth: "0px", borderRightWidth: "0px", borderBottomWidth: "0px", borderLeftWidth: "0px", getPropertyValue: () => "none" };
function fixture() {
  const root = document.createElement("div"), svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const world = document.createElementNS(svg.namespaceURI, "g") as SVGGElement, group = world.cloneNode() as SVGGElement;
  const route = document.createElementNS(svg.namespaceURI, "path") as SVGPathElement, hit = route.cloneNode() as SVGPathElement;
  const label = document.createElement("div"); label.setAttribute("data-narrative-edge-label", "edge");
  route.setAttribute("data-narrative-edge-route", "edge"); route.setAttribute("data-narrative-edge-label-state", "present");
  group.append(route, hit); svg.append(world, group); root.append(svg, label); document.body.append(root);
  const worldFrame = vi.fn(() => ({ ...matrix })), localFrame = vi.fn(() => ({ ...matrix, a: 4, d: 6, e: 60, f: 100 }));
  Object.defineProperty(world, "getScreenCTM", { value: worldFrame });
  for (const child of [route, hit]) Object.defineProperty(child, "getScreenCTM", { value: localFrame, configurable: true });
  vi.spyOn(window, "getComputedStyle").mockReturnValue(supported as unknown as CSSStyleDeclaration);
  vi.mocked(measureSvgRouteGeometry).mockReturnValue({ coordinateSpace: "route-local", coverage: "geometry-stroke-hit-updater",
    complete: false, bounds: { x: 0, y: 0, width: 100, height: 20 } });
  vi.mocked(measureClippedEdgeLabelPaint).mockReturnValue({ kind: "measured", bounds: { x: 1000, y: 20, width: 100, height: 30 } });
  const markerOutset = vi.fn<EdgeWorldFootprintInputs["markerOutset"]>(() => ({ kind: "none" }));
  const input: EdgeWorldFootprintInputs = { id: "edge", root, worldSpace: world, route, label, labelAbsent: false, markerOutset };
  return { input, root, world, group, route, hit, label, worldFrame, localFrame, markerOutset };
}
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.clearAllMocks(); });

it("composes all shape markers in the actual local/world frames with outward rounding", () => {
  const { input, markerOutset, route, hit, world, label } = fixture();
  markerOutset.mockReturnValueOnce({ kind: "bounded", coordinateSpace: "owner-local", radius: 2 })
    .mockReturnValueOnce({ kind: "bounded", coordinateSpace: "owner-local", radius: 5 });
  const before = input.root.innerHTML, result = measureEdgeWorldFootprint(input), box = result.routeBounds!;
  expect(markerOutset.mock.calls.map(([shape]) => shape)).toEqual([route, hit]);
  // Local [-5,-5,105,25] maps to world [0,5,220,95], then expands outwards.
  expect(box.x).toBeLessThan(0); expect(box.y).toBeLessThan(5);
  expect(box.x + box.width).toBeGreaterThan(220); expect(box.y + box.height).toBeGreaterThan(95);
  expect(box.width).toBeLessThan(222); expect(box.height).toBeLessThan(92);
  expect(measureClippedEdgeLabelPaint).toHaveBeenCalledWith(label, world);
  expect(result.label.kind).toBe("measured"); expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(box)).toBe(true);
  expect(input.root.innerHTML).toBe(before);
});

it.each([NaN, Infinity, -1])("rejects invalid delegated marker radius %s", (radius) => {
  const { input, markerOutset } = fixture(); markerOutset.mockReturnValue({ kind: "bounded", coordinateSpace: "owner-local", radius });
  expect(measureEdgeWorldFootprint(input).routeBounds).toBeNull();
});

it("keeps partial route/marker coverage unknown independently of supported labels", () => {
  const { input, markerOutset } = fixture(); markerOutset.mockReturnValue({ kind: "unknown" });
  expect(measureEdgeWorldFootprint(input)).toMatchObject({ routeBounds: null, label: { kind: "measured" } });
  vi.mocked(measureSvgRouteGeometry).mockReturnValue(null); markerOutset.mockClear();
  expect(measureEdgeWorldFootprint(input).routeBounds).toBeNull(); expect(markerOutset).not.toHaveBeenCalled();
});

it("distinguishes actual absence, missing portals and unproven composite paint", () => {
  const { input, route, label } = fixture();
  vi.mocked(measureClippedEdgeLabelPaint).mockReturnValue({ kind: "unknown" });
  expect(measureEdgeWorldFootprint(input)).toMatchObject({ routeBounds: expect.any(Object), label: { kind: "unknown" } });
  label.remove(); expect(measureEdgeWorldFootprint({ ...input, label: null }).label.kind).toBe("unknown");
  route.setAttribute("data-narrative-edge-label-state", "none");
  expect(measureEdgeWorldFootprint({ ...input, label: null, labelAbsent: true, worldSpace: null }).label.kind).toBe("none");
  expect(measureEdgeWorldFootprint({ ...input, label: null, labelAbsent: false }).label.kind).toBe("unknown");
});

it.each(["disconnect", "foreign-world", "wrong-id", "effect", "reflection", "rotation", "failed-native"])("rejects %s inputs", (failure) => {
  const { input, root, route, world, worldFrame } = fixture();
  if (failure === "disconnect") root.remove();
  if (failure === "foreign-world") document.body.append(world);
  if (failure === "wrong-id") route.setAttribute("data-narrative-edge-route", "other");
  if (failure === "effect") vi.mocked(window.getComputedStyle).mockReturnValue({ ...supported, filter: "blur(2px)" } as unknown as CSSStyleDeclaration);
  if (failure === "reflection") vi.mocked(window.getComputedStyle).mockReturnValue({ ...supported, getPropertyValue: () => "below" } as unknown as CSSStyleDeclaration);
  if (failure === "rotation") worldFrame.mockReturnValue({ ...matrix, b: 1 });
  if (failure === "failed-native") worldFrame.mockImplementation(() => { throw new Error("unavailable"); });
  expect(measureEdgeWorldFootprint(input)).toMatchObject({ routeBounds: null, label: { kind: "unknown" } });
});

it.each(["world-frame", "child-frame", "membership", "identity", "label", "world-effect"])("rejects %s changes during delegated reads", (change) => {
  const { input, markerOutset, group, hit, route, label, world, worldFrame } = fixture();
  markerOutset.mockImplementationOnce(() => {
    if (change === "world-frame") worldFrame.mockReturnValue({ ...matrix, e: 50 });
    if (change === "child-frame") Object.defineProperty(hit, "getScreenCTM", { value: () => ({ ...matrix, e: 99 }), configurable: true });
    if (change === "membership") group.append(document.createElementNS(route.namespaceURI, "path"));
    if (change === "identity") route.setAttribute("data-narrative-edge-route", "other");
    if (change === "label") label.remove();
    if (change === "world-effect") vi.mocked(window.getComputedStyle).mockImplementation((element) => ({ ...supported,
      filter: element === world ? "blur(2px)" : "none" }) as unknown as CSSStyleDeclaration);
    return { kind: "none" };
  });
  expect(measureEdgeWorldFootprint(input)).toMatchObject({ routeBounds: null, label: { kind: "unknown" } });
});

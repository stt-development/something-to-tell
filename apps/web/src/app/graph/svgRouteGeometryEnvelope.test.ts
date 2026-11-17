import { afterEach, expect, it, vi } from "vitest";
import { measureSvgRouteGeometry } from "./svgRouteGeometryEnvelope";

const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, is2D: true };
const style = { filter: "none", boxShadow: "none", outlineStyle: "none", animationName: "none", transitionDuration: "0s", vectorEffect: "none",
  stroke: "black", strokeWidth: "3px", strokeLinecap: "butt", strokeLinejoin: "miter", strokeMiterlimit: "4" };
const rect = (x = 0, y = 0, width = 100, height = 20) => ({ x, y, width, height }) as DOMRect;
function fixture() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"), group = document.createElementNS(svg.namespaceURI, "g");
  group.classList.add("react-flow__edge"); svg.append(group); document.body.append(svg);
  const styles = new Map<Element, Partial<typeof style>>();
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => ({ ...style, ...styles.get(element) }) as CSSStyleDeclaration);
  function shape(name: "path" | "circle", bounds = rect(), extra: Partial<typeof style> = {}) {
    const element = document.createElementNS(svg.namespaceURI, name) as SVGGeometryElement;
    const bbox = vi.fn(() => bounds), frame = vi.fn(() => ({ ...identity }));
    Object.defineProperty(element, "getBBox", { configurable: true, value: bbox });
    Object.defineProperty(element, "getScreenCTM", { configurable: true, value: frame });
    group.append(element); styles.set(element, extra); return { element, bbox, frame };
  }
  const route = shape("path");
  return { svg, group, route: route.element as SVGPathElement, bbox: route.bbox, frame: route.frame, shape, styles };
}
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

it("unions current stroke, transparent hit/hover paths and updater circles without treating markers or labels as covered", () => {
  const { route, shape, bbox, styles } = fixture();
  shape("path", rect(), { stroke: "transparent", strokeWidth: "18px", strokeLinejoin: "round" });
  shape("path", rect(), { stroke: "transparent", strokeWidth: "16px", strokeLinejoin: "round" });
  shape("circle", rect(150, 10, 36, 36), { stroke: "none", strokeWidth: "0px" });
  const result = measureSvgRouteGeometry(route)!;
  expect(result).toEqual({ coordinateSpace: "route-local", coverage: "geometry-stroke-hit-updater", complete: false,
    bounds: { x: -18, y: -18, width: 204, height: 64 } });
  expect(bbox.mock.calls.every((args) => args.length === 0)).toBe(true);
  expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.bounds)).toBe(true);
  styles.set(route, { strokeWidth: "100px" });
  expect(measureSvgRouteGeometry(route)!.bounds.x).toBe(-400); expect(result.bounds.x).toBe(-18);
});

it.each(["round", "bevel", "miter", "miter-clip"])("overbounds finite current %s joins and square caps", (join) => {
  const { route, styles } = fixture(); styles.set(route, { strokeWidth: "10px", strokeLinejoin: join, strokeLinecap: "square", strokeMiterlimit: "8" });
  expect(measureSvgRouteGeometry(route)!.bounds.x).toBe(join.startsWith("miter") ? -80 : -10);
});

it.each([
  { strokeWidth: "10%" }, { strokeWidth: "calc(1px + 1%)" }, { strokeWidth: "-2px" }, { strokeWidth: "Infinitypx" },
  { strokeLinejoin: "arcs" }, { strokeLinecap: "unknown" }, { strokeMiterlimit: "" }, { strokeMiterlimit: "0.5" },
  { strokeWidth: "1e308px", strokeMiterlimit: "4" }, { vectorEffect: "non-scaling-stroke" }, { filter: "blur(2px)" },
  { boxShadow: "0 0 10px black" }, { outlineStyle: "solid" }, { animationName: "moving" }, { transitionDuration: "0.2s" }
])("keeps unsupported CSS unknown: %o", (extra) => {
  const { route, styles } = fixture(); styles.set(route, extra); expect(measureSvgRouteGeometry(route)).toBeNull();
});

it.each([rect(NaN), rect(0, 0, -1), rect(0, Infinity), rect(Number.MAX_VALUE, 0, Number.MAX_VALUE), rect(Number.MAX_VALUE, 0, 0, 0)])(
  "rejects invalid geometry %o", (value) => {
    const { route, bbox } = fixture(); bbox.mockReturnValue(value); expect(measureSvgRouteGeometry(route)).toBeNull();
  }
);

it("accepts zero-size line geometry with zero stroke width but rejects unknown shapes or animated descendants", () => {
  const { route, bbox, styles, group } = fixture(); bbox.mockReturnValue(rect(0, 0, 100, 0)); styles.set(route, { stroke: "none", strokeWidth: "0px" });
  expect(measureSvgRouteGeometry(route)!.bounds).toEqual({ x: 0, y: 0, width: 100, height: 0 });
  const title = document.createElementNS(route.namespaceURI, "title"); route.append(title); expect(measureSvgRouteGeometry(route)).not.toBeNull();
  const animation = document.createElementNS(route.namespaceURI, "animate"); route.append(animation); expect(measureSvgRouteGeometry(route)).toBeNull(); animation.remove();
  group.append(document.createElementNS(route.namespaceURI, "text")); expect(measureSvgRouteGeometry(route)).toBeNull();
});

it("requires current connected same-frame shapes and rejects changed transforms or replaced children", () => {
  const { route, shape, bbox, frame, group } = fixture(); const hit = shape("path");
  hit.frame.mockReturnValueOnce({ ...identity, e: 100 }); expect(measureSvgRouteGeometry(route)).toBeNull();
  frame.mockReturnValueOnce({ ...identity, b: 1 }); expect(measureSvgRouteGeometry(route)).toBeNull();
  frame.mockReturnValueOnce({ ...identity, a: 0 }); expect(measureSvgRouteGeometry(route)).toBeNull();
  frame.mockReturnValueOnce({ ...identity, is2D: false }); expect(measureSvgRouteGeometry(route)).toBeNull();
  bbox.mockImplementationOnce(() => { hit.element.remove(); return rect(); }); expect(measureSvgRouteGeometry(route)).toBeNull();
  bbox.mockImplementationOnce(() => { group.remove(); return rect(); }); expect(measureSvgRouteGeometry(route)).toBeNull();
  expect(measureSvgRouteGeometry(null)).toBeNull();
});

it("returns unknown on missing APIs, group effects and thrown native reads", () => {
  const { route, styles, group, bbox } = fixture();
  styles.set(group, { filter: "drop-shadow(2px 2px black)" }); expect(measureSvgRouteGeometry(route)).toBeNull(); styles.delete(group);
  bbox.mockImplementationOnce(() => { throw new Error("native unavailable"); }); expect(measureSvgRouteGeometry(route)).toBeNull();
  Object.defineProperty(route, "getBBox", { value: undefined }); expect(measureSvgRouteGeometry(route)).toBeNull();
});

it("includes non-painted stroke geometry because SVG hit testing can still use its width", () => {
  const { route, styles } = fixture(); styles.set(route, { stroke: "none", strokeWidth: "20px", strokeLinejoin: "round" });
  expect(measureSvgRouteGeometry(route)!.bounds).toEqual({ x: -20, y: -20, width: 140, height: 60 });
});

it("rejects stroke styles that change during the native geometry read", () => {
  const { route, bbox, styles } = fixture();
  bbox.mockImplementationOnce(() => { styles.set(route, { strokeWidth: "100px" }); return rect(); });
  expect(measureSvgRouteGeometry(route)).toBeNull();
});

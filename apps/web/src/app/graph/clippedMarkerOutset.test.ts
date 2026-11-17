import { afterEach, expect, it, vi } from "vitest";
import { measureClippedMarkerOutset } from "./clippedMarkerOutset";

const style = { filter: "none", transform: "none", boxShadow: "none", outlineStyle: "none", animationName: "none",
  transitionDuration: "0s", overflowX: "hidden", overflowY: "hidden", vectorEffect: "none", strokeWidth: "3px",
  scale: "none", rotate: "none", translate: "none", offsetPath: "none", perspective: "none", zoom: "1" };
function fixture() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const marker = document.createElementNS(svg.namespaceURI, "marker") as SVGMarkerElement;
  const owner = document.createElementNS(svg.namespaceURI, "path") as SVGPathElement;
  const arrow = document.createElementNS(svg.namespaceURI, "polyline"); arrow.classList.add("arrowclosed");
  marker.classList.add("react-flow__arrowhead"); marker.append(arrow); svg.append(marker, owner); document.body.append(svg);
  const number = (value: number) => ({ baseVal: { value, unitType: 1 }, animVal: { value, unitType: 1 } });
  const values = { markerWidth: number(12.5), markerHeight: number(12.5), refX: number(0), refY: number(0),
    markerUnits: { baseVal: 2, animVal: 2 }, viewBox: { baseVal: { x: -10, y: -10, width: 20, height: 20 }, animVal: { x: -10, y: -10, width: 20, height: 20 } },
    preserveAspectRatio: { baseVal: { align: 6, meetOrSlice: 1 }, animVal: { align: 6, meetOrSlice: 1 } } };
  for (const [key, value] of Object.entries(values)) Object.defineProperty(marker, key, { configurable: true, value });
  const styles = new Map<Element, Partial<typeof style>>();
  // Minimal unit seam; native cases exercise the real CSSStyleDeclaration implementation.
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => ({ ...style, ...styles.get(element), getPropertyValue: () => "none" }) as unknown as CSSStyleDeclaration);
  return { svg, marker, owner, arrow, values, styles };
}
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

it("returns frozen owner-local rotation-independent bounds from current dimensions and stroke width", () => {
  const { marker, owner, styles, values } = fixture(), first = measureClippedMarkerOutset(marker, owner);
  expect(first).toEqual({ kind: "bounded", coordinateSpace: "owner-local", radius: Math.hypot(12.5, 12.5) * 3 });
  expect(Object.isFrozen(first)).toBe(true);
  styles.set(owner, { strokeWidth: "6px" }); expect(measureClippedMarkerOutset(marker, owner)).toMatchObject({ radius: Math.hypot(12.5, 12.5) * 6 });
  values.markerUnits.baseVal = values.markerUnits.animVal = 1;
  expect(measureClippedMarkerOutset(marker, owner)).toMatchObject({ radius: Math.hypot(12.5, 12.5) });
  expect(first).toMatchObject({ radius: Math.hypot(12.5, 12.5) * 3 });
});

it.each([
  { overflowX: "visible" }, { overflowY: "visible" }, { filter: "blur(2px)" }, { transform: "scale(2)" },
  { boxShadow: "0 0 2px black" }, { outlineStyle: "solid" }, { animationName: "moving" }, { transitionDuration: "0.2s" },
  { scale: "2" }, { rotate: "45deg" }, { translate: "10px" }, { offsetPath: 'path("M0 0L10 10")' }, { perspective: "100px" }, { zoom: "2" }
])("keeps unsupported marker effects unknown: %o", (extra) => {
  const { marker, owner, styles } = fixture(); styles.set(marker, extra); expect(measureClippedMarkerOutset(marker, owner).kind).toBe("unknown");
});

it.each([{ vectorEffect: "non-scaling-stroke" }, { strokeWidth: "10%" }, { strokeWidth: "-3px" }, { strokeWidth: "Infinitypx" },
  { animationName: "moving" }, { transitionDuration: "0.2s" }])("rejects unsupported owner sizing %o", (extra) => {
  const { marker, owner, styles } = fixture(); styles.set(owner, extra); expect(measureClippedMarkerOutset(marker, owner).kind).toBe("unknown");
});

it.each([0, -1, NaN, Infinity])("rejects invalid marker dimensions %s", (value) => {
  const { marker, owner, values } = fixture(); values.markerWidth.baseVal.value = values.markerWidth.animVal.value = value;
  expect(measureClippedMarkerOutset(marker, owner).kind).toBe("unknown");
});

it("rejects changed/animated units, viewBox, references, alignment and nonnumeric lengths", () => {
  const { marker, owner, values } = fixture();
  for (const [object, key, value] of [[values.markerUnits, "animVal", 1], [values.markerUnits, "baseVal", 0],
    [values.markerWidth.animVal, "value", 20], [values.markerWidth.baseVal, "unitType", 2],
    [values.refX.baseVal, "value", 1], [values.viewBox.baseVal, "x", -20], [values.viewBox.animVal, "width", 40],
    [values.preserveAspectRatio.baseVal, "align", 1], [values.preserveAspectRatio.animVal, "meetOrSlice", 2]] as const) {
    const target = object as Record<string, number>, previous = target[key]!; target[key] = value;
    expect(measureClippedMarkerOutset(marker, owner).kind).toBe("unknown"); target[key] = previous;
  }
});

it("rejects missing, detached, foreign or unexpected content instead of assuming absent paint", () => {
  const { marker, owner, arrow, svg } = fixture();
  expect(measureClippedMarkerOutset(null, owner).kind).toBe("unknown"); expect(measureClippedMarkerOutset(marker, null).kind).toBe("unknown");
  marker.setAttribute("transform", "translate(0)"); expect(measureClippedMarkerOutset(marker, owner).kind).toBe("unknown"); marker.removeAttribute("transform");
  arrow.append(document.createElementNS(svg.namespaceURI, "animate")); expect(measureClippedMarkerOutset(marker, owner).kind).toBe("unknown"); arrow.replaceChildren();
  marker.remove(); expect(measureClippedMarkerOutset(marker, owner).kind).toBe("unknown"); svg.append(marker);
  const foreign = document.implementation.createHTMLDocument("foreign"); foreign.body.append(foreign.adoptNode(owner));
  expect(measureClippedMarkerOutset(marker, owner).kind).toBe("unknown");
});

it("rechecks native state, handles missing APIs and rejects overflow rather than caching stale bounds", () => {
  const { marker, owner, values, styles } = fixture();
  const get = vi.mocked(window.getComputedStyle), original = get.getMockImplementation()!; let reads = 0;
  get.mockImplementation((element) => { if (++reads === 3) styles.set(owner, { strokeWidth: "5px" }); return original(element); });
  expect(measureClippedMarkerOutset(marker, owner).kind).toBe("unknown"); get.mockImplementation(original);
  values.markerWidth.baseVal.value = values.markerWidth.animVal.value = Number.MAX_VALUE;
  expect(measureClippedMarkerOutset(marker, owner).kind).toBe("unknown");
  Object.defineProperty(marker, "viewBox", { value: undefined }); expect(measureClippedMarkerOutset(marker, owner).kind).toBe("unknown");
});

it("supports a zero stroke factor but rejects underflow of a positive marker size", () => {
  const { marker, owner, styles, values } = fixture(); styles.set(owner, { strokeWidth: "0px" });
  expect(measureClippedMarkerOutset(marker, owner)).toMatchObject({ kind: "bounded", radius: 0 });
  values.markerWidth.baseVal.value = values.markerWidth.animVal.value = Number.MIN_VALUE;
  values.markerHeight.baseVal.value = values.markerHeight.animVal.value = Number.MIN_VALUE;
  styles.set(owner, { strokeWidth: "0.01px" }); expect(measureClippedMarkerOutset(marker, owner).kind).toBe("unknown");
});

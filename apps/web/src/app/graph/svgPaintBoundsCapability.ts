export interface SvgPaintBoundsCapability {
  readonly status: "supported" | "unsupported" | "unavailable";
  readonly checks: { readonly stroke: boolean; readonly markers: boolean; readonly interaction: boolean };
}

const MARKER_ID = "stt-svg-paint-bounds-probe-marker";
const options = (stroke: boolean, markers: boolean): SVGBoundingBoxOptions => ({ fill: true, stroke, markers, clipped: false });
const result = (status: SvgPaintBoundsCapability["status"], stroke = false, markers = false, interaction = false): SvgPaintBoundsCapability =>
  Object.freeze({ status, checks: Object.freeze({ stroke, markers, interaction }) });

function matches(actual: DOMRect, expected: readonly number[]): boolean {
  if (actual.width < 0 || actual.height < 0) return false;
  const values = [actual.x, actual.y, actual.width, actual.height];
  return values.every((value, index) => Number.isFinite(value) && Math.abs(value - expected[index]!) < 0.00001);
}

/** Stateless native-behavior probe, not a complete reader or permission to exclude an edge. */
export function probeSvgPaintBounds(document: Document): SvgPaintBoundsCapability {
  let svg: SVGSVGElement | null = null;
  try {
    if (!document.defaultView || !document.body?.isConnected || document.getElementById(MARKER_ID)) return result("unavailable");
    const make = <T extends keyof SVGElementTagNameMap>(name: T, attributes: Record<string, string>): SVGElementTagNameMap[T] => {
      const element = document.createElementNS("http://www.w3.org/2000/svg", name);
      for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
      return element;
    };
    const paint = (element: SVGElement, values: Record<string, string>) => {
      for (const [key, value] of Object.entries({ filter: "none", transform: "none", "clip-path": "none", mask: "none",
        "stroke-linecap": "butt", "stroke-linejoin": "miter", "vector-effect": "none", ...values })) element.style.setProperty(key, value, "important");
    };
    svg = make("svg", { width: "320", height: "240", viewBox: "0 0 320 240", "aria-hidden": "true", focusable: "false" });
    // Outside the observed canvas, invisible but laid out: no project or live canvas mutation.
    paint(svg, { position: "fixed", left: "0", top: "0", width: "320px", height: "240px", opacity: "0", "pointer-events": "none", display: "block" });
    const stroke = make("rect", { x: "40", y: "40", width: "80", height: "40", rx: "0", ry: "0" });
    paint(stroke, { fill: "black", stroke: "black", "stroke-width": "20px" });
    const defs = make("defs", {}), marker = make("marker", { id: MARKER_ID, markerWidth: "30", markerHeight: "30",
      markerUnits: "userSpaceOnUse", refX: "0", refY: "0", orient: "0", viewBox: "0 0 30 30" });
    paint(marker, { overflow: "visible" });
    const markerBox = make("rect", { x: "0", y: "0", width: "30", height: "30" });
    paint(markerBox, { fill: "black", stroke: "none" }); marker.append(markerBox); defs.append(marker);
    const group = make("g", {}), route = make("path", { d: "M 40 140 L 120 140" });
    paint(route, { fill: "none", stroke: "black", "stroke-width": "2px", "marker-end": `url(#${MARKER_ID})` });
    const hit = make("path", { d: "M 40 140 L 120 140" });
    paint(hit, { fill: "none", stroke: "transparent", "stroke-width": "20px" });
    const updater = make("circle", { cx: "200", cy: "140", r: "18" });
    paint(updater, { fill: "transparent", stroke: "transparent", "stroke-width": "2px" });
    group.append(route, hit, updater); svg.append(defs, stroke, group); document.body.append(svg);
    // Check both disabled and enabled flags; silently ignored dictionaries fail.
    const strokeKnown = matches(stroke.getBBox(options(false, false)), [40, 40, 80, 40])
      && matches(stroke.getBBox(options(true, false)), [30, 30, 100, 60]);
    const markersKnown = matches(route.getBBox(options(false, false)), [40, 140, 80, 0])
      && matches(route.getBBox(options(false, true)), [40, 140, 110, 30]);
    const interactionKnown = matches(group.getBBox(options(true, true)), [40, 121, 179, 49]);
    if (!svg.isConnected || svg.ownerDocument !== document || !document.body.contains(svg)) return result("unavailable");
    return result(strokeKnown && markersKnown && interactionKnown ? "supported" : "unsupported", strokeKnown, markersKnown, interactionKnown);
  } catch {
    return result("unavailable");
  } finally {
    svg?.remove();
  }
}

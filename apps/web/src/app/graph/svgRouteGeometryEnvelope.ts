export interface SvgRouteGeometryEnvelope {
  readonly coordinateSpace: "route-local";
  readonly coverage: "geometry-stroke-hit-updater";
  /** Markers, filters and HTML labels are not certified by this partial reader. */
  readonly complete: false;
  readonly bounds: Readonly<Pick<DOMRect, "x" | "y" | "width" | "height">>;
}

type Matrix = Pick<DOMMatrix, "a" | "b" | "c" | "d" | "e" | "f">;
const finite = (...values: number[]) => values.every(Number.isFinite);
function matrix(element: SVGGraphicsElement): Matrix | null {
  const value = element.getScreenCTM();
  if (!value || value.is2D === false) return null;
  const { a, b, c, d, e, f } = value;
  return finite(a, b, c, d, e, f) && a > 0 && d > 0 && b === 0 && c === 0 ? { a, b, c, d, e, f } : null;
}
const same = (a: Matrix, b: Matrix | null) => b !== null
  && a.a === b.a && a.b === b.b && a.c === b.c && a.d === b.d && a.e === b.e && a.f === b.f;
const noEffects = (style: CSSStyleDeclaration) => style.filter === "none" && style.boxShadow === "none"
  && style.outlineStyle === "none" && style.animationName === "none" && style.transitionDuration === "0s";

function padding(style: CSSStyleDeclaration): number | null {
  if (!noEffects(style) || style.vectorEffect !== "none") return null;
  // SVG stroke hit testing can apply even when stroke paint is none/transparent.
  if (!style.strokeWidth.endsWith("px") || !style.strokeWidth.slice(0, -2).trim() || !["butt", "round", "square"].includes(style.strokeLinecap)) return null;
  const width = Number(style.strokeWidth.slice(0, -2));
  if (!finite(width) || width < 0) return null;
  if (["round", "bevel"].includes(style.strokeLinejoin)) return width;
  if (!["miter", "miter-clip"].includes(style.strokeLinejoin) || !style.strokeMiterlimit.trim()) return null;
  const limit = Number(style.strokeMiterlimit), bound = width * limit;
  // Full width (not half width) deliberately overbounds caps and the limited miter tip.
  return finite(limit, bound) && limit >= 1 ? bound : null;
}

/** Current geometry/stroke envelope only. Never promotes bare getBBox data to complete edge paint. */
export function measureSvgRouteGeometry(route: SVGPathElement | null): SvgRouteGeometryEnvelope | null {
  try {
    const group = route?.parentElement;
    if (!route?.isConnected || group?.localName !== "g" || !group.classList.contains("react-flow__edge")) return null;
    const document = route.ownerDocument, window = document.defaultView;
    if (!window || !noEffects(window.getComputedStyle(group))) return null;
    const frame = matrix(route), children = [...group.children];
    if (!frame || !children.length) return null;
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const child of children) {
      if (child.namespaceURI !== "http://www.w3.org/2000/svg" || !["path", "circle"].includes(child.localName)
        || [...child.children].some((item) => item.namespaceURI !== child.namespaceURI || !["title", "desc"].includes(item.localName))) return null;
      const shape = child as SVGGeometryElement;
      if (!same(frame, matrix(shape))) return null;
      const outset = padding(window.getComputedStyle(shape));
      if (outset === null) return null;
      // Geometry-only native read is intentional: Chromium's stroke/marker options failed c1.
      const { x, y, width, height } = shape.getBBox();
      const x1 = x - outset, y1 = y - outset, x2 = x + width + outset, y2 = y + height + outset;
      if (!finite(x, y, width, height, x1, y1, x2, y2) || width < 0 || height < 0
        || (width > 0 && x + width <= x) || (height > 0 && y + height <= y)
        || (outset > 0 && (x1 >= x || y1 >= y || x2 <= x + width || y2 <= y + height))) return null;
      if (padding(window.getComputedStyle(shape)) !== outset) return null;
      left = Math.min(left, x1); top = Math.min(top, y1); right = Math.max(right, x2); bottom = Math.max(bottom, y2);
    }
    // Reject reparenting, replaced shapes and a coordinate-frame change during layout reads.
    if (!route.isConnected || route.parentElement !== group || route.ownerDocument !== document || !noEffects(window.getComputedStyle(group))
      || children.length !== group.children.length || children.some((child, index) => group.children[index] !== child || !same(frame, matrix(child as SVGGraphicsElement)))) return null;
    const width = right - left, height = bottom - top;
    if (!finite(left, top, right, bottom, width, height) || width < 0 || height < 0) return null;
    return Object.freeze({ coordinateSpace: "route-local", coverage: "geometry-stroke-hit-updater", complete: false,
      bounds: Object.freeze({ x: left, y: top, width, height }) });
  } catch {
    return null;
  }
}

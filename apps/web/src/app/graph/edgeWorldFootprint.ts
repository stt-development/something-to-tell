import { measureClippedEdgeLabelPaint } from "./clippedEdgeLabelPaint";
import { measureSvgRouteGeometry } from "./svgRouteGeometryEnvelope";
import type { SvgMarkerReferenceOutset } from "./svgMarkerReferences";
import type { ViewportEdgeFootprint } from "./viewportEdgeEligibility";
import type { WorldRectangle } from "./viewportEligibility";

type Frame = Pick<DOMMatrix, "a" | "b" | "c" | "d" | "e" | "f">;
const finite = (...values: number[]) => values.every(Number.isFinite);
function frame(element: SVGGraphicsElement): Frame | null {
  const value = element.getScreenCTM();
  if (!value || value.is2D === false) return null;
  const { a, b, c, d, e, f } = value;
  return finite(a, b, c, d, e, f) && a > 0 && d > 0 && b === 0 && c === 0 ? { a, b, c, d, e, f } : null;
}
const same = (a: Frame, b: Frame | null) => b !== null && a.a === b.a && a.b === b.b
  && a.c === b.c && a.d === b.d && a.e === b.e && a.f === b.f;

function cleanAncestry(element: Element): boolean {
  const window = element.ownerDocument.defaultView;
  if (!window) return false;
  for (let current: Element | null = element; current; current = current.parentElement) {
    const style = window.getComputedStyle(current);
    if (style.filter !== "none" || style.perspective !== "none" || style.animationName !== "none" || style.transitionDuration !== "0s"
      || !["none", ""].includes(style.getPropertyValue("-webkit-box-reflect"))) return false;
    // SVG containers belong to the edge, unlike persistent HTML canvas chrome.
    if (current.namespaceURI === "http://www.w3.org/2000/svg" && (current.localName === "svg" || current.localName === "g")
      && (style.boxShadow !== "none" || style.outlineStyle !== "none" || style.backgroundImage !== "none"
        || !["transparent", "rgba(0, 0, 0, 0)"].includes(style.backgroundColor)
        || [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].some((width) => width !== "0px"))) return false;
  }
  return true;
}

function worldBounds(bounds: WorldRectangle, radius: number, local: Frame, world: Frame): WorldRectangle | null {
  const left = ((bounds.x - radius) * local.a + local.e - world.e) / world.a;
  const top = ((bounds.y - radius) * local.d + local.f - world.f) / world.d;
  const right = ((bounds.x + bounds.width + radius) * local.a + local.e - world.e) / world.a;
  const bottom = ((bounds.y + bounds.height + radius) * local.d + local.f - world.f) / world.d;
  // Outward CSS-pixel/relative allowance covers native float rounding, never shrinks paint.
  const px = 1 / world.a + Math.max(Math.abs(left), Math.abs(right)) * 0.000001;
  const py = 1 / world.d + Math.max(Math.abs(top), Math.abs(bottom)) * 0.000001;
  const x = left - px, y = top - py, width = right + px - x, height = bottom + py - y;
  return finite(x, y, width, height, x + width, y + height) && width > 0 && height > 0
    && x < left && y < top && x + width > right && y + height > bottom ? Object.freeze({ x, y, width, height }) : null;
}

export interface EdgeWorldFootprintInputs {
  readonly id: string;
  readonly root: HTMLElement;
  /** Bridge-owned origin in React Flow's public ViewportPortal, not an arbitrary route. */
  readonly worldSpace: SVGGraphicsElement | null;
  readonly route: SVGPathElement | null;
  readonly label: HTMLElement | null;
  readonly labelAbsent: boolean;
  readonly markerOutset: (owner: SVGGeometryElement) => SvgMarkerReferenceOutset;
}

/** Composes trusted current DOM components only; never renders, retargets, schedules or persists. */
export function measureEdgeWorldFootprint({ id, root, worldSpace, route, label, labelAbsent, markerOutset }: EdgeWorldFootprintInputs): ViewportEdgeFootprint {
  // Declared label absence is independent of native SVG measurement availability.
  const absent = () => labelAbsent && label === null && root.isConnected && route?.isConnected
    && root.contains(route) && route.getAttribute("data-narrative-edge-route") === id
    && route.getAttribute("data-narrative-edge-label-state") === "none";
  const unknown = (): ViewportEdgeFootprint => Object.freeze({ id, routeBounds: null,
    label: Object.freeze({ kind: absent() ? "none" as const : "unknown" as const }) });
  try {
    if (!root.isConnected || !worldSpace?.isConnected || !route?.isConnected || !root.contains(worldSpace) || !root.contains(route)
      || root.ownerDocument !== worldSpace.ownerDocument || root.ownerDocument !== route.ownerDocument
      || route.getAttribute("data-narrative-edge-route") !== id || !cleanAncestry(route) || !cleanAncestry(worldSpace)) return unknown();
    const world = frame(worldSpace), local = frame(route), group = route.parentElement;
    if (!world || !local || !group) return unknown();
    const children = [...group.children], geometry = measureSvgRouteGeometry(route);
    let radius = 0, known = geometry !== null;
    if (known) for (const child of children) {
      const marker = markerOutset(child as SVGGeometryElement);
      if (marker.kind === "unknown") { known = false; break; }
      if (marker.kind === "bounded") {
        if (!Number.isFinite(marker.radius) || marker.radius < 0) { known = false; break; }
        radius = Math.max(radius, marker.radius);
      }
    }
    const routeBounds = known && geometry ? worldBounds(geometry.bounds, radius, local, world) : null;
    const labelState = route.getAttribute("data-narrative-edge-label-state");
    const paint = labelAbsent && label === null && labelState === "none" ? { kind: "none" as const }
      : label && root.contains(label) && label.getAttribute("data-narrative-edge-label") === id && labelState === "present"
        ? measureClippedEdgeLabelPaint(label, worldSpace) : { kind: "unknown" as const };
    if (!root.contains(route) || !root.contains(worldSpace) || route.parentElement !== group || !same(world, frame(worldSpace)) || !same(local, frame(route))
      || children.length !== group.children.length || children.some((child, index) => child !== group.children[index])
      || (known && children.some((child) => !same(local, frame(child as SVGGraphicsElement))))
      || !cleanAncestry(route) || !cleanAncestry(worldSpace) || route.getAttribute("data-narrative-edge-route") !== id
      || route.getAttribute("data-narrative-edge-label-state") !== labelState
      || (label && (!root.contains(label) || label.getAttribute("data-narrative-edge-label") !== id))) return unknown();
    return Object.freeze({ id, routeBounds, label: Object.freeze(paint) });
  } catch { return unknown(); }
}

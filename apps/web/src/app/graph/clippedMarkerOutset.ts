export type ClippedMarkerOutset =
  | { readonly kind: "unknown" }
  | { readonly kind: "bounded"; readonly coordinateSpace: "owner-local"; readonly radius: number };

const unknown = Object.freeze({ kind: "unknown" as const });
const SVG = "http://www.w3.org/2000/svg";
const finite = (...values: number[]) => values.every(Number.isFinite);
const noEffects = (style: CSSStyleDeclaration) => style.filter === "none" && style.transform === "none"
  && style.scale === "none" && style.rotate === "none" && style.translate === "none" && style.offsetPath === "none"
  && style.perspective === "none" && style.zoom === "1" && ["", "none"].includes(style.getPropertyValue("-webkit-box-reflect"))
  && style.boxShadow === "none" && style.outlineStyle === "none" && style.animationName === "none" && style.transitionDuration === "0s";

function length(value: SVGAnimatedLength): number | null {
  // SVG_LENGTHTYPE_NUMBER only; percentage/font/physical units are outside this family.
  return value.baseVal.unitType === 1 && value.animVal.unitType === 1 && finite(value.baseVal.value)
    && value.baseVal.value === value.animVal.value ? value.baseVal.value : null;
}

function radius(marker: SVGMarkerElement, owner: SVGGeometryElement): number | null {
  if (!marker.isConnected || !owner.isConnected || marker.ownerDocument !== owner.ownerDocument
    || marker.namespaceURI !== SVG || marker.localName !== "marker" || owner.namespaceURI !== SVG
    || !marker.classList.contains("react-flow__arrowhead") || marker.hasAttribute("transform")) return null;
  const window = marker.ownerDocument.defaultView;
  if (!window) return null;
  const style = window.getComputedStyle(marker), ownerStyle = window.getComputedStyle(owner);
  if (!noEffects(style) || style.overflowX !== "hidden" || style.overflowY !== "hidden"
    || ownerStyle.vectorEffect !== "none" || ownerStyle.animationName !== "none" || ownerStyle.transitionDuration !== "0s") return null;
  const children = [...marker.children];
  if (children.length !== 1 || children[0]!.namespaceURI !== SVG || children[0]!.localName !== "polyline"
    || !(children[0]!.classList.contains("arrow") || children[0]!.classList.contains("arrowclosed")) || children[0]!.children.length) return null;
  for (const box of [marker.viewBox.baseVal, marker.viewBox.animVal]) {
    if (box.x !== -10 || box.y !== -10 || box.width !== 20 || box.height !== 20) return null;
  }
  for (const aspect of [marker.preserveAspectRatio.baseVal, marker.preserveAspectRatio.animVal]) {
    // SVG_PRESERVEASPECTRATIO_XMIDYMID and SVG_MEETORSLICE_MEET keep ref=(0,0) centered.
    if (aspect.align !== 6 || aspect.meetOrSlice !== 1) return null;
  }
  const width = length(marker.markerWidth), height = length(marker.markerHeight);
  if (width === null || height === null || width <= 0 || height <= 0 || length(marker.refX) !== 0 || length(marker.refY) !== 0) return null;
  const units = marker.markerUnits.baseVal;
  if (units !== marker.markerUnits.animVal || (units !== 1 && units !== 2)) return null;
  let scale = 1; // SVG_MARKERUNITS_USERSPACEONUSE
  if (units === 2) { // SVG_MARKERUNITS_STROKEWIDTH
    const value = ownerStyle.strokeWidth;
    if (!value.endsWith("px") || !value.slice(0, -2).trim()) return null;
    scale = Number(value.slice(0, -2));
  }
  // Full diagonal deliberately overbounds the centered viewport at any orientation.
  const bound = Math.hypot(width, height) * scale;
  return finite(scale, bound) && scale >= 0 && (scale === 0 || bound > 0) ? bound : null;
}

/** Caller must resolve the marker/owner association; this does not locate references or publish a footprint. */
export function measureClippedMarkerOutset(marker: SVGMarkerElement | null, owner: SVGGeometryElement | null): ClippedMarkerOutset {
  try {
    if (!marker || !owner) return unknown;
    const before = radius(marker, owner);
    return before !== null && before === radius(marker, owner)
      ? Object.freeze({ kind: "bounded", coordinateSpace: "owner-local", radius: before }) : unknown;
  } catch {
    return unknown;
  }
}

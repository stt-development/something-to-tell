import { measureEdgeLabelBox } from "./edgeLabelDomMeasurement";
import type { ViewportEdgeLabel } from "./viewportEdgeEligibility";

const unknown = Object.freeze({ kind: "unknown" as const });
const none = (value: string) => value === "" || value === "none";

function clippedText(label: HTMLElement): boolean {
  const window = label.ownerDocument.defaultView;
  if (!window || label.namespaceURI !== "http://www.w3.org/1999/xhtml" || label.localName !== "div" || label.childElementCount !== 0 || label.isContentEditable
    || label.hasAttribute("contenteditable") || label.hasAttribute("popover")) return false;
  const style = window.getComputedStyle(label);
  // Clipping certifies glyph containment, not arbitrary decoration beyond the border.
  if (style.display !== "block" || !["normal", "none"].includes(style.content)
    || style.overflowX !== "hidden" || style.overflowY !== "hidden" || style.boxShadow !== "none"
    || style.textShadow !== "none" || style.outlineStyle !== "none" || !["0", "0px"].includes(style.borderImageOutset)
    || !none(style.backdropFilter)) return false;
  for (const pseudo of ["::before", "::after"]) {
    const content = window.getComputedStyle(label, pseudo).content;
    if (content !== "none" && content !== "normal") return false;
  }
  // An ancestor filter/reflection can expand ink after the label's own overflow clip.
  for (let element: Element | null = label; element; element = element.parentElement) {
    const current = window.getComputedStyle(element);
    if (current.filter !== "none" || current.perspective !== "none" || current.animationName !== "none"
      || current.transitionDuration !== "0s" || !none(current.getPropertyValue("-webkit-box-reflect"))) return false;
  }
  return true;
}

/** Certifies only a clipped text-only label; caller supplies an actual graph-world SVG space. */
export function measureClippedEdgeLabelPaint(label: HTMLElement | null, worldSpace: SVGGraphicsElement | null): Exclude<ViewportEdgeLabel, { kind: "none" }> {
  try {
    if (!label?.isConnected || !clippedText(label)) return unknown;
    const bounds = measureEdgeLabelBox(label, worldSpace);
    return bounds && clippedText(label) ? Object.freeze({ kind: "measured", bounds }) : unknown;
  } catch {
    return unknown;
  }
}

import type { WorldRectangle } from "./viewportEligibility";

type ScreenMatrix = Pick<DOMMatrix, "a" | "b" | "c" | "d" | "e" | "f"> & { readonly is2D?: boolean };
const finite = (...values: number[]) => values.every(Number.isFinite);
const fontsLoading = (document: Document) => document.fonts?.status === "loading";

function matrix(space: SVGGraphicsElement): ScreenMatrix | null {
  const value = space.getScreenCTM();
  if (!value || value.is2D === false) return null;
  const { a, b, c, d, e, f } = value;
  // React Flow's world space is axis-aligned. Do not guess at skewed/3D layouts.
  return finite(a, b, c, d, e, f) && a > 0 && d > 0 && b === 0 && c === 0
    ? { a, b, c, d, e, f } : null;
}
const sameMatrix = (a: ScreenMatrix, b: ScreenMatrix | null) => b !== null
  && a.a === b.a && a.b === b.b && a.c === b.c && a.d === b.d && a.e === b.e && a.f === b.f;

function box(element: Element): WorldRectangle | null {
  const { left, top, width, height } = element.getBoundingClientRect();
  return finite(left, top, width, height, left + width, top + height) && width >= 0 && height >= 0
    ? { x: left, y: top, width, height } : null;
}

/** Stateless DOM adapter: current portal layout boxes, NOT proof of complete painted edge bounds. */
export function measureEdgeLabelBox(label: HTMLElement | null, worldSpace: SVGGraphicsElement | null): WorldRectangle | null {
  try {
    if (!label?.isConnected || !worldSpace?.isConnected || label.ownerDocument !== worldSpace.ownerDocument
      || fontsLoading(label.ownerDocument) || !label.getClientRects().length) return null;
    const document = label.ownerDocument;
    const transform = matrix(worldSpace), root = box(label);
    if (!transform || !root || root.width <= 0 || root.height <= 0) return null;
    let left = root.x, top = root.y, right = left + root.width, bottom = top + root.height;
    // Story labels may have overflowing badges. A root rectangle alone can miss them.
    for (const child of label.querySelectorAll("*")) {
      const bounds = box(child);
      if (!bounds) return null;
      if (bounds.width === 0 || bounds.height === 0) continue;
      left = Math.min(left, bounds.x); top = Math.min(top, bounds.y);
      right = Math.max(right, bounds.x + bounds.width); bottom = Math.max(bottom, bounds.y + bounds.height);
    }
    // No cached camera/DOM references survive this read. Reject a moving coordinate frame.
    if (!label.isConnected || !worldSpace.isConnected || label.ownerDocument !== document
      || worldSpace.ownerDocument !== document || fontsLoading(document)
      || !sameMatrix(transform, matrix(worldSpace))) return null;
    const x = (left - transform.e) / transform.a, y = (top - transform.f) / transform.d;
    const width = (right - left) / transform.a, height = (bottom - top) / transform.d;
    if (!finite(x, y, width, height, x + width, y + height) || width <= 0 || height <= 0
      || x + width <= x || y + height <= y) return null;
    return Object.freeze({ x, y, width, height });
  } catch {
    // Missing browser capabilities and disappearing portals are unknown, not absent labels.
    return null;
  }
}

import type { FitViewOptions, Rect } from "@xyflow/react";
import policy from "../../../performance/rendering-policy.v1.json";

type Padding = NonNullable<FitViewOptions["padding"]>;
type Unit = number | `${number}px` | `${number}%`;
const GAP = 12;
export const INITIAL_CANVAS_FIT_PADDING = { left: "84px", right: "24px", top: "24px", bottom: "184px" } as const;
// Stable props must not overwrite queued programmatic Fits on workspace rerenders.
export const INITIAL_CANVAS_FIT_OPTIONS = { padding: INITIAL_CANVAS_FIT_PADDING, minZoom: policy.min_zoom, maxZoom: 1.2 } as const;

/** Matches the installed public React Flow padding units, retaining caller margins. */
function pixels(value: Unit, size: number): number {
  if (typeof value === "number") return Math.floor((size - size / (1 + value)) / 2);
  return Math.floor(parseFloat(value) * (value.endsWith("%") ? size / 100 : 1));
}

const intersects = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width
  && a.y < b.y + b.height && b.y < a.y + a.height && b.width > 0 && b.height > 0;

/** Camera padding only: current node bounds and authored positions are never inputs to mutate. */
export function canvasFitPadding(canvas: Rect, rail: Rect | null, minimap: Rect | null, padding: Padding = 0.1): Padding {
  if (![canvas.x, canvas.y, canvas.width, canvas.height].every(Number.isFinite) || canvas.width <= 0 || canvas.height <= 0) return padding;
  const sides = typeof padding === "object" ? padding : { x: padding, y: padding };
  const left = Math.max(pixels(sides.left ?? sides.x ?? 0, canvas.width), rail && intersects(canvas, rail) ? rail.x + rail.width - canvas.x + GAP : 0);
  const right = pixels(sides.right ?? sides.x ?? 0, canvas.width);
  const top = pixels(sides.top ?? sides.y ?? 0, canvas.height);
  const bottom = Math.max(pixels(sides.bottom ?? sides.y ?? 0, canvas.height), minimap && intersects(canvas, minimap) ? canvas.y + canvas.height - minimap.y + GAP : 0);
  if (left + right >= canvas.width || top + bottom >= canvas.height) return padding;
  return { left: `${left}px`, right: `${right}px`, top: `${top}px`, bottom: `${bottom}px` };
}

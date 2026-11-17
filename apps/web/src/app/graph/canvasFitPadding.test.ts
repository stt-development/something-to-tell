import { getViewportForBounds, type Rect } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { canvasFitPadding, INITIAL_CANVAS_FIT_OPTIONS } from "./canvasFitPadding";

const canvas = { x: 256, y: 56, width: 768, height: 712 };
const rail = { x: 268, y: 72, width: 52, height: 600 };
const minimap = { x: 808, y: 602, width: 200, height: 150 };

describe("overlay-aware Fit padding", () => {
  it("initial Open explicitly permits zooming out to 1% so large bounds need no manual Fit", () => {
    expect(INITIAL_CANVAS_FIT_OPTIONS.minZoom).toBe(0.01);
    const camera = getViewportForBounds({ x: -10000, y: -5000, width: 40000, height: 30000 }, 1024, 712,
      INITIAL_CANVAS_FIT_OPTIONS.minZoom, INITIAL_CANVAS_FIT_OPTIONS.maxZoom, INITIAL_CANVAS_FIT_OPTIONS.padding);
    expect(camera.zoom).toBeGreaterThanOrEqual(0.01); expect(camera.zoom).toBeLessThan(0.02);
    expect(-10000 * camera.zoom + camera.x).toBeGreaterThanOrEqual(84 - 0.01);
    expect(25000 * camera.zoom + camera.y).toBeLessThanOrEqual(712 - 184 + 0.01);
  });
  it.each([[1440, 844], [1024, 712]])("fits complete bounds clear of controls in a %sx%s canvas using the public engine", (width, height) => {
    const viewport = { x: 0, y: 56, width, height };
    const tools = { x: 12, y: 72, width: 52, height: 600 };
    const map = { x: width - 216, y: height + 56 - 166, width: 200, height: 150 };
    for (const bounds of [{ x: -900, y: -500, width: 4000, height: 500 }, { x: -400, y: 800, width: 400, height: 2400 }]) {
      const camera = getViewportForBounds(bounds, width, height, 0.01, 10, canvasFitPadding(viewport, tools, map));
      expect(bounds.x * camera.zoom + camera.x).toBeGreaterThanOrEqual(76 - 0.01);
      expect((bounds.y + bounds.height) * camera.zoom + camera.y).toBeLessThanOrEqual(map.y - viewport.y - 12 + 0.01);
    }
  });

  it("measures rail offsets relative to the shrunken canvas when Projects is open", () => {
    expect(canvasFitPadding(canvas, rail, minimap, 0)).toEqual({ left: "76px", right: "0px", top: "0px", bottom: "178px" });
  });

  it("preserves larger caller padding and mixed public pixel/percentage/ratio units", () => {
    expect(canvasFitPadding(canvas, rail, minimap, { left: "120px", right: "10%", top: 0.5, bottom: "220px" }))
      .toEqual({ left: "120px", right: "76px", top: "118px", bottom: "220px" });
  });

  it("ignores nonintersecting or hidden controls", () => {
    expect(canvasFitPadding(canvas, { ...rail, x: -300 }, { ...minimap, height: 0 }, 0))
      .toEqual({ left: "0px", right: "0px", top: "0px", bottom: "0px" });
  });

  it("falls back unchanged when geometry is unavailable or controls leave no usable area", () => {
    const padding = { x: "20px" } as const;
    for (const bad of [{ ...canvas, width: 0 }, { ...canvas, x: NaN }, { ...canvas, width: -1 }]) {
      expect(canvasFitPadding(bad, rail, minimap, padding)).toBe(padding);
    }
    expect(canvasFitPadding(canvas, { ...canvas }, minimap, padding)).toBe(padding);
    const originals: Rect[] = [structuredClone(canvas), structuredClone(rail), structuredClone(minimap)];
    canvasFitPadding(canvas, rail, minimap);
    expect([canvas, rail, minimap]).toEqual(originals);
  });
});

import { afterEach, expect, it, vi } from "vitest";
import { probeSvgPaintBounds } from "./svgPaintBoundsCapability";

const original = Object.getOwnPropertyDescriptor(SVGElement.prototype, "getBBox");
afterEach(() => {
  document.body.replaceChildren(); vi.restoreAllMocks();
  if (original) Object.defineProperty(SVGElement.prototype, "getBBox", original); else Reflect.deleteProperty(SVGElement.prototype, "getBBox");
});
const rectangle = (x: number, y: number, width: number, height: number) => ({ x, y, width, height }) as DOMRect;

// Explicit native doubles cover control flow only; separate browser tests use the real getBBox.
function native(stroke = true, markers = true, interaction = true) {
  const read = vi.fn(function(this: SVGElement, options: SVGBoundingBoxOptions) {
    if (this.localName === "rect") return options.stroke && stroke ? rectangle(30, 30, 100, 60) : rectangle(40, 40, 80, 40);
    if (this.localName === "path") return options.markers && markers ? rectangle(40, 140, 110, 30) : rectangle(40, 140, 80, 0);
    return interaction ? rectangle(40, 121, 179, 49) : rectangle(40, 122, 178, 36);
  });
  Object.defineProperty(SVGElement.prototype, "getBBox", { configurable: true, value: read });
  return read;
}

it("accepts only all behavioral checks and leaves the caller's canvas/document unchanged", () => {
  const read = native(); document.body.innerHTML = '<main id="canvas"><p>Unchanged</p></main>';
  const before = document.body.innerHTML;
  expect(probeSvgPaintBounds(document)).toEqual({ status: "supported", checks: { stroke: true, markers: true, interaction: true } });
  expect(document.body.innerHTML).toBe(before); expect(read).toHaveBeenCalledTimes(5);
  for (const [options] of read.mock.calls) expect(options).toMatchObject({ fill: true, clipped: false });
});

it.each([[false, false, false], [false, true, true], [true, false, true], [true, true, false]])(
  "rejects ignored or partial options: stroke=%s markers=%s interaction=%s", (stroke, markers, interaction) => {
    native(stroke, markers, interaction);
    expect(probeSvgPaintBounds(document)).toEqual({ status: "unsupported", checks: { stroke, markers, interaction } });
    expect(document.body.children).toHaveLength(0);
  }
);

it("does not accept an implementation which always returns expanded bounds regardless of options", () => {
  const read = native(); read.mockImplementation(function(this: SVGElement) {
    return this.localName === "rect" ? rectangle(30, 30, 100, 60) : this.localName === "path" ? rectangle(40, 140, 110, 30) : rectangle(40, 121, 179, 49);
  });
  expect(probeSvgPaintBounds(document)).toMatchObject({ status: "unsupported", checks: { stroke: false, markers: false } });
});

it.each([rectangle(NaN, 0, 1, 1), rectangle(0, 0, -1, 1), rectangle(40, 40, 80, Infinity), rectangle(40, 40, 0, 0)])(
  "does not accept malformed or zero rectangles %o", (bounds) => {
    native().mockReturnValue(bounds); expect(probeSvgPaintBounds(document).status).toBe("unsupported");
    expect(document.body.children).toHaveLength(0);
  }
);

it("cleans up missing or throwing APIs, including failure after some successful reads", () => {
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  expect(probeSvgPaintBounds(document).status).toBe("unavailable"); expect(document.body.children).toHaveLength(0);
  native().mockImplementationOnce(() => rectangle(40, 40, 80, 40)).mockImplementationOnce(() => { throw new Error("not supported"); });
  expect(probeSvgPaintBounds(document).status).toBe("unavailable"); expect(document.body.children).toHaveLength(0);
});

it("keeps inert documents and existing marker ids untouched rather than shadowing them", () => {
  const read = native(), inert = document.implementation.createHTMLDocument("inert");
  expect(probeSvgPaintBounds(inert).status).toBe("unavailable"); expect(read).not.toHaveBeenCalled();
  const marker = document.createElement("div"); marker.id = "stt-svg-paint-bounds-probe-marker"; document.body.append(marker);
  expect(probeSvgPaintBounds(document).status).toBe("unavailable"); expect(document.body.firstChild).toBe(marker);
  expect(read).not.toHaveBeenCalled();
});

it("returns only frozen capability flags, does not cache old results, and rejects mid-read detachment", () => {
  native(); const first = probeSvgPaintBounds(document);
  expect(Object.isFrozen(first)).toBe(true); expect(Object.isFrozen(first.checks)).toBe(true);
  native(false, false, false); expect(probeSvgPaintBounds(document).status).toBe("unsupported"); expect(first.status).toBe("supported");
  const read = native(); read.mockImplementationOnce(function(this: SVGElement) { this.ownerSVGElement!.remove(); return rectangle(40, 40, 80, 40); });
  expect(probeSvgPaintBounds(document).status).toBe("unavailable"); expect(document.body.children).toHaveLength(0);
});

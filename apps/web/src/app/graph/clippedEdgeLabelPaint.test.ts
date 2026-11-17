import { afterEach, expect, it, vi } from "vitest";
import { measureClippedEdgeLabelPaint } from "./clippedEdgeLabelPaint";

const defaults = { display: "block", content: "normal", overflowX: "hidden", overflowY: "hidden", boxShadow: "none", textShadow: "none", outlineStyle: "none",
  borderImageOutset: "0", backdropFilter: "none", filter: "none", perspective: "none", animationName: "none", transitionDuration: "0s" };
function fixture() {
  const root = document.createElement("div"), label = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"), space = document.createElementNS(svg.namespaceURI, "g") as SVGGElement;
  label.textContent = "Clipped text"; root.append(svg, label); svg.append(space); document.body.append(root);
  const styles = new Map<Element, Partial<typeof defaults>>(); let pseudo = "none", reflection = "none";
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, selector) => (selector ? { content: pseudo }
    : { ...defaults, ...styles.get(element), getPropertyValue: () => reflection }) as CSSStyleDeclaration);
  Object.defineProperty(space, "getScreenCTM", { value: () => ({ a: 2, b: 0, c: 0, d: 2, e: 10, f: 20 }) });
  const bounds = vi.spyOn(label, "getBoundingClientRect").mockReturnValue({ left: 110, top: 220, width: 200, height: 40 } as DOMRect);
  vi.spyOn(label, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  return { root, label, space, styles, bounds, pseudo: (value: string) => { pseudo = value; }, reflection: (value: string) => { reflection = value; } };
}
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

it("certifies clipped text with copied world bounds and never claims absent labels", () => {
  const { label, space, bounds } = fixture(), first = measureClippedEdgeLabelPaint(label, space);
  expect(first).toEqual({ kind: "measured", bounds: { x: 50, y: 100, width: 100, height: 20 } });
  expect(Object.isFrozen(first)).toBe(true); if (first.kind === "measured") expect(Object.isFrozen(first.bounds)).toBe(true);
  bounds.mockReturnValue({ left: 210, top: 220, width: 200, height: 40 } as DOMRect);
  expect(measureClippedEdgeLabelPaint(label, space)).toMatchObject({ kind: "measured", bounds: { x: 100 } });
  expect(first).toMatchObject({ kind: "measured", bounds: { x: 50 } });
});

it.each([
  { overflowX: "visible" }, { overflowY: "visible" }, { overflowX: "clip" }, { boxShadow: "0 0 10px black" },
  { textShadow: "1px 1px black" }, { outlineStyle: "solid" }, { borderImageOutset: "2" }, { backdropFilter: "blur(2px)" },
  { filter: "blur(2px)" }, { perspective: "100px" }, { animationName: "moving" }, { transitionDuration: "0.3s" },
  { display: "list-item" }, { content: 'url("image.png")' }
])("keeps unsupported root paint unknown: %o", (extra) => {
  const { label, space, styles, bounds } = fixture(); styles.set(label, extra);
  expect(measureClippedEdgeLabelPaint(label, space)).toEqual({ kind: "unknown" }); expect(bounds).not.toHaveBeenCalled();
});

it("rejects composite labels, generated pseudo content, reflection and ancestor effects", () => {
  const { root, label, space, styles, pseudo, reflection } = fixture();
  const child = document.createElement("span"); label.append(child);
  expect(measureClippedEdgeLabelPaint(label, space).kind).toBe("unknown"); child.remove();
  pseudo('"generated"'); expect(measureClippedEdgeLabelPaint(label, space).kind).toBe("unknown"); pseudo("none");
  reflection("below 10px"); expect(measureClippedEdgeLabelPaint(label, space).kind).toBe("unknown"); reflection("none");
  styles.set(root, { filter: "drop-shadow(1px 1px black)" }); expect(measureClippedEdgeLabelPaint(label, space).kind).toBe("unknown");
});

it("revalidates clipping after measurement and delegates missing, detached, failed or malformed DOM to unknown", () => {
  const { label, space, styles, bounds } = fixture();
  bounds.mockImplementationOnce(() => { styles.set(label, { overflowX: "visible" }); return { left: 0, top: 0, width: 100, height: 20 } as DOMRect; });
  expect(measureClippedEdgeLabelPaint(label, space).kind).toBe("unknown"); styles.delete(label);
  expect(measureClippedEdgeLabelPaint(null, space).kind).toBe("unknown"); expect(measureClippedEdgeLabelPaint(label, null).kind).toBe("unknown");
  bounds.mockReturnValue({ left: NaN, top: 0, width: 100, height: 20 } as DOMRect);
  expect(measureClippedEdgeLabelPaint(label, space).kind).toBe("unknown");
  bounds.mockImplementation(() => { throw new Error("native read failed"); }); expect(measureClippedEdgeLabelPaint(label, space).kind).toBe("unknown");
  label.remove(); expect(measureClippedEdgeLabelPaint(label, space).kind).toBe("unknown");
});

it("rejects editable/native controls rather than treating their special paint as plain text", () => {
  const { label, space } = fixture(); label.setAttribute("contenteditable", "true");
  expect(measureClippedEdgeLabelPaint(label, space).kind).toBe("unknown");
  label.removeAttribute("contenteditable"); label.setAttribute("popover", "");
  expect(measureClippedEdgeLabelPaint(label, space).kind).toBe("unknown"); label.removeAttribute("popover");
  Object.defineProperty(label, "isContentEditable", { value: true });
  expect(measureClippedEdgeLabelPaint(label, space).kind).toBe("unknown");
  const input = document.createElement("input"); document.body.append(input);
  expect(measureClippedEdgeLabelPaint(input, space).kind).toBe("unknown");
  const foreign = document.createElementNS("http://www.w3.org/2000/svg", "div"); document.body.append(foreign);
  expect(measureClippedEdgeLabelPaint(foreign as unknown as HTMLElement, space).kind).toBe("unknown");
});

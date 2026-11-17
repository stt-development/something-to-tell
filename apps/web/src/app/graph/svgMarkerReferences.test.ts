import { afterEach, expect, it, vi } from "vitest";
import { measureClippedMarkerOutset } from "./clippedMarkerOutset";
import { createSvgMarkerReferenceReader } from "./svgMarkerReferences";

// Isolate binding/index behavior; native cases use the real marker-outset adapter too.
vi.mock("./clippedMarkerOutset", () => ({ measureClippedMarkerOutset: vi.fn(() => ({ kind: "bounded", coordinateSpace: "owner-local", radius: 10 })) }));
function fixture(id = "marker") {
  const root = document.createElement("div"), svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const marker = document.createElementNS(svg.namespaceURI, "marker") as SVGMarkerElement;
  const owner = document.createElementNS(svg.namespaceURI, "path") as SVGPathElement;
  marker.id = id; svg.append(marker, owner); root.append(svg); document.body.append(root);
  let values = { markerStart: "none", markerMid: "none", markerEnd: `url("#${encodeURIComponent(id)}")` };
  const computed = vi.spyOn(window, "getComputedStyle").mockImplementation(() => ({ ...values }) as CSSStyleDeclaration);
  return { root, svg, marker, owner, computed, references: (extra: Partial<typeof values>) => { values = { ...values, ...extra }; } };
}
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.mocked(measureClippedMarkerOutset).mockReset();
  vi.mocked(measureClippedMarkerOutset).mockReturnValue({ kind: "bounded", coordinateSpace: "owner-local", radius: 10 }); });

it("binds all three computed properties to current owners, deduplicates a shared definition and returns immutable numeric output", () => {
  const { root, marker, owner, references } = fixture(); references({ markerStart: 'url("#marker")', markerMid: 'url("#marker")' });
  const reader = createSvgMarkerReferenceReader(root), result = reader.measure(owner);
  expect(result).toEqual({ kind: "bounded", coordinateSpace: "owner-local", radius: 10 }); expect(Object.isFrozen(result)).toBe(true);
  expect(measureClippedMarkerOutset).toHaveBeenCalledOnce(); expect(measureClippedMarkerOutset).toHaveBeenCalledWith(marker, owner);
  references({ markerStart: "none", markerMid: "none", markerEnd: "none" }); expect(reader.measure(owner)).toEqual({ kind: "none" }); reader.dispose();
});

it("uses the maximum of distinct marker radii and does not cache old measurements", () => {
  const { root, marker, owner, svg, references } = fixture(); const second = marker.cloneNode() as SVGMarkerElement; second.id = "other"; svg.append(second);
  references({ markerStart: 'url("#other")' }); const reader = createSvgMarkerReferenceReader(root);
  vi.mocked(measureClippedMarkerOutset).mockReturnValueOnce({ kind: "bounded", coordinateSpace: "owner-local", radius: 30 });
  expect(reader.measure(owner)).toMatchObject({ radius: 30 }); expect(reader.measure(owner)).toMatchObject({ radius: 10 });
  vi.mocked(measureClippedMarkerOutset).mockReturnValueOnce({ kind: "unknown" }); expect(reader.measure(owner).kind).toBe("unknown"); reader.dispose();
});

it.each(["space and # hash", 'quotes"[] punctuation', "literal%20", "a:b&c=d"])("resolves encoded ids without CSS selector interpolation: %s", (id) => {
  const { root, owner, marker } = fixture(id), reader = createSvgMarkerReferenceReader(root);
  expect(reader.measure(owner).kind).toBe("bounded"); expect(measureClippedMarkerOutset).toHaveBeenCalledWith(marker, owner); reader.dispose();
});

it.each(['url("https://invalid.example/#marker")', 'url("#missing")', 'url("#bad%zz")', "url(#marker)", "url('#marker')", 'url("#a\\b")', "", 'url("")'])(
  "keeps unsupported or missing references unknown: %s", (value) => {
    const { root, owner, references } = fixture(); references({ markerEnd: value }); const reader = createSvgMarkerReferenceReader(root);
    expect(reader.measure(owner).kind).toBe("unknown"); expect(measureClippedMarkerOutset).not.toHaveBeenCalled(); reader.dispose();
  }
);

it("rejects duplicate, out-of-scope, document-shadowed and replaced definitions", () => {
  const { root, marker, owner, svg } = fixture(); const duplicate = marker.cloneNode() as SVGMarkerElement; svg.append(duplicate);
  const ambiguous = createSvgMarkerReferenceReader(root); expect(ambiguous.measure(owner).kind).toBe("unknown"); ambiguous.dispose(); duplicate.remove();
  const reader = createSvgMarkerReferenceReader(root);
  marker.remove(); document.body.append(marker); expect(reader.measure(owner).kind).toBe("unknown"); svg.append(marker);
  const foreign = document.createElement("div"); foreign.id = marker.id; document.body.prepend(foreign);
  marker.remove(); svg.append(marker);
  expect(reader.measure(owner).kind).toBe("unknown"); foreign.remove();
  marker.replaceWith(marker.cloneNode()); expect(reader.measure(owner).kind).toBe("unknown"); reader.dispose();
});

it("revalidates changed references and detachment and terminally releases its index", () => {
  const { root, owner, computed, references } = fixture(), reader = createSvgMarkerReferenceReader(root);
  const original = computed.getMockImplementation()!; let reads = 0;
  computed.mockImplementation((element) => { if (++reads === 2) references({ markerEnd: "none" }); return original(element); });
  expect(reader.measure(owner).kind).toBe("unknown"); computed.mockImplementation(original);
  expect(reader.measure(owner).kind).toBe("none"); root.remove(); expect(reader.measure(owner).kind).toBe("unknown"); document.body.append(root);
  reader.dispose(); reader.dispose(); expect(reader.measure(owner).kind).toBe("unknown"); expect(reader.measure(null).kind).toBe("unknown");
});

it("builds one index for a pass instead of rescanning definitions for every owner", () => {
  const { root, owner, computed } = fixture(), scan = vi.spyOn(root, "querySelectorAll"), reader = createSvgMarkerReferenceReader(root);
  for (let index = 0; index < 1000; index++) expect(reader.measure(owner).kind).toBe("bounded");
  expect(scan).toHaveBeenCalledOnce(); expect(computed).toHaveBeenCalledTimes(2000);
  expect(measureClippedMarkerOutset).toHaveBeenCalledTimes(1000); reader.dispose();
});

it("requires a fresh pass for added definitions and keeps foreign owners or failed style reads unknown", () => {
  const { root, owner, marker, svg, references, computed } = fixture(), reader = createSvgMarkerReferenceReader(root);
  const late = marker.cloneNode() as SVGMarkerElement; late.id = "late"; svg.append(late); references({ markerEnd: 'url("#late")' });
  expect(reader.measure(owner).kind).toBe("unknown"); reader.dispose();
  const next = createSvgMarkerReferenceReader(root); expect(next.measure(owner).kind).toBe("bounded");
  document.body.append(owner); expect(next.measure(owner).kind).toBe("unknown");
  const foreign = document.implementation.createHTMLDocument("foreign"); foreign.body.append(foreign.adoptNode(owner));
  expect(next.measure(owner).kind).toBe("unknown"); svg.append(owner);
  computed.mockImplementationOnce(() => { throw new Error("style unavailable"); }); expect(next.measure(owner).kind).toBe("unknown"); next.dispose();
});

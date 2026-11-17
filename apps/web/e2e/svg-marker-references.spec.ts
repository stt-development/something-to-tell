import { expect, test } from "@playwright/test";
import { BaseEdge, MarkerType, ReactFlow, ReactFlowProvider } from "@xyflow/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import { build } from "vite";

let moduleUrl: string;
test.beforeAll(async () => {
  // Bundle real reference and marker-outset adapters without creating an application build/server.
  const built = await build({ configFile: false, logLevel: "silent", build: { write: false, minify: false,
    lib: { entry: fileURLToPath(new URL("../src/app/graph/svgMarkerReferences.ts", import.meta.url)), formats: ["es"] } } });
  const output = Array.isArray(built) ? built[0]! : built;
  const chunk = "output" in output ? output.output.find((item) => item.type === "chunk") : null;
  if (!chunk || chunk.type !== "chunk") throw new Error("marker_reference_bundle_missing");
  moduleUrl = `data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`;
});
const edges = [{ id: "edge", source: "a", target: "b",
  markerStart: { type: MarkerType.Arrow, color: "black", width: 8, height: 6 },
  markerEnd: { type: MarkerType.ArrowClosed, color: "#475569", width: 16, height: 9 } }];
const fixture = "<div id=\"scope\">" + renderToStaticMarkup(createElement(ReactFlowProvider, { initialEdges: edges }, createElement(ReactFlow, { nodes: [], edges })))
  + renderToStaticMarkup(createElement("svg", { width: 900, height: 600 }, createElement(BaseEdge, { id: "owner", path: "M100 100L500 300", style: { stroke: "black", strokeWidth: 3 } }))) + "</div>";

test("resolves actual CSSOM start/mid/end references and delegates to current native marker bounds", async ({ page }) => {
  await page.setContent(fixture);
  const result = await page.evaluate(async (url) => {
    const { createSvgMarkerReferenceReader } = await import(url), root = document.getElementById("scope")!, owner = document.getElementById("owner") as unknown as SVGPathElement;
    const markers = [...root.querySelectorAll("marker")];
    const small = markers.find((marker) => marker.markerWidth.baseVal.value === 8)!, large = markers.find((marker) => marker.markerWidth.baseVal.value === 16)!;
    owner.style.markerStart = `url('#${small.id}')`; owner.style.markerMid = `url('#${large.id}')`; owner.style.markerEnd = `url('#${large.id}')`;
    const before = root.innerHTML, reader = createSvgMarkerReferenceReader(root), initial = reader.measure(owner);
    const style = getComputedStyle(owner), canonical = [style.markerStart, style.markerMid, style.markerEnd];
    const unchanged = root.innerHTML === before;
    owner.style.strokeWidth = "6px"; const wider = reader.measure(owner);
    owner.style.markerStart = owner.style.markerMid = owner.style.markerEnd = "none"; const absent = reader.measure(owner);
    reader.dispose(); return { initial, wider, absent, canonical, unchanged, disposed: reader.measure(owner) };
  }, moduleUrl);
  expect(result.initial).toEqual({ kind: "bounded", coordinateSpace: "owner-local", radius: Math.hypot(16, 9) * 3 });
  expect(result.wider.radius).toBeCloseTo(result.initial.radius * 2); expect(result.absent.kind).toBe("none");
  expect(result.canonical.every((value) => value.startsWith('url("'))).toBe(true); expect(result.unchanged).toBe(true); expect(result.disposed.kind).toBe("unknown");
});

test("decodes punctuation/percent ids without selectors and rejects replaced or out-of-scope definitions", async ({ page }) => {
  await page.setContent(fixture);
  const result = await page.evaluate(async (url) => {
    const { createSvgMarkerReferenceReader } = await import(url), root = document.getElementById("scope")!, owner = document.getElementById("owner") as unknown as SVGPathElement;
    const marker = root.querySelector("marker")!, parent = marker.parentElement!; marker.id = 'marker #[] & literal% value';
    owner.style.markerEnd = `url('#${encodeURIComponent(marker.id)}')`; const reader = createSvgMarkerReferenceReader(root);
    const encoded = reader.measure(owner); document.body.append(marker); const outside = reader.measure(owner); parent.append(marker);
    marker.replaceWith(marker.cloneNode(true)); const replaced = reader.measure(owner); reader.dispose();
    return { encoded, outside, replaced };
  }, moduleUrl);
  expect(result.encoded.kind).toBe("bounded"); expect(result.outside.kind).toBe("unknown"); expect(result.replaced.kind).toBe("unknown");
});

test("rejects indexed duplicates and native document shadowing", async ({ page }) => {
  await page.setContent(fixture);
  const result = await page.evaluate(async (url) => {
    const { createSvgMarkerReferenceReader } = await import(url), root = document.getElementById("scope")!, owner = document.getElementById("owner") as unknown as SVGPathElement;
    const marker = root.querySelector("marker")!, clone = marker.cloneNode(true); owner.style.markerEnd = `url('#${marker.id}')`;
    marker.parentElement!.append(clone); const duplicateReader = createSvgMarkerReferenceReader(root), duplicate = duplicateReader.measure(owner); duplicateReader.dispose(); clone.parentNode!.removeChild(clone);
    const shadow = document.createElement("div"); shadow.id = marker.id; document.body.prepend(shadow);
    const reader = createSvgMarkerReferenceReader(root), shadowed = reader.measure(owner); reader.dispose();
    return { duplicate, shadowed };
  }, moduleUrl);
  expect(result.duplicate.kind).toBe("unknown"); expect(result.shadowed.kind).toBe("unknown");
});

import { expect, test } from "@playwright/test";
import { BaseEdge, MarkerType, ReactFlow, ReactFlowProvider } from "@xyflow/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/app/graph/clippedMarkerOutset.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const path = "M220 220L450 80L700 400";
function markup(type = MarkerType.ArrowClosed, zoom = 1) {
  // Obtain real library-generated marker definitions, not copies of their SVG implementation.
  const edges = [{ id: "edge", source: "a", target: "b", markerEnd: { type, color: "black", width: 16, height: 9 } }];
  return renderToStaticMarkup(createElement(ReactFlowProvider, { initialEdges: edges }, createElement(ReactFlow, { nodes: [], edges })))
    + `<div style="transform-origin:0 0;transform:translate(20px,30px) scale(${zoom})">`
    + renderToStaticMarkup(createElement("svg", { id: "owned-svg", xmlns: "http://www.w3.org/2000/svg", width: 900, height: 650 },
      createElement(BaseEdge, { id: "owner", path, style: { stroke: "none", strokeWidth: 3 } }))) + "</div>";
}

for (const zoom of [0.01, 1, 10]) {
  test(`bounds actual generated arrow families independently of camera scale ${zoom}`, async ({ page }) => {
    for (const type of [MarkerType.Arrow, MarkerType.ArrowClosed]) {
      await page.setContent(markup(type, zoom));
      const result = await page.evaluate(async (url) => {
        const { measureClippedMarkerOutset } = await import(url), marker = document.querySelector("marker")!, owner = document.getElementById("owner") as unknown as SVGPathElement;
        owner.setAttribute("marker-end", `url('#${marker.id}')`);
        const before = marker.outerHTML, first = measureClippedMarkerOutset(marker, owner), unchanged = marker.outerHTML === before;
        owner.style.strokeWidth = "6px"; const wider = measureClippedMarkerOutset(marker, owner);
        marker.setAttribute("markerUnits", "userSpaceOnUse"); const userSpace = measureClippedMarkerOutset(marker, owner);
        return { first, wider, userSpace, unchanged };
      }, moduleUrl);
      expect(result.first).toEqual({ kind: "bounded", coordinateSpace: "owner-local", radius: Math.hypot(16, 9) * 3 });
      expect(result.wider.radius).toBeCloseTo(result.first.radius * 2); expect(result.userSpace.radius).toBeCloseTo(Math.hypot(16, 9));
      expect(result.unchanged).toBe(true);
    }
  });
}

test("contains real clipped marker pixels at start/mid/end under arbitrary orientation and oversized child strokes", async ({ page }) => {
  await page.setContent(markup());
  const values = await page.evaluate(async (url) => {
    const { measureClippedMarkerOutset } = await import(url), marker = document.querySelector("marker")!, owner = document.getElementById("owner") as unknown as SVGPathElement;
    for (const position of ["marker-start", "marker-mid", "marker-end"]) owner.setAttribute(position, `url('#${marker.id}')`);
    (marker.firstElementChild as SVGElement).style.strokeWidth = "100px";
    const results = [];
    for (const orient of ["auto-start-reverse", "45", "190"]) {
      marker.setAttribute("orient", orient);
      const outset = measureClippedMarkerOutset(marker, owner);
      if (outset.kind !== "bounded") return [{ kind: outset.kind, painted: 0, outside: -1 }];
      const box = owner.getBBox(), radius = outset.radius, svg = document.getElementById("owned-svg")!.cloneNode(true) as unknown as SVGSVGElement;
      const defs = document.createElementNS(svg.namespaceURI, "defs"); defs.append(marker.cloneNode(true)); svg.prepend(defs);
      const image = new Image(); image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`; await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = 900; canvas.height = 650;
      const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, 900, 650).data; let painted = 0, outside = 0;
      for (let y = 0; y < 650; y++) for (let x = 0; x < 900; x++) if (pixels[(y * 900 + x) * 4 + 3]! > 0) {
        painted++; if (x + 1 < box.x - radius || y + 1 < box.y - radius || x > box.x + box.width + radius || y > box.y + box.height + radius) outside++;
      }
      results.push({ kind: outset.kind, painted, outside });
    }
    return results;
  }, moduleUrl);
  expect(values).toHaveLength(3);
  for (const value of values) { expect(value.kind).toBe("bounded"); expect(value.painted).toBeGreaterThan(1000); expect(value.outside).toBe(0); }
});

test("rejects actual visible, shifted, uncentered, percentage-unit and non-scaling definitions", async ({ page }) => {
  await page.setContent(markup());
  const result = await page.evaluate(async (url) => {
    const { measureClippedMarkerOutset } = await import(url), marker = document.querySelector("marker")!, owner = document.getElementById("owner") as unknown as SVGPathElement;
    const states = [];
    marker.style.overflow = "visible"; states.push(measureClippedMarkerOutset(marker, owner)); marker.style.overflow = "hidden";
    marker.setAttribute("refX", "1"); states.push(measureClippedMarkerOutset(marker, owner)); marker.setAttribute("refX", "0");
    marker.setAttribute("preserveAspectRatio", "none"); states.push(measureClippedMarkerOutset(marker, owner)); marker.setAttribute("preserveAspectRatio", "xMidYMid meet");
    marker.setAttribute("markerWidth", "10%"); states.push(measureClippedMarkerOutset(marker, owner)); marker.setAttribute("markerWidth", "16");
    marker.style.scale = "2"; states.push(measureClippedMarkerOutset(marker, owner)); marker.style.scale = "none";
    owner.style.vectorEffect = "non-scaling-stroke"; states.push(measureClippedMarkerOutset(marker, owner));
    return states;
  }, moduleUrl);
  expect(result).toHaveLength(6); expect(result.every((value) => value.kind === "unknown")).toBe(true);
});

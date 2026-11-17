import { expect, test } from "@playwright/test";
import { BaseEdge, getBezierPath, getSmoothStepPath, Position } from "@xyflow/react";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { flowRouteArcPath } from "../src/story-flow/workspace";

// Compile the real stateless reader; use real BaseEdge/route helpers, not copied route math.
const source = readFileSync(new URL("../src/app/graph/svgRouteGeometryEnvelope.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const coordinates = { sourceX: 120, sourceY: 300, targetX: 700, targetY: 300, sourcePosition: Position.Right, targetPosition: Position.Left };
const routes = [getBezierPath(coordinates)[0], getSmoothStepPath({ ...coordinates, targetY: 360 })[0], flowRouteArcPath(120, 300, 700, 300)[0]];
const markup = (path: string) => renderToStaticMarkup(createElement("svg", { xmlns: "http://www.w3.org/2000/svg", width: 900, height: 650 },
  createElement("g", { className: "react-flow__edge" },
    createElement(BaseEdge, { id: "route", path, style: { stroke: "black", strokeWidth: 3 } }),
    createElement("circle", { className: "react-flow__edgeupdater", cx: 760, cy: 300, r: 18, fill: "transparent", stroke: "transparent" }))));

for (const zoom of [0.01, 1, 10]) {
  test(`bounds real BaseEdge curves and current hit/updater geometry in route-local units at ${zoom} scale`, async ({ page }) => {
    const observed = [];
    for (const path of routes) {
      await page.setContent(`<style>.react-flow__edge {pointer-events:visibleStroke}.react-flow__edge-interaction {stroke-width:18px}</style><div style="transform-origin:0 0;transform:translate(50px, 20px) scale(${zoom})">${markup(path)}</div>`);
      const value = await page.evaluate(async (url) => {
        const { measureSvgRouteGeometry } = await import(url), route = document.getElementById("route") as unknown as SVGPathElement;
        const before = route.parentElement!.outerHTML, envelope = measureSvgRouteGeometry(route);
        const boxes = [...route.parentElement!.children].map((child) => {
          const { x, y, width, height } = (child as SVGGraphicsElement).getBBox(); return { x, y, width, height };
        });
        return { envelope, boxes, unchanged: route.parentElement!.outerHTML === before };
      }, moduleUrl);
      expect(value.envelope).not.toBeNull(); expect(value.envelope!.complete).toBe(false); expect(value.envelope!.coordinateSpace).toBe("route-local");
      expect(value.unchanged).toBe(true);
      for (const box of value.boxes) {
        expect(value.envelope!.bounds.x).toBeLessThanOrEqual(box.x); expect(value.envelope!.bounds.y).toBeLessThanOrEqual(box.y);
        expect(value.envelope!.bounds.x + value.envelope!.bounds.width).toBeGreaterThanOrEqual(box.x + box.width);
        expect(value.envelope!.bounds.y + value.envelope!.bounds.height).toBeGreaterThanOrEqual(box.y + box.height);
      }
      observed.push(value.envelope!.bounds);
    }
    // A raised return arc must include more than the endpoint chord at y=300.
    expect(observed[2]!.y).toBeLessThan(200);
    const changed = await page.evaluate(async (url) => {
      const { measureSvgRouteGeometry } = await import(url), route = document.getElementById("route") as unknown as SVGPathElement;
      const before = measureSvgRouteGeometry(route), hit = document.querySelector(".react-flow__edge-interaction") as SVGElement;
      hit.style.strokeWidth = "100px";
      const after = measureSvgRouteGeometry(route); hit.style.vectorEffect = "non-scaling-stroke";
      return { before, after, unsupported: measureSvgRouteGeometry(route) };
    }, moduleUrl);
    expect(changed.after!.bounds.width).toBeGreaterThan(changed.before!.bounds.width); expect(changed.unsupported).toBeNull();
  });
}

test("bounds rasterized miter/square stroke pixels without relying on native stroke options", async ({ page }) => {
  await page.setContent(markup("M 120 300 L 420 60 L 440 400"));
  const pixels = await page.evaluate(async (url) => {
    const { measureSvgRouteGeometry } = await import(url), route = document.getElementById("route") as unknown as SVGPathElement;
    route.style.strokeWidth = "20px"; route.style.strokeLinejoin = "miter"; route.style.strokeLinecap = "square"; route.style.strokeMiterlimit = "8";
    const envelope = measureSvgRouteGeometry(route)!, svg = route.ownerSVGElement!;
    const image = new Image(); image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
    await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = 900; canvas.height = 650;
    const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, 900, 650).data; let painted = 0, outside = 0;
    const { x, y, width, height } = envelope.bounds;
    for (let py = 0; py < 650; py++) for (let px = 0; px < 900; px++) if (data[(py * 900 + px) * 4 + 3]! > 0) {
      painted++; if (px + 1 < x || py + 1 < y || px > x + width || py > y + height) outside++;
    }
    return { painted, outside, envelope };
  }, moduleUrl);
  expect(pixels.painted).toBeGreaterThan(5000); expect(pixels.outside).toBe(0); expect(pixels.envelope.complete).toBe(false);
});

test("keeps unexpected SVG contents and transformed sibling geometry unknown", async ({ page }) => {
  await page.setContent(markup(routes[0]!));
  const value = await page.evaluate(async (url) => {
    const { measureSvgRouteGeometry } = await import(url), route = document.getElementById("route") as unknown as SVGPathElement;
    const hit = document.querySelector(".react-flow__edge-interaction") as SVGElement;
    hit.setAttribute("transform", "translate(10 0)"); const transformed = measureSvgRouteGeometry(route); hit.removeAttribute("transform");
    route.parentElement!.append(document.createElementNS("http://www.w3.org/2000/svg", "text"));
    return { transformed, unexpected: measureSvgRouteGeometry(route) };
  }, moduleUrl);
  expect(value.transformed).toBeNull(); expect(value.unexpected).toBeNull();
});

test("contains actual invisible stroke hit targets and updater controls", async ({ page }) => {
  await page.setContent(`<style>.react-flow__edge{pointer-events:visibleStroke}.react-flow__edge-interaction{stroke-width:18px}.react-flow__edgeupdater{pointer-events:all}</style>${markup(routes[0]!)}`);
  const result = await page.evaluate(async (url) => {
    const { measureSvgRouteGeometry } = await import(url), route = document.getElementById("route") as unknown as SVGPathElement;
    const hit = document.querySelector(".react-flow__edge-interaction") as SVGPathElement;
    const updater = document.querySelector(".react-flow__edgeupdater") as SVGCircleElement;
    const point = hit.getPointAtLength(hit.getTotalLength() / 2); point.y += 8;
    const screen = new DOMPoint(point.x, point.y).matrixTransform(hit.getScreenCTM()!);
    const center = new DOMPoint(760, 300).matrixTransform(updater.getScreenCTM()!);
    const envelope = measureSvgRouteGeometry(route)!;
    return { hitActive: document.elementFromPoint(screen.x, screen.y) === hit,
      updaterActive: document.elementFromPoint(center.x, center.y) === updater,
      strokePaint: getComputedStyle(hit).stroke, point: { x: point.x, y: point.y }, envelope };
  }, moduleUrl);
  expect(result.strokePaint).toBe("none"); expect(result.hitActive).toBe(true); expect(result.updaterActive).toBe(true);
  expect(result.envelope.bounds.x).toBeLessThanOrEqual(result.point.x);
  expect(result.envelope.bounds.y).toBeLessThanOrEqual(result.point.y);
  expect(result.envelope.bounds.x + result.envelope.bounds.width).toBeGreaterThanOrEqual(778);
  expect(result.envelope.bounds.y + result.envelope.bounds.height).toBeGreaterThanOrEqual(result.point.y);
});

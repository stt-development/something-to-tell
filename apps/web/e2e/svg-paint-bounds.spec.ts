import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Compile the real self-contained adapter; no copied probe logic, app server or project session.
const source = readFileSync(new URL("../src/app/graph/svgPaintBoundsCapability.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;

test("records actual native SVG behavior and removes every temporary probe", async ({ page, browser }, testInfo) => {
  await page.setContent('<main id="owned-canvas"><p>Unchanged</p></main>');
  const result = await page.evaluate(async (url) => {
    const { probeSvgPaintBounds } = await import(url);
    const before = document.body.innerHTML, prototype = SVGGraphicsElement.prototype, original = prototype.getBBox;
    const reads: Array<{ element: string; options: SVGBoundingBoxOptions | undefined; bounds: { x: number; y: number; width: number; height: number } }> = [];
    try {
      prototype.getBBox = function(options) {
        const bounds = original.call(this, options), { x, y, width, height } = bounds;
        reads.push({ element: this.localName, options, bounds: { x, y, width, height } });
        return bounds;
      };
      const first = probeSvgPaintBounds(document), second = probeSvgPaintBounds(document);
      return { first, second, reads, unchanged: before === document.body.innerHTML };
    } finally { prototype.getBBox = original; }
  }, moduleUrl);
  expect(["supported", "unsupported"]).toContain(result.first.status);
  expect(result.first.status === "supported").toBe(Object.values(result.first.checks).every(Boolean));
  expect(result.second).toEqual(result.first); expect(result.unchanged).toBe(true);
  expect(result.reads.length).toBeGreaterThanOrEqual(6);
  const evidence = { browser: browser.version(), ...result };
  console.log(JSON.stringify(evidence));
  await testInfo.attach("native-svg-paint-bounds", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
});

test("refuses a native method wrapper which silently ignores options", async ({ page }) => {
  const result = await page.evaluate(async (url) => {
    const { probeSvgPaintBounds } = await import(url), prototype = SVGGraphicsElement.prototype, original = prototype.getBBox;
    const before = document.body.innerHTML;
    try {
      prototype.getBBox = function() { return original.call(this); };
      return { capability: probeSvgPaintBounds(document), unchanged: before === document.body.innerHTML };
    } finally { prototype.getBBox = original; }
  }, moduleUrl);
  expect(result.capability).toEqual({ status: "unsupported", checks: { stroke: false, markers: false, interaction: false } });
  expect(result.unchanged).toBe(true);
});

test("cleans up thrown native reads without leaving a marker or SVG behind", async ({ page }) => {
  const result = await page.evaluate(async (url) => {
    const { probeSvgPaintBounds } = await import(url), prototype = SVGGraphicsElement.prototype, original = prototype.getBBox;
    const before = document.body.innerHTML;
    try {
      prototype.getBBox = function() { throw new Error("forced unsupported capability"); };
      return { capability: probeSvgPaintBounds(document), unchanged: before === document.body.innerHTML };
    } finally { prototype.getBBox = original; }
  }, moduleUrl);
  expect(result.capability.status).toBe("unavailable"); expect(result.unchanged).toBe(true);
});

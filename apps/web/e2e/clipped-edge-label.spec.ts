import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const css = readFileSync(new URL("../src/styles/story-flow.css", import.meta.url), "utf8");
let moduleUrl: string;
test.beforeAll(async () => {
  // Bundle the actual adapter and its DOM reader in memory, without app/runtime servers.
  const built = await build({ configFile: false, logLevel: "silent", build: { write: false, minify: false,
    lib: { entry: fileURLToPath(new URL("../src/app/graph/clippedEdgeLabelPaint.ts", import.meta.url)), formats: ["es"] } } });
  const output = Array.isArray(built) ? built[0]! : built;
  const chunk = "output" in output ? output.output.find((item) => item.type === "chunk") : null;
  if (!chunk || chunk.type !== "chunk") throw new Error("label_adapter_bundle_missing");
  moduleUrl = `data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`;
});
const text = "Clipped overhanging italic \u00c5gjQ text ".repeat(20);

for (const zoom of [0.01, 1, 10]) {
  test(`certifies actual relationship CSS in a separate portal at ${zoom} scale`, async ({ page }) => {
    await page.setContent(`<style>${css} body{margin:0}.viewport{position:relative;transform-origin:0 0;transform:translate(50px,40px) scale(${zoom})}svg,.portal{position:absolute;left:0;top:0}</style>
      <div class="viewport"><svg width="900" height="600"><g id="world"></g></svg><div class="portal"><div id="label" class="relationship-edge-label" style="left:0;top:0;transform:translate(-50%,-50%) translate(400px,200px);font-style:italic">${text}</div></div></div>`);
    const result = await page.evaluate(async (url) => {
      await document.fonts.ready;
      const { measureClippedEdgeLabelPaint } = await import(url), label = document.getElementById("label")!, world = document.getElementById("world");
      const before = document.body.innerHTML;
      return { paint: measureClippedEdgeLabelPaint(label, world), unchanged: before === document.body.innerHTML, clipped: label.scrollWidth > label.clientWidth };
    }, moduleUrl);
    expect(result.paint.kind).toBe("measured"); expect(result.unchanged).toBe(true); expect(result.clipped).toBe(true);
    expect(result.paint.bounds.x + result.paint.bounds.width / 2).toBeCloseTo(400, 1);
    expect(result.paint.bounds.y + result.paint.bounds.height / 2).toBeCloseTo(200, 1);
  });
}

test("contains rasterized clipped italic text paint, border and background", async ({ page }) => {
  await page.setContent(`<style>body{margin:0}</style><svg xmlns="http://www.w3.org/2000/svg" width="600" height="160"><style>${css}</style><g id="world"></g>
    <foreignObject x="0" y="0" width="600" height="160"><div xmlns="http://www.w3.org/1999/xhtml" id="label" class="relationship-edge-label" style="left:100px;top:60px;font-family:Arial;font-style:italic">${text}</div></foreignObject></svg>`);
  const pixels = await page.evaluate(async (url) => {
    await document.fonts.ready;
    const { measureClippedEdgeLabelPaint } = await import(url), paint = measureClippedEdgeLabelPaint(document.getElementById("label"), document.getElementById("world"));
    if (paint.kind !== "measured") return { measured: false, painted: 0, outside: -1 };
    const svg = document.querySelector("svg")!, image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = 600; canvas.height = 160;
    const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, 600, 160).data; let painted = 0, outside = 0;
    const { x, y, width, height } = paint.bounds;
    for (let py = 0; py < 160; py++) for (let px = 0; px < 600; px++) if (data[(py * 600 + px) * 4 + 3]! > 0) {
      painted++; if (px + 1 < x || py + 1 < y || px > x + width || py > y + height) outside++;
    }
    return { measured: true, painted, outside };
  }, moduleUrl);
  expect(pixels.measured).toBe(true); expect(pixels.painted).toBeGreaterThan(1000); expect(pixels.outside).toBe(0);
});

test("keeps real Story labels, shadows, pseudo content and ancestor effects unknown", async ({ page }) => {
  await page.setContent(`<style>${css}</style><div id="root"><svg><g id="world"></g></svg><div id="label" class="relationship-edge-label">Text</div><div id="story" class="story-flow-edge-label"><span>Story</span><small>Default</small></div></div>`);
  const result = await page.evaluate(async (url) => {
    const { measureClippedEdgeLabelPaint } = await import(url), label = document.getElementById("label")!, world = document.getElementById("world");
    const initial = measureClippedEdgeLabelPaint(label, world);
    label.style.boxShadow = "0 0 10px black"; const shadow = measureClippedEdgeLabelPaint(label, world); label.style.boxShadow = "none";
    const style = document.createElement("style"); style.textContent = '#label::after{content:"generated";position:fixed}'; document.head.append(style);
    const pseudo = measureClippedEdgeLabelPaint(label, world); style.remove();
    document.getElementById("root")!.style.filter = "blur(2px)"; const ancestor = measureClippedEdgeLabelPaint(label, world);
    return { initial, shadow, pseudo, ancestor, story: measureClippedEdgeLabelPaint(document.getElementById("story"), world) };
  }, moduleUrl);
  expect(result.initial.kind).toBe("measured");
  for (const value of [result.shadow, result.pseudo, result.ancestor, result.story]) expect(value.kind).toBe("unknown");
});

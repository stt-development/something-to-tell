import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { build } from "vite";

let moduleUrl: string, css: string;
test.beforeAll(async () => {
  const built = await build({ configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": '"production"' }, esbuild: { jsx: "automatic" },
    build: { write: false, minify: false, lib: { entry: fileURLToPath(new URL("./minimapFixture.tsx", import.meta.url)), formats: ["es"] } } });
  const output = Array.isArray(built) ? built[0]! : built;
  const chunk = "output" in output ? output.output.find((item) => item.type === "chunk") : null;
  const styles = "output" in output ? output.output.find((item) => item.type === "asset" && item.fileName.endsWith(".css")) : null;
  if (!chunk || chunk.type !== "chunk" || !styles || styles.type !== "asset" || typeof styles.source !== "string") throw Error("minimap_fixture_missing");
  moduleUrl = `data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`; css = styles.source;
});
for (const width of [1440, 1024]) for (const zoom of [0.01, 1, 10]) test(`native MiniMap inverse/drag at ${zoom} in ${width}px`, async ({ page }) => {
  const height = width === 1440 ? 900 : 768; await page.setViewportSize({ width, height });
  await page.setContent(`<style>${css}</style>`);
  await page.evaluate(async ({ url, zoom }) => { (window as any).miniFixture = (await import(url)).mount(zoom); }, { url: moduleUrl, zoom });
  await expect.poll(() => page.evaluate(() => (window as any).miniFixture.ready())).toBe(true);
  const surface = page.locator(".bounded-minimap-surface"); await expect(surface).toHaveAttribute("data-minimap-nodes", "1001");
  const before = await page.evaluate(() => JSON.stringify((window as any).miniFixture.nodes()));
  const pixelCount = await page.locator(".bounded-minimap canvas").evaluate((element: HTMLCanvasElement) => {
    const bytes = element.getContext("2d")!.getImageData(0, 0, element.width, element.height).data;
    let count = 0; for (let i = 3; i < bytes.length; i += 4) if (bytes[i]) count++; return count;
  });
  expect(pixelCount).toBeGreaterThan(0);
  const selectedPixels = await page.locator(".bounded-minimap canvas").evaluate((element: HTMLCanvasElement) => {
    const bytes = element.getContext("2d")!.getImageData(0, 0, element.width, element.height).data;
    let count = 0; for (let i = 0; i < bytes.length; i += 4) if (bytes[i] === 15 && bytes[i + 1] === 118 && bytes[i + 2] === 110 && bytes[i + 3] === 255) count++;
    return count;
  });
  expect(selectedPixels).toBeGreaterThan(0);
  expect(await surface.evaluate((element) => element.querySelectorAll("*").length)).toBe(3);
  const box = (await surface.boundingBox())!;
  // Exact full domain [-1000,-500,11500,10800], not snapped to occupancy cells.
  const scale = Math.min(184 / 11500, 134 / 10800), offsetX = (200 - 11500 * scale) / 2 + 1000 * scale,
    offsetY = (150 - 10800 * scale) / 2 + 500 * scale;
  const verifyCenter = async (x: number, y: number) => {
    await expect.poll(async () => {
      const camera = await page.evaluate(() => (window as any).miniFixture.viewport());
      return Math.abs((width / 2 - camera.x) / camera.zoom - (x - offsetX) / scale)
        + Math.abs((height / 2 - camera.y) / camera.zoom - (y - offsetY) / scale);
    }).toBeLessThan(0.001);
  };
  await surface.click({ position: { x: 175, y: 120 } }); await verifyCenter(175, 120);
  await page.mouse.move(box.x + 175, box.y + 120); await page.mouse.down();
  await page.mouse.move(box.x + 31, box.y + 22, { steps: 8 }); await page.mouse.up(); await verifyCenter(31, 22);
  const old = await page.evaluate(() => (window as any).miniFixture.viewport()); await surface.press("ArrowRight");
  await expect.poll(async () => (await page.evaluate(() => (window as any).miniFixture.viewport())).x).toBeCloseTo(old.x - width * 0.2);
  expect(await page.evaluate(() => JSON.stringify((window as any).miniFixture.nodes()))).toBe(before);
  expect(await page.locator(".react-flow__minimap-node").count()).toBe(0);
  if (zoom === 1) await page.screenshot({ path: test.info().outputPath(`stt-minimap-${width}.png`) });
  await page.evaluate(() => (window as any).miniFixture.rollback());
  await expect(page.locator(".react-flow__minimap-node")).toHaveCount(1001);
  await page.evaluate(() => (window as any).miniFixture.dispose()); await expect(page.locator(".react-flow")).toHaveCount(0);
});

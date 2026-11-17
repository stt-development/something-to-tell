import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { build } from "vite";

let moduleUrl: string, css: string;
test.beforeAll(async () => {
  // Actual app styles including Tailwind reset/sr-only, compiled in-memory with this owned entry.
  const built = await build({ configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": '"production"' }, esbuild: { jsx: "automatic" },
    build: { write: false, minify: false, lib: { entry: fileURLToPath(new URL("./nodeDetailFixture.tsx", import.meta.url)), formats: ["es"] } } });
  const output = Array.isArray(built) ? built[0]! : built;
  const chunk = "output" in output ? output.output.find((item) => item.type === "chunk") : null;
  const styles = "output" in output ? output.output.find((item) => item.type === "asset" && item.fileName.endsWith(".css")) : null;
  if (!chunk || chunk.type !== "chunk") throw Error("node_detail_fixture_bundle_missing");
  moduleUrl = `data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`;
  if (!styles || styles.type !== "asset" || typeof styles.source !== "string") throw Error("node_detail_fixture_styles_missing");
  css = styles.source;
});
for (const width of [1440, 1024]) for (const zoom of [0.01, 1, 10]) test(`retains native card/port geometry at ${zoom} in ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 1440 ? 900 : 768 });
  await page.setContent(`<style>${css}</style>`);
  await page.evaluate(async ({ url, zoom }) => { (window as any).detailFixture = (await import(url)).mount(zoom); }, { url: moduleUrl, zoom });
  await expect.poll(() => page.evaluate(() => (window as any).detailFixture.ready())).toBe(true);
  const article = (i: number) => page.locator(`[data-id="detail-${i}"] article`);
  await expect(article(0)).toHaveAttribute("data-node-presentation", zoom < 0.2 ? "overview" : "full");
  await expect(article(7)).toHaveAttribute("data-node-presentation", "folded");
  await expect(article(6)).toHaveAttribute("data-node-presentation", zoom === 10 ? "full" : "folded");
  const geometry = () => page.evaluate(() => [...document.querySelectorAll(".react-flow__node")].map((node) => ({ id: node.getAttribute("data-id"),
    boxes: [node, node.querySelector("article")!, ...node.querySelectorAll(".narrative-handle")].map((item) => {
      const b = item.getBoundingClientRect(); return [b.x, b.y, b.width, b.height];
    }) })));
  const reduced = await geometry();
  expect(reduced).toHaveLength(8); expect(reduced.every((node) => node.boxes.length === 6 && node.boxes.every((box) => box.every(Number.isFinite) && box[2]! > 0 && box[3]! > 0))).toBe(true);
  // The four real ports must stay near their respective card boundaries, not become normal-flow divs.
  for (const node of reduced) {
    const box = node.boxes[1]!, tolerance = zoom * 20;
    const [top, right, bottom, left] = node.boxes.slice(2);
    expect(Math.abs(top![0]! + top![2]! / 2 - box[0]! - box[2]! / 2)).toBeLessThan(tolerance);
    expect(Math.abs(top![1]! + top![3]! / 2 - box[1]!)).toBeLessThan(tolerance);
    expect(Math.abs(right![0]! + right![2]! / 2 - box[0]! - box[2]!)).toBeLessThan(tolerance);
    expect(Math.abs(bottom![1]! + bottom![3]! / 2 - box[1]! - box[3]!)).toBeLessThan(tolerance);
    expect(Math.abs(left![0]! + left![2]! / 2 - box[0]!)).toBeLessThan(tolerance);
  }
  if (zoom === 1) {
    await page.screenshot({ path: test.info().outputPath(`stt-node-detail-${width}.png`) });
    await expect(article(7).getByLabel("Linked visual instance", { exact: true })).toHaveCount(1);
  }
  await page.evaluate(() => (window as any).detailFixture.full()); await expect(article(7)).toHaveAttribute("data-node-presentation", "full");
  const full = await geometry(); expect(full.map((node) => node.id)).toEqual(reduced.map((node) => node.id));
  for (let i = 0; i < full.length; i++) for (let j = 0; j < 6; j++) for (let axis = 0; axis < 4; axis++)
    expect(Math.abs(full[i]!.boxes[j]![axis]! - reduced[i]!.boxes[j]![axis]!)).toBeLessThanOrEqual(0.05);
  await page.evaluate(() => (window as any).detailFixture.dispose()); await expect(page.locator(".react-flow")).toHaveCount(0);
});

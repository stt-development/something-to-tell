import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const require = createRequire(import.meta.url);
const css = readFileSync(require.resolve("@xyflow/react/dist/style.css"), "utf8")
  + readFileSync(new URL("../src/styles/story-flow.css", import.meta.url), "utf8");
let moduleUrl: string;
test.beforeAll(async () => {
  const built = await build({ configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": '"production"' },
    esbuild: { jsx: "automatic" }, build: { write: false, minify: false,
      lib: { entry: fileURLToPath(new URL("./edgeFootprintFixture.tsx", import.meta.url)), formats: ["es"] } } });
  const output = Array.isArray(built) ? built[0]! : built;
  const chunk = "output" in output ? output.output.find((item) => item.type === "chunk") : null;
  if (!chunk || chunk.type !== "chunk") throw new Error("edge_world_fixture_bundle_missing");
  moduleUrl = `data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`;
});

for (const zoom of [0.01, 1, 10]) test(`publishes complete supported world footprints through the real viewport portal at ${zoom}`, async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.setContent(`<style>${css}body{margin:0}</style>`);
  await page.evaluate(async (url) => { (window as any).fixture = (await import(url)).mount(); }, moduleUrl);
  await expect.poll(() => page.evaluate(() => (window as any).fixture.read()?.edges.length)).toBe(3);
  await page.evaluate(async ({ zoom }) => { await (window as any).fixture.viewport(zoom, 75, 45); }, { zoom });
  await expect.poll(() => page.evaluate(() => (window as any).fixture.read()?.edges.filter((edge: any) => edge.routeBounds).length)).toBe(3);
  const result = await page.evaluate(() => {
    const anchor = document.querySelector("[data-edge-world-anchor] g") as SVGGraphicsElement;
    return { snapshot: (window as any).fixture.read(), frame: anchor.getScreenCTM()?.a,
      anchorInWorld: !!anchor.closest(".react-flow__viewport-portal")?.closest(".react-flow__viewport"),
      paths: document.querySelectorAll("path[data-narrative-edge-route]").length };
  });
  expect(result.anchorInWorld).toBe(true); expect(result.frame).toBeCloseTo(zoom, 5); expect(result.paths).toBe(3);
  const labelled = result.snapshot.edges.find((edge: any) => edge.id === "labelled");
  expect(labelled.label.kind).toBe("measured");
  expect(result.snapshot.edges.find((edge: any) => edge.id === "absent").label.kind).toBe("none");
  expect(result.snapshot.edges.find((edge: any) => edge.id === "arc").label.kind).toBe("unknown");
  expect(result.snapshot.unknown).toEqual(["arc"]); expect(result.snapshot.eligible).toContain("arc");
  // Every current native shape/hit box must remain inside the published route envelope.
  expect(await page.evaluate(() => {
    const snapshots = (window as any).fixture.read().edges;
    const world = (document.querySelector("[data-edge-world-anchor] g") as SVGGraphicsElement).getScreenCTM()!;
    return [...document.querySelectorAll<SVGPathElement>("path[data-narrative-edge-route]")].every((route) => {
      const bounds = snapshots.find((edge: any) => edge.id === route.getAttribute("data-narrative-edge-route")).routeBounds;
      return [...route.parentElement!.children].every((child) => {
        const box = (child as SVGGraphicsElement).getBoundingClientRect();
        return (box.left - world.e) / world.a >= bounds.x && (box.top - world.f) / world.d >= bounds.y
          && (box.right - world.e) / world.a <= bounds.x + bounds.width && (box.bottom - world.f) / world.d <= bounds.y + bounds.height;
      });
    });
  })).toBe(true);
  await page.evaluate(() => (window as any).fixture.unmount());
  expect(await page.locator(".react-flow").count()).toBe(0); expect(errors).toEqual([]);
});

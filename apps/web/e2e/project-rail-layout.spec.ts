import { openAuroraFixture } from "./projectFixture";
import { expect, test } from "./temporaryProject";

for (const viewport of [{ width: 1024, height: 720 }, { width: 1440, height: 900 }]) {
  test(`preserves project rail layout across authoring modes at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await openAuroraFixture(page);
    const toggle = page.getByTitle("Projects");
    const canvas = page.locator(".workspace-stage > .react-flow");
    const rail = page.locator("aside.absolute");
    const tools = page.locator(".tool-rail");
    const writes: string[] = [];
    // Toggle-only work is presentation; fixture setup and later cleanup are excluded.
    page.on("request", (request) => {
      if (request.method() !== "GET" && request.url().includes("/api/")) writes.push(request.method());
    });
    await expect(rail).toBeVisible();
    const bounds = await canvas.boundingBox();
    expect(bounds).toEqual({ x: 256, y: 56, width: viewport.width - 256, height: viewport.height - 56 });
    await toggle.click();
    await expect(rail).toHaveCount(0);
    await expect(canvas).not.toHaveClass(/project-rail-open/);
    await expect(tools).toHaveCSS("left", "12px");
    await expect(canvas.boundingBox()).resolves.toEqual({ x: 0, y: 56, width: viewport.width, height: viewport.height - 56 });
    await expect(toggle).toBeFocused();

    await page.getByRole("button", { name: "Show graph filters" }).click();
    const filters = page.getByLabel("Search graph").locator("xpath=ancestor::section[1]");
    await expect(filters).toHaveCSS("left", "80px");
    await toggle.click();
    await expect(canvas.boundingBox()).resolves.toEqual(bounds);
    await expect(tools).toHaveCSS("left", "276px");
    await expect(filters).toHaveCSS("left", "344px");
    await page.screenshot({ path: testInfo.outputPath("graph-rail-open.png") });
    const dialogue = page.getByTestId("rf__node-node-dock-dialogue");
    const worldTransform = await dialogue.evaluate((element) => element.style.transform);
    await page.getByLabel("Search graph").fill("Dockmaster Warning");
    await expect(page.getByTestId("rf__node-node-opening")).toHaveCount(0);
    await expect(page.locator(".react-flow__node")).toHaveCount(1);
    await expect.poll(() => dialogue.evaluate((element) => element.style.transform)).toBe(worldTransform);
    await page.screenshot({ path: testInfo.outputPath("graph-filtered-orphan.png") });
    await page.getByLabel("Search graph").fill("");
    await expect(page.getByTestId("rf__node-node-opening")).toBeVisible();
    await expect.poll(() => dialogue.evaluate((element) => element.style.transform)).toBe(worldTransform);
    await page.getByRole("button", { name: "Hide graph filters" }).click();

    await page.getByRole("button", { name: "Flow", exact: true }).click();
    await expect(canvas).toHaveClass(/project-rail-open/);
    await toggle.click();
    await expect(canvas).not.toHaveClass(/project-rail-open/);
    await expect(page.getByRole("region", { name: "Flow summary", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Story", exact: true }).click();
    const story = page.locator(".story-document-workspace");
    await expect(story).toHaveCSS("left", "0px");
    await toggle.click();
    await expect(story).toHaveCSS("left", "256px");
    await page.screenshot({ path: testInfo.outputPath("story-rail-open.png") });
    await page.getByRole("button", { name: "Graph", exact: true }).click();
    await expect(canvas).toHaveClass(/project-rail-open/);
    await expect(tools).toHaveCSS("left", "276px");
    expect(writes).toEqual([]);
  });
}

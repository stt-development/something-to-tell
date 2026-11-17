import { expect, test, type Page } from "./temporaryProject";

const VIEWPORTS = [
  { width: 1024, height: 720 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 }
];

for (const viewport of VIEWPORTS) {
  test(`renders an animated English clean-start graph at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.addInitScript(() => localStorage.setItem("stt.ui_locale.v1", "en"));
    const projectSessionPosts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("/api/project-sessions")) projectSessionPosts.push(request.url());
    });

    await page.goto("http://127.0.0.1:1420");
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    const create = page.getByRole("button", { name: "Create", exact: true });
    await expect(create).toBeFocused();
    const canvas = page.getByTestId("clean-start-graph");
    await expect(canvas).toHaveAttribute("aria-hidden", "true");
    expect(Number(await canvas.evaluate((element) => getComputedStyle(element).opacity))).toBeLessThanOrEqual(0.3);
    expect(await canvas.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("none");

    const first = await canvasDigest(page);
    expect(first.painted).toBeGreaterThan(100);
    await page.waitForTimeout(450);
    const second = await canvasDigest(page);
    expect(second.hash).not.toBe(first.hash);

    await create.click();
    await expect(page.getByRole("heading", { name: "Create project" })).toBeVisible();
    await page.getByRole("button", { name: "Close dialog" }).click();
    expect(projectSessionPosts).toEqual([]);
    await page.screenshot({ path: `/tmp/p39-clean-start-en-${viewport.width}x${viewport.height}.png` });
  });
}

for (const viewport of VIEWPORTS) {
  test(`renders a static Russian clean-start graph with reduced motion at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(() => localStorage.setItem("stt.ui_locale.v1", "ru"));

    await page.goto("http://127.0.0.1:1420");
    await expect(page.getByRole("heading", { name: "Проекты" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Создать", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Открыть", exact: true })).toBeVisible();
    const canvas = page.getByTestId("clean-start-graph");
    const first = await canvasDigest(page);
    expect(first.painted).toBeGreaterThan(100);
    await page.waitForTimeout(450);
    expect(await canvasDigest(page)).toEqual(first);
    await page.screenshot({ path: `/tmp/p39-clean-start-ru-reduced-${viewport.width}x${viewport.height}.png` });
  });
}

/** Samples real canvas pixels without coupling screenshots to antialiasing details. */
async function canvasDigest(page: Page) {
  return page.getByTestId("clean-start-graph").evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext("2d");
    if (!context) return { hash: 0, painted: 0 };
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261;
    let painted = 0;
    const pixelStep = 47;
    for (let pixel = 0; pixel < canvas.width * canvas.height; pixel += pixelStep) {
      const index = pixel * 4;
      const alpha = pixels[index + 3]!;
      if (alpha > 0) painted += 1;
      hash = Math.imul(hash ^ pixels[index]!, 16777619);
      hash = Math.imul(hash ^ pixels[index + 1]!, 16777619);
      hash = Math.imul(hash ^ pixels[index + 2]!, 16777619);
      hash = Math.imul(hash ^ alpha, 16777619);
    }
    return { hash: hash >>> 0, painted };
  });
}

import { openAuroraFixture, openExportAuroraFixture, openRussianAuroraFixture } from "./projectFixture";
import { expect, test } from "./temporaryProject";

test.use({ viewport: { width: 1280, height: 800 } });

/** Real runtime export must stay separate from project authoring and Save. */
test("reviews Aurora, writes JSON/YAML, and shows executable diagnostics without mutation", async ({ page }) => {
  await openAuroraFixture(page);
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (!["GET", "OPTIONS"].includes(request.method()) && !request.url().includes("/exports/")) mutations.push(request.url());
  });
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export", exact: true });
  await expect(dialog.getByLabel("Format")).toBeFocused();
  const refresh = dialog.getByRole("button", { name: "Refresh preview" });
  await refresh.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toHaveText("Refresh preview");
  const bounds = await tooltip.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(8);
  expect(bounds!.y).toBeGreaterThanOrEqual(8);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1272);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(792);
  for (const format of ["json", "yaml", "yarn_spinner", "ink"]) {
    await dialog.getByRole("combobox", { name: "Format", exact: true }).selectOption(format);
    const planned = page.waitForResponse((response) => response.url().includes("/exports/") && response.url().endsWith("/plans"));
    await refresh.click();
    const response = await planned;
    expect(response.ok()).toBeTruthy();
    const plan = await response.json();
    await expect(dialog.getByRole("region", { name: "Inventory", exact: true })).toBeVisible();
    if (["json", "yaml"].includes(format)) {
      expect(plan.can_write).toBe(true);
      const written = page.waitForResponse((result) => result.url().includes("/exports/") && result.url().endsWith("/writes"));
      await dialog.getByRole("button", { name: "Export", exact: true }).click();
      expect((await written).ok()).toBeTruthy();
      await expect(dialog.getByText(/^Exported /)).toBeVisible();
    } else {
      expect(plan.diagnostics.length).toBeGreaterThan(0);
      await expect(dialog.getByLabel("Identifier target")).toHaveValue(format);
    }
    await page.screenshot({ path: `/tmp/p8-export-${format}.png` });
  }
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(mutations).toEqual([]);
});

/** The checked-in ready example exports without hidden browser-only repairs. */
test("exports reviewed Aurora in every format and both scopes", async ({ page }) => {
  await openExportAuroraFixture(page);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export", exact: true });
  for (const scope of ["whole_project", "story_flows"]) {
    await dialog.getByRole("combobox", { name: "Scope", exact: true }).selectOption(scope);
    if (scope === "story_flows") {
      await dialog.getByLabel("Search Story Flows").fill("main");
      await dialog.getByLabel("Main Story", { exact: true }).check();
      await dialog.getByLabel("Replace existing file").check();
    }
    for (const format of ["json", "yaml", "yarn_spinner", "ink"]) {
      await dialog.getByRole("combobox", { name: "Format", exact: true }).selectOption(format);
      const planned = page.waitForResponse((response) => response.url().includes("/exports/") && response.url().endsWith("/plans"));
      await dialog.getByRole("button", { name: "Refresh preview" }).click();
      const plan = await (await planned).json();
      expect(plan.can_write, JSON.stringify(plan.diagnostics)).toBe(true);
      expect(plan.inventory.story_flow_count).toBe(3);
      if (["yarn_spinner", "ink"].includes(format)) {
        expect(plan.preview.text).toContain("stt-source-map:");
        expect(plan.preview.text).toContain("stt_transfer_item");
      }
      const written = page.waitForResponse((response) => response.url().includes("/exports/") && response.url().endsWith("/writes"));
      await dialog.getByRole("button", { name: "Export", exact: true }).click();
      expect((await written).ok()).toBe(true);
      await expect(dialog.getByText(/^Exported /)).toBeVisible();
      await page.screenshot({ path: `/tmp/p8-export-ready-${scope}-${format}.png` });
    }
  }
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
});

/** Narrow windows retain independently scrollable review and visible commands. */
test("localizes the export workspace and keeps it inside a narrow viewport", async ({ page }) => {
  await openRussianAuroraFixture(page);
  await page.setViewportSize({ width: 600, height: 800 });
  await page.getByRole("button", { name: "Экспорт", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Экспорт", exact: true });
  await dialog.getByRole("button", { name: "Обновить предпросмотр" }).click();
  await expect(dialog.getByRole("region", { name: "Состав экспорта" })).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(600);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(800);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(dialog.getByRole("button", { name: "Экспортировать", exact: true })).toBeVisible();
  await page.screenshot({ path: "/tmp/p8-export-ru-narrow.png" });
  await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
});

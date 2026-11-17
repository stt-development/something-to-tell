import { resolve } from "node:path";
import type { Locator } from "@playwright/test";
import { openAuroraFixture } from "./projectFixture";
import { test, expect } from "./temporaryProject";

for (const locale of ["en", "ru"] as const) {
  test(`reads guides from empty-project-start with search, keyboard and no project (${locale})`, async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto("http://127.0.0.1:1420");
    await page.getByLabel("Interface language").selectOption(locale);
    const title = locale === "en" ? "User guides" : "Руководства пользователя";
    const open = locale === "en" ? "Open user guides" : "Открыть руководства пользователя";
    const close = locale === "en" ? "Close user guides" : "Закрыть руководства пользователя";
    const start = page.getByTestId("empty-project-start");
    const launcher = start.getByRole("button", { name: open });
    await expect(launcher).toBeVisible();
    // Source screenshots are updated only by an explicit capture run, never normal tests.
    if (process.env.STT_CAPTURE_GUIDE_IMAGES === "1") {
      await start.screenshot({ path: resolve(`../../docs/guides/assets/getting-started/start.${locale}.png`), animations: "disabled" });
    }
    const writes: string[] = [];
    page.on("request", request => { if (request.url().includes(":8719/api/") && request.method() !== "GET") writes.push(request.url()); });
    await launcher.click();
    const dialog = page.getByRole("dialog", { name: title });
    const closeButton = dialog.getByRole("button", { name: close });
    await expect(closeButton).toBeFocused();
    const firstTopic = locale === "en" ? /^Your first story/ : /^Первая история/;
    await dialog.getByRole("button", { name: firstTopic }).click();
    await expect(dialog.getByRole("heading", { name: locale === "en" ? "Your first story" : "Первая история", exact: true })).toBeVisible();
    const screenshot = dialog.locator(".help-image-button img");
    await expect(screenshot).toBeVisible();
    await expect.poll(() => screenshot.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
    await screenshot.click();
    await expect(dialog.locator(".help-image-expanded")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog.locator(".help-image-expanded")).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await dialog.getByRole("link", { name: locale === "en" ? "projects and saving" : "проекты и сохранение" }).click();
    await expect(dialog.getByRole("heading", { name: locale === "en" ? "Projects and saving" : "Проекты и сохранение", exact: true })).toBeVisible();
    const search = dialog.getByRole("textbox", { name: locale === "en" ? "Search guides" : "Поиск по руководствам" });
    await search.fill(locale === "en" ? "guard agrees" : "переподключения");
    await expect(dialog.getByRole("button", { name: locale === "en" ? /^Conditions and effects/ : /^Хранение и восстановление соединения/ })).toBeVisible();
    await search.fill("zzzzzz-not-a-topic");
    await expect(dialog.getByRole("status")).toHaveText(locale === "en" ? "No guides match your search." : "По вашему запросу руководства не найдены.");
    await search.fill("");
    await dialog.getByRole("button", { name: locale === "en" ? /^Choose an element type/ : /^Выбор типа элемента/ }).click();
    await expect(dialog.getByRole("table")).toBeVisible();
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await bounded(dialog);
      expect(await dialog.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
      expect(await dialog.locator(".help-page").evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: `/tmp/user-guides-${locale}-${width}.png` });
    }
    await closeButton.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(closeButton).not.toBeFocused();
    await page.keyboard.press("Tab");
    await expect(closeButton).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(launcher).toBeFocused();
    expect(writes).toEqual([]);
  });
}

test("opens header help without changing selection or saving and reads local guides with runtime blocked", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAuroraFixture(page);
  const hero = page.getByTestId("rf__node-node-hero");
  await hero.click();
  await expect(hero).toHaveClass(/selected/);
  const launcher = page.locator("main > header").getByRole("button", { name: "Open user guides" });
  await launcher.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Open user guides");
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  // Guide assets are frontend-local and require neither a project API nor an AI provider.
  await page.route("http://127.0.0.1:8719/**", route => route.abort());
  try {
    await launcher.click();
    const dialog = page.getByRole("dialog", { name: "User guides" });
    await dialog.getByRole("button", { name: /^Branching dialogue/ }).click();
    await expect(dialog.getByRole("heading", { name: "Branching dialogue" })).toBeVisible();
    await page.keyboard.press("Delete");
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Escape");
    await expect(launcher).toBeFocused();
    await expect(hero).toHaveClass(/selected/);
    expect(errors).toEqual([]);
  } finally { await page.unroute("http://127.0.0.1:8719/**"); }
});

async function bounded(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.y).toBeGreaterThanOrEqual(0);
  const viewport = locator.page().viewportSize()!;
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
}

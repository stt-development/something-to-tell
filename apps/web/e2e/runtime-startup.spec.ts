import { test, expect } from "@playwright/test";

const origin = process.env.STT_TEST_STARTUP_ORIGIN ?? "http://127.0.0.1:1420";

for (const locale of ["en", "ru"] as const) {
  test(`runtime loss allows explicit native close and keyboard confirmation (${locale})`, async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/e2e/runtime-startup.html?scenario=lost-close&locale=${locale}`);
    const close = page.getByRole("button", { name: locale === "en" ? "Close application" : "Закрыть приложение" });
    await expect(close).toBeVisible();
    const box = await close.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 390).toBeTruthy();
    await page.screenshot({ path: info.outputPath(`startup-close-${locale}.png`) });
    await close.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("body")).toHaveAttribute("data-close-decision", "true");
  });

  test(`startup waits before importing the editor and uses only the ready origin (${locale})`, async ({ page }) => {
    await page.goto(`${origin}/e2e/runtime-startup.html?scenario=pending&locale=${locale}`);
    await expect(page.getByRole("progressbar")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Editor fixture" })).toHaveCount(0);
    await expect(page.getByTestId("fixture-base")).toHaveText("http://127.0.0.1:51234/api");
  });

  test(`startup failure fits a narrow viewport and allows deliberate retry (${locale})`, async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/e2e/runtime-startup.html?scenario=failed&locale=${locale}`);
    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(page.getByText("private fixture error")).toHaveCount(0);
    const button = page.getByRole("button", { name: locale === "en" ? "Try again" : "Повторить" });
    const box = await button.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 390).toBeTruthy();
    await page.screenshot({ path: info.outputPath(`startup-failed-${locale}.png`) });
    await button.click();
    await expect(page.getByRole("heading", { name: "Editor fixture" })).toBeVisible();
  });

  test(`runtime loss covers portals, retains drafts and blocks editor shortcuts (${locale})`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto(`${origin}/e2e/runtime-startup.html?scenario=lost&locale=${locale}`);
    const draft = page.getByRole("textbox", { name: "Draft" });
    await draft.fill("Retained browser draft");
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    const keys = await page.getByTestId("fixture-keys").textContent();
    await page.keyboard.press("Delete");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(draft).toHaveValue("Retained browser draft");
    await expect(page.getByTestId("fixture-keys")).toHaveText(keys!);
    const front = await page.evaluate(() => document.elementFromPoint(innerWidth - 12, 12)?.closest("dialog")?.className);
    expect(front).toBe("runtime-lost");
    await expect(page.getByRole("button", { name: locale === "en" ? "Try again" : "Повторить" })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`startup-lost-${locale}.png`) });
  });
}

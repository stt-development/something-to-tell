import { openAuroraFixture } from "./projectFixture";
import { expect, test } from "./temporaryProject";

test.use({ viewport: { width: 1280, height: 800 } });

test("creates and opens an independent portable project copy", async ({ page }) => {
  await openAuroraFixture(page);
  await page.getByRole("button", { name: "Project settings" }).click();
  let settings = page.getByRole("heading", { name: "Project settings" }).locator("..").locator("..");
  const sourceProjectId = await settings.locator("dt", { hasText: "Project ID" }).locator("xpath=following-sibling::dd[1]").textContent();
  await settings.getByRole("button", { name: "Close dialog" }).click();

  await page.getByRole("button", { name: "More save actions" }).click();
  await page.screenshot({ path: "/tmp/p39-save-split-menu.png" });
  await page.getByRole("menuitem", { name: "Save project as" }).click();
  const dialog = page.getByRole("heading", { name: "Save project as" }).locator("..").locator("..");
  await expect(dialog.getByLabel("Independent copy")).toBeChecked();
  await dialog.getByLabel("Copy folder name").fill("Aurora Portable E2E");
  await page.screenshot({ path: "/tmp/p39-save-as-dialog.png" });
  await dialog.getByRole("button", { name: "Create copy" }).click();
  await expect(dialog.getByText("Portable project copy created")).toBeVisible();
  await dialog.getByRole("button", { name: "Open copy" }).click();

  await expect(page.getByRole("button", { name: "Project settings" })).toBeEnabled();
  await page.getByRole("button", { name: "Project settings" }).click();
  settings = page.getByRole("heading", { name: "Project settings" }).locator("..").locator("..");
  const copiedProjectId = await settings.locator("dt", { hasText: "Project ID" }).locator("xpath=following-sibling::dd[1]").textContent();
  await expect(settings).toContainText("AuroraPortableE2E.narrative");
  expect(copiedProjectId).not.toBe(sourceProjectId);
  await expect(page.getByText("16 nodes / 10 relations / 5 transitions")).toBeVisible();
});

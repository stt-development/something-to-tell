import type { Locator, Page } from "@playwright/test";
import { openAuroraFixture, openRussianAuroraFixture } from "./projectFixture";
import { expect, test } from "./temporaryProject";

test("reviews Aurora Export Identifiers and returns to contextual and bulk authoring", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAuroraFixture(page);
  const workspace = await openRegistry(page);

  await expect(workspace.getByRole("heading", { name: "Character 1" })).toBeVisible();
  await expect(workspace).toContainText("Target alias is not configured");
  await expect(workspace).not.toContainText("engine_tags.integrity");
  await workspace.getByRole("button", { name: /Character\.MaraVale/ }).click();
  await expect(workspace).toContainText("node-hero");
  await expect(workspace).toContainText("Node");
  await expect(workspace.getByLabel("Identifier target")).toHaveValue("ink");
  await expect(workspace.getByRole("option", { name: "Unreal Engine" })).toHaveCount(0);
  await expect(workspace.getByRole("option", { name: "Unity", exact: true })).toHaveCount(0);
  await workspace.getByLabel("Preview export target").selectOption("ink");
  await workspace.getByRole("button", { name: "Generate preview" }).click();
  await expect(workspace).toContainText(/projected entr/i);
  await workspace.getByRole("button", { name: "Open owning element" }).hover();
  await page.screenshot({ path: "/tmp/p7-engine-tags-en-1440x900.png" });
  await workspace.getByRole("button", { name: "Open owning element" }).click();

  const hero = page.getByTestId("rf__node-node-hero");
  await expect(hero).toHaveClass(/selected/);
  await page.getByTitle("Projects").click();
  await page.locator(".react-flow__controls-fitview").click();
  await page.waitForTimeout(250);
  await hero.dblclick();
  const editor = page.getByRole("heading", { name: "Edit node" }).locator("xpath=ancestor::section");
  const contextual = editor.locator("details.engine-tag-picker");
  await contextual.locator("summary").click();
  await expect(contextual).toContainText("Character.MaraVale");
  await editor.getByRole("button", { name: "Close dialog" }).click();

  await page.locator(".react-flow__controls-fitview").click();
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await hero.click();
  await page.getByTestId("rf__node-node-trade-guild").click({ modifiers: ["Shift"] });
  const bulk = page.getByRole("button", { name: "Bind Export ID to selection" }).locator("..");
  await expect(bulk).toBeVisible();
  await bulk.locator("summary").click();
  await bulk.getByRole("button", { name: "Add identifier", exact: true }).click();
  await bulk.getByRole("button", { name: "Generate a new identifier" }).click();
  await expect(bulk.getByLabel("Canonical key")).toHaveValue(/^[A-Za-z]+\./);
});

test("aligns selection tag and analysis actions with a bounded dropdown and immediate tooltip", async ({ page }) => {
  await openAuroraFixture(page);
  await page.getByTitle("Projects").click();
  await page.locator(".react-flow__controls-fitview").click();
  const hero = page.getByTestId("rf__node-node-hero");
  await hero.click();
  const tag = page.getByRole("button", { name: "Bind Export ID to selection" });
  const analyze = page.getByRole("button", { name: "Analyze current selection" });
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    const tagBounds = await tag.boundingBox(), analysisBounds = await analyze.boundingBox();
    expect(tagBounds).not.toBeNull(); expect(analysisBounds).not.toBeNull();
    expect(tagBounds!.width).toBe(analysisBounds!.width);
    expect(tagBounds!.height).toBe(analysisBounds!.height);
    expect(tagBounds!.y).toBe(analysisBounds!.y);
    expect(tagBounds!.x + tagBounds!.width).toBeLessThan(analysisBounds!.x);
    await expect(tag.locator("svg")).toHaveClass(/lucide-tags/);
    await tag.hover();
    await expect(page.getByRole("tooltip")).toHaveText("Bind Export ID to selection");
    await tag.click();
    const content = page.locator(".impact-selection-action .engine-tag-picker-content");
    await expect(content).toBeVisible();
    await expectInsideViewport(page, content);
    expect((await analyze.boundingBox())!.y).toBe(analysisBounds!.y);
    await page.screenshot({ path: `/tmp/selection-tag-actions-${width}.png` });
    await tag.click();
    await expect(content).not.toBeVisible();
  }
});

test("keeps the localized registry and owner tooltip inside the compact viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 720 });
  await openRussianAuroraFixture(page);
  await page.getByTitle("Проекты").click();
  const workspace = await openRegistry(page, "Идентификаторы экспорта");

  await expect(workspace.getByLabel("Цель предпросмотра")).toBeVisible();
  await workspace.getByRole("button", { name: /Character\.MaraVale/ }).click();
  const ownerButton = workspace.getByRole("button", { name: "Открыть связанный элемент" });
  await ownerButton.hover();
  await expectInsideViewport(page, workspace);
  await expect(ownerButton.locator("xpath=parent::span")).toHaveAttribute(
    "data-tooltip",
    "Открыть связанный элемент"
  );
  await page.screenshot({ path: "/tmp/p7-engine-tags-ru-1024x720.png" });
});

async function openRegistry(page: Page, title = "Export Identifiers"): Promise<Locator> {
  // Registry navigation belongs to the persistent header, not the project rail.
  const launcher = page.locator("main > header").getByRole("button", { name: title, exact: true });
  await launcher.hover();
  await expect(page.getByRole("tooltip")).toHaveText(title);
  await expectInsideViewport(page, launcher);
  await launcher.click();
  const workspace = page.getByRole("heading", { name: title }).locator("xpath=ancestor::section");
  await expect(workspace).toBeVisible();
  await expect(workspace.getByText("Loading Export Identifiers…")).toHaveCount(0);
  await expect.poll(() => workspace.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await expect.poll(() => workspace.getByTestId("engine-tags-workspace").evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  return workspace;
}

async function expectInsideViewport(page: Page, locator: Locator): Promise<void> {
  const bounds = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport!.width);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport!.height);
}

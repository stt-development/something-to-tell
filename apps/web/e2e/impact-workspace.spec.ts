import { openAuroraFixture, openRussianAuroraFixture } from "./projectFixture";
import { expect, test } from "./temporaryProject";

test("reviews selected impact paths beside the canvas at 1440x900", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await delayImpactRuns(page);
  await openAuroraFixture(page);

  const hero = page.getByTestId("rf__node-node-hero");
  await hero.click();
  const selectionAction = page.getByRole("button", { name: "Analyze current selection" });
  await selectionAction.locator("..").hover();
  await expect(page.getByRole("tooltip")).toHaveText("Analyze current selection");
  await selectionAction.click();
  await page.getByRole("complementary", { name: "Impact analysis" }).getByRole("button", { name: "Close" }).click();
  await expect(selectionAction).toBeFocused();
  const open = page.getByRole("button", { name: "Open Impact analysis" });
  await page.getByRole("button", { name: "Choose analysis tool" }).click();
  await expect(page.getByRole("menuitem", { name: /Impact analysis Ready 1/ })).toBeVisible();
  await page.getByRole("button", { name: "Choose analysis tool" }).click();
  await open.locator("..").hover();
  await expect(page.getByRole("tooltip")).toHaveText("Open Impact analysis");
  await open.click();

  const workspace = page.getByRole("complementary", { name: "Impact analysis" });
  await expect(workspace).toContainText("Mara Vale");
  await workspace.getByLabel("Canon").uncheck();
  const runRequest = page.waitForRequest((request) => request.url().endsWith("/impact-analysis/runs") && request.method() === "POST");
  await workspace.getByRole("button", { name: "Analyze" }).click();
  await expect(workspace.getByRole("status")).toContainText("Tracing project dependencies");
  const request = await runRequest;
  expect(request.postDataJSON()).toMatchObject({
    scenario: { type: "selection", intent: "modify" },
    domains: expect.not.arrayContaining(["canon"])
  });
  await expect(workspace).toContainText("Required");
  await expect(workspace).toContainText("Distance 1");
  await expect(hero.locator(".narrative-node")).toHaveClass(/narrative-node-impact-seed/);
  await expect(hero.getByRole("img", { name: "Selected Impact Analysis seed." })).toBeVisible();

  const workspaceBounds = await workspace.boundingBox();
  const canvasBounds = await page.locator(".workspace-stage > .react-flow").boundingBox();
  const projectRailBounds = await page.locator(".workspace-stage > aside").first().boundingBox();
  const selectionActionBounds = await selectionAction.boundingBox();
  const selectionToolbarBounds = await page.locator(".impact-selection-action").boundingBox();
  expect(workspaceBounds).not.toBeNull();
  expect(canvasBounds).not.toBeNull();
  expect(projectRailBounds).not.toBeNull();
  expect(selectionActionBounds).not.toBeNull();
  expect(selectionToolbarBounds).not.toBeNull();
  expect(canvasBounds!.x + canvasBounds!.width).toBeLessThanOrEqual(workspaceBounds!.x + 1);
  const usableCanvasCenter = (projectRailBounds!.x + projectRailBounds!.width + workspaceBounds!.x) / 2;
  // The approved tag/analysis pair is centered as one toolbar, not one child.
  const selectionToolbarCenter = selectionToolbarBounds!.x + selectionToolbarBounds!.width / 2;
  expect(Math.abs(selectionToolbarCenter - usableCanvasCenter)).toBeLessThanOrEqual(2);
  expect(selectionActionBounds!.x).toBeGreaterThanOrEqual(selectionToolbarBounds!.x);
  expect(selectionActionBounds!.x + selectionActionBounds!.width)
    .toBeLessThanOrEqual(selectionToolbarBounds!.x + selectionToolbarBounds!.width);
  expect(workspaceBounds!.x + workspaceBounds!.width).toBeLessThanOrEqual(1440);
  await page.screenshot({ path: "/tmp/p5-impact-workspace-1440x900.png" });

  const workspaceModes = page.getByRole("group", { name: "Workspace view" });
  await workspaceModes.getByRole("button", { name: "Flow" }).click();
  await expect(page.locator(".narrative-node-impact-direct, .narrative-node-impact-transitive").first()).toBeVisible();
  await workspaceModes.getByRole("button", { name: "Story" }).click();
  await expect(page.locator(".story-impact-marker").first()).toBeVisible();
  await expect(page.locator(".story-impact-marker").first()).toHaveAttribute("data-impact-role", /seed|direct|transitive/);
  await workspaceModes.getByRole("button", { name: "Graph" }).click();
  await workspace.locator(".impact-finding-row").first().locator("summary").click();
  await expect(workspace).toContainText("Dependency paths");

  await workspace.getByRole("button", { name: "Close" }).click();
  await expect(open).toBeFocused();
  await hero.click({ button: "right" });
  await page.getByRole("button", { name: "Analyze selected dependencies" }).click();
  await expect(workspace).toBeVisible();
  await workspace.getByRole("button", { name: "Close" }).click();
  await expect(open).toBeFocused();
});

test("returns from Delete preflight without applying or saving the command", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const saveRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/save")) saveRequests.push(request.url());
  });
  await openAuroraFixture(page);

  const hero = page.getByTestId("rf__node-node-hero");
  await hero.click();
  await page.keyboard.press("Delete");
  const confirmation = page.getByRole("heading", { name: /Delete Mara Vale/ }).locator("xpath=ancestor::section[1]");
  const analyze = confirmation.getByRole("button", { name: "Analyze impact" });
  await analyze.click();

  const workspace = page.getByRole("complementary", { name: "Impact analysis" });
  await expect(workspace.getByRole("button", { name: "Delete", exact: true })).toHaveAttribute("aria-pressed", "true");
  await workspace.getByRole("button", { name: "Analyze" }).click();
  const returnToDelete = workspace.getByRole("button", { name: /Return to Delete Mara Vale/ });
  await expect(returnToDelete).toBeEnabled();
  await returnToDelete.click();

  await expect(analyze).toBeFocused();
  await expect(hero).toBeVisible();
  expect(saveRequests).toEqual([]);
  await confirmation.getByRole("button", { name: "Cancel" }).click();
});

test("keeps Impact Analysis localized and inside 1024x720", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 720 });
  await openRussianAuroraFixture(page);

  await page.getByTestId("rf__node-node-hero").click();
  await page.getByRole("button", { name: "Выбрать инструмент анализа" }).click();
  await page.getByRole("menuitem", { name: /Анализ влияния Готово 1/ }).click();
  const workspace = page.getByRole("complementary", { name: "Анализ влияния" });
  await expect(workspace.getByRole("button", { name: "Анализировать" })).toBeVisible();
  await expect(workspace).toContainText("Планируемое изменение");
  await expect(workspace).toContainText("Обязательные");
  await workspace.getByRole("button", { name: "Анализировать" }).click();
  await expect(workspace).toContainText("визуальном вложении");
  await expect(workspace).not.toContainText("{{role}}");

  const bounds = await workspace.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1024);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(720);
  await page.screenshot({ path: "/tmp/p5-impact-workspace-ru-1024x720.png" });
});

test("opens derived Story impact and reproduces an Aurora Playback consequence", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const saveRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/save")) saveRequests.push(request.url());
  });
  await openAuroraFixture(page);

  await page.getByTestId("rf__node-node-hero").click();
  await page.getByRole("button", { name: "Analyze current selection" }).click();
  const workspace = page.getByRole("complementary", { name: "Impact analysis" });
  await workspace.getByRole("button", { name: "Analyze" }).click();
  await expect(workspace.getByText(/affected finding/)).toBeVisible();
  await expect(workspace.getByText(/executable consequence/)).toBeVisible();

  await workspace.getByRole("button", { name: "Open story" }).click();
  await expect(page.getByRole("button", { name: "Story", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".story-impact-marker").first()).toBeFocused();

  await page.getByRole("button", { name: "Open Impact analysis" }).click();
  await page.getByRole("complementary", { name: "Impact analysis" }).getByRole("button", { name: "Reproduce", exact: true }).click();
  await expect(page.getByLabel("Playback workspace")).toBeVisible();
  expect(saveRequests).toEqual([]);
});

/** Keeps the runtime run observable while exercising the real API response. */
async function delayImpactRuns(page: import("@playwright/test").Page): Promise<void> {
  await page.route("**/api/project-sessions/*/impact-analysis/runs", async (route) => {
    if (route.request().method() === "POST") {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await route.continue();
  });
}

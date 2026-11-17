import { NARRATIVE_NODE_KINDS } from "../src/types";
import { openAuroraFixture, openNodeChromeFixture } from "./projectFixture";
import { expect, test } from "./temporaryProject";
import { selectFullNode, useFullDetailRollback } from "./canvasNodeInteractions";

const VIEWPORTS = [
  { width: 1024, height: 720 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 }
] as const;

for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
  test(`switches the device-local Graph card experiment live at ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openAuroraFixture(page);
    await page.getByRole("button", { name: "Quest: Smuggler Route", exact: true }).click();
    const wrappers = await page.locator(".react-flow__node").count();
    const handles = await page.locator(".react-flow__handle").count();
    const shells = page.locator('[data-node-presentation="shell"]');
    await expect.poll(() => shells.count()).toBeGreaterThan(0);
    const writes: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/") && !["GET", "HEAD"].includes(request.method())) writes.push(request.method());
    });
    const openSettings = async () => {
      await page.getByRole("button", { name: "Project settings", exact: true }).click();
      return page.getByRole("heading", { name: "Project settings", exact: true }).locator("../..");
    };
    const settings = await openSettings();
    const checkbox = settings.getByRole("checkbox", { name: "Graph viewport card optimization", exact: true });
    await checkbox.check();
    await expect.poll(() => shells.count()).toBeGreaterThan(0);
    await expect(page.locator(".react-flow__node")).toHaveCount(wrappers);
    await expect(page.locator(".react-flow__handle")).toHaveCount(handles);
    await checkbox.uncheck();
    await expect(shells).toHaveCount(0);
    await checkbox.check();
    await settings.getByRole("button", { name: "Close dialog", exact: true }).click();
    await expect.poll(() => shells.count()).toBeGreaterThan(0);
    await openSettings();
    await expect(checkbox).toBeChecked();
    await page.screenshot({ path: `/tmp/p91-graph-experiment-${viewport.width}.png` });
    await settings.getByRole("button", { name: "Close dialog", exact: true }).click();
    expect(writes).toEqual([]);
    await page.getByRole("button", { name: "Flow", exact: true }).click();
    await expect(shells).toHaveCount(0);
    await page.getByRole("button", { name: "Graph", exact: true }).click();
    await expect.poll(() => shells.count()).toBeGreaterThan(0);
    await openSettings();
    await checkbox.uncheck();
    await settings.getByRole("button", { name: "Close dialog", exact: true }).click();
    await expect(shells).toHaveCount(0);
  });
}

test("refreshes Quest card metrics after an authored reward edit", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openAuroraFixture(page);
  await page.getByRole("button", { name: "Quest: Smuggler Route", exact: true }).click();
  const quest = page.getByTestId("rf__node-node-smuggler-route");
  await expect(quest).toContainText("2 stages");
  await expect(quest).toContainText("1 reward");
  await quest.locator(".narrative-node-title").dblclick();
  const editor = page.getByRole("heading", { name: "Edit quest: Smuggler Route", exact: true }).locator("../..");
  await editor.getByRole("checkbox", { name: "Sealed Ledger", exact: true }).uncheck();
  const saved = page.waitForResponse((response) => response.url().includes("/quests/") && response.request().method() === "PUT");
  await editor.getByRole("button", { name: "Save quest", exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect(editor).toBeHidden();
  await expect(quest).toContainText("0 rewards");
  await expect(quest).toContainText("2 stages");
  // A separate selection must not restore stale document-derived values.
  await page.getByRole("button", { name: "Character: Mara Vale", exact: true }).click();
  await page.getByRole("button", { name: "Quest: Smuggler Route", exact: true }).click();
  await expect(quest).toContainText("0 rewards");
  await page.screenshot({ path: "/tmp/p91-quest-metrics.png" });
});

test("refreshes Dialogue metrics after document and external outcome edits", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openAuroraFixture(page);
  const focus = page.getByRole("button", { name: "Dialogue: Dockmaster Warning", exact: true });
  await focus.click();
  const dialogue = page.getByTestId("rf__node-node-dock-dialogue");
  await expect(dialogue.getByTitle("4 lines", { exact: true })).toBeVisible();
  await expect(dialogue.getByTitle("1 ending", { exact: true })).toBeVisible();
  await dialogue.locator(".narrative-node-title").dblclick();
  const editor = page.getByRole("heading", { name: "Edit dialogue: Dockmaster Warning", exact: true }).locator("../..");
  await editor.getByRole("button", { name: "Duplicate line-ilya-concedes", exact: true }).click();
  const saved = page.waitForResponse((response) => response.url().includes("/dialogues/") && response.request().method() === "PUT");
  await editor.getByRole("button", { name: "Save dialogue", exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect(editor).toBeHidden();
  await expect(dialogue.getByTitle("5 lines", { exact: true })).toBeVisible();
  await expect(dialogue.getByTitle("2 endings", { exact: true })).toBeVisible();
  await dialogue.locator(".narrative-node-title").dblclick();
  const outcome = editor.getByLabel("Outcomes for line-mara-orders-run");
  await outcome.getByRole("button", { name: "Delete outcome edge-dialogue-blockade", exact: true }).click();
  const removed = page.waitForResponse((response) => response.url().endsWith("/edges/edge-dialogue-blockade") && response.request().method() === "DELETE");
  // This authored outcome participates in a Flow call, so deletion requires review.
  await outcome.getByRole("alert").getByRole("button", { name: "Delete", exact: true }).click();
  expect((await removed).ok()).toBe(true);
  await editor.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(dialogue.getByTitle("3 endings", { exact: true })).toBeVisible();
  await expect(dialogue.getByTitle("5 lines", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Character: Mara Vale", exact: true }).click();
  await focus.click();
  await expect(dialogue.getByTitle("3 endings", { exact: true })).toBeVisible();
  await page.screenshot({ path: "/tmp/p91-dialogue-metrics.png" });
});

test("refreshes Scene placement counts and retains them while children are collapsed", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openAuroraFixture(page);
  await page.getByTitle("Projects").click();
  await page.locator(".react-flow__controls-fitview").click();
  await page.waitForTimeout(350);
  const scene = page.getByTestId("rf__node-node-opening");
  const location = page.getByTestId("rf__node-node-harbor");
  // Selecting the child also protects its Scene ancestry without changing geometry.
  await selectFullNode(location);
  await expect(scene.locator(".frame-content-count")).toHaveText("6");
  await expect(location.locator(".frame-content-count")).toHaveText("1");
  await scene.getByRole("button", { name: "Add linked node to Opening Dock", exact: true }).click();
  const picker = page.getByRole("heading", { name: "Add linked node to Opening Dock", exact: true }).locator("../..");
  await picker.getByRole("button", { name: "Smuggler Route Quest", exact: true }).click();
  await expect(picker).toBeHidden();
  await selectFullNode(location);
  await expect(scene.locator(".frame-content-count")).toHaveText("7");
  await expect(scene.locator(".frame-content-count")).toHaveAttribute("data-tooltip", /1 quest/);
  await expect(location.locator(".frame-content-count")).toHaveText("1");
  await selectFullNode(scene);
  await scene.getByRole("button", { name: "Collapse Opening Dock", exact: true }).click();
  await expect(page.getByTestId("rf__node-node-dock-dialogue")).toHaveCount(0);
  await expect(scene.locator(".frame-content-count")).toHaveText("7");
  await scene.getByRole("button", { name: "Expand Opening Dock", exact: true }).click();
  await expect(page.getByTestId("rf__node-node-dock-dialogue")).toBeVisible();
  await selectFullNode(location);
  await expect(scene.locator(".frame-content-count")).toHaveText("7");
  await expect(location.locator(".frame-content-count")).toHaveText("1");
  await page.screenshot({ path: "/tmp/p91-frame-counts.png" });
});

test("refreshes canonical Item placement metrics across all linked cards", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openAuroraFixture(page);
  await page.getByTitle("Projects").click();
  await page.locator(".react-flow__controls-fitview").click();
  await page.waitForTimeout(350);
  const items = page.locator('.narrative-node[data-node-kind="Item"]');
  await expect(items).toHaveCount(2);
  for (const item of await items.all()) {
    await selectFullNode(item.locator("xpath=.."));
    await expect(item).toContainText("2 placements");
  }
  const location = page.getByTestId("rf__node-node-harbor");
  await selectFullNode(location);
  await location.getByRole("button", { name: "Add linked node to Glass Harbor", exact: true }).click();
  const picker = page.getByRole("heading", { name: "Add linked node to Glass Harbor", exact: true }).locator("../..");
  const saved = page.waitForResponse((response) => response.url().endsWith("/compositions/placements") && response.request().method() === "POST");
  await picker.getByRole("button", { name: "Sealed Ledger Item", exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect(picker).toBeHidden();
  await expect(items).toHaveCount(3);
  for (const item of await items.all()) {
    await selectFullNode(item.locator("xpath=.."));
    await expect(item).toContainText("3 placements");
  }
  await page.screenshot({ path: "/tmp/p91-topology-metrics.png" });
});

test("refreshes Faction card titles after membership edits", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openAuroraFixture(page);
  await page.getByRole("button", { name: "Faction: Trade Guild", exact: true }).click();
  const faction = page.getByTestId("rf__node-node-trade-guild");
  const preview = faction.locator(".faction-member-preview");
  await expect(preview).toHaveAttribute("title", "Mara Vale");
  await faction.locator(".narrative-node-title").dblclick();
  const editor = page.getByRole("heading", { name: "Edit node", exact: true }).locator("../..");
  const added = page.waitForResponse((response) => response.url().endsWith("/factions/node-trade-guild/members") && response.request().method() === "POST");
  await editor.getByLabel("Available faction members", { exact: true }).getByRole("button", { name: /Ilya Voss/ }).click();
  expect((await added).ok()).toBe(true);
  await expect(editor.getByLabel("Current faction members", { exact: true })).toContainText("Ilya Voss");
  await editor.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(preview).toHaveAttribute("aria-label", "2 faction members");
  await expect(preview).toContainText("Ilya Voss");
  await expect(preview).toContainText("Mara Vale");
  await faction.locator(".narrative-node-title").dblclick();
  const removed = page.waitForResponse((response) => response.url().endsWith("/factions/node-trade-guild/members/node-dockmaster") && response.request().method() === "DELETE");
  await editor.getByRole("button", { name: "Remove Ilya Voss from Trade Guild", exact: true }).click();
  expect((await removed).ok()).toBe(true);
  await expect(editor.getByLabel("Current faction members", { exact: true })).not.toContainText("Ilya Voss");
  await editor.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(preview).toHaveAttribute("aria-label", "1 faction member");
  await expect(preview).toHaveAttribute("title", "Mara Vale");
  await page.screenshot({ path: "/tmp/p91-faction-titles.png" });
});

test("refreshes Consequence card target titles after an authored target edit", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openAuroraFixture(page);
  await page.getByRole("button", { name: "Outcome: Route Reopened", exact: true }).click();
  const outcome = page.getByTestId("rf__node-node-route-consequence");
  const targets = outcome.locator(".causal-role-outcome small");
  await expect(targets).toHaveText("Smuggler Route, Glass Harbor");
  await outcome.locator(".narrative-node-title").dblclick();
  const editor = page.getByRole("heading", { name: "Edit node", exact: true }).locator("../..");
  await editor.getByRole("checkbox", { name: "Affect Smuggler Route", exact: true }).uncheck();
  const saved = page.waitForResponse((response) => response.url().endsWith("/nodes/node-route-consequence") && response.request().method() === "PUT");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect(editor).toBeHidden();
  await expect(targets).toHaveText("Glass Harbor");
  await page.getByRole("button", { name: "Character: Mara Vale", exact: true }).click();
  await page.getByRole("button", { name: "Outcome: Route Reopened", exact: true }).click();
  await expect(targets).toHaveText("Glass Harbor");
  await page.screenshot({ path: "/tmp/p91-outcome-titles.png" });
});

for (const viewport of VIEWPORTS) {
  test(`keeps the complete node chrome matrix visible with full-detail rollback at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openNodeChromeFixture(page);
    await useFullDetailRollback(page);

    const analysisChooser = page.getByRole("button", { name: "Choose analysis tool" });
    await analysisChooser.click();
    const analysisMenu = page.getByRole("menu", { name: "Analysis tools" });
    await expect(analysisMenu.getByRole("menuitem", { name: /Scene analysis/ })).toHaveCount(0);
    await analysisMenu.getByRole("menuitem", { name: /Canon check/ }).click();
    const analysisPanel = page.getByRole("complementary", { name: "Canon review" });
    await expect(analysisPanel).toBeVisible();
    const panelBounds = await analysisPanel.boundingBox();
    const canvasBounds = await page.locator(".workspace-stage > .react-flow").boundingBox();
    expect(panelBounds).not.toBeNull();
    expect(canvasBounds).not.toBeNull();
    expect(canvasBounds!.x + canvasBounds!.width).toBeLessThanOrEqual(panelBounds!.x + 1);
    if (viewport.width === 1024) await page.screenshot({ path: "/tmp/p5-canon-workspace-1024x720.png" });
    await analysisPanel.getByRole("button", { name: "Close" }).click();
    await page.getByTitle("Projects").click();
    await page.locator(".react-flow__controls-fitview").click();
    await page.locator(".react-flow__controls-zoomout").click();
    await page.waitForTimeout(350);

    for (const kind of NARRATIVE_NODE_KINDS) {
      const card = page.locator(`.narrative-node[data-node-kind="${kind}"]`).first();
      await expect(card, `${kind} card`).toBeVisible();
      await expect(card.locator(".narrative-node-title")).toBeVisible();
      await expect(card.locator(".narrative-node-content")).toBeAttached();
    }

    const layout = await page.locator(".narrative-node").evaluateAll((cards) => cards.map((card) => {
      const title = card.querySelector<HTMLElement>(".narrative-node-title");
      const chrome = card.querySelectorAll<HTMLElement>(
        ".narrative-node-title-meta > *, .narrative-frame-actions > button"
      );
      if (!title) return { controlsInside: false, kind: card.dataset.nodeKind ?? "unknown" };
      const bounds = title.getBoundingClientRect();
      return {
        controlsInside: [...chrome].every((control) => {
          const controlBounds = control.getBoundingClientRect();
          return controlBounds.width > 0
            && controlBounds.left >= bounds.left - 1
            && controlBounds.right <= bounds.right + 1;
        }),
        kind: card.dataset.nodeKind ?? "unknown"
      };
    }));
    expect(layout.filter((entry) => !entry.controlsInside)).toEqual([]);
    const chromeHandleOverlaps = await page.locator(".narrative-node").evaluateAll((cards) => cards.flatMap((card) => {
      const handles = [...card.querySelectorAll<HTMLElement>(".narrative-handle")];
      const chrome = [...card.querySelectorAll<HTMLElement>(
        ".narrative-node-title-meta > *, .narrative-frame-actions > button, .node-floating-status > *"
      )];
      const overlaps = (left: DOMRect, right: DOMRect) => (
        Math.min(left.right, right.right) > Math.max(left.left, right.left)
        && Math.min(left.bottom, right.bottom) > Math.max(left.top, right.top)
      );
      return handles.flatMap((handle) => chrome
        .filter((item) => overlaps(handle.getBoundingClientRect(), item.getBoundingClientRect()))
        .map((item) => ({
          chrome: item.className,
          handle: handle.className,
          kind: card.dataset.nodeKind ?? "unknown"
        })));
    }));
    expect(chromeHandleOverlaps).toEqual([]);

    const minimumCard = page.getByTestId("rf__node-node-hero").locator(".narrative-node");
    const enlargedCard = page.getByTestId("rf__node-node-smuggler-route").locator(".narrative-node");
    expect(await minimumCard.evaluate((card) => card.offsetWidth)).toBe(220);
    expect(await enlargedCard.evaluate((card) => card.offsetWidth)).toBe(380);

    const scene = page.getByTestId("rf__node-node-opening");
    const location = page.getByTestId("rf__node-node-harbor");
    await expect(scene.locator(".frame-content-count")).toHaveText("6");
    await expect(location.locator(".narrative-node")).toHaveAttribute("data-node-frame-state", "expanded");
    await expect(location.locator(".frame-content-count")).toHaveText("1");

    const sceneDescription = scene.getByLabel(/Description for Opening Dock/);
    const nestedDialogue = page.getByTestId("rf__node-node-dock-dialogue");
    await sceneDescription.hover();
    await expect(scene).not.toHaveClass(/issue-tooltip-active/);
    await expect(nestedDialogue).toBeVisible();
    const descriptionButton = scene.getByRole("button", { name: /Show description for Opening Dock/ });
    await descriptionButton.hover();
    await expect(page.getByRole("tooltip")).toHaveText("Show description");
    await descriptionButton.click();
    const descriptionPopover = page.getByRole("dialog", { name: /Opening Dock/ });
    await expect(descriptionPopover).toContainText("First playable scene where the embargo is revealed.");
    const popoverBounds = await descriptionPopover.boundingBox();
    expect(popoverBounds).not.toBeNull();
    expect(popoverBounds!.x).toBeGreaterThanOrEqual(0);
    expect(popoverBounds!.y).toBeGreaterThanOrEqual(0);
    expect(popoverBounds!.x + popoverBounds!.width).toBeLessThanOrEqual(viewport.width);
    expect(popoverBounds!.y + popoverBounds!.height).toBeLessThanOrEqual(viewport.height);
    await page.screenshot({ path: `/tmp/p36-frame-description-${viewport.width}x${viewport.height}.png` });
    await page.keyboard.press("Escape");
    await expect(descriptionPopover).not.toBeVisible();
    await expect(descriptionButton).toBeFocused();

    const customsOffice = page.getByTestId("rf__node-node-customs-office");
    const restingLocationLayer = await location.evaluate((node) => getComputedStyle(node).zIndex);
    await location.locator(".narrative-node-title").hover();
    expect(await location.evaluate((node) => getComputedStyle(node).zIndex)).toBe(restingLocationLayer);
    await expect(customsOffice).toBeVisible();
    await customsOffice.getByRole("button", { name: "Show description for Customs Office" }).hover();

    const linked = page.locator('.narrative-node[data-node-linked="true"]').first();
    await expect(linked.locator(".linked-instance-indicator")).toBeVisible();
    await linked.locator(".linked-instance-indicator").hover();
    await expect(linked.locator("xpath=..")).toHaveClass(/issue-tooltip-active/);
    await expect(page.getByRole("tooltip")).toHaveText("Linked visual instance");

    const issueBadge = minimumCard.locator(".issue-badge");
    const issuePreview = await issueBadge.getAttribute("data-preview");
    await issueBadge.hover();
    await expect(page.getByTestId("rf__node-node-hero")).toHaveClass(/issue-tooltip-active/);
    await expect(page.getByRole("tooltip")).toHaveText(issuePreview!);
    await page.screenshot({ path: `/tmp/p39-node-chrome-${viewport.width}x${viewport.height}.png` });

    await scene.getByRole("button", { name: /Collapse/ }).click();
    const collapsedScene = page.getByTestId("rf__node-node-opening");
    await expect(collapsedScene.locator(".narrative-node")).toHaveAttribute("data-node-frame-state", "collapsed");
    await expect(collapsedScene.locator(".frame-content-count")).toHaveText("6");
    const collapsedActionsFit = await collapsedScene.evaluate((wrapper) => {
      const title = wrapper.querySelector<HTMLElement>(".narrative-node-title")!;
      const bounds = title.getBoundingClientRect();
      return [...wrapper.querySelectorAll<HTMLElement>(".narrative-frame-actions > button")].every((button) => {
        const buttonBounds = button.getBoundingClientRect();
        return buttonBounds.left >= bounds.left - 1 && buttonBounds.right <= bounds.right + 1;
      });
    });
    expect(collapsedActionsFit).toBe(true);
  });
}

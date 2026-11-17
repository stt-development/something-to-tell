import { openAuroraFixture, openLegacyQuestFixture } from "./projectFixture";
import { expect, test } from "./temporaryProject";
import { selectFullNode } from "./canvasNodeInteractions";

test.use({ viewport: { width: 1440, height: 900 } });

/** Hand keeps graph content read-only, including keyboard and assistive clicks. */
for (const width of [1440, 1024]) {
test(`Hand preserves keyboard navigation and controls without graph mutations at ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 1440 ? 900 : 768 });
  await openAuroraFixture(page);
  await page.getByTitle("Projects").click();
  await page.locator(".react-flow__controls-fitview").click();
  await page.waitForTimeout(350);
  const hero = page.getByTestId("rf__node-node-hero");
  const edge = page.getByTestId("rf__edge-edge-hero-opening");
  await selectFullNode(hero);
  await page.getByRole("button", { name: "Pan canvas", exact: true }).click();
  await expect(hero).not.toHaveClass(/selected/);
  await expect(page.locator(".react-flow__pane")).toHaveCSS("cursor", "grab");
  expect(await page.locator(".react-flow__pane").evaluate((pane) => getComputedStyle(pane, "::after").content)).toBe('""');
  // Hit testing must stop at the original pane, not an overlay with new gestures.
  for (const target of [hero, edge]) {
    const bounds = await target.boundingBox();
    expect(bounds).not.toBeNull();
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.classList.contains("react-flow__pane"),
      { x: bounds!.x + bounds!.width / 2, y: bounds!.y + bounds!.height / 2 })).toBe(true);
  }
  const minimap = page.locator(".react-flow__minimap");
  const mapBounds = await minimap.boundingBox();
  expect(mapBounds).not.toBeNull();
  expect(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest(".react-flow__minimap")),
    { x: mapBounds!.x + mapBounds!.width / 2, y: mapBounds!.y + mapBounds!.height / 2 })).toBe(true);
  const positions = await page.locator(".react-flow__node").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("style")));
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/") && !["GET", "HEAD", "OPTIONS"].includes(request.method())) writes.push(request.url());
  });
  for (const target of [hero, edge]) {
    await target.focus();
    await expect(target).toBeFocused();
    for (const key of ["Enter", "Space", "ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Delete", "Backspace"]) {
      await page.keyboard.press(key);
      await expect(page.locator(".react-flow__node.selected, .react-flow__edge.selected")).toHaveCount(0);
    }
    // Assistive/programmatic click does not participate in CSS pointer hit testing.
    await target.evaluate((element) => element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    await expect(page.locator(".react-flow__node.selected, .react-flow__edge.selected")).toHaveCount(0);
  }
  await hero.focus();
  await page.keyboard.press("Tab");
  await expect(hero).not.toBeFocused();
  const viewport = page.locator(".react-flow__viewport");
  const before = await viewport.getAttribute("style");
  const box = await hero.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 45, box!.y + box!.height / 2 + 30, { steps: 6 });
  await page.mouse.up();
  expect(await viewport.getAttribute("style")).not.toBe(before);
  const fit = page.locator(".react-flow__controls-fitview");
  await fit.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(350);
  expect(await page.locator(".react-flow__node").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("style")))).toEqual(positions);
  expect(writes).toEqual([]);
  await page.screenshot({ path: test.info().outputPath(`p9-1-hand-canvas-${width}.png`) });
  await hero.focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Select", exact: true })).toHaveClass(/tool-button-active/);
  expect(await page.locator(".react-flow__pane").evaluate((pane) => getComputedStyle(pane, "::after").content)).toBe("none");
  await hero.focus();
  await page.keyboard.press("Enter");
  await expect(hero).toHaveClass(/selected/);
  await page.getByRole("button", { name: "Flow", exact: true }).click();
  await page.getByRole("button", { name: "Pan canvas", exact: true }).click();
  // Floating Flow controls remain above the pane's stacking context in Hand.
  const summary = page.locator(".flow-summary-panel");
  await expect(summary).toBeVisible();
  await summary.getByRole("button", { name: "Hide Flow summary", exact: true }).click();
  await expect(summary).toHaveCount(0);
  await page.getByRole("button", { name: "Show Flow summary", exact: true }).click();
  await expect(summary).toBeVisible();
  await page.screenshot({ path: test.info().outputPath(`p9-1-hand-flow-${width}.png`) });
});
}

test("marquee-selects and moves a hierarchy-safe group while alternate gestures pan", async ({ page }) => {
  await openAuroraFixture(page);
  await page.getByTitle("Projects").click();
  await page.locator(".react-flow__controls-fitview").click();
  await page.waitForTimeout(350);

  const hero = page.getByTestId("rf__node-node-hero");
  const faction = page.getByTestId("rf__node-node-trade-guild");
  const viewport = page.locator(".react-flow__viewport");
  await page.getByRole("button", { name: "Pan canvas" }).click();
  const viewportBeforeHandPan = await viewport.getAttribute("style");
  await page.mouse.move(1320, 300);
  await page.mouse.down();
  await page.mouse.move(1260, 350, { steps: 5 });
  await page.mouse.up();
  expect(await viewport.getAttribute("style")).not.toBe(viewportBeforeHandPan);
  await hero.click({ force: true });
  await expect(hero).not.toHaveClass(/selected/);
  await page.getByRole("button", { name: "Select" }).click();
  await page.locator(".react-flow__controls-fitview").click();
  await page.waitForTimeout(350);

  const heroBox = await hero.boundingBox();
  const factionBox = await faction.boundingBox();
  expect(heroBox).not.toBeNull();
  expect(factionBox).not.toBeNull();
  const start = { x: Math.min(heroBox!.x, factionBox!.x) - 8, y: Math.min(heroBox!.y, factionBox!.y) - 8 };
  const end = {
    x: Math.max(heroBox!.x + heroBox!.width, factionBox!.x + factionBox!.width) + 8,
    y: Math.max(heroBox!.y + heroBox!.height, factionBox!.y + factionBox!.height) + 8
  };

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await expect(page.locator(".react-flow__selection")).toBeVisible();
  await page.mouse.up();
  await expect(hero).toHaveClass(/selected/);
  await expect(faction).toHaveClass(/selected/);

  const edge = page.getByTestId("rf__edge-edge-hero-opening");
  const edgePath = edge.locator(".react-flow__edge-path");
  await edge.locator(".react-flow__edge-interaction").click({ force: true, modifiers: ["Shift"] });
  await page.keyboard.press("Delete");
  const deletionDialog = page.getByRole("heading", { name: "Delete selected elements" }).locator("xpath=ancestor::section");
  await expect(deletionDialog).toContainText("Mara Vale");
  await expect(deletionDialog).toContainText("owns");
  await deletionDialog.getByRole("button", { name: "Cancel" }).click();

  const edgeBefore = await edgePath.getAttribute("d");
  const heroBefore = await hero.boundingBox();
  const factionBefore = await faction.boundingBox();
  const persistedGroupMove = page.waitForResponse((response) => response.url().endsWith("/api/compositions/placements") && response.request().method() === "PUT");
  await page.mouse.move(heroBefore!.x + heroBefore!.width / 2, heroBefore!.y + heroBefore!.height / 2);
  await page.mouse.down();
  await page.mouse.move(heroBefore!.x + heroBefore!.width / 2 + 48, heroBefore!.y + heroBefore!.height / 2 + 24, { steps: 6 });
  await page.mouse.up();
  expect((await persistedGroupMove).status()).toBe(200);
  await page.waitForTimeout(300);
  const heroAfter = await hero.boundingBox();
  const factionAfter = await faction.boundingBox();
  expect(heroAfter!.x - heroBefore!.x).toBeGreaterThan(20);
  expect(heroAfter!.y - heroBefore!.y).toBeGreaterThan(10);
  expect(heroAfter!.x - heroBefore!.x).toBeCloseTo(factionAfter!.x - factionBefore!.x, 0);
  expect(heroAfter!.y - heroBefore!.y).toBeCloseTo(factionAfter!.y - factionBefore!.y, 0);
  expect(await edgePath.getAttribute("d")).not.toBe(edgeBefore);
  await expect(hero).toHaveClass(/selected/);
  await expect(faction).toHaveClass(/selected/);

  const viewportBefore = await viewport.getAttribute("style");
  await page.keyboard.down("Space");
  await page.mouse.move(1380, 200);
  await page.mouse.down();
  await page.mouse.move(1320, 250, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Space");
  expect(await viewport.getAttribute("style")).not.toBe(viewportBefore);
  await expect(hero).toHaveClass(/selected/);
  await expect(faction).toHaveClass(/selected/);

  const viewportAfterSpacePan = await viewport.getAttribute("style");
  await page.mouse.move(1380, 400);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(1320, 450, { steps: 5 });
  await page.mouse.up({ button: "middle" });
  expect(await viewport.getAttribute("style")).not.toBe(viewportAfterSpacePan);
  await expect(hero).toHaveClass(/selected/);
  await expect(faction).toHaveClass(/selected/);

  await page.keyboard.press("Escape");
  const scene = page.getByTestId("rf__node-node-opening");
  const dialogue = page.getByTestId("rf__node-node-dock-dialogue");
  await scene.click();
  await dialogue.click({ modifiers: ["Shift"] });
  const sceneBefore = await scene.boundingBox();
  const dialogueBefore = await dialogue.boundingBox();
  const relativeBefore = { x: dialogueBefore!.x - sceneBefore!.x, y: dialogueBefore!.y - sceneBefore!.y };
  await page.mouse.move(sceneBefore!.x + 24, sceneBefore!.y + 24);
  await page.mouse.down();
  await page.mouse.move(sceneBefore!.x + 64, sceneBefore!.y + 54, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const sceneAfter = await scene.boundingBox();
  const dialogueAfter = await dialogue.boundingBox();
  expect(dialogueAfter!.x - sceneAfter!.x).toBeCloseTo(relativeBefore.x, 0);
  expect(dialogueAfter!.y - sceneAfter!.y).toBeCloseTo(relativeBefore.y, 0);
});

/** Hover feedback must prefer the innermost frame, including invalid destinations. */
test("previews valid and invalid containment in the smallest intersecting frame", async ({ page }) => {
  await openAuroraFixture(page);
  await page.getByTitle("Projects").click();
  await page.locator(".react-flow__controls-fitview").click();
  await page.waitForTimeout(350);
  const destination = page.getByTestId("rf__node-node-customs-office");
  for (const [id, valid] of [["node-hero", true], ["node-dock-dialogue", false]] as const) {
    await selectFullNode(page.getByTestId(`rf__node-${id}`));
    const source = await page.getByTestId(`rf__node-${id}`).locator(".narrative-node-title-text").boundingBox();
    const target = await destination.boundingBox();
    expect(source).not.toBeNull();
    expect(target).not.toBeNull();
    const start = { x: source!.x + source!.width / 2, y: source!.y + source!.height / 2 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, { steps: 10 });
    await expect(destination.locator(".narrative-node")).toHaveClass(new RegExp(`narrative-frame-drop-${valid ? "valid" : "invalid"}`));
    await expect(destination.locator(".composition-drop-label")).toHaveText(valid ? "Placed in Customs Office" : "Location cannot contain Dialogue");
    await expect(page.locator(".composition-drop-label")).toHaveCount(1);
    await page.mouse.move(start.x, start.y, { steps: 10 });
    await page.mouse.up();
    await expect(page.locator(".composition-drop-label")).toHaveCount(0);
  }
});

/** Exercise the actual tree payload and canvas drop adapter, not just the placement helper. */
test("creates a linked instance from a project-tree drop into the innermost frame", async ({ page }) => {
  await openAuroraFixture(page);
  await page.locator(".react-flow__controls-fitview").click();
  await page.waitForTimeout(350);
  const source = page.getByRole("button", { name: "Character: Mara Vale", exact: true });
  const destination = page.getByTestId("rf__node-node-customs-office");
  const created = page.waitForResponse((response) => response.url().endsWith("/api/compositions/placements") && response.request().method() === "POST");
  await source.dragTo(destination);
  const response = await created;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toMatchObject({ canonical_node_id: "node-hero", container_node_id: "node-customs-office", is_primary: false });
  const snapshot = await response.json() as { placements: Array<{ id: string; canonical_node_id: string; container_node_id: string | null }> };
  const placement = snapshot.placements.find((item) => item.canonical_node_id === "node-hero" && item.container_node_id === "node-customs-office");
  expect(placement).toBeDefined();
  await expect(page.getByTestId(`rf__node-placement:${placement!.id}`).locator(".narrative-node")).toHaveAttribute("data-node-linked", "true");
  await expect(page.getByTestId("rf__node-node-hero")).toBeVisible();
});

/** Stage pointer handlers share the existing completion and Escape cancellation owner. */
test("draws a frame and cancels a second frame gesture with Escape", async ({ page }) => {
  await openAuroraFixture(page);
  await page.getByTitle("Projects").click();
  await page.locator(".react-flow__controls-fitview").click();
  await page.waitForTimeout(350);
  const locations = page.locator('.narrative-node[data-node-kind="Location"]');
  const before = await locations.count();
  let creations = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/compositions/frames")) creations += 1;
  });
  await page.getByRole("button", { name: "Location Frame", exact: true }).click();
  const pane = await page.locator(".react-flow__pane").boundingBox();
  expect(pane).not.toBeNull();
  const created = page.waitForResponse((response) => response.url().endsWith("/api/compositions/frames") && response.request().method() === "POST");
  await page.mouse.move(pane!.x + pane!.width - 230, pane!.y + 40);
  await page.mouse.down();
  await page.mouse.move(pane!.x + pane!.width - 30, pane!.y + 160, { steps: 8 });
  await expect(page.locator(".frame-draw-preview")).toBeVisible();
  await page.mouse.up();
  const response = await created;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toMatchObject({ kind: "Location" });
  await expect(locations).toHaveCount(before + 1);
  await expect(page.locator(".frame-draw-preview")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Select", exact: true })).toHaveClass(/tool-button-active/);
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Scene Frame", exact: true }).click();
  await page.mouse.move(pane!.x + 110, pane!.y + 40);
  await page.mouse.down();
  await page.mouse.move(pane!.x + 260, pane!.y + 110, { steps: 8 });
  await expect(page.locator(".frame-draw-preview")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".frame-draw-preview")).toHaveCount(0);
  await page.mouse.up();
  expect(creations).toBe(1);
});

/** Frame-ID actions keep their existing UI commands and placement persistence. */
test("adds a linked node then fits and toggles its frame through title actions", async ({ page }) => {
  await openAuroraFixture(page);
  await page.getByTitle("Projects").click();
  await page.locator(".react-flow__controls-fitview").click();
  await page.waitForTimeout(350);
  const scene = page.getByTestId("rf__node-node-opening");
  await selectFullNode(scene);
  await scene.getByRole("button", { name: "Add linked node to Opening Dock", exact: true }).click();
  const dialog = page.getByRole("heading", { name: "Add linked node to Opening Dock" }).locator("xpath=ancestor::section");
  const created = page.waitForResponse((response) => response.url().endsWith("/api/compositions/placements") && response.request().method() === "POST");
  await dialog.getByRole("button", { name: /Mara Vale/ }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toMatchObject({ canonical_node_id: "node-hero", container_node_id: "node-opening", is_primary: false });
  const snapshot = await response.json() as { placements: Array<{ id: string; canonical_node_id: string; container_node_id: string | null }> };
  const placement = snapshot.placements.find((item) => item.canonical_node_id === "node-hero" && item.container_node_id === "node-opening");
  expect(placement).toBeDefined();
  const framePlacement = snapshot.placements.find((item) => item.canonical_node_id === "node-opening");
  expect(framePlacement).toBeDefined();
  const linked = page.getByTestId(`rf__node-placement:${placement!.id}`);
  await expect(linked).toBeVisible();
  await expect(scene.locator(".frame-content-count")).toHaveText("7");

  const fit = page.waitForResponse((item) => item.url().endsWith("/api/compositions/placements") && item.request().method() === "PUT");
  await scene.getByRole("button", { name: "Fit content in Opening Dock", exact: true }).click();
  expect((await fit).status()).toBe(200);
  for (const [action, state] of [["Collapse", "collapsed"], ["Expand", "expanded"]] as const) {
    const saved = page.waitForResponse((item) => item.url().endsWith(`/api/compositions/placements/${encodeURIComponent(framePlacement!.id)}`) && item.request().method() === "PUT");
    await scene.getByRole("button", { name: `${action} Opening Dock`, exact: true }).click();
    expect((await saved).status()).toBe(200);
    await expect(scene.locator(".narrative-node")).toHaveAttribute("data-node-frame-state", state);
    await expect(linked).toHaveCount(state === "collapsed" ? 0 : 1);
    await expect(scene.locator(".frame-content-count")).toHaveText("7");
  }
  await expect(linked).toBeVisible();
  await expect(page.getByTestId("rf__node-node-hero")).toBeVisible();
  const collapsedBeforeFocus = page.waitForResponse((item) => item.url().endsWith(`/api/compositions/placements/${encodeURIComponent(framePlacement!.id)}`) && item.request().method() === "PUT");
  await scene.getByRole("button", { name: "Collapse Opening Dock", exact: true }).click();
  expect((await collapsedBeforeFocus).status()).toBe(200);
  await expect(scene.locator(".narrative-node")).toHaveAttribute("data-node-frame-state", "collapsed");
  const focusExpanded = page.waitForResponse((item) => item.url().endsWith(`/api/compositions/placements/${encodeURIComponent(framePlacement!.id)}`) && item.request().method() === "PUT");
  await scene.getByRole("button", { name: "Focus Opening Dock", exact: true }).click();
  expect((await focusExpanded).status()).toBe(200);
  await expect(page.getByLabel("Focused frame workspace", { exact: true })).toContainText("Opening Dock");
  await expect(scene.locator(".narrative-node")).toHaveAttribute("data-node-frame-state", "expanded");
  await expect(linked).toBeVisible();
  await expect(page.getByTestId("rf__node-node-hero")).toHaveCount(0);
  await page.getByRole("button", { name: "Exit focused frame workspace", exact: true }).click();
  await expect(page.getByTestId("rf__node-node-hero")).toBeVisible();
});

test("persists an Aurora Requirement and Quest click-selected group", async ({ page }) => {
  await openAuroraFixture(page);
  await page.getByTitle("Projects").click();
  await page.locator(".react-flow__controls-fitview").click();
  await page.waitForTimeout(350);

  const requirement = page.getByTestId("rf__node-node-ledger-condition");
  const quest = page.getByTestId("rf__node-node-smuggler-route");
  await requirement.click();
  await quest.click({ modifiers: ["Shift"] });
  await expect(requirement).toHaveClass(/selected/);
  await expect(quest).toHaveClass(/selected/);

  const requirementBefore = await requirement.boundingBox();
  const questBefore = await quest.boundingBox();
  const persisted = page.waitForResponse((response) =>
    response.url().endsWith("/api/compositions/placements")
    && response.request().method() === "PUT"
  );
  await page.mouse.move(
    requirementBefore!.x + requirementBefore!.width / 2,
    requirementBefore!.y + requirementBefore!.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(
    requirementBefore!.x + requirementBefore!.width / 2 + 54,
    requirementBefore!.y + requirementBefore!.height / 2 + 32,
    { steps: 6 }
  );
  await page.mouse.up();
  const persistedResponse = await persisted;
  expect(persistedResponse.status()).toBe(200);

  await page.waitForTimeout(300);
  const requirementAfter = await requirement.boundingBox();
  const questAfter = await quest.boundingBox();
  expect(requirementAfter!.x - requirementBefore!.x).toBeGreaterThan(30);
  expect(questAfter!.x - questBefore!.x).toBeCloseTo(
    requirementAfter!.x - requirementBefore!.x,
    0
  );

  const command = persistedResponse.request().postDataJSON() as {
    placements: Array<{ placement_id: string; position: { x: number; y: number } }>;
  };
  const persistedRequirement = command.placements.find((item) =>
    item.placement_id === "fixture-placement-node-ledger-condition"
  );
  expect(persistedRequirement).toBeDefined();
  const sessionId = persistedResponse.request().headers()["x-project-session-id"];
  const inspectedResponse = await page.request.get(
    `http://127.0.0.1:8719/api/project-sessions/${sessionId}`
  );
  expect(inspectedResponse.status()).toBe(200);
  const inspected = await inspectedResponse.json() as {
    document: { placements: Array<{ id: string; x: number; y: number }> };
  };
  const storedRequirement = inspected.document.placements.find((item) =>
    item.id === "fixture-placement-node-ledger-condition"
  );
  expect({ x: storedRequirement?.x, y: storedRequirement?.y }).toEqual(
    persistedRequirement!.position
  );

  await page.keyboard.press("Escape");
  await quest.click();
  const questSingleBefore = await quest.boundingBox();
  const persistedSingleQuest = page.waitForResponse((response) =>
    response.url().endsWith("/api/compositions/placements")
    && response.request().method() === "PUT"
  );
  await page.mouse.move(
    questSingleBefore!.x + questSingleBefore!.width / 2,
    questSingleBefore!.y + questSingleBefore!.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(
    questSingleBefore!.x + questSingleBefore!.width / 2 + 48,
    questSingleBefore!.y + questSingleBefore!.height / 2 + 26,
    { steps: 6 }
  );
  await page.mouse.up();
  expect((await persistedSingleQuest).status()).toBe(200);
  await page.waitForTimeout(3_000);
  const questSingleAfter = await quest.boundingBox();
  expect(questSingleAfter!.x - questSingleBefore!.x).toBeGreaterThan(25);
});

test("recovers a detached Graph session before persisting a Quest move", async ({ page }) => {
  let detachedSessionId: string | null = null;
  page.on("request", (request) => {
    detachedSessionId ??= request.headers()["x-project-session-id"] ?? null;
  });
  await openAuroraFixture(page);
  await page.getByRole("button", { name: "Graph", exact: true }).click();
  expect(detachedSessionId).toBeTruthy();
  const closed = await page.request.post(
    `http://127.0.0.1:8719/api/project-sessions/${detachedSessionId}/close`
  );
  expect(closed.status()).toBe(200);

  const quest = page.getByTestId("rf__node-node-smuggler-route");
  await page.locator(".react-flow__controls-fitview").click();
  await page.waitForTimeout(350);
  const before = await quest.boundingBox();
  const recovered = page.waitForResponse((response) =>
    response.url().endsWith("/api/project-sessions/open")
    && response.request().method() === "POST"
  );
  const persisted = page.waitForResponse((response) =>
    response.url().endsWith("/api/compositions/placements")
    && response.request().method() === "PUT"
    && response.request().headers()["x-project-session-id"] !== detachedSessionId
  );
  await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    before!.x + before!.width / 2 + 58,
    before!.y + before!.height / 2 + 32,
    { steps: 6 }
  );
  await page.mouse.up();

  expect((await recovered).status()).toBe(200);
  expect((await persisted).status()).toBe(200);
  await page.waitForTimeout(1_000);
  const after = await quest.boundingBox();
  expect(after!.x - before!.x).toBeGreaterThan(30);
});

test("creates the missing placement for legacy Quest ce9aa006 on its first Graph move", async ({ page }) => {
  await openLegacyQuestFixture(page);
  await page.getByRole("button", { name: "Graph", exact: true }).click();
  await page.locator(".react-flow__controls-fitview").click();
  await page.waitForTimeout(350);

  const quest = page.getByTestId("rf__node-ce9aa006-b53b-497c-ae62-76be28587a71");
  const before = await quest.boundingBox();
  const created = page.waitForResponse((response) =>
    response.url().endsWith("/api/compositions/placements")
    && response.request().method() === "POST"
  );
  await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    before!.x + before!.width / 2 + 64,
    before!.y + before!.height / 2 + 36,
    { steps: 6 }
  );
  await page.mouse.up();

  const response = await created;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toMatchObject({
    canonical_node_id: "ce9aa006-b53b-497c-ae62-76be28587a71"
  });
  await page.waitForTimeout(1_000);
  const after = await quest.boundingBox();
  expect(after!.x - before!.x).toBeGreaterThan(35);
});

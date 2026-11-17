import { openAuroraFixture } from "./projectFixture";
import { expect, test } from "./temporaryProject";
import { selectFullNode } from "./canvasNodeInteractions";

test.use({ viewport: { width: 1280, height: 800 } });

/** Prevents persistent default-catalog projects from colliding across E2E runs. */
function uniqueProjectName(prefix: string): string {
  return `${prefix} ${Date.now()} ${Math.random().toString(16).slice(2, 8)}`;
}

test("starts with an Event from the keyboard without creating a Scene", async ({ page, projectDirectory }) => {
  const projectName = uniqueProjectName("Event First Browser");
  await page.setViewportSize({ width: 1024, height: 720 });
  await page.goto("http://127.0.0.1:1420");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  const projectDialog = page.getByRole("heading", { name: "Create project" }).locator("..").locator("..");
  await projectDialog.getByLabel("Parent directory").fill(projectDirectory);
  await projectDialog.getByLabel("Name").fill(projectName);
  await projectDialog.getByRole("button", { name: "Create", exact: true }).click();

  const eventStarter = page.getByRole("button", { name: "Create story event" });
  await eventStarter.focus();
  await page.keyboard.press("Enter");

  await expect(page.getByLabel("Start empty project")).toBeHidden();
  await expect(page.getByRole("button", { name: "Flow", exact: true })).toHaveAttribute("aria-pressed", "true");
  const eventNode = page.getByTestId(/rf__node-/).filter({ hasText: "Opening Event" });
  await expect(eventNode).toBeVisible();
  await expect(page.locator(".narrative-node-frame")).toHaveCount(0);
  await expect(page.getByText("1 member / 0 transitions")).toBeVisible();
  await expect(page.locator("main > header").evaluate((header) => header.scrollWidth <= header.clientWidth)).resolves.toBe(true);
  await page.waitForTimeout(450);
  const eventNodeBox = await eventNode.boundingBox();
  const toolRailBox = await page.locator("nav").boundingBox();
  expect(eventNodeBox).not.toBeNull();
  expect(toolRailBox).not.toBeNull();
  expect(eventNodeBox!.x).toBeGreaterThanOrEqual(toolRailBox!.x + toolRailBox!.width + 8);
  expect(eventNodeBox!.x + eventNodeBox!.width).toBeLessThanOrEqual(1024);
  await page.screenshot({ path: "/tmp/p37-event-first-minimum-desktop.png" });
});

test("builds world content before explicitly creating a Story Flow", async ({ page, projectDirectory }) => {
  const projectName = uniqueProjectName("World First Browser");
  await page.setViewportSize({ width: 1024, height: 720 });
  await page.goto("http://127.0.0.1:1420");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  const projectDialog = page.getByRole("heading", { name: "Create project" }).locator("..").locator("..");
  await projectDialog.getByLabel("Parent directory").fill(projectDirectory);
  await projectDialog.getByLabel("Name").fill(projectName);
  await projectDialog.getByRole("button", { name: "Create", exact: true }).click();

  await page.getByRole("button", { name: "Build world" }).click();
  const worldDialog = page.getByRole("heading", { name: "Build world" }).locator("..").locator("..");
  await worldDialog.getByLabel("Name").fill("Founding Myth");
  await worldDialog.getByLabel("Description").fill("A disputed origin story.");
  await worldDialog.getByRole("button", { name: "Create node" }).click();

  await expect(page.getByRole("button", { name: "Graph", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("No Story Flows")).toBeVisible();
  await expect(page.getByRole("button", { name: "Lore: Founding Myth" })).toBeVisible();
  await expect(page.getByText("1 node / 0 relations / 0 transitions")).toBeVisible();
  const worldNode = page.getByTestId(/rf__node-/).filter({ hasText: "Founding Myth" });
  // Graph fit runs after the creation dialog closes; measure only once its viewport settles.
  await page.waitForTimeout(450);
  const worldNodeBox = await worldNode.boundingBox();
  const toolRailBox = await page.locator("nav").boundingBox();
  expect(worldNodeBox).not.toBeNull();
  expect(toolRailBox).not.toBeNull();
  expect(worldNodeBox!.x).toBeGreaterThanOrEqual(toolRailBox!.x + toolRailBox!.width + 8);

  await page.getByRole("button", { name: "Create Story Flow" }).click();
  const flowDialog = page.getByRole("heading", { name: "Create Story Flow" }).locator("..").locator("..");
  await flowDialog.getByLabel("Name").fill("Main Story");
  await flowDialog.getByLabel("Kind").selectOption("main");
  await flowDialog.getByRole("button", { name: "Create flow", exact: true }).click();

  await expect(page.getByRole("button", { name: "Open Story Flow Main Story" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Lore: Founding Myth" })).toBeVisible();
  await expect(page.locator(".story-flow-edge-label")).toHaveCount(0);
  await page.screenshot({ path: "/tmp/p37-worldbuilding-first-minimum-desktop.png" });
});

test("creates a Scene-first project without overlapping desktop controls", async ({ page, projectDirectory }) => {
  const projectName = uniqueProjectName("Browser Aurora");
  await page.goto("http://127.0.0.1:1420");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  const projectDialog = page.getByRole("heading", { name: "Create project" }).locator("..").locator("..");
  await projectDialog.getByLabel("Parent directory").fill(projectDirectory);
  await projectDialog.getByLabel("Name").fill(projectName);
  await projectDialog.getByRole("button", { name: "Create", exact: true }).click();

  const starter = page.getByLabel("Start empty project");
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();
  await expect(starter).toBeVisible();
  await expect(page.getByRole("button", { name: "Create first scene" })).toBeFocused();
  const starterBox = await starter.boundingBox();
  const railBox = await page.locator("aside.absolute").boundingBox();
  expect(starterBox && railBox && starterBox.x).toBeGreaterThan(railBox!.x + railBox!.width);
  await page.screenshot({ path: "/tmp/p37-empty-project-chooser.png" });

  await page.getByRole("button", { name: "Create first scene" }).click();
  await expect(starter).toBeHidden();
  await expect(page.getByRole("button", { name: "Flow", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Open Story Flow Main Story" })).toBeVisible();
  await expect(page.getByText("1 member / 0 transitions")).toBeVisible();
  await expect(page.locator(".flow-role-entry").getByText("Entry")).toBeVisible();

  await page.waitForTimeout(450);
  const viewport = page.viewportSize()!;
  const toolRailBox = await page.locator("nav").boundingBox();
  for (const node of await page.locator(".react-flow__node").all()) {
    const box = await node.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(toolRailBox!.x + toolRailBox!.width + 8);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  }
  await page.screenshot({ path: "/tmp/p37-empty-project-scene.png" });
});

/** Card entry/boundary actions preserve canonical sources and persist current Scene details. */
test("saves an Aurora Scene boundary and replaces the Flow entry from Graph cards", async ({ page }) => {
  await openAuroraFixture(page);
  await page.getByTitle("Projects").click();
  await page.locator(".react-flow__controls-fitview").click();
  await page.waitForTimeout(350);
  const scene = page.getByTestId("rf__node-node-opening");
  await selectFullNode(scene);
  await expect(scene.getByLabel("Scene Flow boundary", { exact: true })).toContainText("Entry: Dockmaster Warning");
  await scene.getByRole("button", { name: "Configure Scene flow for Opening Dock", exact: true }).click();
  const boundary = page.getByRole("heading", { name: "Scene flow: Opening Dock" }).locator("xpath=ancestor::section");
  await boundary.getByLabel("Entry child").selectOption("node-sealed-ledger");
  await boundary.getByRole("checkbox", { name: "Dockmaster Warning", exact: true }).uncheck();
  await boundary.getByRole("checkbox", { name: "Sealed Ledger", exact: true }).check();
  const bounded = page.waitForResponse((response) => response.url().endsWith("/api/story-flows/flow-main-story/scenes/node-opening/boundary") && response.request().method() === "PUT");
  await boundary.getByRole("button", { name: "Save boundary", exact: true }).click();
  const savedBoundary = await bounded;
  expect(savedBoundary.status()).toBe(200);
  expect(savedBoundary.request().postDataJSON()).toMatchObject({ entry_node_id: "node-sealed-ledger", exit_node_ids: ["node-sealed-ledger"] });
  await expect(boundary).toHaveCount(0);
  await expect(scene.getByLabel("Scene Flow boundary", { exact: true })).toContainText("Entry: Sealed Ledger");
  await expect(scene.getByLabel("Scene Flow boundary", { exact: true })).toContainText("1 exit");
  const ledger = page.getByTestId("rf__node-node-sealed-ledger");
  await selectFullNode(ledger);
  await ledger.getByRole("button", { name: "Set Sealed Ledger as flow entry", exact: true }).click();
  const confirmation = page.getByRole("heading", { name: "Replace Story Flow entry" }).locator("xpath=ancestor::section");
  await expect(confirmation).toContainText("Both nodes and every membership remain unchanged");
  const entered = page.waitForResponse((response) => response.url().endsWith("/api/story-flows/flow-main-story/entry") && response.request().method() === "POST");
  await confirmation.getByRole("button", { name: "Set entry", exact: true }).click();
  const savedEntry = await entered;
  expect(savedEntry.status()).toBe(200);
  expect(savedEntry.request().postDataJSON()).toMatchObject({ node_id: "node-sealed-ledger" });
  await expect(confirmation).toHaveCount(0);
  await expect(ledger.getByLabel("Story Flow role", { exact: true })).toContainText("Entry");
  await page.screenshot({ path: "/tmp/p91-scene-boundary-summary.png" });
});

/** Member card actions keep current call/exit sources through successive authoring updates. */
test("creates an Aurora Flow call and terminal named exit from Graph cards", async ({ page }) => {
  await openAuroraFixture(page);
  await page.getByTitle("Projects").click();
  await page.locator(".react-flow__controls-fitview").click();
  await page.waitForTimeout(350);
  const source = page.getByTestId("rf__node-node-opening");
  await selectFullNode(source);
  await source.getByRole("button", { name: "Call a Story Flow from Opening Dock", exact: true }).click();
  const callDialog = page.getByRole("heading", { name: "Call a Story Flow from Opening Dock" }).locator("xpath=ancestor::section");
  await callDialog.getByLabel("Called Story Flow").selectOption("flow-smuggler-route");
  await callDialog.getByLabel("Label", { exact: true }).fill("Review the harbor route");
  const called = page.waitForResponse((response) => response.url().endsWith("/api/flow-composition/invocations") && response.request().method() === "POST");
  await callDialog.getByRole("button", { name: "Create call", exact: true }).click();
  const invocation = await called;
  expect(invocation.status()).toBe(201);
  expect(invocation.request().postDataJSON()).toMatchObject({ source_flow_id: "flow-main-story", source_node_id: "node-opening", target_flow_id: "flow-smuggler-route" });
  const createdInvocation = await invocation.json() as { id: string };
  const bindings = page.getByRole("heading", { name: "Returns from Smuggler Route" }).locator("xpath=ancestor::section");
  await bindings.getByRole("button", { name: "Close dialog", exact: true }).click();
  await source.getByRole("button", { name: "Edit call Review the harbor route", exact: true }).click();
  const success = bindings.getByLabel("Return target for success", { exact: true });
  await success.selectOption("node-route-consequence");
  const bound = page.waitForResponse((response) => response.url().endsWith("/api/flow-composition/bindings") && response.request().method() === "POST");
  await success.locator("..").getByRole("button", { name: "Bind return", exact: true }).click();
  const savedBinding = await bound;
  expect(savedBinding.status()).toBe(201);
  expect(savedBinding.request().postDataJSON()).toMatchObject({ invocation_id: createdInvocation.id, target_node_id: "node-route-consequence" });
  await expect(success.locator("..").getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await bindings.getByRole("button", { name: "Close dialog", exact: true }).click();
  await source.getByRole("button", { name: "Create named exit from Opening Dock", exact: true }).click();
  const exitDialog = page.getByRole("heading", { name: "Named exit from Opening Dock" }).locator("xpath=ancestor::section");
  await exitDialog.getByLabel("Exit key").fill("reviewed_exit");
  await exitDialog.getByLabel("Label", { exact: true }).fill("Harbor reviewed");
  const exited = page.waitForResponse((response) => response.url().endsWith("/api/flow-composition/exits") && response.request().method() === "POST");
  await exitDialog.getByRole("button", { name: "Create named exit", exact: true }).click();
  const flowExit = await exited;
  expect(flowExit.status()).toBe(409);
  expect(await flowExit.json()).toMatchObject({ detail: { code: "composable_flow_exit_not_terminal" } });
  await expect(exitDialog.getByRole("alert")).toContainText(/terminal/i);
  await exitDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  const terminal = page.getByTestId("rf__node-node-sealed-ledger");
  await selectFullNode(terminal);
  await terminal.getByRole("button", { name: "Create named exit from Sealed Ledger", exact: true }).click();
  const terminalDialog = page.getByRole("heading", { name: "Named exit from Sealed Ledger" }).locator("xpath=ancestor::section");
  await expect(terminalDialog.getByRole("alert")).toHaveCount(0);
  await terminalDialog.getByLabel("Exit key").fill("reviewed_exit");
  await terminalDialog.getByLabel("Label", { exact: true }).fill("Harbor reviewed");
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/flow-composition/exits") && response.request().method() === "POST");
  await terminalDialog.getByRole("button", { name: "Create named exit", exact: true }).click();
  const terminalExit = await saved;
  expect(terminalExit.status()).toBe(201);
  expect(terminalExit.request().postDataJSON()).toMatchObject({ flow_id: "flow-main-story", source_node_id: "node-sealed-ledger", key: "reviewed_exit" });
  await expect(terminalDialog).toHaveCount(0);
  await selectFullNode(source);
  await expect(source.locator(".flow-call-status")).toContainText("Review the harbor route");
  await selectFullNode(terminal);
  await expect(terminal).toContainText("Harbor reviewed");
  await expect(terminal.locator(".flow-exit-status")).toHaveText("Harbor reviewed");
  await page.screenshot({ path: "/tmp/p91-flow-exit-lists.png" });
});

test("opens Aurora call bindings from a Flow card and restores its focus", async ({ page }) => {
  await openAuroraFixture(page);
  await page.getByTitle("Projects").click();
  await page.getByRole("button", { name: "Flow", exact: true }).click();
  const source = page.getByTestId("rf__node-node-inspection");
  const opener = source.getByRole("button", { name: "Edit call Call the covert harbor route", exact: true });
  await opener.click();
  const bindings = page.getByRole("heading", { name: "Returns from Smuggler Route" }).locator("xpath=ancestor::section");
  await expect(bindings.getByLabel("Return target for success", { exact: true })).toHaveValue("node-route-consequence");
  await bindings.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(opener).toBeFocused();
  await opener.click();
  await expect(bindings.getByLabel("Return target for success", { exact: true })).toHaveValue("node-route-consequence");
  await bindings.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(opener).toBeFocused();
  await page.screenshot({ path: "/tmp/p91-flow-call-lists.png" });
});

/** Node actions retain canonical membership and continuation commands after eligibility changes. */
test("adds an Aurora node to Main Story and continues it from Graph", async ({ page }) => {
  await openAuroraFixture(page);
  await page.getByTitle("Projects").click();
  await page.locator(".react-flow__controls-fitview").click();
  await page.waitForTimeout(350);
  const hero = page.getByTestId("rf__node-node-hero");
  await selectFullNode(hero);
  const joined = page.waitForResponse((response) => response.url().endsWith("/api/story-flows/flow-main-story/nodes") && response.request().method() === "POST");
  await hero.getByRole("button", { name: "Add Mara Vale to Main Story", exact: true }).click();
  const membership = await joined;
  expect(membership.status()).toBe(201);
  expect(membership.request().postDataJSON()).toMatchObject({ node_id: "node-hero" });
  await expect(hero.getByRole("button", { name: "Add Mara Vale to Main Story", exact: true })).toHaveCount(0);
  await hero.getByRole("button", { name: "Continue from Mara Vale", exact: true }).click();
  const dialog = page.getByRole("heading", { name: "Continue from Mara Vale" }).locator("xpath=ancestor::section");
  await dialog.getByLabel("Target node").selectOption("node-sealed-ledger");
  await dialog.getByLabel("Label", { exact: true }).fill("Audit the ledger");
  const continued = page.waitForResponse((response) => response.url().endsWith("/api/story-flows/flow-main-story/continue-existing") && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "Add continuation", exact: true }).click();
  const continuation = await continued;
  expect(continuation.status()).toBe(201);
  expect(continuation.request().postDataJSON()).toMatchObject({ source_node_id: "node-hero", target_node_id: "node-sealed-ledger" });
  await expect(dialog).toHaveCount(0);
  await expect(hero.getByRole("button", { name: "Continue from Mara Vale", exact: true })).toBeVisible();
});

test("authors a Project Aurora continuation from the Flow workspace", async ({ page }) => {
  await openAuroraFixture(page);
  await page.getByRole("button", { name: "Flow", exact: true }).click();
  await expect(page.getByLabel("Main Story members")).toBeVisible();
  const viewport = page.viewportSize()!;
  for (const overlay of [page.locator(".react-flow__controls"), page.locator(".react-flow__minimap")]) {
    const box = await overlay.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
  }
  await page.getByLabel("Main Story members").getByRole("button", { name: "Harbor Inspection", exact: true }).click();
  await page.waitForTimeout(400);
  const focusedNode = await page.getByTestId("rf__node-node-inspection").boundingBox();
  const flowCanvas = await page.locator(".flow-canvas").boundingBox();
  expect(focusedNode).not.toBeNull();
  expect(flowCanvas).not.toBeNull();
  expect(Math.abs((focusedNode!.x + focusedNode!.width / 2) - (flowCanvas!.x + flowCanvas!.width / 2))).toBeLessThan(12);
  expect(Math.abs((focusedNode!.y + focusedNode!.height / 2) - (flowCanvas!.y + flowCanvas!.height / 2))).toBeLessThan(12);
  await expect(page.getByRole("button", { name: "Continue from Opening Dock" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Continue from Opening Dock" }).first().click();

  const dialog = page.getByRole("heading", { name: "Continue from Opening Dock" }).locator("..").locator("..");
  await expect(dialog.getByLabel("Target node")).toBeVisible();
  await dialog.getByLabel("Transition").selectOption("branch");
  await dialog.getByLabel("Condition").fill("customs_cleared");
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
  await page.screenshot({ path: "/tmp/p37-continue-with.png" });
});

test("inspects Project Aurora containment and integrity without overlapping controls", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAuroraFixture(page);

  await expect(page.getByRole("button", { name: "Graph", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Composition", exact: true })).toHaveCount(0);
  const scene = page.getByTestId("rf__node-node-opening");
  const dialogue = page.getByTestId("rf__node-node-dock-dialogue");
  const sceneBox = await scene.boundingBox();
  const dialogueBox = await dialogue.boundingBox();
  expect(sceneBox).not.toBeNull();
  expect(dialogueBox).not.toBeNull();
  expect(dialogueBox!.x).toBeGreaterThan(sceneBox!.x);
  expect(dialogueBox!.y).toBeGreaterThan(sceneBox!.y);
  expect(dialogueBox!.x + dialogueBox!.width).toBeLessThan(sceneBox!.x + sceneBox!.width);
  expect(dialogueBox!.y + dialogueBox!.height).toBeLessThan(sceneBox!.y + sceneBox!.height);

  await page.getByRole("button", { name: "Flow", exact: true }).click();
  const integrity = page.getByRole("region", { name: "Flow summary", exact: true });
  await expect(integrity).toContainText("Unreachable Member");
  const integrityBox = await integrity.boundingBox();
  expect(integrityBox).not.toBeNull();
  expect(integrityBox!.x + integrityBox!.width).toBeLessThanOrEqual(1440);
  expect(integrityBox!.y + integrityBox!.height).toBeLessThanOrEqual(900);
  await page.screenshot({ path: "/tmp/p37-project-aurora-containment-integrity.png" });
});

test("configures Scene boundaries and reviews specialized outcome ordering", async ({ page }) => {
  await openAuroraFixture(page);
  await page.getByRole("button", { name: "Flow", exact: true }).click();

  const opening = page.getByTestId("rf__node-node-opening");
  await expect(opening.getByLabel("Scene Flow boundary")).toContainText("Entry: Dockmaster Warning");
  await opening.getByRole("button", { name: "Configure Scene flow for Opening Dock" }).click();
  const boundary = page.getByRole("heading", { name: "Scene flow: Opening Dock" }).locator("..").locator("..");
  await expect(boundary.getByLabel("Entry child")).toHaveValue("node-dock-dialogue");
  await expect(boundary.getByRole("checkbox", { name: "Dockmaster Warning" })).toBeChecked();
  await boundary.getByRole("button", { name: "Close dialog" }).click();

  await page.getByTestId("rf__node-node-dock-dialogue").dblclick();
  const dialogue = page.getByRole("heading", { name: "Edit dialogue: Dockmaster Warning" }).locator("..").locator("..");
  await expect(dialogue.getByRole("button", { name: "Blockade Outcome" })).toBeVisible();
  await dialogue.getByRole("button", { name: "Blockade Outcome" }).click();
  const outcome = page.getByRole("heading", { name: "Outcome and Story Flow" }).locator("..").locator("..");
  await expect(outcome.getByLabel("Parent Story Flow")).toHaveValue("flow-main-story");
  await expect(outcome.getByLabel("Called Story Flow")).toHaveValue("flow-z-blockade-outcome");
  await expect(outcome.getByRole("button", { name: "Use Story Flow call" })).toBeVisible();
  await page.screenshot({ path: "/tmp/p37-scene-outcome-flow.png" });
});

test("keeps Dialogue fields aligned and expands style review across the wide editor", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAuroraFixture(page);
  await page.getByTestId("rf__node-node-dock-dialogue").dblclick();
  const dialog = page.getByRole("heading", { name: "Edit dialogue: Dockmaster Warning" }).locator("xpath=ancestor::section[1]");

  const firstLine = dialog.locator("article").filter({ hasText: "line-dockmaster-warning" }).first();
  const speakerBox = await firstLine.getByLabel("Speaker").boundingBox();
  const lineTextBox = await firstLine.getByRole("textbox", { name: "Text", exact: true }).boundingBox();
  expect(speakerBox).not.toBeNull();
  expect(lineTextBox).not.toBeNull();
  expect(Math.abs(speakerBox!.y - lineTextBox!.y)).toBeLessThanOrEqual(1);

  const choice = dialog.locator("article").filter({ hasText: "choice-mara-response" }).first();
  const answerBox = await choice.getByRole("textbox", { name: "Answer 1" }).boundingBox();
  const conditionBox = await choice.getByPlaceholder("Optional").first().boundingBox();
  const nextBox = await choice.getByLabel("Next").first().boundingBox();
  expect(answerBox).not.toBeNull();
  expect(conditionBox).not.toBeNull();
  expect(nextBox).not.toBeNull();
  expect(Math.abs(answerBox!.y - conditionBox!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(answerBox!.y - nextBox!.y)).toBeLessThanOrEqual(1);

  const outcomes = dialog.getByLabel("Outcomes for line-mara-orders-run");
  const outcomeLabelBox = await outcomes.getByLabel("Outcome label").boundingBox();
  const mainStoryBox = await outcomes.getByTitle("Choose whether this outcome defines story order").boundingBox();
  expect(outcomeLabelBox).not.toBeNull();
  expect(mainStoryBox).not.toBeNull();
  expect(Math.abs(outcomeLabelBox!.y - mainStoryBox!.y)).toBeLessThanOrEqual(1);
  expect(mainStoryBox!.height).toBe(outcomeLabelBox!.height);

  await dialog.getByRole("button", { name: "Get style recommendation: Text for Dockmaster Warning" }).click();
  const request = page.getByLabel("Style recommendation");
  await expect(request).toBeVisible();
  const styleDialog = request.locator("xpath=ancestor::section[1]");
  const dialogBox = await styleDialog.boundingBox();
  const requestBox = await request.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(requestBox).not.toBeNull();
  expect(requestBox!.width).toBeGreaterThanOrEqual(dialogBox!.width - 42);
  await page.screenshot({ path: "/tmp/p6-dialogue-style-review-wide.png" });
});

test("reviews an existing progression relationship before converting it", async ({ page }) => {
  await openAuroraFixture(page);
  await page.getByRole("button", { name: "Review progression migrations" }).click();

  const dialog = page.getByRole("heading", { name: "Review progression migrations" }).locator("..").locator("..");
  const candidate = dialog.getByRole("article", { name: /Migration candidate reopens the legal route/ });
  await expect(candidate).toContainText("Confirm membership additions: Smuggler Route");
  await candidate.getByLabel("Transition type").selectOption("next");
  await candidate.getByRole("button", { name: "Accept conversion" }).click();

  await expect(candidate).toBeHidden();
  await expect(dialog.getByLabel("Migration decision history")).toContainText("reopens the legal route");
  await expect(page.getByRole("button", { name: "Open Story Flow Main Story" })).toContainText("6 members");
  await expect(page.getByText("16 nodes / 10 relations / 4 transitions")).toBeVisible();
  await page.screenshot({ path: "/tmp/p37-reviewed-progression-migration.png" });
});

test("authors an active Story Flow from the unified Graph workspace", async ({ page }) => {
  await openAuroraFixture(page);

  const graphMode = page.getByRole("button", { name: "Graph", exact: true });
  await expect(graphMode).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("group", { name: "Graph connection type" })).toHaveCount(0);
  await expect(page.getByText("16 nodes / 10 relations / 5 transitions")).toBeVisible();
  // React Flow suppresses the container-to-direct-child route in the nested
  // Graph projection; three transitions and one call route remain visible.
  await expect(page.locator(".story-flow-edge-label")).toHaveCount(4);

  // Selecting another flow changes the Graph overlay without navigating away.
  await page.getByRole("button", { name: "Open Story Flow Smuggler Route" }).click();
  await expect(graphMode).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("16 nodes / 10 relations / 5 transitions")).toBeVisible();
  await expect(page.locator(".story-flow-edge-label")).toHaveCount(5);

  // Connection ownership is chosen after the gesture, where its effect is clear.
  const sourceHandle = page.getByTestId("rf__node-node-trade-guild").locator(".narrative-handle-right");
  const targetNode = page.getByTestId("rf__node-node-sealed-ledger");
  await sourceHandle.hover();
  const sourceBox = await sourceHandle.boundingBox();
  const targetBox = await targetNode.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 8 });
  await page.mouse.up();
  const connectionDialog = page.getByRole("heading", { name: "Create connection" }).locator("..").locator("..");
  await expect(connectionDialog.getByRole("button", { name: /Relationship/ })).toBeVisible();
  await page.screenshot({ path: "/tmp/p37-connection-choice.png" });
  await connectionDialog.getByRole("button", { name: /Story transition/ }).click();
  const continuationDialog = page.getByRole("heading", { name: "Continue from Trade Guild" }).locator("..").locator("..");
  await expect(continuationDialog.getByLabel("Target node")).toHaveValue("node-sealed-ledger");
  await continuationDialog.getByRole("button", { name: "Cancel" }).click();

  // The denser Graph header must remain inside the desktop viewport.
  const headerFits = await page.locator("main > header").evaluate((header) => header.scrollWidth <= header.clientWidth);
  expect(headerFits).toBe(true);
  await page.screenshot({ path: "/tmp/p37-unified-graph.png" });
});

/** Exercise React Flow's reconnect anchors against persisted relationship commands. */
test("reconnects a relationship endpoint and deletes it when detached onto empty canvas", async ({ page }) => {
  await openAuroraFixture(page);
  await page.getByTitle("Projects").click();
  await page.locator(".react-flow__controls-fitview").click();
  await page.waitForTimeout(500);
  const relation = page.getByTestId("rf__edge-edge-guild-ledger");
  const source = relation.locator(".react-flow__edgeupdater-source");
  await source.hover();
  const sourceBox = await source.boundingBox();
  const destination = await page.getByTestId("rf__node-node-hero").locator(".narrative-handle-bottom").boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(destination).not.toBeNull();
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/edges/edge-guild-ledger") && response.request().method() === "PUT");
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(destination!.x + destination!.width / 2, destination!.y + destination!.height / 2, { steps: 8 });
  await page.mouse.up();
  const response = await saved;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON()).toMatchObject({ source_node_id: "node-hero", target_node_id: "node-sealed-ledger" });
  await expect(relation).toHaveAttribute("aria-label", "Edge from node-hero to node-sealed-ledger");
  await expect(page.locator(".narrative-node-connecting-source, .narrative-node-connecting-target")).toHaveCount(0);

  const target = relation.locator(".react-flow__edgeupdater-target");
  await target.hover();
  const targetBox = await target.boundingBox();
  const pane = await page.locator(".react-flow__pane").boundingBox();
  expect(targetBox).not.toBeNull();
  expect(pane).not.toBeNull();
  const removed = page.waitForResponse((result) => result.url().endsWith("/api/edges/edge-guild-ledger") && result.request().method() === "DELETE");
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(pane!.x + pane!.width - 40, pane!.y + 60, { steps: 8 });
  await page.mouse.up();
  expect((await removed).ok()).toBe(true);
  await expect(relation).toHaveCount(0);
  await expect(page.locator(".narrative-node-connecting-source, .narrative-node-connecting-target")).toHaveCount(0);
});

/** A body drop must use Flow routing and clear gesture feedback before review. */
test("routes a new body-drop connection through the current Flow workspace", async ({ page }) => {
  await openAuroraFixture(page);
  await page.getByRole("button", { name: "Flow", exact: true }).click();
  await page.getByTitle("Projects").click();
  await page.locator(".react-flow__controls-fitview").click();
  // Mode switching schedules a delayed animated fit; sample endpoints after it.
  await page.waitForTimeout(500);
  const statistics = page.locator("main > header p").first();
  const before = await statistics.innerText();
  const source = page.getByTestId("rf__node-node-inspection");
  const target = page.getByTestId("rf__node-node-sealed-ledger");
  const handle = source.locator(".narrative-handle-right");
  await handle.hover();
  const sourceBox = await handle.boundingBox();
  const targetBox = await target.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 8 });
  await expect(source.locator(".narrative-node")).toHaveClass(/narrative-node-connecting-source/);
  await expect(target.locator(".narrative-node")).toHaveClass(/narrative-node-connecting-target/);
  await page.mouse.up();
  const dialog = page.getByRole("heading", { name: "Continue from Harbor Inspection" }).locator("..").locator("..");
  await expect(dialog.getByLabel("Target node")).toHaveValue("node-sealed-ledger");
  await expect(page.getByRole("heading", { name: "Create connection", exact: true })).toHaveCount(0);
  await expect(page.locator(".narrative-node-connecting-source, .narrative-node-connecting-target")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(statistics).toHaveText(before);
});

test("reads and edits the selected flow as a Story document", async ({ page }) => {
  await openAuroraFixture(page);
  await page.getByRole("button", { name: "Story", exact: true }).click();

  const story = page.getByLabel("Story document");
  await expect(page.getByRole("button", { name: "Story", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(story.getByRole("heading", { name: "Main Story" })).toBeVisible();
  await expect(story.locator(".story-route-label strong").filter({ hasText: /^Present the ledger$/ })).toBeVisible();
  await expect(story.getByRole("region", { name: "Called Story Flow: Blockade Outcome" })).toContainText("Mara runs the blockade");
  await expect(story.getByRole("region", { name: "Named exit: Patrol exposes the route" })).toContainText("Returns to Sealed Ledger");
  await expect(page.locator(".react-flow")).toHaveCount(0);

  const opening = story.getByRole("article", { name: "Scene: Opening Dock" });
  await opening.getByRole("button", { name: "Edit Opening Dock inline" }).click();
  await opening.getByLabel("Description").fill("Edited directly in the Story document.");
  await opening.getByRole("button", { name: "Save text" }).click();
  await expect(opening).toContainText("Edited directly in the Story document.");

  const storyBox = await story.boundingBox();
  const railBox = await page.locator("aside.absolute").boundingBox();
  expect(storyBox).not.toBeNull();
  expect(railBox).not.toBeNull();
  expect(storyBox!.x).toBeGreaterThanOrEqual(railBox!.x + railBox!.width);
  const headerFits = await page.locator("main > header").evaluate((header) => header.scrollWidth <= header.clientWidth);
  expect(headerFits).toBe(true);
  await page.screenshot({ path: "/tmp/p37-story-document.png", fullPage: true });

  await story.getByRole("button", { name: "Open Dockmaster Warning in Flow" }).click();
  await expect(page.getByRole("button", { name: "Flow", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("rf__node-node-dock-dialogue")).toBeVisible();
});

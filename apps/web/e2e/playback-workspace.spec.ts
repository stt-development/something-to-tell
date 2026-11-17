import { openAuroraFixture } from "./projectFixture";
import { expect, test } from "./temporaryProject";
import type { Page } from "@playwright/test";

/** Verifies the production reciprocal route labels after React Flow transforms. */
async function expectReciprocalRouteLabelsSeparated(page: Page) {
  const circle = page.locator(".story-flow-edge-label").filter({ hasText: "Circle back past the patrol" });
  const take = page.locator(".story-flow-edge-label").filter({ hasText: "Take the covert route" });
  const [circleBox, takeBox] = await Promise.all([circle.boundingBox(), take.boundingBox()]);
  expect(circleBox).not.toBeNull();
  expect(takeBox).not.toBeNull();
  const overlaps = circleBox!.x < takeBox!.x + takeBox!.width
    && circleBox!.x + circleBox!.width > takeBox!.x
    && circleBox!.y < takeBox!.y + takeBox!.height
    && circleBox!.y + circleBox!.height > takeBox!.y;
  const centerDistance = Math.hypot(
    circleBox!.x + circleBox!.width / 2 - takeBox!.x - takeBox!.width / 2,
    circleBox!.y + circleBox!.height / 2 - takeBox!.y - takeBox!.height / 2
  );
  expect(overlaps).toBe(false);
  expect(centerDistance).toBeGreaterThan(40);
}

/** Keeps every Flow label in a route corridor rather than beneath a node card. */
async function expectFlowLabelsClearOfNodes(page: Page) {
  const collisions = await page.evaluate(() => {
    const labels = [...document.querySelectorAll<HTMLElement>(".flow-canvas .story-flow-edge-label")];
    const nodes = [...document.querySelectorAll<HTMLElement>(".flow-canvas .react-flow__node")];
    return labels.flatMap((label) => {
      const left = label.getBoundingClientRect();
      return nodes.flatMap((node) => {
        const right = node.getBoundingClientRect();
        const overlaps = left.left < right.right - 2 && left.right > right.left + 2
          && left.top < right.bottom - 2 && left.bottom > right.top + 2;
        return overlaps ? [`${label.textContent ?? "label"} / ${node.getAttribute("data-id") ?? "node"}`] : [];
      });
    });
  });
  expect(collisions).toEqual([]);
}

test.use({ viewport: { width: 1280, height: 800 } });
test.beforeEach(async ({ page }) => {
  await openAuroraFixture(page);
});

test("shows production Aurora state changes at specialized Story positions", async ({ page }) => {
  await page.getByRole("button", { name: "Story", exact: true }).click();
  const story = page.getByLabel("Story document");

  await expect(story).toHaveAttribute("data-temporal-effect-count", "4");
  await expect(story.getByText("Ilya returns the Sealed Ledger to Mara after accepting its proof.").first()).toBeVisible();
  await expect(story.getByText("Choosing the blockade outcome completes the Smuggler Route quest.").first()).toBeVisible();
  await expect(story.getByText("The Sealed Ledger becomes a party quest reward.").first()).toBeVisible();
  await expect(story.getByText("The party hands the Ledger to the player before returning to Main Story.").first()).toBeVisible();
});

test("authors and navigates the composed Project Aurora flow", async ({ page }) => {
  await page.getByRole("button", { name: "Flow", exact: true }).click();
  await expect(page.getByText("7 members / 5 transitions")).toBeVisible();

  const memberList = page.getByLabel("Main Story members");
  const memberCallButton = memberList.getByRole("button", { name: "Call a Story Flow from Harbor Inspection" });
  await memberCallButton.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Call a Story Flow from Harbor Inspection");
  await expect(memberCallButton.locator("xpath=..").evaluate((member) => getComputedStyle(member).overflow)).resolves.toBe("visible");
  await page.screenshot({ path: "/tmp/p310-flow-member-tooltip.png" });

  const source = page.getByTestId("rf__node-node-inspection");
  await expect(source.locator(".flow-call-status")).toContainText("Call the covert harbor route");
  const callButton = source.getByRole("button", { name: "Call a Story Flow from Harbor Inspection" });
  await expect(callButton).toHaveAttribute("data-tooltip", "Call a Story Flow from Harbor Inspection");
  await callButton.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Call a Story Flow from Harbor Inspection");
  const exitButton = source.getByRole("button", { name: "Create named exit from Harbor Inspection" });
  await exitButton.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Create named exit from Harbor Inspection");
  await page.screenshot({ path: "/tmp/p310-flow-action-tooltip.png" });
  const overlapReport = await page.evaluate(() => {
    const rects = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
      .map((element) => ({ label: element.getAttribute("aria-label") ?? element.getAttribute("data-id") ?? element.textContent ?? "", rect: element.getBoundingClientRect() }))
      .filter((item) => item.rect.width > 0 && item.rect.height > 0);
    const labels = rects(".flow-canvas .story-flow-edge-label");
    const nodes = rects(".flow-canvas .react-flow__node");
    const overlaps = (left: DOMRect, right: DOMRect) =>
      left.left < right.right - 2 && left.right > right.left + 2
      && left.top < right.bottom - 2 && left.bottom > right.top + 2;
    return {
      labelPairs: labels.flatMap((left, index) => labels.slice(index + 1)
        .filter((right) => overlaps(left.rect, right.rect))
        .map((right) => `${left.label} / ${right.label}`)),
      labelsOnNodes: labels.flatMap((label) => nodes
        .filter((node) => overlaps(label.rect, node.rect))
        .map((node) => `${label.label} / ${node.label}`))
    };
  });
  expect(overlapReport).toEqual({ labelPairs: [], labelsOnNodes: [] });
  const canvasBox = await page.locator(".flow-canvas").boundingBox();
  const summaryBox = await page.getByRole("region", { name: "Flow summary", exact: true }).boundingBox();
  expect(canvasBox).not.toBeNull();
  expect(summaryBox).not.toBeNull();
  expect(summaryBox!.x).toBeGreaterThanOrEqual(canvasBox!.x);
  expect(summaryBox!.x + summaryBox!.width).toBeLessThanOrEqual(canvasBox!.x + canvasBox!.width);
  await callButton.focus();
  await callButton.click();
  const callDialog = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Call a Story Flow from Harbor Inspection" })
  });
  await expect(callDialog.getByLabel("Called Story Flow")).toHaveValue("flow-smuggler-route");
  await callDialog.getByRole("button", { name: "Close dialog" }).click();
  await expect(callButton).toBeFocused();

  const callRoute = page.getByTestId("rf__edge-flow-invocation:flow-invocation-inspection-smuggler-route");
  // A perfectly horizontal SVG path has a zero-height bounding box in Chromium,
  // so assert its rendered geometry and separately rely on the visible label.
  await expect(callRoute.locator(".react-flow__edge-path")).toHaveAttribute("d", /^M.+L.+/);
  await expect(page.locator(".story-flow-invocation").filter({ hasText: "Call the covert harbor route" })).toBeVisible();
  const editCall = source.getByRole("button", { name: "Edit call Call the covert harbor route" });
  await editCall.focus();
  await page.keyboard.press("Enter");
  const bindings = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Returns from Smuggler Route" })
  });
  await expect(bindings.getByLabel("Return target for success")).toHaveValue("node-route-consequence");
  await bindings.getByRole("button", { name: "Open called flow" }).click();
  await expect(page.getByRole("region", { name: "Flow summary", exact: true })).toContainText("Smuggler Route");
  await expect(page.getByText("Patrol evaded")).toBeVisible();
  await expect(page.getByTestId("rf__edge-story-flow:flow-transition-blockade-cycle").locator(".react-flow__edge-path"))
    .toHaveAttribute("d", /^M.+C.+/);
  await expectReciprocalRouteLabelsSeparated(page);
  await expectFlowLabelsClearOfNodes(page);
  await page.screenshot({ path: "/tmp/p310-composable-flow-authoring.png" });
  await page.getByRole("button", { name: "Graph", exact: true }).click();
  await expect(page.locator(".relationship-edge-label").filter({ hasText: "starts the blockade run" })).toBeVisible();
  await expectReciprocalRouteLabelsSeparated(page);
  await page.screenshot({ path: "/tmp/p311-reciprocal-labels-graph.png" });
  await page.getByRole("button", { name: "Flow", exact: true }).click();

  // Let the one-shot projection fit finish before validating explicit user zoom.
  await page.waitForTimeout(350);
  const zoomIndicator = page.locator(".canvas-zoom-control");
  const zoomOut = page.locator(".react-flow__controls-zoomout");
  for (let index = 0; index < 40 && await zoomOut.isEnabled(); index += 1) {
    await zoomOut.click();
    await page.waitForTimeout(20);
  }
  await expect.poll(() => page.locator(".react-flow__viewport").evaluate((viewport) => viewport.getAttribute("style")))
    .toContain("scale(0.01)");
  await expect(zoomIndicator).toHaveText("1%");
  await expect(zoomIndicator).toHaveAttribute("data-visible", "true");
  await page.waitForTimeout(750);
  await expect(zoomIndicator).toHaveAttribute("data-visible", "false");
  const zoomIn = page.locator(".react-flow__controls-zoomin");
  for (let index = 0; index < 60 && await zoomIn.isEnabled(); index += 1) {
    await zoomIn.click();
    await page.waitForTimeout(20);
  }
  await expect.poll(() => page.locator(".react-flow__viewport").evaluate((viewport) => viewport.getAttribute("style")))
    .toContain("scale(10)");
  await expect(zoomIndicator).toHaveText("1000%");
  await expect(zoomIndicator).toHaveAttribute("data-visible", "true");
});

test("keeps the Flow canvas full-size beneath its floating summary panel", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 700 });
  await page.getByRole("button", { name: "Flow", exact: true }).click();

  const canvasBox = await page.locator(".flow-canvas").boundingBox();
  const summary = page.getByRole("region", { name: "Flow summary", exact: true });
  const summaryBox = await summary.boundingBox();
  expect(canvasBox).not.toBeNull();
  expect(summaryBox).not.toBeNull();
  expect(summaryBox!.x).toBeGreaterThanOrEqual(canvasBox!.x);
  expect(summaryBox!.x + summaryBox!.width).toBeLessThanOrEqual(canvasBox!.x + canvasBox!.width);
  const toolRailBox = await page.locator(".tool-rail").boundingBox();
  expect(toolRailBox).not.toBeNull();
  expect(toolRailBox!.x + toolRailBox!.width).toBeLessThanOrEqual(summaryBox!.x);

  await summary.getByRole("button", { name: "Hide Flow summary" }).click();
  await expect(summary).toHaveCount(0);
  const collapsedCanvasBox = await page.locator(".flow-canvas").boundingBox();
  const stageBox = await page.locator(".workspace-stage").boundingBox();
  expect(collapsedCanvasBox).not.toBeNull();
  expect(stageBox).not.toBeNull();
  expect(collapsedCanvasBox!.y).toBe(stageBox!.y);
  expect(collapsedCanvasBox!.height).toBe(canvasBox!.height);
  expect(collapsedCanvasBox!.width).toBe(canvasBox!.width);

  await page.getByRole("button", { name: "Show Flow summary" }).click();
  await expect(summary).toBeVisible();
  const reopenedCanvasBox = await page.locator(".flow-canvas").boundingBox();
  const reopenedSummaryBox = await summary.boundingBox();
  expect(reopenedCanvasBox).not.toBeNull();
  expect(reopenedSummaryBox).not.toBeNull();
  expect(reopenedCanvasBox!.y).toBe(stageBox!.y);
  expect(reopenedCanvasBox!.width).toBe(canvasBox!.width);
  expect(reopenedSummaryBox!.x).toBeGreaterThanOrEqual(reopenedCanvasBox!.x);
  expect(reopenedSummaryBox!.x + reopenedSummaryBox!.width).toBeLessThanOrEqual(reopenedCanvasBox!.x + reopenedCanvasBox!.width);
  await page.waitForTimeout(1200);
  await expect(page.locator(".canvas-zoom-control")).toHaveAttribute("data-visible", "false");
  await page.screenshot({ path: "/tmp/p310-compact-flow-layout.png" });
});

test("creates, reuses, cancels, and deletes specialized outcome calls", async ({ page }) => {
  const atomicRequests: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/flow-composition/outcomes/new-side-flow")) {
      atomicRequests.push(request.url());
    }
  });
  await page.getByTestId("rf__node-node-dock-dialogue").dblclick({ force: true });
  let editor = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Edit dialogue: Dockmaster Warning" })
  });
  let outcomes = editor.getByLabel("Outcomes for line-mara-orders-run");

  await outcomes.getByRole("button", { name: "Blockade Outcome" }).click();
  await expect(page.getByRole("button", { name: "Existing side flow" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText(/already references the selected call/)).toBeVisible();
  await page.getByRole("button", { name: "Keep semantic only" }).click();
  await expect(editor).toBeVisible();

  await outcomes.getByRole("button", { name: "Blockade Outcome" }).click();
  await page.getByRole("button", { name: "New side flow" }).click();
  await page.getByRole("textbox", { name: "Side flow name" }).fill("E2E Dialogue Outcome");
  await page.getByRole("button", { name: "Use Story Flow call" }).click();
  await expect(page.getByRole("button", { name: "Open Story Flow E2E Dialogue Outcome" })).toBeVisible();
  expect(atomicRequests).toHaveLength(1);

  outcomes = editor.getByLabel("Outcomes for line-mara-orders-run");
  await outcomes.getByRole("button", { name: "E2E Dialogue Outcome" }).click();
  await expect(page.getByRole("button", { name: "Existing side flow" })).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: "/tmp/p310-specialized-outcome-call.png" });
  await page.getByRole("button", { name: "Keep semantic only" }).click();
  await outcomes.getByRole("button", { name: "Delete outcome edge-dialogue-blockade" }).click();
  const impact = outcomes.getByRole("alert");
  await expect(impact).toContainText("1 call(s), and 0 return binding(s)");
  await page.screenshot({ path: "/tmp/p310-specialized-outcome-deletion.png" });
  await impact.getByRole("button", { name: "Delete" }).click();
  await expect(outcomes).toContainText("Outcomes (0)");

  await editor.getByRole("button", { name: "Close dialog" }).click();
  await page.getByTestId("rf__node-node-smuggler-route").dblclick({ force: true });
  const quest = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Edit quest: Smuggler Route" })
  });
  const questOutcomes = quest.getByLabel("Outcomes for branch-legal-route");
  await questOutcomes.getByRole("button", { name: "Add to flow" }).click();
  await page.getByRole("button", { name: "New side flow" }).click();
  await page.getByRole("textbox", { name: "Side flow name" }).fill("E2E Legal Route");
  await page.getByRole("button", { name: "Use Story Flow call" }).click();
  await expect(page.getByRole("button", { name: "Open Story Flow E2E Legal Route" })).toBeVisible();
});

test("expands composed flows inside the Story document", async ({ page }) => {
  await page.getByRole("button", { name: "Story", exact: true }).click();

  const document = page.getByLabel("Story document");
  const calledFlow = page.getByLabel("Called Story Flow: Smuggler Route");
  await expect(calledFlow).toBeVisible();
  await expect(calledFlow.getByLabel("Flow breadcrumbs")).toContainText("Main Story");
  await expect(calledFlow.getByLabel("Flow breadcrumbs")).toContainText("Smuggler Route");
  await expect(page.getByLabel("Named exit: Patrol evaded")).toContainText("Returns to Route Reopened");
  await expect(page.getByLabel("Named exit: Patrol exposes the route")).toContainText("Returns to Sealed Ledger");
  await expect(page.getByLabel("Named exit: Covert route abandoned")).toContainText("Returns to Dockmaster Warning");
  await expect(page.getByLabel("Quest: Smuggler Route").first()).toBeVisible();

  const layout = await document.evaluate((element) => {
    const beats = [...element.querySelectorAll<HTMLElement>(".story-document-beat")];
    const widths = beats.map((beat) => beat.getBoundingClientRect().width);
    return {
      overflows: element.scrollWidth > element.clientWidth,
      widthSpread: widths.length === 0 ? 0 : Math.max(...widths) - Math.min(...widths)
    };
  });
  expect(layout).toEqual({ overflows: false, widthSpread: 0 });
  await calledFlow.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/p310-expanded-story-flow.png" });

  await calledFlow.getByRole("button", { name: "Collapse called flow Smuggler Route" }).click();
  await expect(page.getByLabel("Quest: Smuggler Route")).toHaveCount(0);
  await expect(page.getByLabel("Named exit: Patrol evaded")).toHaveCount(0);
  await calledFlow.getByRole("button", { name: "Expand called flow Smuggler Route" }).click();
  await expect(page.getByLabel("Quest: Smuggler Route").first()).toBeVisible();

  await calledFlow.getByRole("button", { name: "Open Smuggler Route" }).click();
  await expect(page.getByRole("button", { name: "Flow", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("region", { name: "Flow summary", exact: true })).toContainText("Smuggler Route");
});

test("plays the branching Project Aurora route as a full workspace", async ({ page }) => {
  const play = page.getByRole("button", { name: "Play Main Story" });
  await play.click();

  const workspace = page.getByLabel("Playback workspace");
  await expect(workspace).toBeVisible();
  await expect(page.getByLabel("Scene slide: Opening Dock")).toBeVisible();
  await page.getByRole("button", { name: "Diagnostics", exact: true }).click();
  await page.getByRole("tab", { name: "State" }).click();
  await expect(page.getByLabel("Playback state")).toContainText("Character: Ilya Voss");
  await page.getByRole("button", { name: "Close diagnostics" }).click();
  await expect(workspace.evaluate((element) =>
    element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight
  )).resolves.toBe(true);

  await page.getByRole("button", { name: /Begin inspection/ }).click();
  await expect(page.getByLabel("Dialogue slide: Dockmaster Warning")).toBeVisible();
  await expect(page.getByText("Choose a reply")).toBeVisible();
  await expect(page.getByRole("button", { name: /Order the crew to run the blockade/ })).toBeEnabled();

  await page.getByRole("button", { name: /Show Ilya the sealed ledger/ }).click();
  await expect(page.locator(".playback-live-status")).toContainText(
    "Selected reply in Dockmaster Warning"
  );
  await expect(page.getByLabel("Dialogue slide content")).toContainText("Those seals are genuine");
  await expect(page.getByLabel("Latest state changes")).toContainText("Ilya returns the Sealed Ledger to Mara");
  await page.getByRole("button", { name: /Present the ledger/ }).click();
  await expect(page.locator(".playback-live-status")).toContainText(
    "Advanced to Harbor Inspection"
  );
  await expect(page.getByLabel("Event slide: Harbor Inspection")).toBeVisible();
  await page.getByRole("button", { name: /Embargo disproved/ }).click();
  await expect(page.getByText("Ending reached", { exact: true })).toBeVisible();
  await page.screenshot({ path: "/tmp/p38-slide-playback-ending.png" });
  await page.getByRole("button", { name: "Diagnostics", exact: true }).click();
  await page.getByRole("tab", { name: "Facts" }).click();
  await expect(page.getByLabel("Playback facts")).toContainText("ending reached");
  await page.getByLabel("Playback facts").getByRole("button", { name: "Open source" }).click();
  await expect(page.getByRole("heading", { name: "Edit node" })).toBeVisible();
  await expect(page.getByLabel("Label")).toHaveValue("Route Reopened");
  await page.getByTitle("Close dialog").click();
  await page.getByRole("button", { name: "Return to Playback" }).click();

  await page.getByRole("button", { name: "Exit Playback" }).click();
  await expect(page.getByRole("button", { name: "Graph", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Play Main Story" })).toBeFocused();
});

test("traverses the Aurora side-flow call and returns to Main", async ({ page }) => {
  await page.getByRole("button", { name: "Play Main Story" }).click();
  await page.getByRole("button", { name: /Begin inspection/ }).click();
  await page.getByRole("button", { name: /Show Ilya the sealed ledger/ }).click();
  await page.getByRole("button", { name: /Present the ledger/ }).click();

  const call = page.getByRole("button", { name: /Call the covert harbor route/ });
  await expect(call).toBeEnabled();
  await call.click();
  await expect(page.getByLabel("Quest slide: Smuggler Route")).toBeVisible();
  await expect(page.getByLabel("Call depth 1")).toContainText("Inside Smuggler Route");
  await page.screenshot({ path: "/tmp/p310-composed-playback-call.png" });

  await page.getByRole("button", { name: /Take the covert route/ }).click();
  await expect(page.getByLabel("Event slide: Mara Runs the Blockade")).toBeVisible();
  await page.getByRole("button", { name: "Diagnostics", exact: true }).click();
  await page.getByRole("tab", { name: "State" }).click();
  await expect(page.getByLabel("Playback state")).toContainText("Party");
  await expect(page.getByLabel("Playback state")).toContainText("completed");
  await page.getByRole("button", { name: "Close diagnostics" }).click();
  await page.getByRole("button", { name: /Rejoin the harbor outcome/ }).click();
  await expect(page.getByLabel("Outcome slide: Route Reopened")).toBeVisible();
  await expect(page.getByText("Ending reached", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Call depth 1")).toHaveCount(0);

  await page.getByRole("button", { name: "Diagnostics", exact: true }).click();
  await page.getByRole("tab", { name: "State" }).click();
  await expect(page.getByLabel("Playback state")).toContainText("Player");
  await page.getByRole("tab", { name: "Trace" }).click();
  const operations = page.getByLabel("Composed Flow operations").last();
  await expect(operations).toContainText("exit");
  await expect(operations).toContainText("return");
  await page.screenshot({ path: "/tmp/p310-composed-playback-return.png" });
  await page.getByRole("button", { name: "Diagnostics", exact: true }).click();

  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByLabel("Event slide: Mara Runs the Blockade")).toBeVisible();
  await expect(page.getByLabel("Call depth 1")).toBeVisible();
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect(page.getByLabel("Scene slide: Opening Dock")).toBeVisible();
  await expect(page.getByLabel("Call depth 1")).toHaveCount(0);
});

test("returns from the Aurora side flow through its failure outcome", async ({ page }) => {
  await page.getByRole("button", { name: "Play Main Story" }).click();
  await page.getByRole("button", { name: /Begin inspection/ }).click();
  await page.getByRole("button", { name: /Show Ilya the sealed ledger/ }).click();
  await page.getByRole("button", { name: /Present the ledger/ }).click();
  await page.getByRole("button", { name: /Call the covert harbor route/ }).click();
  await page.getByRole("button", { name: /Take the covert route/ }).click();
  await page.getByRole("button", { name: /Patrol identifies the ship/ }).click();

  await expect(page.getByLabel("Item slide: Sealed Ledger")).toBeVisible();
  await expect(page.getByLabel("Call depth 1")).toHaveCount(0);
  await page.getByRole("button", { name: "Diagnostics", exact: true }).click();
  const operations = page.getByLabel("Composed Flow operations").last();
  await expect(operations).toContainText("Patrol exposes the route");
  await expect(operations).toContainText("return");
});

test("keeps the playback slide and choices usable on minimum desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 720 });
  await page.getByRole("button", { name: "Play Main Story" }).click();
  await page.getByRole("button", { name: /Begin inspection/ }).click();

  const workspace = page.getByLabel("Playback workspace");
  const slide = page.getByLabel("Dialogue slide: Dockmaster Warning");
  const choices = page.getByLabel("Playback choices");
  for (const region of [workspace, slide, choices]) {
    const box = await region.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(1024);
    expect(box!.y + box!.height).toBeLessThanOrEqual(720);
  }
  await expect(workspace.evaluate((element) => element.scrollWidth <= element.clientWidth)).resolves.toBe(true);
  await page.getByRole("button", { name: "Diagnostics" }).click();
  const diagnostics = page.getByLabel("Playback diagnostics");
  const diagnosticBox = await diagnostics.boundingBox();
  expect(diagnosticBox).not.toBeNull();
  expect(diagnosticBox!.x).toBeGreaterThanOrEqual(0);
  expect(diagnosticBox!.y).toBeGreaterThanOrEqual(64);
  expect(diagnosticBox!.x + diagnosticBox!.width).toBeLessThanOrEqual(1024);
  expect(diagnosticBox!.y + diagnosticBox!.height).toBeLessThanOrEqual(720);
  await expect(page.locator(".playback-header").evaluate((element) => element.scrollWidth <= element.clientWidth)).resolves.toBe(true);
  await page.screenshot({ path: "/tmp/p38-playback-diagnostics-minimum-desktop.png" });
});

test("plays the linear Project Aurora side route", async ({ page }) => {
  await page.getByRole("button", { name: "Open Story Flow Smuggler Route" }).click();
  await page.getByRole("button", { name: "Play Smuggler Route" }).click();

  await expect(page.getByLabel("Quest slide: Smuggler Route")).toBeVisible();
  await page.getByRole("button", { name: "Open source in Edit" }).click();
  await expect(page.getByRole("heading", { name: "Edit quest: Smuggler Route" })).toBeVisible();
  await page.getByTitle("Close dialog").click();
  await page.getByRole("button", { name: "Return to Playback" }).click();
  await page.getByRole("button", { name: /Take the covert route/ }).click();
  await expect(page.getByLabel("Event slide: Mara Runs the Blockade")).toBeVisible();
  await page.getByRole("button", { name: "Diagnostics" }).click();
  await page.getByRole("tab", { name: "State" }).click();
  await expect(page.getByLabel("Playback state")).toContainText("Smuggler Route");
  await expect(page.getByLabel("Playback state")).toContainText("completed");
  await page.getByRole("tab", { name: "Trace" }).click();
  await page.getByLabel("Playback trace").getByRole("button", {
    name: /Open effect source: Choosing the blockade outcome/
  }).click();
  await expect(page.getByRole("heading", { name: "Edit quest: Smuggler Route" })).toBeVisible();
  await page.getByTitle("Close dialog").click();
  await page.getByRole("button", { name: "Return to Playback" }).click();
  await page.getByRole("button", { name: /Rejoin the harbor outcome/ }).click();
  await expect(page.getByText("Exit reached: Patrol evaded", { exact: true })).toBeVisible();
  await expect(page.getByText("Direct Flow result: success", { exact: true })).toBeVisible();
});

test("navigates diagnostics, back, and restart from the keyboard", async ({ page }) => {
  await page.getByRole("button", { name: "Play Main Story" }).click();
  const firstChoice = page.getByRole("button", { name: /Begin inspection/ });
  await firstChoice.focus();
  await page.keyboard.press("Enter");

  await page.getByRole("button", { name: "Diagnostics" }).click();
  await expect(page.getByLabel("Playback trace")).toContainText("Step 1");
  await expect(page.getByLabel("Playback trace")).toContainText("Begin inspection");
  await expect(page.getByLabel("Playback trace")).toContainText("No state changes");
  await page.getByRole("tab", { name: "State" }).click();
  await expect(page.getByLabel("Playback state")).toContainText("Sealed Ledger");
  await expect(page.getByLabel("Playback state")).toContainText("Character: Ilya Voss");
  await page.getByRole("button", { name: "Close diagnostics" }).click();

  await page.getByRole("button", { name: /Show Ilya the sealed ledger/ }).click();
  await page.getByRole("button", { name: /Present the ledger/ }).click();
  const back = page.getByRole("button", { name: "Back", exact: true });
  await back.focus();
  await back.click();
  await expect(page.getByLabel("Dialogue slide: Dockmaster Warning")).toBeVisible();
  await back.click();
  await expect(page.getByRole("button", { name: /Present the ledger/ })).toBeVisible();
  await back.click();
  await expect(page.getByRole("button", { name: /Show Ilya the sealed ledger/ })).toBeVisible();
  await expect(back).toBeDisabled();
  await page.getByRole("button", { name: "Restart" }).click();
  await expect(page.getByLabel("Scene slide: Opening Dock")).toBeVisible();
  await expect(back).toBeDisabled();

  await page.getByRole("button", { name: /Begin inspection/ }).click();
  await page.getByRole("button", { name: "Restart" }).click();
  await expect(page.getByLabel("Scene slide: Opening Dock")).toBeVisible();
  await expect(page.getByText("Restarted at Opening Dock.")).toBeVisible();
});

test("plays the default Flow call selected by an internal Dialogue reply", async ({ page }) => {
  await page.getByRole("button", { name: "Play Main Story" }).click();
  await page.getByRole("button", { name: /Begin inspection/ }).click();
  await page.getByRole("button", { name: /Order the crew to run the blockade/ }).click();

  await expect(page.getByLabel("Dialogue slide content")).toContainText(
    "Full power, and keep the inspection boats in our wake."
  );
  const call = page.getByRole("button", { name: /Mara runs the blockade/ });
  await expect(call).toBeEnabled();
  await call.click();
  await expect(page.getByLabel("Outcome slide: Route Reopened")).toBeVisible();
  await page.getByRole("button", { name: "Diagnostics" }).click();
  await expect(page.getByLabel("Playback diagnostics")).toContainText("call");
  await expect(page.getByLabel("Playback diagnostics")).toContainText("exit");
  await expect(page.getByLabel("Playback diagnostics")).toContainText("return");
});

test("round-trips unchanged sources and requires restart after an authored edit", async ({ page }) => {
  await page.getByRole("button", { name: "Play Main Story" }).click();
  await page.getByRole("button", { name: /Begin inspection/ }).click();

  await page.getByRole("button", { name: "Open source in Story" }).click();
  const storyBeats = page.getByLabel("Dialogue: Dockmaster Warning");
  await expect.poll(async () => storyBeats.evaluateAll((items) => items.some((item) => item === document.activeElement))).toBe(true);
  await page.getByRole("button", { name: "Return to Playback" }).click();
  await expect(page.getByLabel("Dialogue slide: Dockmaster Warning")).toBeVisible();

  await page.getByRole("button", { name: "Open source in Graph" }).click();
  await page.getByTestId("rf__node-node-opening").dblclick();
  const editor = page.getByRole("heading", { name: "Edit node" }).locator("..").locator("..");
  await editor.getByRole("textbox", { name: "Text", exact: true }).fill("Revised during the browser Playback round trip.");
  await editor.getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: "Return to Playback" }).click();

  await expect(page.getByLabel("Playback blocked")).toContainText("Authored source changed");
  await expect(page.getByRole("button", { name: "Back", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Restart" }).click();
  await expect(page.getByLabel("Scene slide: Opening Dock")).toContainText(
    "Revised during the browser Playback round trip."
  );
  await expect(page.getByRole("button", { name: "Back", exact: true })).toBeDisabled();
});

test("blocks and locates a repeated one-time Quest outcome", async ({ page }) => {
  await page.getByRole("button", { name: "Open Story Flow Smuggler Route" }).click();
  await page.getByRole("button", { name: "Play Smuggler Route" }).click();

  await page.getByRole("button", { name: /Take the covert route/ }).click();
  await page.getByRole("button", { name: /Circle back past the patrol/ }).click();
  await page.getByRole("button", { name: /Take the covert route/ }).click();

  await expect(page.getByLabel("Playback blocked")).toContainText("was already applied");
  await page.getByLabel("Playback blocked").getByRole("button", { name: "Open source" }).first().click();
  await expect(page.getByRole("heading", { name: "Edit quest: Smuggler Route" })).toBeVisible();
});

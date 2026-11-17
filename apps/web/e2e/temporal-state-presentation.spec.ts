import { openTemporalStateFixture } from "./projectFixture";
import { expect, test } from "./temporaryProject";

test.use({ viewport: { width: 1280, height: 800 } });

test("presents ordered state changes at transitions, calls, and exits", async ({ page }) => {
  const snapshot = await openTemporalStateFixture(page);
  expect(snapshot.effects).toHaveLength(5);
  expect(snapshot.bindings).toHaveLength(5);
  await page.getByRole("button", { name: "Story", exact: true }).click();
  const story = page.getByLabel("Story document");
  await expect(story).toHaveAttribute("data-temporal-effect-count", "5");
  const inspection = story.getByRole("article", { name: "Event: Harbor Inspection" });
  const playerChange = inspection.locator(".story-temporal-effects").filter({ hasText: "The player receives the sealed ledger." });
  const maraChange = inspection.locator(".story-temporal-effects").filter({ hasText: "Mara receives the sealed ledger." });

  await expect(story.getByText("Mara receives the sealed ledger.").first()).toBeVisible();
  await expect(playerChange).toContainText("Ilya Voss");
  await expect(playerChange).toContainText("Player");
  await expect(maraChange).toContainText("Player");
  await expect(maraChange).toContainText("Mara Vale");

  const call = story.getByRole("region", { name: "Called Story Flow: Smuggler Route" }).filter({ hasText: "Call the covert harbor route" }).first();
  await expect(call.locator(":scope > .story-temporal-effects")).toContainText("The covert route becomes known.");
  const exit = story.getByRole("region", { name: "Named exit: Patrol evaded" }).first();
  await expect(exit.locator(".story-exit-effects")).toContainText("The covert route is completed before return.");
  await expect(exit.evaluate((element) => {
    const effects = element.querySelector(".story-exit-effects");
    const returnButton = element.querySelector('button[aria-label="Open return target"]');
    return Boolean(effects && returnButton && (effects.compareDocumentPosition(returnButton) & Node.DOCUMENT_POSITION_FOLLOWING));
  })).resolves.toBe(true);

  // Source navigation must resolve the exact owner instead of opening a generic editor.
  await call.getByRole("button", { name: "Open source" }).click();
  await expect(page.getByRole("button", { name: "Flow", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("rf__edge-flow-invocation:flow-invocation-inspection-smuggler-route")).toBeVisible();
});

test("separates the selected-step state overlay from authored Graph relationships", async ({ page }) => {
  const snapshot = await openTemporalStateFixture(page);
  expect(snapshot.effects).toHaveLength(5);
  await page.getByTestId("rf__node-node-inspection").click();
  const overlay = page.getByLabel("Selected-step temporal state");

  await expect(overlay).toContainText("The inspection is ready.");
  await expect(overlay).toContainText("Mara receives the sealed ledger.");
  await expect(page.getByTestId("rf__edge-temporal-state:binding-inspection-custody")).toBeVisible();
  await expect(page.locator('[data-testid^="rf__edge-"]')).not.toHaveCount(0);
  await expect(overlay.evaluate((element) => element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight)).resolves.toBe(true);
});

test("shows persisted Item custody in the Playback state panel", async ({ page }) => {
  await openTemporalStateFixture(page);
  const prepareResponse = page.waitForResponse((response) => response.url().endsWith("/api/playback/prepare"));
  await page.getByRole("button", { name: "Play Main Story" }).click();
  const preparation = await (await prepareResponse).json() as { definition: unknown; facts: unknown[] };
  expect(preparation.facts).toEqual([]);
  expect(preparation.definition).not.toBeNull();
  await page.getByRole("button", { name: "Diagnostics" }).click();
  await page.getByRole("tab", { name: "State" }).click();

  const state = page.getByLabel("Playback state");
  await expect(state).toContainText("Item custody");
  await expect(state).toContainText("Sealed Ledger");
  await expect(state).toContainText("Character: Ilya Voss");
  await page.getByRole("button", { name: "Close diagnostics" }).click();
  await page.getByRole("button", { name: /Begin inspection/ }).click();
  await page.getByRole("button", { name: /Show Ilya the sealed ledger/ }).click();
  await page.getByRole("button", { name: /Present the ledger/ }).click();
  await expect(page.getByLabel("Event slide: Harbor Inspection")).toBeVisible();
  await expect(page.getByLabel("Latest state changes")).toContainText("The player receives the sealed ledger.");
  await expect(page.getByLabel("Latest state changes")).toContainText("Mara receives the sealed ledger.");
  await page.getByRole("button", { name: "Diagnostics" }).click();
  await page.getByRole("tab", { name: "State" }).click();
  await expect(page.getByLabel("Playback state")).toContainText("Character: Mara Vale");
});

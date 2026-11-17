import { openNestedPlaybackFixture } from "./projectFixture";
import { expect, test } from "./temporaryProject";

test.use({ viewport: { width: 1280, height: 800 } });

test("traverses two nested Story Flow calls and restores both stack levels", async ({ page }) => {
  await openNestedPlaybackFixture(page);
  await page.getByRole("button", { name: "Play Main Story" }).click();
  await page.getByRole("button", { name: /Begin inspection/ }).click();
  await page.getByRole("button", { name: /Show Ilya the sealed ledger/ }).click();
  await page.getByRole("button", { name: /Present the ledger/ }).click();
  await page.getByRole("button", { name: /Call the covert harbor route/ }).click();
  await page.getByRole("button", { name: /Take the covert route/ }).click();
  await page.getByRole("button", { name: /Scout the patrol route/ }).click();

  await expect(page.getByLabel("Event slide: Harbor Inspection")).toBeVisible();
  await expect(page.getByLabel("Call depth 2")).toContainText("Inside Patrol Scout");
  await page.screenshot({ path: "/tmp/p310-nested-playback-depth-two.png" });

  await page.getByRole("button", { name: /Confirm the patrol gap/ }).click();
  await expect(page.getByLabel("Outcome slide: Route Reopened")).toBeVisible();
  await expect(page.getByText("Ending reached", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Diagnostics", exact: true }).click();
  const operations = page.getByLabel("Composed Flow operations").last();
  await expect(operations).toContainText("Patrol gap confirmed");
  await expect(operations.locator("[data-operation='return']")).toHaveCount(2);
  await page.getByRole("button", { name: "Diagnostics", exact: true }).click();

  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByLabel("Event slide: Harbor Inspection")).toBeVisible();
  await expect(page.getByLabel("Call depth 2")).toBeVisible();
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect(page.getByLabel("Scene slide: Opening Dock")).toBeVisible();
  await expect(page.getByLabel(/Call depth/)).toHaveCount(0);
});

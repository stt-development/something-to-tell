import { openAuroraFixture } from "./projectFixture";
import { expect, test } from "./temporaryProject";

test.use({ viewport: { width: 1440, height: 900 } });

/** Real resizers share actions but must persist only the exact resized placement. */
test("resizes linked and primary placements independently through shared actions", async ({ page }) => {
  await openAuroraFixture(page);
  await page.locator(".react-flow__controls-fitview").click();
  await page.waitForTimeout(350);
  const created = page.waitForResponse((response) => response.url().endsWith("/api/compositions/placements") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Character: Mara Vale", exact: true })
    .dragTo(page.getByTestId("rf__node-node-customs-office"));
  const creation = await created;
  expect(creation.status()).toBe(201);
  interface Placement {
    id: string;
    canonical_node_id: string;
    is_primary: boolean;
    size: { width: number; height: number };
  }
  const snapshot = await creation.json() as { placements: Placement[] };
  const linked = snapshot.placements.find((item) => item.canonical_node_id === "node-hero" && !item.is_primary)!;
  const primary = snapshot.placements.find((item) => item.canonical_node_id === "node-hero" && item.is_primary)!;
  expect(linked).toBeDefined();
  expect(primary).toBeDefined();
  await page.getByTitle("Projects").click();

  for (const [target, visualId, other] of [
    [linked, `placement:${linked.id}`, primary],
    [primary, "node-hero", linked]
  ] as const) {
    await page.locator(".react-flow__controls-fitview").click();
    await page.waitForTimeout(350);
    const node = page.getByTestId(`rf__node-${visualId}`);
    await node.click({ force: true });
    await expect(node).toHaveClass(/selected/);
    const handle = node.locator(".react-flow__resize-control.handle.bottom.right");
    await expect(handle).toBeVisible();
    const before = await node.boundingBox();
    const handleBox = await handle.boundingBox();
    expect(before).not.toBeNull();
    expect(handleBox).not.toBeNull();
    const persisted = page.waitForResponse((response) => response.url().endsWith("/api/compositions/placements") && response.request().method() === "PUT");
    await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox!.x + handleBox!.width / 2 + 40, handleBox!.y + handleBox!.height / 2 + 30, { steps: 6 });
    await page.mouse.up();
    const response = await persisted;
    expect(response.status()).toBe(200);
    const result = await response.json() as { placements: Placement[] };
    const saved = result.placements.find((item) => item.id === target.id)!;
    expect(saved.size.width).toBeGreaterThan(target.size.width);
    expect(saved.size.height).toBeGreaterThan(target.size.height);
    expect(result.placements.find((item) => item.id === other.id)?.size).toEqual(other.size);
    const after = await node.boundingBox();
    expect(after!.width).toBeGreaterThan(before!.width + 20);
    expect(after!.height).toBeGreaterThan(before!.height + 15);
    // The second resize must retain the first placement's newly saved dimensions.
    target.size = saved.size;
  }
});

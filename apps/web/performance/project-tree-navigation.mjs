import { expect } from "@playwright/test";

/** Materialize a canonical tree row through public keyboard navigation, not a state hook. */
export async function projectTreeButton(page, nodeId) {
  if (!await page.locator(".project-tree-row").count()) await page.getByTitle("Projects", { exact: true }).click();
  const escaped = await page.evaluate((id) => CSS.escape(id), nodeId);
  const button = page.locator(`.project-tree-row[data-node-id=${escaped}] button`);
  if (await button.count()) return button;
  const list = page.getByRole("list", { name: "Graph", exact: true });
  await list.locator("button").first().focus(); await page.keyboard.press("Home");
  await expect.poll(() => list.locator("button:focus").locator("..").locator("..").getAttribute("data-nav-index")).toBe("0");
  const count = Number(await list.locator('[role="listitem"]').first().getAttribute("aria-setsize"));
  if (!Number.isSafeInteger(count) || count < 1) throw Error("project_tree_extent_invalid");
  for (let step = 0; step < count; step++) {
    if (await button.count()) return button;
    const before = Number(await list.locator("button:focus").locator("..").locator("..").getAttribute("data-nav-index"));
    if (before >= count - 1) break;
    await page.keyboard.press("PageDown");
    await expect.poll(async () => Number(await list.locator("button:focus").locator("..").locator("..").getAttribute("data-nav-index"))).toBeGreaterThan(before);
  }
  throw Error("project_tree_target_missing");
}

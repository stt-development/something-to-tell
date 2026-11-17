import { expect, type Locator, type Page } from "@playwright/test";

/** Use public selection before asserting full controls at a reduced zoom. */
export async function selectFullNode(node: Locator) {
  await node.locator(".node-detail-title, .narrative-node-title-text").click();
  await expect(node.locator(".narrative-node")).toHaveAttribute("data-node-presentation", "full");
}

/** The all-card chrome matrix explicitly exercises the supported device rollback. */
export async function useFullDetailRollback(page: Page) {
  await page.getByRole("button", { name: "Project settings", exact: true }).click();
  const settings = page.getByRole("heading", { name: "Project settings", exact: true }).locator("../..");
  await settings.getByRole("checkbox", { name: "Graph viewport card optimization", exact: true }).uncheck();
  await settings.getByRole("checkbox", { name: "Automatic node detail (Graph)", exact: true }).uncheck();
  await settings.getByRole("button", { name: "Close dialog", exact: true }).click();
}

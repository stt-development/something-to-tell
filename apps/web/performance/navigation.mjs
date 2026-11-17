import { expect } from "@playwright/test";
import { visibleSelectionTarget } from "./selection.mjs";
import { settledViewport } from "./zoom.mjs";
import { centeredTreeTarget, hoveredTargetPorts, observeActionWithPhases, treeNodeForLabel } from "./workflow-observation.mjs";

/** Read-only Graph navigation on owned fixtures; only counts/durations survive. */
export async function measureNavigation(page, mark = () => {}, { phases = false } = {}) {
  const collector = phases ? { start: () => page.evaluate(() => window.__sttPhaseProbe.start()),
    stop: () => page.evaluate(() => window.__sttPhaseProbe.stop()) } : null;
  const measure = (perform, verify) => observeActionWithPhases(perform, verify, collector);
  let blocked = 0;
  const protect = async (route) => {
    if (!["GET", "HEAD"].includes(route.request().method())) { blocked++; await route.abort(); }
    else await route.fallback();
  };
  await page.route("**/api/**", protect);
  try {
    // Navigation v2 prepares Select explicitly; Hand mode correctly excludes node hit targets.
    await page.getByRole("button", { name: "Select", exact: true }).click();
    await page.evaluate(settledViewport, { minimumMs: 350 });
    const nodes = page.locator(".react-flow__node");
    const initialCount = await nodes.count();
    const target = await page.evaluate(visibleSelectionTarget, null);
    mark("hover");
    const hover = await measure(() => page.mouse.move(target.x, target.y), () => page.waitForFunction(hoveredTargetPorts, target.id));
    await page.getByRole("button", { name: "Show graph filters", exact: true }).click();
    const search = page.getByRole("textbox", { name: "Search graph", exact: true });
    mark("search_empty");
    const searchEmpty = await measure(() => search.fill("stt-probe-no-matching-node-81c9"), () => expect(nodes).toHaveCount(0));
    mark("search_restore");
    const searchRestore = await measure(() => search.fill(""), () => expect(nodes).toHaveCount(initialCount));
    await page.getByRole("button", { name: "Hide graph filters", exact: true }).click();
    if (!await page.locator(".project-tree-row").count()) await page.getByTitle("Projects", { exact: true }).click();
    const tree = page.locator(".project-tree-row button").filter({ hasText: /^Lore:/ }).first();
    const title = (await tree.innerText()).trim();
    const id = await page.evaluate(treeNodeForLabel, title);
    if (!id) throw new Error("navigation_tree_target_missing");
    mark("tree_focus");
    const treeFocus = await measure(() => tree.click(), () => page.waitForFunction(centeredTreeTarget, id));
    await page.evaluate(settledViewport, {});
    await expect(nodes).toHaveCount(initialCount);
    if (blocked) throw new Error("navigation_attempted_mutation");
    return { hover, search_empty: searchEmpty, search_restore: searchRestore, tree_focus: treeFocus,
      nodes_before: initialCount, nodes_after: await nodes.count(), blocked_mutations: blocked };
  } finally { await page.unroute("**/api/**", protect); }
}

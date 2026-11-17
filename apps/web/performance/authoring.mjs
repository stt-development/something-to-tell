import { expect } from "@playwright/test";
import { ownedSession, observeCommand } from "./owned-session.mjs";
import { settledViewport } from "./zoom.mjs";
import { centeredTreeTarget } from "./workflow-observation.mjs";

/** Node authoring through public UI, then public read-back, on an owned copy only. */
export async function measureNodeAuthoring(page, config, mark = () => {}) {
  mark("prepare");
  const session = await ownedSession(page, config);
  const original = session.initial.document.nodes.find((node) => node.type === "Lore");
  if (!original) throw new Error("probe_lore_missing");
  await page.getByRole("button", { name: "Show graph filters", exact: true }).click();
  const search = page.getByRole("textbox", { name: "Search graph", exact: true });
  await search.fill(original.title);
  const node = page.getByTestId(`rf__node-${original.id}`);
  await expect(node).toBeVisible();
  await page.getByRole("button", { name: "Hide graph filters", exact: true }).click();
  if (!await page.locator(".project-tree-row").count()) await page.getByTitle("Projects", { exact: true }).click();
  await page.locator(".project-tree-row button").getByText(`Lore: ${original.title}`, { exact: true }).click();
  await page.waitForFunction(centeredTreeTarget, original.id);
  await page.evaluate(settledViewport, { minimumMs: 350 });
  await page.getByRole("button", { name: "Select", exact: true }).click();
  const titleBox = await node.locator(".narrative-node-title-text").boundingBox();
  if (!titleBox) throw new Error("probe_move_target_mismatch");
  const target = { id: original.id, x: titleBox.x + Math.min(20, titleBox.width / 2), y: titleBox.y + titleBox.height / 2 };
  const box = await node.boundingBox();
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".react-flow__node")?.getAttribute("data-id"), target);
  if (!box || hit !== original.id) throw new Error("probe_move_target_mismatch");
  mark("move");
  const move = await observeCommand(page,
    (response) => response.url().endsWith("/api/compositions/placements") && ["POST", "PUT"].includes(response.request().method()),
    async () => {
      await page.mouse.move(target.x, target.y); await page.mouse.down();
      await page.mouse.move(target.x + 45, target.y + 25, { steps: 6 }); await page.mouse.up();
    }, async () => {
      await expect.poll(async () => (await node.boundingBox())?.x ?? box.x).toBeGreaterThan(box.x + 20);
    });
  const moved = await session.read();
  const placement = moved.document.placements.find((item) => item.canonical_node_id === original.id && item.is_primary);
  const prior = session.initial.document.placements.find((item) => item.canonical_node_id === original.id && item.is_primary);
  if (!placement || prior && placement.x === prior.x && placement.y === prior.y) throw new Error("probe_move_not_persisted");
  await page.evaluate(settledViewport, {});
  await node.locator(".narrative-node-title-text").dblclick();
  const dialog = page.getByRole("heading", { name: "Edit node", exact: true }).locator("..").locator("..");
  const text = `${original.summary}\nDisposable performance probe edit.`;
  await dialog.getByRole("textbox", { name: "Text", exact: true }).fill(text);
  mark("edit");
  const edit = await observeCommand(page,
    (response) => response.url().endsWith(`/api/nodes/${original.id}`) && response.request().method() === "PUT",
    () => dialog.getByRole("button", { name: "Save", exact: true }).click(), () => expect(dialog).toBeHidden());
  const updated = await session.read();
  if (updated.document.nodes.find((item) => item.id === original.id)?.summary !== text) throw new Error("probe_edit_not_persisted");
  return { move, edit, authoritative_move_verified: true, authoritative_edit_verified: true,
    node_count_preserved: updated.document.nodes.length === session.initial.document.nodes.length };
}

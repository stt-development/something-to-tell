import { expect } from "@playwright/test";
import { ownedSession, observeCommand } from "./owned-session.mjs";
import { settledViewport } from "./zoom.mjs";

/** Use three UI-created canaries, never move canonical fixture content for easier gestures. */
export async function measureConnections(page, config, mark = () => {}) {
  mark("prepare");
  const session = await ownedSession(page, config);
  await page.getByRole("button", { name: "Show graph filters", exact: true }).click();
  const search = page.getByRole("textbox", { name: "Search graph", exact: true });
  await search.fill("stt-no-visible-node-3c2");
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  const ids = [];
  for (const [x, y] of [[650, 300], [1050, 300], [1050, 650]]) {
    await page.getByRole("button", { name: "Lore", exact: true }).click();
    const pending = page.waitForResponse((response) => response.url().endsWith("/api/nodes") && response.request().method() === "POST");
    await page.mouse.click(x, y);
    const response = await pending;
    if (!response.ok()) throw new Error("probe_canary_create_failed");
    ids.push((await response.json()).id);
  }
  await search.fill("Lore node");
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await page.getByRole("button", { name: "Hide graph filters", exact: true }).click();
  await page.evaluate(settledViewport, { minimumMs: 350 });
  const nodes = ids.map((id) => page.getByTestId(`rf__node-${id}`));
  const drag = async (start, destination) => {
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.mouse.move(destination.x, destination.y, { steps: 12 }); await page.mouse.up();
  };
  const center = async (locator) => {
    const box = await locator.boundingBox();
    if (!box) throw new Error("probe_connection_target_missing");
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const source = nodes[0].locator(".narrative-handle-right");
  await source.hover();
  mark("connect");
  const connect = await observeCommand(page,
    (response) => response.url().endsWith("/api/edges") && response.request().method() === "POST",
    async () => {
      await drag(await center(source), await center(nodes[1].locator(".narrative-handle-left")));
      mark("choose_connection");
      await page.getByRole("button", { name: /^Relationship/ }).click();
    }, () => expect(page.locator(".react-flow__edge")).toHaveCount(1));
  let snapshot = await session.read();
  const edge = snapshot.document.edges.find((item) => item.source_node_id === ids[0] && item.target_node_id === ids[1]);
  if (!edge) throw new Error("probe_connection_not_persisted");
  const rendered = page.getByTestId(`rf__edge-${edge.id}`);
  const point = await rendered.locator(".react-flow__edge-path").evaluate((path) => {
    const p = path.getPointAtLength(path.getTotalLength() * 0.35);
    const screen = new DOMPoint(p.x, p.y).matrixTransform(path.getScreenCTM());
    return { x: screen.x, y: screen.y };
  });
  await page.mouse.dblclick(point.x, point.y);
  const dialog = page.getByRole("heading", { name: "Edit edge", exact: true }).locator("..").locator("..");
  await dialog.getByRole("textbox", { name: "Label", exact: true }).fill("Disposable probe connection");
  mark("label");
  const label = await observeCommand(page,
    (response) => response.url().endsWith(`/api/edges/${edge.id}`) && response.request().method() === "PUT",
    () => dialog.getByRole("button", { name: "Save", exact: true }).click(), () => expect(dialog).toBeHidden());
  const updater = rendered.locator(".react-flow__edgeupdater-target");
  await updater.hover();
  mark("reconnect");
  const reconnect = await observeCommand(page,
    (response) => response.url().endsWith(`/api/edges/${edge.id}`) && response.request().method() === "PUT",
    async () => drag(await center(updater), await center(nodes[2].locator(".narrative-handle-left"))),
    () => expect(page.locator(".react-flow__edge")).toHaveCount(1));
  snapshot = await session.read();
  const updated = snapshot.document.edges.find((item) => item.id === edge.id);
  if (updated?.target_node_id !== ids[2] || updated.source_node_id !== ids[0] || updated.label !== "Disposable probe connection") {
    throw new Error("probe_reconnection_not_persisted");
  }
  return { connect, label, reconnect, created_canary_nodes: 3, authoritative_endpoints_verified: true, label_verified: true };
}

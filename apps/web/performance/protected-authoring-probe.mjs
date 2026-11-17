import { chromium, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { assertOwnedFixture, ownedSession } from "./owned-session.mjs";
import { settledViewport } from "./zoom.mjs";
import { verifyProtectedAuthoring } from "./protected-authoring-contract.mjs";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const report = { step: "launch", page_errors: 0 };
const persist = (step) => { report.step = step; writeFileSync(config.result, JSON.stringify(report)); };
let browser, page;
try {
  assertOwnedFixture(config.fixture);
  browser = await chromium.launch({ headless: true }); report.browser = browser.version();
  page = await browser.newPage({ viewport: config.viewport, deviceScaleFactor: 1 });
  page.setDefaultTimeout(20000); page.on("pageerror", () => { report.page_errors++; });
  persist("open"); await page.goto(config.url);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.getByLabel("Projects directory").fill(config.fixture.directory);
  await page.getByRole("button", { name: "Refresh project list" }).click();
  await page.getByRole("button", { name: new RegExp(config.fixture.name) }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(1124);
  await page.evaluate(settledViewport, { minimumMs: 350 });
  const session = await ownedSession(page, config), before = session.initial.document;
  if (await page.locator(".project-tree-row").count()) await page.getByTitle("Projects", { exact: true }).click();
  const command = async (path, method, action) => {
    const pending = page.waitForResponse((response) => response.url().endsWith(path) && [method].flat().includes(response.request().method()))
      .then((response) => ({ response }), (error) => ({ error }));
    await action();
    const value = await pending;
    if (value.error) throw value.error;
    if (!value.response.ok()) throw new Error("protected_authoring_command_failed");
    return value.response.json();
  };
  persist("prepare_canaries");
  await page.getByRole("button", { name: "Show graph filters", exact: true }).click();
  const search = page.getByRole("textbox", { name: "Search graph", exact: true });
  await search.fill("stt-protected-canary-no-match-6a2f");
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  // In a constrained window the filter panel covers the creation coordinates.
  // Keep the filter active but close its overlay before actual canvas gestures.
  await page.getByRole("button", { name: "Hide graph filters", exact: true }).click();
  // Establish a useful UI creation scale, never write a camera/internal store directly.
  for (let index = 0; index < 32; index++) {
    const { viewport } = await page.evaluate(settledViewport, {});
    if (viewport.zoom >= 0.85) break;
    await page.locator(".react-flow__controls-zoomin").click();
  }
  persist("create_canaries"); const ids = [];
  for (const [x, y] of [[240, 250], [620, 250], [240, 480]]) {
    await page.getByRole("button", { name: "Lore", exact: true }).click();
    const result = await command("/api/nodes", "POST", () => page.mouse.click(x, y)); ids.push(result.id);
  }
  await page.getByRole("button", { name: "Show graph filters", exact: true }).click();
  await search.fill("Lore node"); await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await page.getByRole("button", { name: "Hide graph filters", exact: true }).click();
  await page.evaluate(settledViewport, { minimumMs: 350 });
  const created = (await session.read()).document;
  const nodes = ids.map((id) => page.getByTestId(`rf__node-${id}`));
  const title = (index) => nodes[index].locator(".narrative-node-title-text");
  persist("select_group"); await page.getByRole("button", { name: "Select", exact: true }).click();
  await title(0).click(); await title(1).click({ modifiers: ["Shift"] });
  await expect(nodes[0]).toHaveClass(/selected/); await expect(nodes[1]).toHaveClass(/selected/);
  await expect(nodes[2]).not.toHaveClass(/selected/);
  persist("group_move");
  const box = await title(0).boundingBox();
  await command("/api/compositions/placements", ["POST", "PUT"], async () => {
    await page.mouse.move(box.x + Math.min(20, box.width / 2), box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + Math.min(20, box.width / 2) + 42, box.y + box.height / 2 + 22, { steps: 6 });
    for (const node of nodes.slice(0, 2)) await expect(node.locator("article")).toHaveAttribute("data-node-presentation", "full");
    await page.mouse.up();
  });
  // The first group movement can allocate each previously unplaced canary in
  // separate POSTs. A first receipt alone is not proof both writes completed.
  await expect.poll(async () => {
    const current = (await session.read()).document;
    return ids.slice(0, 2).every((id) => {
      const placement = current.placements.find((item) => item.canonical_node_id === id && item.is_primary);
      const origin = created.nodes.find((item) => item.id === id).metadata.position;
      return placement && placement.x > origin.x && placement.y > origin.y;
    });
  }).toBe(true);
  const moved = (await session.read()).document;
  persist("protected_offscreen_pan");
  await page.keyboard.down("Space");
  for (let index = 0; index < 4; index++) {
    await page.mouse.move(config.viewport.width - 100, 150); await page.mouse.down();
    await page.mouse.move(400, 150, { steps: 6 }); await page.mouse.up();
  }
  await page.keyboard.up("Space"); await page.evaluate(settledViewport, { minimumMs: 350 });
  if (config.nodeDom) {
    // Materialize only for geometry observation, without moving the camera or
    // changing selection. Release this focus before checking actual DOM elision.
    await page.locator(".react-flow__controls-fitview").focus();
    await expect(page.locator(".react-flow__node")).toHaveCount(3);
  }
  const canvas = await page.locator(".react-flow").boundingBox();
  for (const node of nodes) {
    const bounds = await node.boundingBox();
    if (!(bounds.x + bounds.width <= canvas.x || bounds.x >= canvas.x + canvas.width
      || bounds.y + bounds.height <= canvas.y || bounds.y >= canvas.y + canvas.height)) throw new Error("protected_authoring_pan_not_offscreen");
  }
  report.all_canaries_offscreen = true;
  if (config.nodeDom) { await page.getByTitle("Projects", { exact: true }).focus(); await page.evaluate(settledViewport, { minimumMs: 350 }); }
  for (const node of nodes.slice(0, 2)) {
    await expect(node).toHaveClass(/selected/);
    await expect(node.locator("article")).toHaveAttribute("data-node-presentation", "full");
  }
  if (config.nodeDom && config.enabled) {
    await expect(nodes[2]).toHaveCount(0);
    report.offscreen_unselected_elided = true;
  } else await expect(nodes[2].locator("article")).toHaveAttribute("data-node-presentation", config.stableTool || config.nodeDom || config.enabled ? "shell" : "full");
  report.offscreen_selected_full = true; report.offscreen_unselected_shell = config.stableTool ? true : config.nodeDom ? !config.enabled : config.enabled;
  report.pan_document_unchanged = (await session.read()).document.checksum === moved.checksum;
  if (!report.pan_document_unchanged) throw new Error("protected_authoring_pan_mutated_document");
  await page.screenshot({ path: `${config.artifacts}/protected-offscreen.png` });
  await page.locator(".react-flow__controls-fitview").click(); await page.evaluate(settledViewport, { minimumMs: 350 });
  for (const node of nodes) await expect(node.locator("article")).toHaveAttribute("data-node-presentation", "full");
  persist("resize"); await title(0).click(); await expect(nodes[1]).not.toHaveClass(/selected/);
  const handle = nodes[0].locator(".react-flow__resize-control.handle.bottom.right");
  const corner = await handle.boundingBox();
  await command("/api/compositions/placements", "PUT", async () => {
    await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2); await page.mouse.down();
    await page.mouse.move(corner.x + corner.width / 2 + 40, corner.y + corner.height / 2 + 30, { steps: 6 }); await page.mouse.up();
  });
  const resized = (await session.read()).document;
  persist("text_edit"); await title(0).dblclick();
  const dialog = page.getByRole("heading", { name: "Edit node", exact: true }).locator("../..");
  const text = "Disposable viewport protection authoring canary.";
  await dialog.getByRole("textbox", { name: "Text", exact: true }).fill(text);
  await expect(nodes[0].locator("article")).toHaveAttribute("data-node-presentation", "full");
  await command(`/api/nodes/${ids[0]}`, "PUT", () => dialog.getByRole("button", { name: "Save", exact: true }).click());
  await expect(dialog).toBeHidden();
  const edited = await session.read();
  Object.assign(report, verifyProtectedAuthoring(before, created, moved, resized, edited.document, ids, text));
  await page.screenshot({ path: `${config.artifacts}/edited-resized.png` });
  persist("dirty_close_cancel_discard");
  if (edited.session.save_status !== "dirty") throw new Error("protected_authoring_dirty_status_missing");
  await page.getByTitle("Close project", { exact: true }).click();
  const decision = page.getByRole("heading", { name: "Unsaved changes", exact: true }).locator("../..");
  await expect(decision.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  await decision.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  report.close_cancel_retained_workspace = true;
  await page.getByTitle("Close project", { exact: true }).click();
  const discarded = await command(`/api/project-sessions/${session.sessionId}/discard`, "POST", () => decision.getByRole("button", { name: "Discard", exact: true }).click());
  report.saved_checkpoint_restored = discarded.document.checksum === before.checksum;
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  report.session_released = (await page.request.get(`${config.url}/api/project-sessions/${session.sessionId}/history`)).status() === 404;
  if (!report.saved_checkpoint_restored || !report.session_released || report.page_errors) throw new Error("protected_authoring_release_failed");
  persist("complete");
} catch (error) {
  report.error_kind = error.name; report.error_message = String(error.message).slice(0, 4000);
  report.error_code = /^protected_authoring_[a-z_]+$/.test(error.message) ? error.message : "browser_action_failed";
  await page?.screenshot({ path: `${config.artifacts}/failure.png`, timeout: 5000 }).catch(() => {});
  persist(report.step); process.exitCode = 1;
} finally { await browser?.close(); }

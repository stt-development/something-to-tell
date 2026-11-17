import { chromium, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { assertOwnedFixture, ownedSession } from "./owned-session.mjs";
import { settledViewport } from "./zoom.mjs";
import { centeredTreeTarget } from "./workflow-observation.mjs";
import { readCardLayout } from "./viewport-cards-contract.mjs";
import { linkedFixtureTargets, verifyLinkedDocument, verifyLinkedGeometry } from "./protected-linked-contract.mjs";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const report = { step: "launch", page_errors: 0, write_attempts: 0 };
const persist = (step) => { report.step = step; writeFileSync(config.result, JSON.stringify(report)); };
let browser, page;
try {
  assertOwnedFixture(config.fixture);
  browser = await chromium.launch({ headless: true }); report.browser = browser.version();
  page = await browser.newPage({ viewport: config.viewport, deviceScaleFactor: 1 });
  page.setDefaultTimeout(20000); page.on("pageerror", () => { report.page_errors++; });
  const settle = () => page.evaluate(settledViewport, { minimumMs: 350 });
  persist("open"); await page.goto(config.url);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.getByLabel("Projects directory").fill(config.fixture.directory);
  await page.getByRole("button", { name: "Refresh project list" }).click();
  await page.getByRole("button", { name: new RegExp(config.fixture.name) }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(1124); await settle();
  const session = await ownedSession(page, config), source = session.initial.document;
  const { canonical, scene, linkedId, unplaced } = linkedFixtureTargets(source);
  const card = (id) => page.getByTestId(`rf__node-${id}`);
  const linked = card(linkedId), primary = card(canonical.id);
  const blockWrites = async (route) => {
    if (!["GET", "HEAD"].includes(route.request().method())) { report.write_attempts++; await route.abort(); }
    else await route.fallback();
  };
  await page.route("**/api/**", blockWrites);
  const baseline = await page.evaluate(readCardLayout);
  const rootIds = baseline.geometry.nodes.map((node) => node.id).sort();
  const rail = page.getByTitle("Projects", { exact: true });
  const treeFocus = async (node) => {
    if (!await page.locator(".project-tree-row").count()) await rail.click();
    await page.locator(".project-tree-row button").getByText(`${node.type}: ${node.title}`, { exact: true }).first().click();
    await page.waitForFunction(centeredTreeTarget, node.id); await rail.click(); await settle();
  };
  const enterScene = async () => {
    await treeFocus(scene);
    for (let index = 0; index < 2; index++) { await page.locator(".react-flow__controls-zoomout").click(); await settle(); }
    await card(scene.id).getByRole("button", { name: `Focus ${scene.title}`, exact: true }).click();
    await expect(page.getByLabel("Focused frame workspace", { exact: true })).toContainText(scene.title);
    await expect(primary).toHaveCount(0); await expect(linked).toHaveCount(1); await settle();
  };
  const exitScene = async () => {
    await page.getByRole("button", { name: "Exit focused frame workspace", exact: true }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(rootIds.length); await settle();
    const current = await page.evaluate(readCardLayout);
    expect(current.geometry.nodes.map((node) => node.id).sort()).toEqual(rootIds);
    expect(current.counts.handles).toBe(rootIds.length * 4);
    for (const id of [canonical.id, linkedId, unplaced.id]) verifyLinkedGeometry(baseline, current, id);
  };
  const selectedOnly = async (id) => {
    await expect(page.locator(".react-flow__node.selected")).toHaveCount(1);
    await expect(card(id)).toHaveClass(/selected/);
  };
  const editor = page.getByRole("heading", { name: "Edit node", exact: true }).locator("../..");
  const openEditor = async (node) => {
    await node.locator(".narrative-node-title-text").dblclick();
    await expect(editor.getByRole("textbox", { name: "Label", exact: true })).toHaveValue(canonical.title);
    await expect(editor.getByRole("textbox", { name: "Text", exact: true })).toHaveValue(canonical.summary);
    await expect(node.locator("article")).toHaveAttribute("data-node-presentation", "full");
  };
  persist("linked_editor"); await enterScene();
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await linked.locator(".narrative-node-title-text").click(); await selectedOnly(linkedId);
  await expect(linked.locator("article")).toHaveAttribute("data-node-linked", "true");
  await openEditor(linked);
  const draft = `${canonical.summary}\nDisposable cancelled editor draft`;
  await editor.getByRole("textbox", { name: "Text", exact: true }).fill(draft);
  await editor.getByRole("textbox", { name: "Label", exact: true }).focus();
  await expect(editor.getByRole("textbox", { name: "Text", exact: true })).toHaveValue(draft);
  await page.screenshot({ path: `${config.artifacts}/linked-editor-draft.png` });
  await editor.getByRole("button", { name: "Close dialog", exact: true }).click(); await expect(editor).toHaveCount(0);
  report.editor_draft_retained_across_blur = true;
  await exitScene(); await selectedOnly(linkedId); await expect(primary).not.toHaveClass(/selected/);
  persist("primary_selection"); await treeFocus(canonical); await selectedOnly(canonical.id);
  await expect(linked).not.toHaveClass(/selected/);
  await openEditor(primary);
  await editor.getByRole("button", { name: "Close dialog", exact: true }).click(); await expect(editor).toHaveCount(0);
  report.linked_primary_selection_independent = true; report.cancelled_draft_not_published = true;

  persist("native_focus"); await enterScene();
  await page.getByRole("button", { name: "Pan canvas", exact: true }).click();
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);
  const control = linked.getByLabel("Linked visual instance", { exact: true });
  await control.focus(); await expect(control).toBeFocused();
  // Wheel gestures change the public camera without a pointer-down blurring the
  // focused control. No graph store writes, forced clicks or focus flags are injected.
  const outside = async () => page.evaluate((id) => {
    const c = document.querySelector(".react-flow").getBoundingClientRect();
    const n = [...document.querySelectorAll(".react-flow__node")].find((node) => node.dataset.id === id).getBoundingClientRect();
    return n.right <= c.left || n.left >= c.right || n.bottom <= c.top || n.top >= c.bottom;
  }, linkedId);
  for (let index = 0; index < 12 && !await outside(); index++) {
    const origin = await page.evaluate(() => {
      const b = document.querySelector(".react-flow").getBoundingClientRect(), x = b.right - 20;
      for (const fraction of [0.3, 0.5, 0.7]) {
        const y = b.top + b.height * fraction;
        if (document.elementFromPoint(x, y)?.classList.contains("react-flow__pane")) return { x, y };
      }
      return null;
    });
    if (!origin) throw new Error("protected_linked_wheel_origin_missing");
    await page.mouse.move(origin.x, origin.y); await page.mouse.wheel(0, -400); await settle();
  }
  if (!await outside()) throw new Error("protected_linked_focus_target_not_offscreen");
  await expect(control).toBeFocused();
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);
  await expect(linked.locator("article")).toHaveAttribute("data-node-presentation", "full");
  report.offscreen_native_focus_retained = true;
  await rail.focus(); await settle();
  await expect(linked.locator("article")).toHaveAttribute("data-node-presentation", config.enabled ? "shell" : "full");
  await expect(linked.locator(".narrative-handle")).toHaveCount(4);
  report.blur_releases_unselected_card = true;
  await page.screenshot({ path: `${config.artifacts}/focus-released.png` }); await exitScene();

  persist("unplaced_navigation"); await treeFocus(unplaced);
  await expect(card(unplaced.id).locator("article")).toHaveAttribute("data-node-presentation", "full");
  verifyLinkedGeometry(baseline, await page.evaluate(readCardLayout), unplaced.id);
  await selectedOnly(unplaced.id); report.unplaced_navigation_preserves_geometry = true;
  await page.screenshot({ path: `${config.artifacts}/unplaced-focused.png` });
  persist("scope_restore"); await enterScene(); await exitScene(); await treeFocus(unplaced);
  report.root_and_unplaced_restored = true;
  const current = await session.read();
  report.document_unchanged = verifyLinkedDocument(source, current.document)
    && current.session.save_status === "clean" && current.session.saved_revision === session.initial.session.saved_revision;
  if (!report.document_unchanged || report.write_attempts || report.page_errors) throw new Error("protected_linked_read_only_failed");
  await page.unroute("**/api/**", blockWrites);
  persist("close"); await page.getByTitle("Close project", { exact: true }).click();
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  report.session_released = (await page.request.get(`${config.url}/api/project-sessions/${session.sessionId}/history`)).status() === 404;
  if (!report.session_released) throw new Error("protected_linked_session_not_released");
  persist("complete");
} catch (error) {
  report.error_kind = error.name; report.error_message = String(error.message).slice(0, 4000);
  report.error_code = /^protected_linked_[a-z_]+$/.test(error.message) ? error.message : "browser_action_failed";
  await page?.screenshot({ path: `${config.artifacts}/failure.png`, timeout: 5000 }).catch(() => {});
  persist(report.step); process.exitCode = 1;
} finally { await browser?.close(); }

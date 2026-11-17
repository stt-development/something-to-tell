import { chromium, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { assertOwnedFixture, ownedSession } from "./owned-session.mjs";
import { settledViewport } from "./zoom.mjs";
import { centeredTreeTarget } from "./workflow-observation.mjs";
import { readCardLayout } from "./viewport-cards-contract.mjs";
import { readFlowCurves } from "./protected-flow-dom.mjs";
import { frameScopeIds } from "./protected-frames-contract.mjs";
import { linkedFixtureTargets } from "./protected-linked-contract.mjs";
import { sameFixtureValue } from "./protected-document-contract.mjs";
import { detailBand } from "./rendering-policy.mjs";
import { APPROVED_NODE_DETAIL_DEFAULT, detailFixtureTargets, readDetailCounts } from "./node-detail-contract.mjs";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const enabled = config.enabled ?? APPROVED_NODE_DETAIL_DEFAULT;
const report = { step: "launch", page_errors: 0, write_attempts: 0, released_sessions: 0, stages: {}, band_observations: [] }, layouts = {};
const persist = (step) => { report.step = step; writeFileSync(config.result, JSON.stringify(report)); };
let browser, page;
try {
  assertOwnedFixture(config.fixture);
  browser = await chromium.launch({ headless: true }); report.browser = browser.version();
  page = await browser.newPage({ viewport: config.viewport, deviceScaleFactor: 1 }); page.setDefaultTimeout(20000);
  // Owned-page focus diagnostics stay private; public reports contain boolean proof only.
  await page.addInitScript(() => {
    window.__detailFocusEvents = [];
    document.addEventListener("focusin", (event) => {
      const node = event.target.closest?.(".react-flow__node");
      window.__detailFocusEvents.push({ node: node?.getAttribute("data-id"), control: event.target.getAttribute?.("aria-label"),
        pan: Boolean(document.querySelector(".react-flow.pan-canvas")) });
    });
  });
  page.on("pageerror", () => { report.page_errors++; });
  const settle = () => page.evaluate(settledViewport, { minimumMs: 350 });
  const card = (id) => page.getByTestId(`rf__node-${id}`), article = (id) => card(id).locator("article");
  const rail = page.getByTitle("Projects", { exact: true });
  const open = async () => {
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await page.getByLabel("Projects directory").fill(config.fixture.directory);
    await page.getByRole("button", { name: "Refresh project list" }).click();
    await page.getByRole("button", { name: new RegExp(config.fixture.name) }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(1124); await settle();
    if (await page.locator(".project-tree-row").count()) await rail.click();
    return ownedSession(page, config);
  };
  const blockWrites = async (route) => {
    if (!["GET", "HEAD"].includes(route.request().method())) { report.write_attempts++; await route.abort(); }
    else await route.fallback();
  };
  const settings = async (expected, next = expected) => {
    await page.getByRole("button", { name: "Project settings", exact: true }).click();
    const dialog = page.getByRole("heading", { name: "Project settings", exact: true }).locator("../..");
    const detail = dialog.getByRole("checkbox", { name: "Automatic node detail (Graph)", exact: true });
    await expect(detail).toBeChecked({ checked: expected });
    await expect(dialog.getByRole("checkbox", { name: "Graph viewport card optimization", exact: true })).toBeChecked();
    if (next !== expected) await detail.setChecked(next);
    await dialog.getByRole("button", { name: "Close dialog", exact: true }).click(); await settle();
  };
  const treeFocus = async (node) => {
    if (!await page.locator(".project-tree-row").count()) await rail.click();
    await page.locator(".project-tree-row button").getByText(`${node.type}: ${node.title}`, { exact: true }).first().click();
    await page.waitForFunction(centeredTreeTarget, node.id); await rail.click(); await settle();
  };
  const zoomBetween = async (low, high) => {
    for (let i = 0; i < 60; i++) {
      const z = (await settle()).viewport.zoom; if (z >= low && z <= high) return z;
      await page.locator(z < low ? ".react-flow__controls-zoomin" : ".react-flow__controls-zoomout").click();
    }
    throw Error("node_detail_zoom_unreachable");
  };
  const clearSelection = async () => {
    await page.getByRole("button", { name: "Pan canvas", exact: true }).click();
    await page.getByRole("button", { name: "Select", exact: true }).click(); await settle();
  };
  // Public control rectangles + native pan only, even when a large frame's title is outside view.
  const panTo = async (locator) => {
    await page.getByRole("button", { name: "Pan canvas", exact: true }).click();
    for (let i = 0; i < 60; i++) {
      const box = await locator.boundingBox(), canvas = await page.locator(".react-flow").boundingBox();
      if (!box || !canvas) throw Error("node_detail_control_missing");
      const dx = canvas.x + canvas.width - 120 - box.x - box.width / 2, dy = canvas.y + canvas.height * 0.4 - box.y - box.height / 2;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) break;
      const origin = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 };
      const clamp = (value) => Math.max(-300, Math.min(300, value));
      await page.mouse.move(origin.x, origin.y); await page.mouse.down();
      await page.mouse.move(origin.x + clamp(dx), origin.y + clamp(dy), { steps: 5 }); await page.mouse.up(); await settle();
    }
    await page.getByRole("button", { name: "Select", exact: true }).click(); await settle();
  };
  const focusFrame = async (node) => {
    const control = card(node.id).getByRole("button", { name: `Focus ${node.title}`, exact: true });
    await panTo(control); await control.click();
    await expect(page.getByLabel("Focused frame workspace", { exact: true })).toContainText(node.title); await settle();
  };
  const fit = async () => { await page.locator(".react-flow__controls-fitview").click(); await settle(); };
  const snapshot = async (name) => {
    await settle(); const layout = await page.evaluate(readCardLayout, { preciseCamera: true });
    layout.geometry.curves = await page.evaluate(readFlowCurves);
    expect(layout.invalid_handle_bounds).toBe(0); expect(layout.counts.handles).toBe(layout.counts.wrappers * 4);
    const modes = await page.evaluate(readDetailCounts); expect(Object.values(modes).reduce((a, b) => a + b, 0)).toBe(layout.counts.wrappers);
    if (!enabled) expect(modes.overview + modes.compact + modes.folded).toBe(0);
    report.stages[name] = { ...layout.counts, modes, original_handles: true }; layouts[name] = layout;
    writeFileSync(`${config.artifacts}/layouts.json`, JSON.stringify(layouts));
    await page.screenshot({ path: `${config.artifacts}/${name}.png` }); persist(name);
  };
  const close = async (session) => {
    const current = await session.read(); expect(sameFixtureValue(current.document, session.initial.document)).toBe(true);
    expect(current.session.save_status).toBe("clean"); expect(current.session.saved_revision).toBe(session.initial.session.saved_revision);
    await page.unroute("**/api/**", blockWrites);
    await page.getByTitle("Close project", { exact: true }).click(); await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
    expect((await page.request.get(`${config.url}/api/project-sessions/${session.sessionId}/history`)).status()).toBe(404); report.released_sessions++;
  };

  persist("open"); await page.goto(config.url); const first = await open(), source = first.initial.document;
  const targets = detailFixtureTargets(source), linked = linkedFixtureTargets(source);
  await page.route("**/api/**", blockWrites); await settings(enabled); await fit(); await snapshot("root_fit");
  await treeFocus(targets.scene); await focusFrame(targets.scene); await clearSelection();
  await expect(page.locator(".react-flow__node")).toHaveCount(frameScopeIds(source, targets.scene.id).length);
  persist("zoom_bands"); await zoomBetween(0.08, 0.14); let previous = "overview", deadband = false;
  const witness = targets.offices[0].id;
  for (let i = 0; i < 40; i++) {
    const zoom = (await settle()).viewport.zoom, expected = detailBand(zoom, previous);
    await expect(article(witness)).toHaveAttribute("data-node-presentation", enabled ? expected : "full");
    report.band_observations.push({ zoom, mode: enabled ? expected : "full" });
    if (expected !== detailBand(zoom)) deadband = true; previous = expected;
    if (zoom >= 1.5) break;
    await page.locator(".react-flow__controls-zoomin").click();
  }
  report.deadband_observed = deadband;
  if (enabled) { expect(deadband).toBe(true); expect(new Set(report.band_observations.map((row) => row.mode)).size).toBe(3); }
  await zoomBetween(0.85, 1); await panTo(card(witness).getByRole("button", { name: `Focus ${targets.offices[0].title}`, exact: true }));
  writeFileSync(`${config.artifacts}/detail-debug.json`, JSON.stringify(await page.evaluate(() => ({
    camera: document.querySelector(".react-flow__viewport").getAttribute("style"),
    active: document.activeElement?.outerHTML,
    focus: window.__detailFocusEvents,
    nodes: [...document.querySelectorAll(".react-flow__node")].map((node) => ({ id: node.getAttribute("data-id"), selected: node.classList.contains("selected"),
      parent: node.getAttribute("style"), detail: { ...node.querySelector("article").dataset } }))
  }))));
  await expect(article(witness)).toHaveAttribute("data-node-presentation", "full");
  if (enabled) await expect(card(witness).locator("[data-node-focus=folded-count]")).toHaveAttribute("aria-label", /Folded descendant details: 5 \(direct: 1\)/);
  await snapshot("scene_nominal");

  persist("reduced_frame_focus");
  // A deep frame's explicit open path works without zooming to its permitted depth.
  await focusFrame(targets.offices[1]);
  await expect(page.locator(".react-flow__node")).toHaveCount(frameScopeIds(source, targets.offices[1].id).length);
  expect(await page.getByTestId(`rf__node-${targets.offices[1].id}`).count()).toBe(1); report.deep_frame_focus = true;
  await page.getByRole("button", { name: "Exit focused frame workspace", exact: true }).click(); await settle();
  await treeFocus(targets.leaf); await expect(article(targets.leaf.id)).toHaveAttribute("data-node-presentation", "full");
  await card(targets.leaf.id).locator(".narrative-node-title-text").dblclick();
  const editor = page.getByRole("heading", { name: "Edit node", exact: true }).locator("../..");
  const text = editor.getByRole("textbox", { name: "Text", exact: true }); await expect(text).toHaveValue(targets.leaf.summary);
  await text.fill(`${targets.leaf.summary}\nCancelled detail draft`); await editor.getByRole("textbox", { name: "Label", exact: true }).focus();
  await expect(text).toHaveValue(`${targets.leaf.summary}\nCancelled detail draft`);
  await editor.getByRole("button", { name: "Close dialog", exact: true }).click(); report.deep_navigation_editor = true;

  persist("linked_identity"); await treeFocus(targets.scene); await focusFrame(targets.scene);
  const linkedCard = card(linked.linkedId); await panTo(linkedCard.locator("[data-node-focus=linked]"));
  await linkedCard.locator("[data-node-focus=linked]").focus();
  await expect(article(linked.linkedId)).toHaveAttribute("data-node-presentation", "full");
  await expect(linkedCard.locator("[data-node-focus=linked]")).toBeFocused();
  await expect(article(linked.linkedId)).toHaveAttribute("data-node-linked", "true"); report.linked_focus_retained = true;
  await page.getByRole("button", { name: "Exit focused frame workspace", exact: true }).click(); await settle(); await fit(); await clearSelection();
  await snapshot("root_restored");

  persist("flow_scope"); await page.getByRole("button", { name: "Flow", exact: true }).click(); await settle();
  const modes = await page.evaluate(readDetailCounts); expect(modes.full).toBeGreaterThan(0);
  expect(modes.shell + modes.overview + modes.compact + modes.folded).toBe(0); report.flow_unchanged = true;
  await page.getByRole("button", { name: "Graph", exact: true }).click(); await settle();
  report.pan_excludes_node_focus = await page.evaluate(() => window.__detailFocusEvents.every((event) => !event.node || !event.pan));
  expect(report.pan_excludes_node_focus).toBe(true);
  await settings(enabled, false); await close(first);
  persist("reload"); await page.reload(); const second = await open(); await page.route("**/api/**", blockWrites);
  expect(sameFixtureValue(source, second.initial.document)).toBe(true); await settings(false);
  await zoomBetween(0.08, 0.14);
  const off = await page.evaluate(readDetailCounts); expect(off.overview + off.compact + off.folded).toBe(0);
  await settings(false, true); const on = await page.evaluate(readDetailCounts); expect(on.overview + on.compact + on.folded).toBeGreaterThan(0);
  await settings(true, false); report.explicit_off_survives_reload = true; report.live_rollback_independent = true;
  await close(second); report.document_unchanged = true;
  if (report.page_errors || report.write_attempts || report.released_sessions !== 2) throw Error("node_detail_read_only_failed");
  persist("complete");
} catch (error) {
  report.error_kind = error.name; report.error_message = String(error.message).slice(0, 4000);
  report.error_code = /^node_detail_[a-z_]+$/.test(error.message) ? error.message : "browser_action_failed";
  await page?.screenshot({ path: `${config.artifacts}/failure.png`, timeout: 5000 }).catch(() => {});
  persist(report.step); process.exitCode = 1;
} finally { await browser?.close(); }

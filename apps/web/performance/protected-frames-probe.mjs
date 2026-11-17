import { chromium, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { assertOwnedFixture, ownedSession } from "./owned-session.mjs";
import { settledViewport } from "./zoom.mjs";
import { centeredTreeTarget } from "./workflow-observation.mjs";
import { readCardLayout } from "./viewport-cards-contract.mjs";
import { frameScopeIds, verifyFocusedFrameLayout } from "./protected-frames-contract.mjs";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const report = { step: "launch", page_errors: 0, write_attempts: 0, scopes: [] };
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
  const blockWrites = async (route) => {
    if (!["GET", "HEAD"].includes(route.request().method())) { report.write_attempts++; await route.abort(); }
    else await route.fallback();
  };
  await page.route("**/api/**", blockWrites);
  const scene = source.nodes.find((node) => node.type === "Scene");
  const location = source.placements.find((p) => p.is_primary && p.container_node_id === scene.id
    && source.nodes.some((node) => node.id === p.canonical_node_id && node.type === "Location"));
  const child = source.placements.find((p) => p.is_primary && p.container_node_id === location?.canonical_node_id);
  if (!scene || !location || !child) throw new Error("protected_frames_fixture_shape_missing");
  const locationNode = source.nodes.find((node) => node.id === location.canonical_node_id);
  const card = (id) => page.getByTestId(`rf__node-${id}`);
  const toggleRail = page.getByTitle("Projects", { exact: true });
  const treeFocus = async () => {
    if (!await page.locator(".project-tree-row").count()) await toggleRail.click();
    await page.locator(".project-tree-row button").getByText(`${scene.type}: ${scene.title}`, { exact: true }).first().click();
    await page.waitForFunction(centeredTreeTarget, scene.id);
    await toggleRail.click();
    // The Scene title controls must be inside the constrained viewport as well.
    await page.locator(".react-flow__controls-zoomout").click(); await settle();
    await page.locator(".react-flow__controls-zoomout").click(); await settle();
  };
  persist("root_geometry"); await treeFocus();
  const baseline = await page.evaluate(readCardLayout);
  const rootIds = baseline.geometry.nodes.map((node) => node.id).sort();
  const scopeSnapshot = async (frame, name) => {
    persist(name); await settle();
    const ids = frameScopeIds(source, frame.id);
    await expect(page.locator(".react-flow__node")).toHaveCount(ids.length);
    const layout = await page.evaluate(readCardLayout);
    // Test painted descendants, not just their flex/grid group boxes: a wrapping
    // group can overflow its own box and hide the title while its bounds look safe.
    const chrome = await page.evaluate((id) => {
      const wrapper = document.querySelector(`.react-flow__node[data-id="${id}"]`);
      const title = wrapper.querySelector(".narrative-node-title").getBoundingClientRect();
      const badges = [...document.querySelectorAll(".node-floating-status button, .node-floating-status span")];
      const banner = document.querySelector(".frame-workspace-banner");
      const controls = [...wrapper.querySelectorAll(".narrative-frame-actions button")];
      return {
        badges: badges.length,
        badges_clear_of_title: badges.every((badge) => {
          const b = badge.getBoundingClientRect();
          return b.bottom <= title.top || b.top >= title.bottom || b.right <= title.left || b.left >= title.right;
        }),
        context_in_header: Boolean(banner?.closest("header")),
        actions_hittable: controls.length > 0 && controls.every((button) => {
          const b = button.getBoundingClientRect();
          return button.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2));
        })
      };
    }, frame.id);
    expect(chrome).toMatchObject({ badges_clear_of_title: true, context_in_header: true, actions_hittable: true });
    report.scopes.push({ name, ...verifyFocusedFrameLayout(baseline, layout, frame.id, ids, config.enabled), chrome });
    await page.screenshot({ path: `${config.artifacts}/${name}.png` });
  };
  const enter = async (frame) => {
    await card(frame.id).getByRole("button", { name: `Focus ${frame.title}`, exact: true }).click();
    await expect(page.getByLabel("Focused frame workspace", { exact: true })).toContainText(frame.title);
  };
  const exit = async () => {
    await page.getByRole("button", { name: "Exit focused frame workspace", exact: true }).click();
    await expect(page.getByLabel("Focused frame workspace", { exact: true })).toHaveCount(0);
    await expect(page.locator(".react-flow__node")).toHaveCount(rootIds.length); await settle();
    const restored = await page.evaluate(readCardLayout);
    expect(restored.geometry.nodes.map((node) => node.id).sort()).toEqual(rootIds);
    expect(restored.counts.handles).toBe(rootIds.length * 4);
    expect(restored.visible_shells).toBe(0);
  };
  await enter(scene); await scopeSnapshot(scene, "scene_scope");
  await enter(locationNode); await scopeSnapshot(locationNode, "location_scope");
  persist("ancestor_protection");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await card(child.canonical_node_id).locator(".narrative-node-title").click();
  await expect(card(child.canonical_node_id)).toHaveClass(/selected/);
  await expect(card(locationNode.id)).not.toHaveClass(/selected/);
  await page.keyboard.down("Space");
  for (let index = 0; index < 4; index++) {
    const origin = await page.evaluate(() => {
      const b = document.querySelector(".react-flow").getBoundingClientRect(), x = b.right - 100;
      for (const y of [b.top + b.height * 0.3, b.top + b.height * 0.5, b.bottom - 30, b.top + 30]) {
        if (document.elementFromPoint(x, y)?.classList.contains("react-flow__pane")) return { x, y };
      }
      return null;
    });
    if (!origin) throw new Error("protected_frames_pan_origin_missing");
    await page.mouse.move(origin.x, origin.y); await page.mouse.down();
    await page.mouse.move(400, origin.y, { steps: 6 }); await page.mouse.up();
  }
  await page.keyboard.up("Space"); await settle();
  const outer = await page.locator(".react-flow").boundingBox();
  for (const id of [locationNode.id, child.canonical_node_id]) {
    const b = await card(id).boundingBox();
    if (!(b.x + b.width <= outer.x || b.x >= outer.x + outer.width || b.y + b.height <= outer.y || b.y >= outer.y + outer.height)) {
      throw new Error("protected_frames_pan_not_offscreen");
    }
    await expect(card(id).locator("article")).toHaveAttribute("data-node-presentation", "full");
  }
  report.offscreen_child_and_ancestor_full = true;
  await page.getByRole("button", { name: "Pan canvas", exact: true }).click(); await settle();
  for (const id of [locationNode.id, child.canonical_node_id]) {
    await expect(card(id)).not.toHaveClass(/selected/);
    await expect(card(id).locator("article")).toHaveAttribute("data-node-presentation", config.enabled ? "shell" : "full");
  }
  await expect(page.locator(".narrative-handle")).toHaveCount(8);
  report.unselected_ancestor_protection_released = true;
  await page.screenshot({ path: `${config.artifacts}/offscreen-released.png` });
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.locator(".react-flow__controls-fitview").click(); await scopeSnapshot(locationNode, "location_fit");
  await exit(); await treeFocus(); await enter(scene); await scopeSnapshot(scene, "scene_reentered");
  await enter(locationNode); await scopeSnapshot(locationNode, "location_reentered"); await exit();
  report.root_membership_restored = true;
  const current = await session.read();
  report.document_unchanged = current.document.checksum === source.checksum && current.session.save_status === "clean"
    && current.session.saved_revision === session.initial.session.saved_revision;
  if (!report.document_unchanged || report.write_attempts || report.page_errors) throw new Error("protected_frames_read_only_failed");
  await page.unroute("**/api/**", blockWrites);
  persist("close"); await page.getByTitle("Close project", { exact: true }).click();
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  report.session_released = (await page.request.get(`${config.url}/api/project-sessions/${session.sessionId}/history`)).status() === 404;
  if (!report.session_released) throw new Error("protected_frames_session_not_released");
  persist("complete");
} catch (error) {
  report.error_kind = error.name; report.error_message = String(error.message).slice(0, 4000);
  report.error_code = /^protected_frames_[a-z_]+$/.test(error.message) ? error.message : "browser_action_failed";
  await page?.screenshot({ path: `${config.artifacts}/failure.png`, timeout: 5000 }).catch(() => {});
  persist(report.step); process.exitCode = 1;
} finally { await browser?.close(); }

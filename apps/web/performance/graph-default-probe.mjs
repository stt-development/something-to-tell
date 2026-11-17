import { chromium, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { assertOwnedFixture, ownedSession } from "./owned-session.mjs";
import { settledViewport } from "./zoom.mjs";
import { centeredTreeTarget } from "./workflow-observation.mjs";
import { compareCardLayouts, readCardLayout } from "./viewport-cards-contract.mjs";
import { sameFixtureValue } from "./protected-document-contract.mjs";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const report = { step: "launch", page_errors: 0, write_attempts: 0, released_sessions: 0, stages: {} };
const persist = (step) => { report.step = step; writeFileSync(config.result, JSON.stringify(report)); };
let browser, page;
try {
  assertOwnedFixture(config.fixture);
  if (config.enabled !== null) throw Error("graph_default_test_override_present");
  browser = await chromium.launch({ headless: true }); report.browser = browser.version();
  // A fresh context has no remembered preference; never seed the renderer or storage.
  page = await browser.newPage({ viewport: config.viewport, deviceScaleFactor: 1 });
  page.setDefaultTimeout(20000); page.on("pageerror", () => { report.page_errors++; });
  const settle = () => page.evaluate(settledViewport, { minimumMs: 350 });
  const rail = page.getByTitle("Projects", { exact: true });
  const open = async () => {
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await page.getByLabel("Projects directory").fill(config.fixture.directory);
    await page.getByRole("button", { name: "Refresh project list" }).click();
    await page.getByRole("button", { name: new RegExp(config.fixture.name) }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(1124); await settle();
    return ownedSession(page, config);
  };
  const blockWrites = async (route) => {
    if (!["GET", "HEAD"].includes(route.request().method())) { report.write_attempts++; await route.abort(); }
    else await route.fallback();
  };
  const settings = async (expected, next = expected) => {
    await page.getByRole("button", { name: "Project settings", exact: true }).click();
    const dialog = page.getByRole("heading", { name: "Project settings", exact: true }).locator("../..");
    const checkbox = dialog.getByRole("checkbox", { name: "Graph viewport card optimization", exact: true });
    await expect(checkbox).toBeChecked({ checked: expected });
    if (next !== expected) await checkbox.setChecked(next);
    await dialog.getByRole("button", { name: "Close dialog", exact: true }).click(); await settle();
  };
  const focus = async (target) => {
    if (!await page.locator(".project-tree-row").count()) await rail.click();
    await page.locator(".project-tree-row button").getByText(`${target.type}: ${target.title}`, { exact: true }).first().click();
    await page.waitForFunction(centeredTreeTarget, target.id); await rail.click(); await settle();
  };
  const snapshot = async (name, enabled) => {
    persist(name); await settle();
    const value = await page.evaluate(readCardLayout);
    expect(value.counts.wrappers).toBe(1124); expect(value.counts.handles).toBe(4496);
    expect(value.visible_shells).toBe(0); expect(value.invalid_handle_bounds).toBe(0);
    if (enabled) expect(value.counts.shells).toBeGreaterThan(0);
    else expect(value.counts.shells).toBe(0);
    report.stages[name] = { ...value.counts, no_visible_shells: true, original_handles: true };
    await page.screenshot({ path: `${config.artifacts}/${name}.png` });
    return value;
  };
  const equalGeometry = (before, after) => {
    const result = compareCardLayouts(before, after);
    if (!result.equal) throw Error("graph_default_toggle_geometry_changed");
    return result;
  };
  const close = async (session) => {
    const current = await session.read();
    expect(sameFixtureValue(current.document, session.initial.document)).toBe(true);
    expect(current.session.save_status).toBe("clean");
    expect(current.session.saved_revision).toBe(session.initial.session.saved_revision);
    await page.unroute("**/api/**", blockWrites);
    await page.getByTitle("Close project", { exact: true }).click();
    await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
    expect((await page.request.get(`${config.url}/api/project-sessions/${session.sessionId}/history`)).status()).toBe(404);
    report.released_sessions++;
  };

  persist("open"); await page.goto(config.url);
  const first = await open(), source = first.initial.document;
  const target = source.nodes.find((node) => node.type === "Lore" && !source.placements.some((p) => p.canonical_node_id === node.id));
  const main = source.story_flows.find((flow) => flow.kind === "main");
  if (!target || !main) throw Error("graph_default_fixture_shape_missing");
  await page.route("**/api/**", blockWrites);
  if (!await page.locator(".project-flow-select").count()) await rail.click();
  await page.getByRole("button", { name: `Open Story Flow ${main.name}`, exact: true }).click(); await rail.click();
  await focus(target); await settings(true);
  const initial = await snapshot("inherited_on", true);
  await settings(true, false); const off = await snapshot("explicit_off", false);
  report.off_geometry = equalGeometry(initial, off);
  await settings(false, true); const on = await snapshot("explicit_on", true);
  report.on_geometry = equalGeometry(off, on);

  persist("flow_fallback"); await page.getByRole("button", { name: "Flow", exact: true }).click(); await settle();
  const summary = page.getByRole("region", { name: "Flow summary", exact: true });
  if (await summary.count()) await summary.getByRole("button", { name: "Hide Flow summary", exact: true }).click();
  await page.getByRole("button", { name: "Pan canvas", exact: true }).click();
  for (let index = 0; index < 4; index++) {
    const origin = await page.evaluate(() => {
      const b = document.querySelector(".react-flow").getBoundingClientRect(), x = b.right - 30;
      for (const fraction of [0.3, 0.5, 0.1, 0.8]) {
        const y = b.top + b.height * fraction;
        if (document.elementFromPoint(x, y)?.classList.contains("react-flow__pane")) return { x, y };
      }
      return null;
    });
    if (!origin) throw Error("graph_default_pan_origin_missing");
    await page.mouse.move(origin.x, origin.y); await page.mouse.down();
    await page.mouse.move(400, origin.y, { steps: 6 }); await page.mouse.up();
  }
  await settle();
  const flow = await page.evaluate(readCardLayout);
  expect(flow.counts.wrappers).toBe(7); expect(flow.counts.handles).toBe(28); expect(flow.counts.shells).toBe(0);
  const allOffscreen = await page.evaluate(() => {
    const c = document.querySelector(".react-flow").getBoundingClientRect();
    return [...document.querySelectorAll(".react-flow__node")].every((node) => {
      const b = node.getBoundingClientRect(); return b.right <= c.left || b.left >= c.right || b.bottom <= c.top || b.top >= c.bottom;
    });
  });
  expect(allOffscreen).toBe(true); report.offscreen_flow_full = true;
  await page.getByRole("button", { name: "Graph", exact: true }).click(); await settle();
  await focus(target); await settings(true, false); await snapshot("off_before_reload", false);
  await close(first);

  // Reload only after closing the owned session, avoiding a deliberately orphaned lock.
  persist("reload"); await page.reload();
  const second = await open(); await page.route("**/api/**", blockWrites);
  expect(sameFixtureValue(second.initial.document, source)).toBe(true);
  await focus(target); await settings(false);
  const persisted = await snapshot("persisted_off", false);
  await settings(false, true); const restored = await snapshot("on_after_reload", true);
  report.reload_geometry = equalGeometry(persisted, restored);
  await close(second);
  report.document_unchanged = true;
  if (report.page_errors || report.write_attempts || report.released_sessions !== 2) throw Error("graph_default_read_only_failed");
  persist("complete");
} catch (error) {
  report.error_kind = error.name; report.error_message = String(error.message).slice(0, 4000);
  report.error_code = /^graph_default_[a-z_]+$/.test(error.message) ? error.message : "browser_action_failed";
  await page?.screenshot({ path: `${config.artifacts}/failure.png`, timeout: 5000 }).catch(() => {});
  persist(report.step); process.exitCode = 1;
} finally { await browser?.close(); }

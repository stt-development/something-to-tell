import { chromium, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { assertOwnedFixture, ownedSession } from "./owned-session.mjs";
import { settledViewport } from "./zoom.mjs";
import { centeredTreeTarget } from "./workflow-observation.mjs";
import { readCardLayout } from "./viewport-cards-contract.mjs";
import { sameFixtureValue } from "./protected-document-contract.mjs";
import { compareExtremeGeometry, verifyExtremeSnapshot } from "./protected-extremes-contract.mjs";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const report = { step: "launch", page_errors: 0, write_attempts: 0, stages: {}, modes: {} }, layouts = {};
const persist = (step) => { report.step = step; writeFileSync(config.result, JSON.stringify(report)); };
let browser, page;
try {
  assertOwnedFixture(config.fixture);
  browser = await chromium.launch({ headless: true }); report.browser = browser.version();
  page = await browser.newPage({ viewport: config.viewport, deviceScaleFactor: 1 });
  page.setDefaultTimeout(20000); page.on("pageerror", () => { report.page_errors++; });
  const settle = () => page.evaluate(settledViewport, { minimumMs: 350 });
  const readLayout = () => page.evaluate(readCardLayout, { preciseCamera: true });
  persist("open"); await page.goto(config.url);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.getByLabel("Projects directory").fill(config.fixture.directory);
  await page.getByRole("button", { name: "Refresh project list" }).click();
  await page.getByRole("button", { name: new RegExp(config.fixture.name) }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(1124); await settle();
  const session = await ownedSession(page, config), source = session.initial.document;
  const main = source.story_flows.find((flow) => flow.kind === "main");
  const graphTarget = source.nodes.find((node) => node.type === "Lore" && !source.placements.some((p) => p.canonical_node_id === node.id));
  const flowTarget = source.nodes.find((node) => node.type === "Dialogue" && source.story_flow_nodes.some((member) => member.flow_id === main?.id && member.node_id === node.id));
  if (!main || !graphTarget || !flowTarget) throw new Error("protected_extremes_fixture_shape_missing");
  const rail = page.getByTitle("Projects", { exact: true });
  const blockWrites = async (route) => {
    if (!["GET", "HEAD"].includes(route.request().method())) { report.write_attempts++; await route.abort(); }
    else await route.fallback();
  };
  await page.route("**/api/**", blockWrites);
  const openRail = async () => { if (!await page.locator(".project-flow-select").count()) await rail.click(); };
  await openRail(); await page.getByRole("button", { name: `Open Story Flow ${main.name}`, exact: true }).click(); await rail.click(); await settle();
  const fit = async () => {
    await page.getByRole("button", { name: "Pan canvas", exact: true }).click();
    await page.locator(".react-flow__controls-fitview").click(); await settle();
  };
  const origin = () => page.evaluate(() => {
    const b = document.querySelector(".react-flow").getBoundingClientRect();
    for (const x of [b.right - 20, b.right - 100]) for (const fraction of [0.05, 0.2, 0.35, 0.55]) {
      const y = b.top + b.height * fraction;
      if (document.elementFromPoint(x, y)?.classList.contains("react-flow__pane")) return { x, y };
    }
    throw new Error("protected_extremes_wheel_origin_missing");
  });
  // Public wheel gestures preserve native focus. A second gesture at the bound
  // proves clamping rather than merely trusting the rounded percentage indicator.
  const zoomToBound = async (zoom, point) => {
    await page.mouse.move(point.x, point.y);
    for (let index = 0; index < 6; index++) {
      await page.mouse.wheel(0, zoom === 0.01 ? 8000 : -8000); await settle();
      if (Math.abs((await readLayout()).geometry.camera[2] - zoom) <= 1e-8) break;
    }
    expect(Math.abs((await readLayout()).geometry.camera[2] - zoom)).toBeLessThanOrEqual(1e-8);
    await page.mouse.wheel(0, zoom === 0.01 ? 8000 : -8000); await settle();
    expect(Math.abs((await readLayout()).geometry.camera[2] - zoom)).toBeLessThanOrEqual(1e-8);
    await expect(page.locator(".canvas-zoom-control output")).toHaveText(`${zoom * 100}%`);
  };
  const outside = async (target) => {
    const c = await page.locator(".react-flow").boundingBox(), b = await target.boundingBox();
    if (!(b.x + b.width <= c.x || b.x >= c.x + c.width || b.y + b.height <= c.y || b.y >= c.y + c.height)) {
      throw new Error("protected_extremes_target_not_offscreen");
    }
  };
  const snapshot = async (name, baseline, zoom) => {
    persist(name); await settle();
    const value = await readLayout(); layouts[name] = value;
    writeFileSync(`${config.artifacts}/layouts.json`, JSON.stringify(layouts));
    report.stages[name] = zoom ? verifyExtremeSnapshot(baseline, value, zoom, config.enabled)
      : { zoom: value.geometry.camera[2], wrappers: value.counts.wrappers, handles: value.counts.handles,
          edges: value.counts.edges, labels: value.counts.labels, minimap: value.counts.minimap, shells: value.counts.shells };
    await page.screenshot({ path: `${config.artifacts}/${name}.png` });
    return value;
  };
  for (const [mode, node] of [["graph", graphTarget], ["flow", flowTarget]]) {
    if (mode === "flow") {
      await page.getByRole("button", { name: "Flow", exact: true }).click(); await settle();
      const summary = page.getByRole("region", { name: "Flow summary", exact: true });
      if (await summary.count()) await summary.getByRole("button", { name: "Hide Flow summary", exact: true }).click();
    }
    persist(`${mode}_prepare`); await fit();
    await expect(page.locator(".react-flow__node")).toHaveCount(mode === "graph" ? 1124 : 7);
    const baseline = await snapshot(`${mode}_fit`);
    const target = page.getByTestId(`rf__node-${node.id}`);
    await page.getByRole("button", { name: "Select", exact: true }).click(); await openRail();
    if (mode === "graph") await page.locator(".project-tree-row button").getByText(`${node.type}: ${node.title}`, { exact: true }).first().click();
    else await page.locator(".project-flow-member-title").filter({ hasText: node.title }).click();
    await page.waitForFunction(centeredTreeTarget, node.id); await rail.click(); await settle();
    await expect(page.locator(".react-flow__node.selected")).toHaveCount(1); await expect(target).toHaveClass(/selected/);
    const point = await origin();
    persist(`${mode}_zoom_min`); await zoomToBound(0.01, point); await snapshot(`${mode}_min`, baseline, 0.01);
    persist(`${mode}_zoom_max_selected`); await zoomToBound(10, point); await outside(target);
    await expect(target).toHaveClass(/selected/);
    await expect(target.locator("article")).toHaveAttribute("data-node-presentation", "full");
    await snapshot(`${mode}_max_selected`, baseline, 10);

    await fit(); await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);
    const control = target.locator(".narrative-frame-action").first();
    await control.focus(); await expect(control).toBeFocused();
    persist(`${mode}_zoom_max_focused`); await zoomToBound(10, await origin()); await outside(target);
    await expect(control).toBeFocused(); await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);
    await expect(target.locator("article")).toHaveAttribute("data-node-presentation", "full");
    await snapshot(`${mode}_max_focused`, baseline, 10);
    await rail.focus(); await settle();
    await expect(target.locator("article")).toHaveAttribute("data-node-presentation", config.enabled ? "shell" : "full");
    await snapshot(`${mode}_max_blurred`, baseline, 10);
    if (config.enabled && report.stages[`${mode}_max_blurred`].shells === 0) throw new Error("protected_extremes_no_shells_observed");
    await fit(); const recovered = await snapshot(`${mode}_recovered`);
    const recovery = compareExtremeGeometry(baseline, recovered);
    if (!recovery.equal) throw new Error("protected_extremes_fit_not_restored");
    report.modes[mode] = { min_clamped: true, max_clamped: true, selected_offscreen_full: true,
      native_focus_offscreen_full: true, blur_releases_card: true, recovery };
  }
  const current = await session.read();
  report.document_unchanged = sameFixtureValue(source, current.document) && current.session.save_status === "clean"
    && current.session.saved_revision === session.initial.session.saved_revision;
  if (!report.document_unchanged || report.write_attempts || report.page_errors) throw new Error("protected_extremes_read_only_failed");
  await page.unroute("**/api/**", blockWrites);
  persist("close"); await page.getByTitle("Close project", { exact: true }).click();
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  report.session_released = (await page.request.get(`${config.url}/api/project-sessions/${session.sessionId}/history`)).status() === 404;
  if (!report.session_released) throw new Error("protected_extremes_session_not_released");
  persist("complete");
} catch (error) {
  report.error_kind = error.name; report.error_message = String(error.message).slice(0, 4000);
  report.error_code = /^protected_extremes_[a-z_]+$/.test(error.message) ? error.message : "browser_action_failed";
  await page?.screenshot({ path: `${config.artifacts}/failure.png`, timeout: 5000 }).catch(() => {});
  persist(report.step); process.exitCode = 1;
} finally { await browser?.close(); }

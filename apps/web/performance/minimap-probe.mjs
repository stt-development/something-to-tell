import { chromium, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { assertOwnedFixture, ownedSession } from "./owned-session.mjs";
import { settledViewport } from "./zoom.mjs";
import { centeredTreeTarget } from "./workflow-observation.mjs";
import { sameFixtureValue } from "./protected-document-contract.mjs";
import { detailFixtureTargets } from "./node-detail-contract.mjs";
import { APPROVED_MINIMAP_DEFAULT, observeMiniMap, verifyMiniMapObservation } from "./minimap-contract.mjs";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const report = { step: "launch", page_errors: 0, write_attempts: 0, released_sessions: 0, stages: {} };
const persist = (step) => { report.step = step; writeFileSync(config.result, JSON.stringify(report)); };
let browser, page;
try {
  assertOwnedFixture(config.fixture); browser = await chromium.launch({ headless: true }); report.browser = browser.version();
  page = await browser.newPage({ viewport: config.viewport, deviceScaleFactor: 1 }); page.setDefaultTimeout(20000);
  page.on("pageerror", () => { report.page_errors++; });
  // Observe native raster calls only; preserve the original methods and all drawing output.
  await page.addInitScript(() => {
    window.__miniPaints = { paints: 0, cells: 0, started: 0, span: 0 };
    for (const key of ["clearRect", "fillRect"]) {
      const original = CanvasRenderingContext2D.prototype[key];
      CanvasRenderingContext2D.prototype[key] = function (...args) {
        if (this.canvas.closest(".bounded-minimap")) {
          if (key === "clearRect") { window.__miniPaints.paints++; window.__miniPaints.cells = 0; window.__miniPaints.started = performance.now(); }
          else window.__miniPaints.cells++;
        }
        const result = original.apply(this, args);
        if (this.canvas.closest(".bounded-minimap")) window.__miniPaints.span = performance.now() - window.__miniPaints.started;
        return result;
      };
    }
  });
  const settle = () => page.evaluate(settledViewport, { minimumMs: 350 });
  const settings = async (expected, next = expected) => {
    await page.getByRole("button", { name: "Project settings", exact: true }).click();
    const dialog = page.getByRole("heading", { name: "Project settings", exact: true }).locator("../..");
    const control = dialog.getByRole("checkbox", { name: "Bounded MiniMap rendering", exact: true });
    await expect(control).toBeChecked({ checked: expected });
    await expect(dialog.getByRole("checkbox", { name: "Graph viewport card optimization", exact: true })).toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: "Automatic node detail (Graph)", exact: true })).toBeChecked();
    if (expected !== next) await control.setChecked(next);
    await dialog.getByRole("button", { name: "Close dialog", exact: true }).click(); await settle();
  };
  const open = async () => {
    await page.getByRole("button", { name: "Open", exact: true }).click(); await page.getByLabel("Projects directory").fill(config.fixture.directory);
    await page.getByRole("button", { name: "Refresh project list" }).click(); await page.getByRole("button", { name: new RegExp(config.fixture.name) }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(1124); await settle();
    if (await page.locator(".project-tree-row").count()) await page.getByTitle("Projects", { exact: true }).click();
    return ownedSession(page, config);
  };
  const blockWrites = async (route) => {
    if (!["GET", "HEAD"].includes(route.request().method())) { report.write_attempts++; await route.abort(); } else await route.fallback();
  };
  const snapshot = async (name) => {
    await settle(); const value = await page.evaluate(observeMiniMap), paint = await page.evaluate(() => window.__miniPaints);
    report.stages[name] = { ...verifyMiniMapObservation(value), raster_paints: paint.paints, last_raster_cells: paint.cells,
      instrumented_clear_to_last_fill_ms: paint.span };
    expect(paint.cells).toBe(value.cells); await page.screenshot({ path: `${config.artifacts}/${name}.png` }); persist(name); return value;
  };
  const close = async (session) => {
    const state = await session.read(); expect(sameFixtureValue(state.document, session.initial.document)).toBe(true);
    expect(state.session.save_status).toBe("clean"); expect(state.session.saved_revision).toBe(session.initial.session.saved_revision);
    await page.unroute("**/api/**", blockWrites); await page.getByTitle("Close project", { exact: true }).click();
    await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
    expect((await page.request.get(`${config.url}/api/project-sessions/${session.sessionId}/history`)).status()).toBe(404); report.released_sessions++;
  };
  persist("open"); await page.goto(config.url); const first = await open(), source = first.initial.document;
  await page.route("**/api/**", blockWrites); await settings(APPROVED_MINIMAP_DEFAULT, true);
  await page.locator(".react-flow__controls-fitview").click(); const initial = await snapshot("graph_fit");
  const surface = page.locator(".bounded-minimap-surface");
  const centerAt = async (x, y) => {
    const current = await page.evaluate(observeMiniMap);
    const world = { x: (x - current.mapping.x) / current.mapping.scale, y: (y - current.mapping.y) / current.mapping.scale };
    const box = await surface.boundingBox(); await page.mouse.move(box.x + x, box.y + y); await page.mouse.down();
    await page.mouse.move(box.x + x - 23.7, box.y + y - 17.3, { steps: 8 }); await page.mouse.up();
    const finalWorld = { x: world.x - 23.7 / current.mapping.scale, y: world.y - 17.3 / current.mapping.scale };
    const observed = (await settle()).viewport;
    expect(Math.abs((current.width / 2 - observed.x) / observed.zoom - finalWorld.x)).toBeLessThan(1);
    expect(Math.abs((current.height / 2 - observed.y) / observed.zoom - finalWorld.y)).toBeLessThan(1);
    expect(observed.zoom).toBeCloseTo(current.camera.zoom, 5);
  };
  persist("distant_navigation"); const paints = await page.evaluate(() => window.__miniPaints.paints);
  await centerAt(180, 125); await snapshot("graph_distant");
  expect(await page.evaluate(() => window.__miniPaints.paints)).toBe(paints); report.pan_does_not_repaint = true;
  // The complete domain stays exact even when the main viewport is far outside it.
  const distant = await page.evaluate(observeMiniMap);
  report.pan_domain_delta_world = Math.max(...Object.keys(initial.bounds).map((key) => Math.abs(distant.bounds[key] - initial.bounds[key])));
  expect(report.pan_domain_delta_world).toBeLessThan(0.05); report.global_domain_stable = true;

  // The first nested office is the first matching visible title; do not confuse
  // later repeated authored titles with a different public node id.
  persist("focused_scope"); const target = detailFixtureTargets(source).offices[0];
  await page.getByTitle("Projects", { exact: true }).click();
  await page.locator(".project-tree-row button").getByText(`${target.type}: ${target.title}`, { exact: true }).first().click();
  await page.waitForFunction(centeredTreeTarget, target.id); await page.getByTitle("Projects", { exact: true }).click(); await settle();
  // Tree centering can leave the frame's upper-right focus control offscreen;
  // bring that same original-id control into view using native pane pan.
  const control = page.getByTestId(`rf__node-${target.id}`).getByRole("button", { name: `Focus ${target.title}`, exact: true });
  await page.getByRole("button", { name: "Pan canvas", exact: true }).click();
  for (let i = 0; i < 30; i++) {
    const b = await control.boundingBox(), c = await page.locator(".react-flow").boundingBox();
    const dx = c.x + c.width - 120 - b.x - b.width / 2, dy = c.y + c.height * 0.4 - b.y - b.height / 2;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) break;
    const clamp = (v) => Math.max(-300, Math.min(300, v));
    await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2); await page.mouse.down();
    await page.mouse.move(c.x + c.width / 2 + clamp(dx), c.y + c.height / 2 + clamp(dy), { steps: 5 }); await page.mouse.up(); await settle();
  }
  await page.getByRole("button", { name: "Select", exact: true }).click(); await control.click();
  await expect(page.getByLabel("Focused frame workspace", { exact: true })).toContainText(target.title);
  await page.getByRole("button", { name: "Pan canvas", exact: true }).click();
  await page.getByRole("button", { name: "Select", exact: true }).click(); await snapshot("focused_frame");
  await centerAt(160, 110); await page.getByRole("button", { name: "Exit focused frame workspace", exact: true }).click(); await settle();
  await page.getByRole("button", { name: "Flow", exact: true }).click(); const flow = await snapshot("flow_fit");
  expect(flow.nodes).toBeLessThan(initial.nodes); await centerAt(160, 100); await snapshot("flow_panned");
  await page.getByRole("button", { name: "Graph", exact: true }).click(); await page.locator(".react-flow__controls-fitview").click(); await snapshot("graph_restored");
  report.scoped_navigation = true; await settings(true, false);
  await expect(page.locator(".react-flow__minimap-node")).toHaveCount(1124); await close(first);
  persist("reload"); await page.reload(); const second = await open(); await page.route("**/api/**", blockWrites); await settings(false);
  await expect(page.locator(".react-flow__minimap-node")).toHaveCount(1124); await settings(false, true); await snapshot("reloaded_live_on");
  await settings(true, false); await close(second);
  report.rollback_reload = true; report.document_unchanged = true;
  if (report.page_errors || report.write_attempts || report.released_sessions !== 2) throw Error("minimap_read_only_failed"); persist("complete");
} catch (error) {
  report.error_kind = error.name; report.error_message = String(error.message).slice(0, 4000);
  report.error_code = /^minimap_[a-z_]+$/.test(error.message) ? error.message : "browser_action_failed";
  await page?.screenshot({ path: `${config.artifacts}/failure.png`, timeout: 5000 }).catch(() => {}); persist(report.step); process.exitCode = 1;
} finally { await browser?.close(); }

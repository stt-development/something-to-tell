import { chromium, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { ownedSession } from "./owned-session.mjs";
import { settledViewport } from "./zoom.mjs";
import { centeredTreeTarget } from "./workflow-observation.mjs";
import { readCardLayout } from "./viewport-cards-contract.mjs";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const report = { step: "launch", stages: {}, write_attempts: 0, page_errors: 0 };
const persist = (step) => { report.step = step; writeFileSync(config.result, JSON.stringify(report)); };
let browser, page;
try {
  browser = await chromium.launch({ headless: true });
  report.browser = browser.version();
  page = await browser.newPage({ viewport: config.viewport, deviceScaleFactor: 1 });
  page.setDefaultTimeout(20000);
  page.on("pageerror", () => { report.page_errors++; });
  persist("open");
  await page.goto(config.url);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.getByLabel("Projects directory").fill(config.fixture.directory);
  await page.getByRole("button", { name: "Refresh project list" }).click();
  await page.getByRole("button", { name: new RegExp(config.fixture.name) }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(config.fixture.render_count);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(settledViewport, { minimumMs: 350 });
  const session = await ownedSession(page, config);
  const source = session.initial.document;
  const blockWrites = async (route) => {
    if (!["GET", "HEAD"].includes(route.request().method())) { report.write_attempts++; await route.abort(); }
    else await route.fallback();
  };
  await page.route("**/api/**", blockWrites);
  async function snapshot(name) {
    persist(name);
    await page.evaluate(settledViewport, { minimumMs: 350 });
    const value = await page.evaluate(readCardLayout);
    if (value.counts.wrappers !== config.fixture.render_count || value.counts.handles !== value.counts.wrappers * 4
      || value.visible_shells || value.invalid_handle_bounds) throw new Error("viewport_card_geometry_gate_failed");
    if (!config.enabled && value.counts.shells) throw new Error("viewport_card_control_not_full");
    report.stages[name] = value;
    await page.screenshot({ path: `${config.artifacts}/${name}.png` });
    persist(name);
  }
  const toggleRail = page.getByTitle("Projects", { exact: true });
  if (!await page.locator(".project-tree-row").count()) await toggleRail.click();
  const frame = source.nodes.find((node) => node.type === "Scene");
  const focus = async (node) => {
    // Repeated scale-fixture scenes share titles. The first matching primary is
    // verified by exact public document id after navigation, never assumed correct.
    await page.locator(".project-tree-row button").getByText(`${node.type}: ${node.title}`, { exact: true }).first().click();
    await page.waitForFunction(centeredTreeTarget, node.id);
    await expect(page.getByTestId(`rf__node-${node.id}`).locator("article")).toHaveAttribute("data-node-presentation", "full");
  };
  persist("tree_focus"); await focus(frame); await toggleRail.click();
  await snapshot("focused");
  persist("pan"); await page.getByRole("button", { name: "Pan canvas", exact: true }).click();
  const beforePan = await page.locator(".react-flow__viewport").getAttribute("style");
  await page.mouse.move(config.viewport.width - 100, 150); await page.mouse.down();
  await page.mouse.move(config.viewport.width - 220, 210, { steps: 12 }); await page.mouse.up();
  expect(await page.locator(".react-flow__viewport").getAttribute("style")).not.toBe(beforePan);
  await snapshot("panned");
  persist("zoom");
  await page.locator(".react-flow__controls-zoomin").click();
  await page.evaluate(settledViewport, { minimumMs: 350 });
  await page.locator(".react-flow__controls-zoomout").click();
  await snapshot("zoom_round_trip");

  persist("search"); await page.getByRole("button", { name: "Show graph filters", exact: true }).click();
  const search = page.getByRole("textbox", { name: "Search graph", exact: true });
  await search.fill("stt-viewport-shell-no-match-57b9");
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await search.fill(""); await expect(page.locator(".react-flow__node")).toHaveCount(config.fixture.render_count);
  await page.getByRole("button", { name: "Hide graph filters", exact: true }).click();
  // Restoring authored filters legitimately schedules Fit; re-establish a close
  // camera before proving navigation to a currently offscreen placement.
  await toggleRail.click(); await focus(frame); await toggleRail.click();
  await page.evaluate(settledViewport, { minimumMs: 350 });
  // Resolve navigation from complete public document identity, not a culled title.
  const distantLore = async () => {
    const ids = await page.evaluate(() => {
      const c = document.querySelector(".react-flow").getBoundingClientRect();
      return [...document.querySelectorAll(".react-flow__node")].filter((node) => {
        const b = node.getBoundingClientRect(); return b.left > c.right + 400 || b.right < c.left - 400 || b.top > c.bottom + 400;
      }).map((node) => node.getAttribute("data-id"));
    });
    return source.nodes.find((node) => node.type === "Lore" && ids.includes(node.id));
  };
  let distant = await distantLore();
  // The pinned overlap workload can put every Lore in one camera. Pan away
  // through public gestures rather than moving authored nodes to manufacture distance.
  report.distant_pan_gestures = 0;
  if (!distant) {
    for (let index = 0; index < 4; index++) {
      await page.mouse.move(config.viewport.width - 100, 150); await page.mouse.down();
      await page.mouse.move(400, 150, { steps: 6 }); await page.mouse.up();
      report.distant_pan_gestures++;
    }
    await page.evaluate(settledViewport, { minimumMs: 350 });
    distant = await distantLore();
  }
  if (!distant) throw new Error("viewport_card_distant_target_missing");
  await toggleRail.click(); await focus(distant); await toggleRail.click();
  await snapshot("distant_focus");
  persist("fit"); await page.locator(".react-flow__controls-fitview").click(); await snapshot("fit");
  const current = await session.read();
  report.document_unchanged = current.document.checksum === source.checksum
    && current.session.save_status === "clean" && current.session.saved_revision === session.initial.session.saved_revision;
  if (!report.document_unchanged || report.write_attempts || report.page_errors) throw new Error("viewport_card_read_only_gate_failed");
  await page.unroute("**/api/**", blockWrites);
  persist("close"); await page.getByTitle("Close project", { exact: true }).click();
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  const released = await page.request.get(`${config.url}/api/project-sessions/${encodeURIComponent(session.sessionId)}/history`);
  report.session_released = released.status() === 404;
  if (!report.session_released) throw new Error("viewport_card_session_not_released");
  persist("complete");
} catch (error) {
  report.error_kind = error.name;
  report.error_message = String(error.message).slice(0, 4000);
  report.error_code = /^viewport_card_[a-z_]+$/.test(error.message) ? error.message : "browser_action_failed";
  await page?.screenshot({ path: `${config.artifacts}/failure.png`, timeout: 5000 }).catch(() => {});
  persist(report.step);
  process.exitCode = 1;
} finally {
  await browser?.close();
}

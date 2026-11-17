import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { summarize, resourceSummary } from "./metrics.mjs";
import { createCpuRecorder } from "./cpu.mjs";
import { createBrowserWorkRecorder } from "./browser-work.mjs";
import { measureSelection } from "./selection.mjs";
import { measureZoom, zoomFailureCode } from "./zoom.mjs";
import { measureNavigation } from "./navigation.mjs";
import { measureNodeAuthoring } from "./authoring.mjs";
import { measureConnections } from "./connections.mjs";
import { measureLifecycle } from "./lifecycle.mjs";
import { calibratedMenu, calibratedTool } from "./calibration.mjs";
import { waitStartScreen } from "./workflow-observation.mjs";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const report = { status: "running", step: "launch", samples: [] };
const persist = (step) => {
  report.step = step;
  writeFileSync(config.result, JSON.stringify(report));
};
let browser;
let page;

try {
  browser = await chromium.launch({ headless: true });
  report.browser = browser.version();
  const context = await browser.newContext({ viewport: config.viewport, deviceScaleFactor: 1 });
  page = await context.newPage();
  const cpu = config.cpu ? await createCpuRecorder(page, config.dist) : null;
  const timeline = config.trace ? await createBrowserWorkRecorder(page) : null;
  page.setDefaultTimeout(20000);
  await page.addInitScript(() => {
    const state = window.__baseline = { longTasks: [], jsonWall: [], frames: [], active: false, previous: null };
    new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) if (state.longTasks.length < 500) state.longTasks.push(entry.duration);
    }).observe({ type: "longtask", buffered: true });
    const json = Response.prototype.json;
    Response.prototype.json = async function (...args) {
      const start = performance.now();
      try { return await json.apply(this, args); }
      finally { if (this.url.includes("/api/")) state.jsonWall.push(performance.now() - start); }
    };
    function frame(now) {
      if (state.active && state.previous !== null && state.frames.length < 500) state.frames.push(now - state.previous);
      state.previous = state.active ? now : null;
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
  if (config.delayMs) await page.route("**/api/project-sessions/open", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, config.delayMs));
    await route.continue();
  });
  page.on("response", async (response) => {
    if (!response.url().endsWith("/api/project-sessions/open")) return;
    await response.finished().catch(() => {});
    report.last_open_network_ms = response.request().timing().responseEnd;
    persist(report.step);
  });
  persist("startup");
  const navigation = performance.now();
  await page.goto(config.url);
  await page.getByRole("button", { name: "Open", exact: true }).waitFor();
  report.startup_ms = performance.now() - navigation;
  for (let index = 0; index < config.samples; index++) {
    persist(`open_dialog_${index}`);
    await waitStartScreen(page);
    await page.getByRole("button", { name: "Open", exact: true }).click();
    persist(`open_directory_${index}`);
    await page.getByLabel("Projects directory").fill(config.fixture.directory);
    persist(`open_refresh_${index}`);
    await page.getByRole("button", { name: "Refresh project list" }).click();
    persist(`open_card_ready_${index}`);
    await page.getByRole("button", { name: new RegExp(config.fixture.name) }).waitFor();
    await page.evaluate(() => { performance.clearResourceTimings(); window.__baseline.longTasks = []; window.__baseline.jsonWall = []; });
    if (config.phases) await page.evaluate(() => window.__sttPhaseProbe.start());
    await cpu?.start();
    await timeline?.start();
    const started = performance.now();
    persist(`open_canvas_${index}`);
    await page.getByRole("button", { name: new RegExp(config.fixture.name) }).click();
    if (config.delayMs) {
      await page.getByRole("progressbar").waitFor();
      await page.screenshot({ path: `${config.artifacts}/opening-${index}.png` });
    }
    await page.getByRole("heading", { name: config.fixture.name, exact: true }).waitFor();
    await page.locator(".react-flow__node").first().waitFor();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const sample = { cache: index ? "warm_same_page" : "first_project_install", open_canvas_ms: performance.now() - started };
    sample.resources = resourceSummary(await page.evaluate(() => performance.getEntriesByType("resource").map((entry) => entry.toJSON())));
    sample.post_response_canvas_ms = await page.evaluate(() => {
      const entry = performance.getEntriesByType("resource").find((item) => item.name.endsWith("/api/project-sessions/open"));
      return entry ? performance.now() - entry.responseEnd : null;
    });
    if (cpu) sample.cpu = { open: await cpu.stop() };
    if (timeline) sample.browser_work = { open: await timeline.stop() };
    if (config.phases) sample.phases = { open: await page.evaluate(() => window.__sttPhaseProbe.stop()) };
    sample.dom = await page.evaluate(() => ({ total: document.querySelectorAll("*").length,
      nodes: document.querySelectorAll(".react-flow__node").length,
      edges: document.querySelectorAll(".react-flow__edge").length,
      minimap_shapes: document.querySelectorAll(".react-flow__minimap-node").length,
      labels: document.querySelectorAll(".react-flow__edgelabel-renderer > *").length }));
    report.samples.push(sample);
    persist(`screenshot_${index}`);
    await page.screenshot({ path: `${config.artifacts}/open-${index}.png` });
    const paint = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (config.calibration && !await page.locator(".project-tree-row").count()) {
      await page.getByTitle("Projects", { exact: true }).click(); await paint();
    }
    if (config.calibration) {
      sample.menu_close_feedback_ms = (await calibratedMenu(page, false)).settled_ms;
      sample.menu_feedback_ms = sample.menu_close_feedback_ms;
      sample.menu_open_feedback_ms = (await calibratedMenu(page, true)).settled_ms;
    } else {
    if (config.phases) await page.evaluate(() => window.__sttPhaseProbe.start());
    await cpu?.start();
    const menu = performance.now();
    await timeline?.start();
    await page.getByTitle("Projects", { exact: true }).click();
    await paint();
    sample.menu_feedback_ms = performance.now() - menu;
    if (cpu) sample.cpu.menu = await cpu.stop();
    if (timeline) sample.browser_work.menu = await timeline.stop();
    if (config.phases) sample.phases.menu = await page.evaluate(() => window.__sttPhaseProbe.stop());
    }
    persist(`pan_${index}`);
    if (config.calibration) {
      await page.getByRole("button", { name: "Pan canvas", exact: true }).click(); await paint();
      sample.tool_select_feedback_ms = (await calibratedTool(page, "Select")).settled_ms;
      sample.tool_pan_feedback_ms = (await calibratedTool(page, "Pan canvas")).settled_ms;
    } else {
    await page.getByRole("button", { name: "Pan canvas", exact: true }).click();
    if (timeline || cpu) {
      for (const [name, label] of [["tool_select", "Select"], ["tool_pan", "Pan canvas"]]) {
        await cpu?.start();
        await timeline?.start();
        await calibratedTool(page, label);
        if (cpu) sample.cpu[name] = await cpu.stop();
        if (timeline) sample.browser_work[name] = await timeline.stop();
      }
    }
    }
    const beforePan = await page.locator(".react-flow__viewport").getAttribute("style");
    if (config.phases) await page.evaluate(() => window.__sttPhaseProbe.start());
    await cpu?.start();
    await timeline?.start();
    await page.evaluate(() => { window.__baseline.frames = []; window.__baseline.active = true; });
    // Stay above the cards and far from the bottom-right pannable MiniMap.
    await page.mouse.move(config.viewport.width - 100, 120);
    await page.mouse.down();
    if (config.calibration) {
      for (let step = 1; step <= 32; step++) {
        await page.mouse.move(config.viewport.width - 100 - 120 * step / 32, 120 + 60 * step / 32);
        await page.evaluate(() => new Promise(requestAnimationFrame));
      }
    } else await page.mouse.move(config.viewport.width - 220, 180, { steps: 12 });
    await page.mouse.up();
    await paint();
    const metrics = await page.evaluate(() => { window.__baseline.active = false; return window.__baseline; });
    if (await page.locator(".react-flow__viewport").getAttribute("style") === beforePan) throw new Error("pan_not_observed");
    sample.pan_frames = summarize(metrics.frames);
    sample.long_tasks = summarize(metrics.longTasks);
    // Includes body availability plus JSON parsing; not pure JSON CPU time.
    sample.json_body_read_wall = summarize(metrics.jsonWall);
    if (cpu) sample.cpu.pan = await cpu.stop();
    if (timeline) sample.browser_work.pan = await timeline.stop();
    if (config.phases) sample.phases.pan = await page.evaluate(() => window.__sttPhaseProbe.stop());
    persist(`flow_${index}`);
    if (config.phases) await page.evaluate(() => window.__sttPhaseProbe.start());
    await cpu?.start();
    const flow = performance.now();
    await timeline?.start();
    await page.getByRole("button", { name: "Flow", exact: true }).click();
    await paint();
    sample.flow_switch_ms = performance.now() - flow;
    sample.flow_dom_nodes = await page.locator(".react-flow__node").count();
    if (cpu) sample.cpu.flow = await cpu.stop();
    if (timeline) sample.browser_work.flow = await timeline.stop();
    if (config.phases) sample.phases.flow = await page.evaluate(() => window.__sttPhaseProbe.stop());
    await page.screenshot({ path: `${config.artifacts}/flow-${index}.png` });
    if (config.selection) {
      persist(`selection_flow_${index}`);
      sample.selection = { flow: await measureSelection(page, { cpu, phases: config.phases }) };
      await page.screenshot({ path: `${config.artifacts}/selection-flow-${index}.png` });
    }
    if (config.zoom) {
      persist(`zoom_flow_${index}`);
      sample.zoom = { flow: await measureZoom(page, { cpu, phases: config.phases }) };
      await page.screenshot({ path: `${config.artifacts}/zoom-flow-${index}.png` });
    }
    // The workspace mode survives Close. Reset it so warm Graph samples do not
    // accidentally measure a seven-member Flow instead of the full graph.
    await page.getByRole("button", { name: "Graph", exact: true }).click();
    await paint();
    if (config.selection) {
      persist(`selection_graph_${index}`);
      sample.selection.graph = await measureSelection(page, { cpu, phases: config.phases });
      await page.screenshot({ path: `${config.artifacts}/selection-graph-${index}.png` });
    }
    if (config.zoom) {
      persist(`zoom_graph_${index}`);
      sample.zoom.graph = await measureZoom(page, { cpu, phases: config.phases });
      await page.screenshot({ path: `${config.artifacts}/zoom-graph-${index}.png` });
    }
    if (config.workflow === "navigation") sample.workflow = await measureNavigation(page, (step) => persist(`navigation_${step}_${index}`), { phases: config.phases });
    if (config.workflow === "node-authoring") sample.workflow = await measureNodeAuthoring(page, config, (step) => persist(`authoring_${step}_${index}`));
    if (config.workflow === "connections") sample.workflow = await measureConnections(page, config, (step) => persist(`connections_${step}_${index}`));
    if (config.workflow === "lifecycle") sample.workflow = await measureLifecycle(page, config, (step) => persist(`lifecycle_${step}_${index}`));
    persist(`close_${index}`);
    const closing = performance.now();
    await page.getByTitle("Close project", { exact: true }).click();
    if (["node-authoring", "connections"].includes(config.workflow)) await page.getByRole("button", { name: "Discard", exact: true }).click();
    await waitStartScreen(page);
    sample.close_ms = performance.now() - closing;
    persist(`sample_complete_${index}`);
  }
  report.status = "ok";
} catch (error) {
  report.status = "failed";
  report.error_type = error.name; // Never serialize DOM, response payloads or local paths.
  writeFileSync(`${config.artifacts}/failure.txt`, String(error)); // Temporary diagnostic only, never part of reports.
  await page?.screenshot({ path: `${config.artifacts}/failure.png`, timeout: 3000 }).catch(() => {});
  if (config.zoom && zoomFailureCode(error)) report.error_code = zoomFailureCode(error);
  process.exitCode = 1;
} finally {
  persist(report.step);
  await browser?.close();
}

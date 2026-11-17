import { chromium, expect } from "@playwright/test";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { assertOwnedFixture, ownedSession } from "./owned-session.mjs";
import { sameFixtureValue } from "./protected-document-contract.mjs";
import { settledViewport } from "./zoom.mjs";
import { allowedRetentionWrite, summarizeRetention } from "./retention-contract.mjs";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const report = { step: "launch", page_errors: 0, unexpected_writes: 0, released_sessions: 0, cycles: [], checkpoints: [] };
const persist = (step) => { report.step = step; writeFileSync(config.result, JSON.stringify(report)); };
let browser, page;
try {
  assertOwnedFixture(config.fixture); assertOwnedFixture(config.switchFixture);
  browser = await chromium.launch({ headless: true }); report.browser = browser.version();
  page = await browser.newPage({ viewport: config.viewport, deviceScaleFactor: 1 }); page.setDefaultTimeout(20000);
  const cdp = await page.context().newCDPSession(page); await cdp.send("Performance.enable");
  page.on("pageerror", () => { report.page_errors++; });
  const ids = new Set(), paths = new Set([config.fixture, config.switchFixture].flatMap((fixture) => [fixture.path, realpathSync(fixture.path)]));
  await page.route("**/api/**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (["GET", "HEAD"].includes(request.method())) return route.fallback();
    const allowed = allowedRetentionWrite(path, request.method(), request.postDataJSON(), paths, ids);
    if (allowed) return route.fallback();
    report.unexpected_writes++; await route.abort();
  });
  await page.goto(config.url);

  async function checkpoint(index) {
    await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
    await page.waitForTimeout(300);
    await cdp.send("HeapProfiler.collectGarbage");
    await page.waitForTimeout(100);
    await cdp.send("HeapProfiler.collectGarbage");
    const heap = await cdp.send("Runtime.getHeapUsage"), dom = await cdp.send("Memory.getDOMCounters");
    const metrics = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]));
    const counts = await page.evaluate(() => ({ canvas_nodes: document.querySelectorAll(".react-flow__node").length,
      canvas_edges: document.querySelectorAll(".react-flow__edge").length, story_beats: document.querySelectorAll(".story-document-beat").length,
      navigation_lists: document.querySelectorAll("[data-project-navigation]").length }));
    const sample = { checkpoint: index, heap_used: heap.usedSize, dom_nodes: dom.nodes, documents: dom.documents,
      listeners: metrics.JSEventListeners, ...counts };
    // The experimental CDP method is optional; never call absence proof of zero detached DOM.
    try { sample.detached_roots = (await cdp.send("DOM.getDetachedDomNodes")).detachedNodes.length; }
    catch { sample.detached_roots = null; }
    report.checkpoints.push(sample);
  }

  async function cycle(fixture, index) {
    persist(`cycle_${index}`);
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await page.getByLabel("Projects directory").fill(fixture.directory);
    await page.getByRole("button", { name: "Refresh project list" }).click();
    await page.getByRole("button", { name: new RegExp(fixture.name) }).click();
    await page.getByRole("heading", { name: fixture.name, exact: true }).waitFor();
    await page.evaluate(settledViewport, { minimumMs: 750 });
    const session = await ownedSession(page, { ...config, fixture }); ids.add(session.sessionId);
    const nodeCount = await page.locator(".react-flow__node").count();
    const represented = new Set(session.initial.document.placements.map((row) => row.canonical_node_id));
    expect(nodeCount).toBe(session.initial.document.placements.length + session.initial.document.nodes.filter((row) => !represented.has(row.id)).length);
    await expect(page.getByRole("button", { name: "Graph", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Show graph filters", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Story", exact: true }).click();
    await expect(page.getByLabel("Story document", { exact: true })).toBeVisible();
    const beats = await page.locator(".story-document-beat").count(); expect(beats).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Flow", exact: true }).click();
    await expect(page.locator(".flow-canvas")).toBeVisible();
    await page.getByRole("button", { name: "Graph", exact: true }).click();
    await page.getByRole("button", { name: "Show graph filters", exact: true }).click();
    await page.getByRole("textbox", { name: "Search graph", exact: true }).fill("retention-empty-match");
    expect(sameFixtureValue((await session.read()).document, session.initial.document)).toBe(true);
    await page.getByTitle("Close project", { exact: true }).click();
    await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
    expect((await page.request.get(`${config.url}/api/project-sessions/${session.sessionId}/history`)).status()).toBe(404);
    ids.delete(session.sessionId); report.released_sessions++;
    await page.getByLabel("Interface language", { exact: true }).selectOption("ru");
    await expect(page.getByRole("heading", { name: "Проекты", exact: true })).toBeVisible();
    await page.getByLabel("Язык интерфейса", { exact: true }).selectOption("en");
    report.cycles.push({ index, canonical_nodes: fixture.node_count, visual_nodes: nodeCount, story_beats: beats,
      document_unchanged: true, old_history_missing: true, locale_round_trip: true });
  }

  // Warm both bundles/projections before comparing equivalent closed checkpoints.
  await cycle(config.fixture, -2); await cycle(config.switchFixture, -1); await checkpoint(0);
  for (let i = 0; i < 6; i++) {
    await cycle(i % 2 ? config.switchFixture : config.fixture, i); await checkpoint(i + 1);
  }
  report.retained_changes = summarizeRetention(report.checkpoints);
  if (ids.size || report.page_errors || report.unexpected_writes || report.released_sessions !== 8) throw Error("retention_lifecycle_failed");
  await page.screenshot({ path: `${config.artifacts}/closed.png` }); persist("complete");
} catch (error) {
  report.error_kind = error.name; report.error_message = String(error.message).slice(0, 4000); report.error_code = "retention_browser_failed";
  await page?.screenshot({ path: `${config.artifacts}/failure.png`, timeout: 5000 }).catch(() => {}); persist(report.step); process.exitCode = 1;
} finally { await browser?.close(); }

import { chromium, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { assertOwnedFixture, ownedSession } from "./owned-session.mjs";
import { settledViewport } from "./zoom.mjs";
import { readCardLayout } from "./viewport-cards-contract.mjs";
import { readFlowCurves } from "./protected-flow-dom.mjs";
import { sameFixtureValue } from "./protected-document-contract.mjs";
import { verifyEdgeObservation } from "./edge-boundary-contract.mjs";
import { centeredTreeTarget } from "./workflow-observation.mjs";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const report = { step: "launch", page_errors: 0, write_attempts: 0, stages: {} }, layouts = {};
const persist = (step) => { report.step = step; writeFileSync(config.result, JSON.stringify(report)); };
let browser, page;
try {
  assertOwnedFixture(config.fixture);
  browser = await chromium.launch({ headless: true }); report.browser = browser.version();
  page = await browser.newPage({ viewport: config.viewport, deviceScaleFactor: 1 }); page.setDefaultTimeout(20000);
  page.on("pageerror", () => { report.page_errors++; });
  await page.addInitScript(() => { window.addEventListener("stt-edge-observation", (event) => { window.__edgeObservation = event.detail; }); });
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
  const rail = page.getByTitle("Projects", { exact: true });
  const openRail = async () => { if (!await page.locator(".project-flow-select").count()) await rail.click(); };
  if (await page.locator(".project-tree-row").count()) await rail.click();
  const chooseFlow = async (flow) => {
    await openRail(); await page.getByRole("button", { name: `Open Story Flow ${flow.name}`, exact: true }).click();
    await rail.click(); await settle();
  };
  const fit = async () => { await page.locator(".react-flow__controls-fitview").click(); await settle(); };
  const pathFor = (id) => page.getByTestId(`rf__edge-${id}`).locator(".react-flow__edge-path");
  const endpointsOutside = (ids) => page.evaluate((ids) => {
    const c = document.querySelector(".react-flow").getBoundingClientRect();
    return ids.every((id) => {
      const node = [...document.querySelectorAll(".react-flow__node")].find((node) => node.dataset.id === id), b = node?.getBoundingClientRect();
      return b && (b.right <= c.left || b.left >= c.right || b.bottom <= c.top || b.top >= c.bottom);
    });
  }, ids);
  const midpoint = (id) => pathFor(id).evaluate((path) => {
    const p = path.getPointAtLength(path.getTotalLength() / 2), screen = new DOMPoint(p.x, p.y).matrixTransform(path.getScreenCTM());
    const c = document.querySelector(".react-flow").getBoundingClientRect();
    return { dx: c.x + c.width * 0.55 - screen.x, dy: c.y + c.height * 0.4 - screen.y };
  });
  // Native toolbar zoom/pane gestures only: no transform setter or internal application hook.
  const centerRoute = async (target) => {
    await page.getByRole("button", { name: "Pan canvas", exact: true }).click();
    for (let zoomAttempt = 0; zoomAttempt < 20; zoomAttempt++) {
      for (let attempt = 0; attempt < 60; attempt++) {
        const delta = await midpoint(target.id); if (Math.abs(delta.dx) < 1 && Math.abs(delta.dy) < 1) break;
        const origin = await page.evaluate(() => {
          const b = document.querySelector(".react-flow").getBoundingClientRect();
          for (const fx of [0.75, 0.5, 0.9, 0.3]) for (const fy of [0.1, 0.5, 0.8]) {
            const x = b.x + b.width * fx, y = b.y + b.height * fy;
            if (document.elementFromPoint(x, y)?.classList.contains("react-flow__pane")) return { x, y };
          }
          return null;
        });
        if (!origin) throw new Error("edge_boundary_pan_origin_missing");
        const clamp = (value) => Math.max(-300, Math.min(300, value));
        await page.mouse.move(origin.x, origin.y); await page.mouse.down();
        await page.mouse.move(origin.x + clamp(delta.dx), origin.y + clamp(delta.dy), { steps: 5 }); await page.mouse.up(); await settle();
      }
      if (await endpointsOutside([target.source, target.target])) return;
      const before = (await settle()).viewport.zoom;
      await page.locator(".react-flow__controls-zoomin").click(); await settle();
      if ((await settle()).viewport.zoom <= before) break;
    }
    throw new Error("edge_boundary_endpoints_not_outside");
  };
  const capture = async (name, target) => {
    persist(name); await centerRoute(target);
    await expect.poll(() => page.evaluate(() => window.__edgeObservation?.edges.length)).toBe(await page.locator(".react-flow__edge").count());
    const current = await page.evaluate(() => window.__edgeObservation);
    const value = await page.evaluate(readCardLayout); value.geometry.curves = await page.evaluate(readFlowCurves);
    report.stages[name] = verifyEdgeObservation(current, target.id, value.geometry.edges.map((edge) => edge.id));
    expect(await endpointsOutside([target.source, target.target]), "both original endpoint cards remain outside").toBe(true);
    const delta = await midpoint(target.id); expect(Math.abs(delta.dx)).toBeLessThan(1); expect(Math.abs(delta.dy)).toBeLessThan(1);
    const paint = await pathFor(target.id).evaluate((path) => {
      const raw = path.getAttribute("marker-end");
      const marker = [...document.querySelectorAll("marker")].find((marker) => [`url(#${marker.id})`, `url('#${marker.id}')`, `url("#${marker.id}")`].includes(raw));
      const id = path.getAttribute("data-narrative-edge-route");
      const label = [...document.querySelectorAll("[data-narrative-edge-label]")].find((item) => item.getAttribute("data-narrative-edge-label") === id);
      const b = label?.getBoundingClientRect();
      return { arrow: !!marker?.querySelector("polyline,path,polygon"), label: !!b && b.width > 0 && b.height > 0,
        path_length: path.getTotalLength(), handles: [...document.querySelectorAll(".narrative-handle")].length };
    });
    report.stages[name].paint = paint; persist(name);
    expect(paint.arrow, "resolved painted arrow").toBe(true); expect(paint.label, "current portal label").toBe(true); expect(paint.path_length).toBeGreaterThan(0);
    report.stages[name] = { ...report.stages[name], both_endpoints_offscreen: true, arrow: true, label: true, handles: paint.handles };
    layouts[name] = value; writeFileSync(`${config.artifacts}/layouts.json`, JSON.stringify(layouts));
    await page.screenshot({ path: `${config.artifacts}/${name}.png` });
  };

  persist("graph_target");
  const relationship = await page.evaluate((edges) => {
    return edges.map((edge) => ({ ...edge, element: [...document.querySelectorAll(".react-flow__edge")].find((item) => item.dataset.id === edge.id) }))
      .filter((edge) => edge.element && edge.label)
      .map((edge) => ({ id: edge.id, source: edge.source_node_id, target: edge.target_node_id,
        length: edge.element.querySelector("path").getTotalLength() })).sort((a, b) => b.length - a.length)[0];
  }, source.edges);
  if (!relationship) throw new Error("edge_boundary_relationship_missing");
  await capture("graph_crossing", relationship);

  const transition = source.flow_transitions.find((row) => row.kind === "return" && row.label === "Circle back past the patrol");
  const flow = source.story_flows.find((row) => row.id === transition?.flow_id);
  if (!flow) throw new Error("edge_boundary_return_missing");
  await chooseFlow(flow); await page.getByRole("button", { name: "Flow", exact: true }).click(); await settle();
  const summary = page.getByRole("region", { name: "Flow summary", exact: true });
  if (await summary.count()) await summary.getByRole("button", { name: "Hide Flow summary", exact: true }).click();
  await capture("flow_return", { id: `story-flow:${transition.id}`, source: transition.source_node_id, target: transition.target_node_id });
  // Real project-rail navigation rematerializes the target after both cards were offscreen.
  await openRail();
  const node = source.nodes.find((node) => node.id === transition.target_node_id);
  await page.locator(".project-flow-member-title").filter({ hasText: node.title }).click();
  await page.waitForFunction(centeredTreeTarget, node.id); await rail.click(); await settle();
  await expect(page.getByTestId(`rf__node-${node.id}`).locator("article")).toHaveAttribute("data-node-presentation", "full");
  report.navigation_rematerialized = true;
  await page.getByRole("button", { name: "Graph", exact: true }).click(); await settle(); await fit();
  await capture("graph_restored", relationship);
  const current = await session.read();
  report.document_unchanged = sameFixtureValue(source, current.document) && current.session.save_status === "clean"
    && current.session.saved_revision === session.initial.session.saved_revision;
  if (!report.document_unchanged || report.write_attempts || report.page_errors) throw new Error("edge_boundary_read_only_failed");
  await page.unroute("**/api/**", blockWrites);
  persist("close"); await page.getByTitle("Close project", { exact: true }).click();
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  report.session_released = (await page.request.get(`${config.url}/api/project-sessions/${session.sessionId}/history`)).status() === 404;
  if (!report.session_released) throw new Error("edge_boundary_session_not_released"); persist("complete");
} catch (error) {
  report.error_kind = error.name; report.error_message = String(error.message).slice(0, 4000);
  report.error_code = /^edge_boundary_[a-z_]+$/.test(error.message) ? error.message : "browser_action_failed";
  await page?.screenshot({ path: `${config.artifacts}/failure.png`, timeout: 5000 }).catch(() => {});
  persist(report.step); process.exitCode = 1;
} finally { await browser?.close(); }

import { chromium, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { assertOwnedFixture, ownedSession } from "./owned-session.mjs";
import { settledViewport } from "./zoom.mjs";
import { centeredTreeTarget } from "./workflow-observation.mjs";
import { readCardLayout } from "./viewport-cards-contract.mjs";
import { sameFixtureValue } from "./protected-document-contract.mjs";
import { flowScopeRecords, verifyFlowScope, compareFlowGeometry } from "./protected-flow-contract.mjs";
import { readFlowCurves } from "./protected-flow-dom.mjs";
import { BOUNDARY_VARIANT, standaloneBoundaryTarget, readBoundaryPaint, verifyBoundarySnapshot } from "./protected-boundary-contract.mjs";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const report = { step: "launch", page_errors: 0, write_attempts: 0, stages: {} }, layouts = {};
const persist = (step) => { report.step = step; writeFileSync(config.result, JSON.stringify(report)); };
let browser, page;
try {
  assertOwnedFixture(config.fixture);
  browser = await chromium.launch({ headless: true }); report.browser = browser.version();
  page = await browser.newPage({ viewport: config.viewport, deviceScaleFactor: 1 });
  page.setDefaultTimeout(20000); page.on("pageerror", () => { report.page_errors++; });
  const settle = () => page.evaluate(settledViewport, { minimumMs: 350 });
  const readLayout = async () => {
    const value = await page.evaluate(readCardLayout);
    value.geometry.curves = await page.evaluate(readFlowCurves);
    return value;
  };
  persist("open"); await page.goto(config.url);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.getByLabel("Projects directory").fill(config.fixture.directory);
  await page.getByRole("button", { name: "Refresh project list" }).click();
  await page.getByRole("button", { name: new RegExp(config.fixture.name) }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(1124); await settle();
  const session = await ownedSession(page, config), source = session.initial.document;
  const boundary = config.fixture.variant === BOUNDARY_VARIANT ? standaloneBoundaryTarget(source) : null;
  const main = source.story_flows.find((flow) => flow.kind === "main");
  const side = source.story_flows.find((flow) => flow.kind === "side"
    && source.flow_invocations.some((call) => call.source_flow_id === main?.id && call.target_flow_id === flow.id)
    && source.flow_transitions.filter((transition) => transition.flow_id === flow.id).length > 1);
  if (!main || !side) throw new Error("protected_flow_fixture_shape_missing");
  const scopes = new Map([main, side].map((flow) => [flow.id, flowScopeRecords(source, flow.id)]));
  const rail = page.getByTitle("Projects", { exact: true });
  const blockWrites = async (route) => {
    if (!["GET", "HEAD"].includes(route.request().method())) { report.write_attempts++; await route.abort(); }
    else await route.fallback();
  };
  await page.route("**/api/**", blockWrites);
  const openRail = async () => { if (!await page.locator(".project-flow-select").count()) await rail.click(); };
  const chooseFlow = async (flow) => {
    await openRail(); await page.getByRole("button", { name: `Open Story Flow ${flow.name}`, exact: true }).click();
    await rail.click(); await settle();
  };
  const fit = async () => {
    await page.getByRole("button", { name: "Pan canvas", exact: true }).click();
    await page.locator(".react-flow__controls-fitview").click(); await settle();
  };
  // Public painted rectangles only; arbitrary pan may overlap chrome, explicit Fit may not.
  const checkFitOverlays = async () => {
    const result = await page.evaluate(() => {
      const canvas = document.querySelector(".workspace-stage > .react-flow"), c = canvas.getBoundingClientRect();
      const overlays = [canvas.parentElement.querySelector(".tool-rail"), canvas.querySelector(".react-flow__minimap")]
        .filter(Boolean).map((element) => element.getBoundingClientRect());
      const nodes = [...canvas.querySelectorAll(".react-flow__node")].map((element) => element.getBoundingClientRect());
      return { nodes: nodes.length, outside: nodes.filter((b) => b.left < c.left - 0.5 || b.top < c.top - 0.5 || b.right > c.right + 0.5 || b.bottom > c.bottom + 0.5).length,
        overlaps: nodes.filter((b) => overlays.some((o) => Math.min(b.right, o.right) > Math.max(b.left, o.left) + 0.5 && Math.min(b.bottom, o.bottom) > Math.max(b.top, o.top) + 0.5)).length };
    });
    expect(result).toMatchObject({ outside: 0, overlaps: 0 });
    return result;
  };
  const snapshot = async (name, flow) => {
    persist(name); await settle();
    await expect(page.locator(".react-flow__node")).toHaveCount(scopes.get(flow.id).nodeIds.length);
    const value = await readLayout();
    report.stages[name] = verifyFlowScope(value, scopes.get(flow.id), config.enabled); layouts[name] = value;
    if (boundary) report.stages[name].boundary = verifyBoundarySnapshot(value, boundary,
      await page.evaluate(readBoundaryPaint, boundary), flow.id === boundary.flowId);
    if (name !== "main_panned") report.stages[name].fit_occlusion = await checkFitOverlays();
    writeFileSync(`${config.artifacts}/layouts.json`, JSON.stringify(layouts));
    await page.screenshot({ path: `${config.artifacts}/${name}.png` });
  };
  persist("graph_baseline"); await chooseFlow(main);
  report.graph_auto_fit_occlusion = await checkFitOverlays();
  await fit();
  const graph = await readLayout();
  report.graph_fit_occlusion = await checkFitOverlays();
  await page.getByRole("button", { name: "Flow", exact: true }).click(); await settle();
  const summary = page.getByRole("region", { name: "Flow summary", exact: true });
  if (await summary.count()) await summary.getByRole("button", { name: "Hide Flow summary", exact: true }).click();
  report.flow_auto_fit_occlusion = await checkFitOverlays();
  await fit(); await snapshot("main_fit", main);

  persist("selected_member"); await page.getByRole("button", { name: "Select", exact: true }).click(); await openRail();
  const entry = source.nodes.find((node) => node.id === main.entry_node_id);
  await page.locator(".project-flow-member-title").filter({ hasText: entry.title }).click();
  await page.waitForFunction(centeredTreeTarget, entry.id); await rail.click(); await settle();
  const selected = page.getByTestId(`rf__node-${entry.id}`);
  await expect(selected).toHaveClass(/selected/);
  await page.keyboard.down("Space");
  for (let index = 0; index < 4; index++) {
    const origin = await page.evaluate(() => {
      const b = document.querySelector(".react-flow").getBoundingClientRect(), x = b.right - 30;
      for (const fraction of [0.3, 0.5, 0.1, 0.8]) {
        const y = b.top + b.height * fraction;
        if (document.elementFromPoint(x, y)?.classList.contains("react-flow__pane")) return { x, y };
      }
      return null;
    });
    if (!origin) throw new Error("protected_flow_pan_origin_missing");
    await page.mouse.move(origin.x, origin.y); await page.mouse.down();
    await page.mouse.move(400, origin.y, { steps: 6 }); await page.mouse.up();
  }
  await page.keyboard.up("Space"); await settle();
  const outer = await page.locator(".react-flow").boundingBox(), b = await selected.boundingBox();
  if (!(b.x + b.width <= outer.x || b.x >= outer.x + outer.width || b.y + b.height <= outer.y || b.y >= outer.y + outer.height)) {
    throw new Error("protected_flow_selected_member_not_offscreen");
  }
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(1);
  await expect(selected).toHaveClass(/selected/);
  await expect(selected.locator("article")).toHaveAttribute("data-node-presentation", "full");
  report.selected_offscreen_member_full = true;
  await snapshot("main_panned", main);
  if (config.enabled && report.stages.main_panned.shells === 0) throw new Error("protected_flow_no_shells_observed");
  report.offscreen_shells_observed = config.enabled;
  await fit(); await snapshot("main_restored", main);
  await chooseFlow(side); await fit(); await snapshot("side_fit", side);
  await chooseFlow(main); await fit(); await snapshot("main_reentered", main);
  report.main_geometry = compareFlowGeometry(layouts.main_fit, layouts.main_reentered);
  report.main_scope_restored = report.main_geometry.equal;
  if (!report.main_scope_restored) throw new Error("protected_flow_main_geometry_not_restored");
  persist("graph_return"); await page.getByRole("button", { name: "Graph", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(1124); await settle(); await fit();
  report.graph_geometry = compareFlowGeometry(graph, await readLayout());
  if (!report.graph_geometry.equal) throw new Error("protected_flow_graph_geometry_not_restored");
  if (boundary) {
    await page.getByRole("button", { name: "Flow", exact: true }).click(); await settle(); await fit();
    report.boundary_after_graph_return = verifyBoundarySnapshot(await readLayout(), boundary,
      await page.evaluate(readBoundaryPaint, boundary));
  }
  const current = await session.read();
  report.document_unchanged = sameFixtureValue(source, current.document) && current.session.save_status === "clean"
    && current.session.saved_revision === session.initial.session.saved_revision;
  if (!report.document_unchanged || report.write_attempts || report.page_errors) throw new Error("protected_flow_read_only_failed");
  // Full raw layouts stay private; the runner publishes comparison counts only.
  writeFileSync(`${config.artifacts}/layouts.json`, JSON.stringify(layouts));
  await page.unroute("**/api/**", blockWrites);
  persist("close"); await page.getByTitle("Close project", { exact: true }).click();
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  report.session_released = (await page.request.get(`${config.url}/api/project-sessions/${session.sessionId}/history`)).status() === 404;
  if (!report.session_released) throw new Error("protected_flow_session_not_released");
  persist("complete");
} catch (error) {
  report.error_kind = error.name; report.error_message = String(error.message).slice(0, 4000);
  report.error_code = /^protected_flow_[a-z_]+$/.test(error.message) ? error.message : "browser_action_failed";
  await page?.screenshot({ path: `${config.artifacts}/failure.png`, timeout: 5000 }).catch(() => {});
  persist(report.step); process.exitCode = 1;
} finally { await browser?.close(); }

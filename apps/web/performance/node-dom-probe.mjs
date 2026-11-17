import { chromium, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { assertOwnedFixture, ownedSession } from "./owned-session.mjs";
import { settledViewport } from "./zoom.mjs";
import { projectTreeButton } from "./project-tree-navigation.mjs";
import { sameFixtureValue } from "./protected-document-contract.mjs";
import { readCardLayout } from "./viewport-cards-contract.mjs";
import { readFlowCurves } from "./protected-flow-dom.mjs";
import { compareDomBoundaryCurves, verifyDomObservation } from "./node-dom-contract.mjs";
import { calibratedTool } from "./calibration.mjs";
import { summarize } from "./metrics.mjs";
import { createBrowserWorkRecorder } from "./browser-work.mjs";
import { observeActionWithPhases } from "./workflow-observation.mjs";
import { createCpuRecorder } from "./cpu.mjs";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const report = { step: "launch", page_errors: 0, write_attempts: 0, stages: {} }, layouts = {};
const persist = step => { report.step = step; writeFileSync(config.result, JSON.stringify(report)); };
let browser, page;
try {
  assertOwnedFixture(config.fixture);
  browser = await chromium.launch({ headless: true }); report.browser = browser.version();
  page = await browser.newPage({ viewport: config.viewport, deviceScaleFactor: 1 }); page.setDefaultTimeout(20000);
  page.on("pageerror", () => { report.page_errors++; });
  const settle = () => page.evaluate(settledViewport, { minimumMs: 350 });
  const count = () => page.locator(".react-flow__node").count();
  const snapshot = () => page.evaluate(() => ({ nodes: document.querySelectorAll(".react-flow__node").length,
    edges: document.querySelectorAll(".react-flow__edge").length,
    labels: document.querySelectorAll(".react-flow__edgelabel-renderer > *").length,
    minimap: Number(document.querySelector(".bounded-minimap-surface")?.getAttribute("data-minimap-nodes")) }));
  const curves = () => page.evaluate(readFlowCurves);
  const layout = async () => {
    const result = await page.evaluate(readCardLayout);
    result.geometry.curves = await curves();
    return result;
  };
  const blockWrites = async route => {
    if (!["GET", "HEAD"].includes(route.request().method())) { report.write_attempts++; await route.abort(); } else await route.fallback();
  };
  persist("open"); await page.goto(config.url);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.getByLabel("Projects directory").fill(config.fixture.directory);
  await page.getByRole("button", { name: "Refresh project list" }).click();
  await page.getByRole("button", { name: new RegExp(config.fixture.name) }).click();
  await page.getByRole("heading", { name: config.fixture.name, exact: true }).waitFor(); await settle();
  const session = await ownedSession(page, config), original = session.initial.document;
  await page.route("**/api/**", blockWrites);
  report.stages.initial_fit_nodes = await count();
  await page.screenshot({ path: `${config.artifacts}/initial.png` });
  // Focus suspends elision without changing the camera; capture complete geometry.
  await page.locator(".react-flow__controls-fitview").focus(); await expect(page.locator(".react-flow__node")).toHaveCount(1124);
  layouts.initial = await layout();
  const originalCurves = layouts.initial.geometry.curves;
  report.stages.full_nodes = await count();

  persist("spatial_elision");
  const spread = config.fixture.variant === "root_grid_v1";
  if (spread) {
    // Actual project-tree navigation supplies a working scale; no private camera mutation.
    const target = original.nodes.find(node => config.enabled === null || config.stableTool
      ? node.type === "Character" && original.placements.some(row => row.canonical_node_id === node.id && row.is_primary && row.container_node_id === null)
      : node.type === "Lore");
    await (await projectTreeButton(page, target.id)).click(); await settle();
    await page.keyboard.press("Escape"); await settle();
  } else for (let i = 0; i < 6; i++) { await page.locator(".react-flow__controls-zoomin").click(); await settle(); }
  await page.getByRole("button", { name: "Pan canvas", exact: true }).click();
  for (let i = 0; i < (spread ? 1 : 3); i++) {
    await page.mouse.move(config.viewport.width - 70, 160); await page.mouse.down();
    await page.mouse.move(config.viewport.width - (spread ? 190 : 550), spread ? 220 : 300, { steps: 12 }); await page.mouse.up(); await settle();
  }
  await page.getByTitle("Projects", { exact: true }).focus(); await settle();
  const after = await snapshot();
  report.stages.zoomed_nodes = after.nodes;
  report.stages.minimap_nodes = after.minimap;
  report.stages.edge_routes = after.edges; report.stages.labels = after.labels;
  verifyDomObservation(report.stages, config.nodeDom && config.enabled);
  report.boundary_curve_comparison = compareDomBoundaryCurves(originalCurves, await curves());
  expect(report.boundary_curve_comparison.equal).toBe(true);
  report.boundary_routes_unchanged = true;
  await page.screenshot({ path: `${config.artifacts}/elided.png` });

  persist("conditional_tool_feedback");
  const selectTimes = [], panTimes = [];
  const collector = config.toolTrace ? await createBrowserWorkRecorder(page)
    : config.toolCpu ? await createCpuRecorder(page, config.dist) : null;
  const toolWork = [];
  const measure = label => collector
    ? observeActionWithPhases(() => calibratedTool(page, label), async () => {}, collector)
    : calibratedTool(page, label);
  for (let i = 0; i < (collector ? 3 : 8); i++) {
    const select = await measure("Select"), pan = await measure("Pan canvas");
    selectTimes.push(select.settled_ms); panTimes.push(pan.settled_ms);
    if (collector) toolWork.push({ select: select.phases, pan: pan.phases });
  }
  if (config.toolTrace) report.tool_browser_work = toolWork;
  if (config.toolCpu) report.tool_cpu = toolWork;
  report.conditional_tool_feedback = { scope: "zoomed_panned_view", select: summarize(selectTimes), pan: summarize(panTimes) };
  if (spread) {
    report.working_zoom = (await page.evaluate(settledViewport, {})).viewport.zoom;
    report.working_visible_nodes = await page.evaluate(() => {
      const canvas = document.querySelector(".react-flow").getBoundingClientRect();
      return [...document.querySelectorAll(".react-flow__node")].filter(node => {
        const rect = node.getBoundingClientRect();
        return rect.right > canvas.left && rect.left < canvas.right && rect.bottom > canvas.top && rect.top < canvas.bottom;
      }).length;
    });
    expect(report.working_visible_nodes).toBeGreaterThan(0);
  }

  if (config.stableTool) {
    persist("keyboard_parity");
    const target = original.nodes.find(node => node.type === "Character");
    await page.getByRole("button", { name: "Select", exact: true }).click();
    await (await projectTreeButton(page, target.id)).click(); await settle();
    const card = page.getByTestId(`rf__node-${target.id}`);
    await card.focus(); await page.keyboard.press("Enter"); await expect(card).toHaveClass(/selected/);
    await page.getByRole("button", { name: "Pan canvas", exact: true }).click();
    await card.focus();
    for (const key of ["Enter", "Space", "ArrowRight", "ArrowDown", "Delete", "Backspace"]) {
      await page.keyboard.press(key); await expect(card).not.toHaveClass(/selected/);
    }
    await page.keyboard.press("Escape");
    await expect(page.locator(".react-flow")).not.toHaveClass(/pan-canvas/);
    await page.keyboard.press("Enter"); await expect(card).toHaveClass(/selected/);
    await page.keyboard.press("Escape");
    // Space must still reach existing native/app listeners, not a synthetic replacement.
    const beforePan = await page.locator(".react-flow__viewport").getAttribute("style");
    await page.keyboard.down("Space");
    await page.mouse.move(config.viewport.width - 70, 120); await page.mouse.down();
    await page.mouse.move(config.viewport.width - 190, 180, { steps: 12 }); await page.mouse.up();
    await page.keyboard.press("Escape"); await page.keyboard.up("Space"); await settle();
    expect(await page.locator(".react-flow__viewport").getAttribute("style")).not.toBe(beforePan);
    await page.getByRole("button", { name: "Lore", exact: true }).click();
    await card.focus(); await page.keyboard.press("Enter"); await expect(card).not.toHaveClass(/selected/);
    await page.keyboard.press("Escape");
    report.keyboard_parity = true;
    await page.locator(".react-flow__controls-interactive").click();
    await expect(card).not.toHaveClass(/draggable/);
    await page.getByRole("button", { name: "Pan canvas", exact: true }).click();
    await page.getByRole("button", { name: "Select", exact: true }).click();
    await expect(card).toHaveClass(/draggable/);
    report.native_lock_reset = true;
  }

  if (config.selectableTrial) {
    persist("selectable_shift_and_edge_parity");
    const target = original.nodes.find(node => node.type === "Character");
    await page.getByRole("button", { name: "Select", exact: true }).click();
    await (await projectTreeButton(page, target.id)).click(); await settle();
    const card = page.getByTestId(`rf__node-${target.id}`);
    await page.getByRole("button", { name: "Pan canvas", exact: true }).click();
    // Press Shift outside the canvas: capture must also protect the first pointer event.
    await page.keyboard.down("Shift");
    const box = await card.boundingBox(), board = await page.locator(".react-flow").boundingBox();
    await page.mouse.move(Math.max(board.x + 90, box.x - 30), Math.max(board.y + 80, box.y - 30));
    await page.mouse.down();
    await page.mouse.move(Math.min(board.x + board.width - 30, box.x + box.width + 30),
      Math.min(board.y + board.height - 80, box.y + box.height + 30), { steps: 12 });
    await page.mouse.up(); await page.keyboard.up("Shift"); await settle();
    await expect(page.locator(".react-flow__node.selected,.react-flow__edge.selected")).toHaveCount(0);
    await expect(page.locator(".react-flow__selection")).toHaveCount(0);
    report.shift_hand_selection_blocked = true;

    const edgeId = await page.locator(".react-flow__edge").evaluateAll((elements, ids) => {
      const authored = new Set(ids);
      return elements.map(element => element.getAttribute("data-id")).find(id => authored.has(id));
    }, original.edges.map(edge => edge.id));
    if (!edgeId) throw Error("selectable_fixture_edge_missing");
    const edge = page.getByTestId(`rf__edge-${edgeId}`);
    await edge.focus();
    for (const key of ["Enter", "Space"]) {
      await page.keyboard.press(key); await expect(edge).not.toHaveClass(/selected/);
    }
    await page.keyboard.press("Escape"); await page.keyboard.press("Enter");
    await expect(edge).toHaveClass(/selected/); await page.keyboard.press("Escape");
    report.edge_keyboard_parity = true;

    // Native Select rubberband must still work after the conservative Shift fallback.
    await (await projectTreeButton(page, target.id)).click(); await settle();
    await page.keyboard.press("Escape");
    const selectBox = await card.boundingBox();
    await page.keyboard.down("Shift");
    await page.mouse.move(Math.max(board.x + 90, selectBox.x - 30), Math.max(board.y + 80, selectBox.y - 30));
    await page.mouse.down();
    await page.mouse.move(Math.min(board.x + board.width - 30, selectBox.x + selectBox.width + 30),
      Math.min(board.y + board.height - 80, selectBox.y + selectBox.height + 30), { steps: 12 });
    await page.mouse.up(); await page.keyboard.up("Shift");
    await expect(card).toHaveClass(/selected/); await page.keyboard.press("Escape");
    report.select_rubberband_restored = true;
  }

  persist("minimap_fallback");
  const settings = async () => {
    await page.getByRole("button", { name: "Project settings", exact: true }).click();
    return page.getByRole("heading", { name: "Project settings", exact: true }).locator("../..");
  };
  let panel = await settings();
  await panel.getByRole("checkbox", { name: "Bounded MiniMap rendering", exact: true }).uncheck();
  await panel.getByRole("button", { name: "Close dialog", exact: true }).click(); await settle();
  await expect(page.locator(".react-flow__node")).toHaveCount(1124);
  await expect(page.locator(".react-flow__minimap-node")).toHaveCount(1124);
  report.legacy_minimap_restores_complete_dom = true;
  panel = await settings();
  await panel.getByRole("checkbox", { name: "Bounded MiniMap rendering", exact: true }).check();
  await panel.getByRole("button", { name: "Close dialog", exact: true }).click(); await settle();
  if (config.nodeDom && config.enabled) await expect.poll(count).toBeLessThan(1124);
  report.minimap_rollback_verified = true;

  persist("distant_navigation");
  const target = original.nodes.find(node => node.type === "Lore");
  if (!target) throw Error("node_dom_fixture_target_missing");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await (await projectTreeButton(page, target.id)).click(); await settle();
  const card = page.getByTestId(`rf__node-${target.id}`);
  await expect(card).toHaveCount(1); await expect(card).toHaveClass(/selected/);
  await expect(card.locator("article")).toHaveAttribute("data-node-presentation", "full");
  report.distant_target_materialized = true;
  await card.locator(".narrative-node-title-text, .node-detail-title").first().dblclick();
  const editor = page.getByRole("heading", { name: "Edit node", exact: true }).locator("../..");
  await expect(editor.getByRole("textbox", { name: "Label", exact: true })).toHaveValue(target.title);
  await expect(page.locator(".react-flow__node")).toHaveCount(1124);
  await editor.getByRole("textbox", { name: "Text", exact: true }).fill(`${target.summary}\nCancelled DOM experiment draft`);
  await editor.getByRole("button", { name: "Close dialog", exact: true }).click();
  report.editor_retained_and_cancelled = true;

  persist("selected_protection");
  // Middle-button Pan keeps selection rather than replacing the selection owner.
  for (let i = 0; i < 3; i++) {
    await page.mouse.move(config.viewport.width - 70, 160); await page.mouse.down({ button: "middle" });
    await page.mouse.move(config.viewport.width - 550, 300, { steps: 12 }); await page.mouse.up({ button: "middle" }); await settle();
  }
  await page.getByTitle("Projects", { exact: true }).focus(); await settle();
  await expect(card).toHaveCount(1); await expect(card).toHaveClass(/selected/);
  report.selected_target_retained = true;

  persist("fit_restore"); await page.locator(".react-flow__controls-fitview").focus();
  await expect(page.locator(".react-flow__node")).toHaveCount(1124);
  await page.locator(".react-flow__controls-fitview").click(); await settle();
  layouts.fit_restored = await layout();
  expect(layouts.fit_restored.minimap_coverage.represented_nodes).toBe(1124);
  await page.screenshot({ path: `${config.artifacts}/fit-restored.png` });
  persist("flow_fallback"); await page.getByRole("button", { name: "Flow", exact: true }).click(); await settle();
  layouts.flow = await layout();
  report.stages.flow_nodes = await count();
  await page.screenshot({ path: `${config.artifacts}/flow.png` });
  report.document_unchanged = sameFixtureValue(original, (await session.read()).document);
  if (!report.document_unchanged || report.write_attempts || report.page_errors) throw Error("node_dom_read_only_failed");
  writeFileSync(`${config.artifacts}/layouts.json`, JSON.stringify(layouts));
  await page.unroute("**/api/**", blockWrites);
  persist("close"); await page.getByTitle("Close project", { exact: true }).click();
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  report.session_released = (await page.request.get(`${config.url}/api/project-sessions/${session.sessionId}/history`)).status() === 404;
  if (!report.session_released) throw Error("node_dom_public_release_failed");
  persist("complete");
} catch (error) {
  report.error_kind = error.name; report.error_message = String(error.message).slice(0, 4000);
  report.error_code = "node_dom_browser_failed";
  await page?.screenshot({ path: `${config.artifacts}/failure.png`, timeout: 5000 }).catch(() => {});
  persist(report.step); process.exitCode = 1;
} finally { await browser?.close(); }

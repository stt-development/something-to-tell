import { chromium, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { assertOwnedFixture, ownedSession } from "./owned-session.mjs";
import { settledViewport } from "./zoom.mjs";
import { sameFixtureValue } from "./protected-document-contract.mjs";
import { flowScopeRecords, verifyFlowScope } from "./protected-flow-contract.mjs";
import { readCardLayout } from "./viewport-cards-contract.mjs";
import { readFlowCurves } from "./protected-flow-dom.mjs";
import { flowAuthoringTargets, verifyFlowAuthoringDelta } from "./protected-flow-authoring-contract.mjs";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const report = { step: "launch", page_errors: 0, unexpected_writes: 0, commands: 0, stages: {} };
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
  const session = await ownedSession(page, config), before = session.initial.document;
  const targets = flowAuthoringTargets(before), main = before.story_flows.find((row) => row.id === targets.flowId);
  const side = before.story_flows.find((row) => row.kind === "side" && row.id !== main.id);
  if (!side) throw Error("protected_flow_authoring_side_missing");
  const rail = page.getByTitle("Projects", { exact: true });
  let allowed = null;
  await page.route("**/api/**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (["GET", "HEAD"].includes(request.method())) return route.fallback();
    if (report.step === "discard_close" && request.method() === "POST" && path === `/api/project-sessions/${session.sessionId}/close`) return route.fallback();
    if (allowed?.path === path && allowed.method === request.method()
      && (request.headers()["x-project-session-id"] === session.sessionId || path.includes(`/project-sessions/${session.sessionId}/`))) return route.fallback();
    report.unexpected_writes++; await route.abort();
  });
  const command = async (path, method, action) => {
    allowed = { path, method };
    const pending = page.waitForResponse((r) => new URL(r.url()).pathname === path && r.request().method() === method)
      .then((response) => ({ response }), (error) => ({ error }));
    await action(); const result = await pending; allowed = null;
    if (result.error) throw result.error;
    if (!result.response.ok()) throw Error("protected_flow_authoring_command_failed");
    report.commands++;
    return method === "DELETE" ? null : result.response.json();
  };
  const choose = async (flow) => {
    if (!await page.locator(".project-flow-select").count()) await rail.click();
    await page.getByRole("button", { name: `Open Story Flow ${flow.name}`, exact: true }).click();
    await rail.click(); await settle();
  };
  const fit = async () => { await page.locator(".react-flow__controls-fitview").click(); await settle(); };
  const card = (node) => page.getByTestId(`rf__node-${node.id}`);
  const point = async (locator) => {
    const b = await locator.boundingBox();
    if (!b) throw Error("protected_flow_authoring_hit_missing");
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const drag = async (start, end, moving = async () => {}) => {
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 12 }); await moving(); await page.mouse.up();
  };
  const full = async (node) => { await expect(card(node).locator("article")).toHaveAttribute("data-node-presentation", "full"); };
  const snapshot = async (name, document) => {
    const value = await page.evaluate(readCardLayout);
    value.geometry.curves = await page.evaluate(readFlowCurves);
    report.stages[name] = verifyFlowScope(value, flowScopeRecords(document, main.id), config.enabled);
  };
  await choose(main); await page.getByRole("button", { name: "Flow", exact: true }).click(); await settle();
  const summary = page.getByRole("region", { name: "Flow summary", exact: true });
  if (await summary.count()) await summary.getByRole("button", { name: "Hide Flow summary", exact: true }).click();
  await page.getByRole("button", { name: "Select", exact: true }).click(); await fit();
  const continuation = () => page.getByRole("heading", { name: `Continue from ${targets.source.title}`, exact: true }).locator("../..");
  const connect = async () => {
    const port = card(targets.source).locator(".narrative-handle-right"); await port.hover();
    await drag(await point(port), await point(card(targets.target).locator(".narrative-handle-left")), async () => {
      await expect(card(targets.source).locator("article")).toHaveClass(/narrative-node-connecting-source/);
      await full(targets.source); await full(targets.target);
    });
    await expect(continuation()).toBeVisible();
    await expect(continuation().getByRole("combobox", { name: /^Target node/ })).toHaveValue(targets.target.id);
  };
  persist("cancel_pending"); await connect();
  await continuation().getByRole("textbox", { name: "Label", exact: true }).fill("Cancelled pending Flow canary");
  await continuation().getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(continuation()).toBeHidden();
  report.pending_cancel_document_unchanged = sameFixtureValue(before, (await session.read()).document);
  if (!report.pending_cancel_document_unchanged) throw Error("protected_flow_authoring_cancel_mutated");

  persist("create"); await connect();
  const label = "Viewport Flow canary", editedLabel = "Viewport Flow edited canary";
  await continuation().getByRole("textbox", { name: "Label", exact: true }).fill(label);
  await command(`/api/story-flows/${main.id}/continue-existing`, "POST", () => continuation().getByRole("button", { name: "Add continuation", exact: true }).click());
  await expect(continuation()).toBeHidden(); await settle(); await fit();
  const created = (await session.read()).document;
  const row = created.flow_transitions.find((row) => !before.flow_transitions.some((old) => old.id === row.id));
  if (!row) throw Error("protected_flow_authoring_transition_missing");
  const expected = { ...row, flow_id: main.id, source_node_id: targets.source.id, target_node_id: targets.target.id,
    kind: "next", label, condition: "", is_default: false, metadata: {} };
  report.created = verifyFlowAuthoringDelta(before, created, expected); await snapshot("created", created);
  const edge = page.getByTestId(`rf__edge-story-flow:${row.id}`);
  const hit = () => edge.locator(".react-flow__edge-path").evaluate((path) => {
    for (const fraction of [0.25, 0.4, 0.6, 0.8]) {
      const p = path.getPointAtLength(path.getTotalLength() * fraction);
      const screen = new DOMPoint(p.x, p.y).matrixTransform(path.getScreenCTM());
      if (document.elementFromPoint(screen.x, screen.y)?.closest(".react-flow__edge")?.dataset.id === path.closest(".react-flow__edge").dataset.id) return { x: screen.x, y: screen.y };
    }
    throw Error("protected_flow_authoring_edge_hit_missing");
  });
  persist("edit"); const editorHit = await hit(); await page.mouse.dblclick(editorHit.x, editorHit.y);
  const editor = page.getByRole("heading", { name: "Edit Story Flow transition", exact: true }).locator("../..");
  await editor.getByRole("textbox", { name: "Label", exact: true }).fill(editedLabel);
  const condition = "flags.take_smuggler_route == true";
  await editor.getByRole("textbox", { name: "Condition", exact: true }).fill(condition);
  const path = `/api/story-flows/${main.id}/transitions/${row.id}`;
  await command(path, "PUT", () => editor.getByRole("button", { name: "Save", exact: true }).click());
  await expect(editor).toBeHidden(); await settle(); await fit();
  Object.assign(expected, { label: editedLabel, condition });
  const edited = (await session.read()).document;
  report.edited = verifyFlowAuthoringDelta(before, edited, expected); await snapshot("edited", edited);
  const selectHit = await hit(); await page.mouse.click(selectHit.x, selectHit.y); await expect(edge).toHaveClass(/selected/);

  persist("reconnect");
  const updater = edge.locator(".react-flow__edgeupdater-target");
  const updaterPoint = await updater.evaluate((element) => {
    const b = element.getBoundingClientRect();
    for (const fx of [0.15, 0.25, 0.35, 0.65, 0.75, 0.85]) {
      const x = b.x + b.width * fx, y = b.y + b.height / 2;
      if (document.elementFromPoint(x, y) === element) return { x, y };
    }
    throw Error("protected_flow_authoring_updater_hit_missing");
  });
  await command(path, "PUT", async () => drag(updaterPoint, await point(card(targets.replacement).locator(".narrative-handle-left"))));
  await settle(); await fit(); Object.assign(expected, { target_node_id: targets.replacement.id });
  const reconnected = (await session.read()).document;
  report.reconnected = verifyFlowAuthoringDelta(before, reconnected, expected); await snapshot("reconnected", reconnected);
  await expect(edge).toHaveClass(/selected/);
  persist("selected_endpoint_pan"); await page.keyboard.down("Space");
  for (let index = 0; index < 4; index++) {
    const origin = await page.evaluate(() => {
      const b = document.querySelector(".react-flow").getBoundingClientRect(), x = b.right - 30;
      for (const fraction of [0.3, 0.5, 0.1, 0.8]) {
        const y = b.top + b.height * fraction;
        if (document.elementFromPoint(x, y)?.classList.contains("react-flow__pane")) return { x, y };
      }
      return null;
    });
    if (!origin) throw Error("protected_flow_authoring_pan_origin_missing");
    await drag(origin, { x: 400, y: origin.y });
  }
  await page.keyboard.up("Space"); await settle(); await expect(edge).toHaveClass(/selected/);
  const outer = await page.locator(".react-flow").boundingBox();
  for (const node of [targets.source, targets.replacement]) {
    const b = await card(node).boundingBox();
    if (!(b.x + b.width <= outer.x || b.x >= outer.x + outer.width || b.y + b.height <= outer.y || b.y >= outer.y + outer.height)) throw Error("protected_flow_authoring_endpoint_not_offscreen");
    await full(node); await expect(card(node).locator(".narrative-handle")).toHaveCount(4);
  }
  await expect(card(targets.target).locator("article")).toHaveAttribute("data-node-presentation", config.enabled ? "shell" : "full");
  report.old_endpoint_protection_released = true;
  report.selected_offscreen_endpoints_full = true; await snapshot("panned", reconnected);
  await page.screenshot({ path: `${config.artifacts}/selected-endpoints.png` }); await fit();

  persist("scope_return"); await choose(side); await expect(edge).toHaveCount(0); await choose(main); await fit();
  await expect(edge).toHaveCount(1);
  await page.getByRole("button", { name: "Graph", exact: true }).click(); await settle();
  await page.getByRole("button", { name: "Flow", exact: true }).click(); await settle(); await fit();
  await expect(edge).toHaveCount(1); await snapshot("returned", reconnected);
  report.scope_return_readback = verifyFlowAuthoringDelta(before, (await session.read()).document, expected);
  await page.screenshot({ path: `${config.artifacts}/returned.png` });
  persist("remove"); const deleteHit = await hit(); await page.mouse.click(deleteHit.x, deleteHit.y);
  await command(path, "DELETE", () => page.getByRole("region", { name: "Story Flow transition details", exact: true }).getByRole("button", { name: "Remove", exact: true }).click());
  await expect(edge).toHaveCount(0); await settle();
  report.deleted = verifyFlowAuthoringDelta(before, (await session.read()).document, null);
  persist("discard_close"); await page.getByTitle("Close project", { exact: true }).click();
  const decision = page.getByRole("heading", { name: "Unsaved changes", exact: true }).locator("../..");
  const discarded = await command(`/api/project-sessions/${session.sessionId}/discard`, "POST", () => decision.getByRole("button", { name: "Discard", exact: true }).click());
  report.saved_checkpoint_restored = sameFixtureValue(discarded.document, before);
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  report.session_released = (await page.request.get(`${config.url}/api/project-sessions/${session.sessionId}/history`)).status() === 404;
  if (!report.saved_checkpoint_restored || !report.session_released || report.page_errors || report.unexpected_writes) throw Error("protected_flow_authoring_release_failed");
  persist("complete");
} catch (error) {
  report.error_kind = error.name; report.error_message = String(error.message).slice(0, 4000);
  report.error_code = /^protected_flow_authoring_[a-z_]+$/.test(error.message) ? error.message : "browser_action_failed";
  await page?.screenshot({ path: `${config.artifacts}/failure.png`, timeout: 5000 }).catch(() => {});
  persist(report.step); process.exitCode = 1;
} finally { await browser?.close(); }

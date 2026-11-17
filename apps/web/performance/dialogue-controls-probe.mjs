import { chromium, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { assertOwnedFixture, ownedSession } from "./owned-session.mjs";
import { projectTreeButton } from "./project-tree-navigation.mjs";
import { sameFixtureValue } from "./protected-document-contract.mjs";
import { observeDialogueControls, verifyDialogueControls, verifyDialogueRegistryRequests } from "./dialogue-controls-contract.mjs";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const report = { step: "launch", observe_only: Boolean(config.observeOnly), page_errors: 0, unexpected_writes: 0, registry_requests: 0, close_requests: 0, stages: {} };
const persist = (step) => { report.step = step; writeFileSync(config.result, JSON.stringify(report)); };
let browser, page;
try {
  assertOwnedFixture(config.fixture); browser = await chromium.launch({ headless: true }); report.browser = browser.version();
  page = await browser.newPage({ viewport: config.viewport, deviceScaleFactor: 1 }); page.setDefaultTimeout(20000);
  page.on("pageerror", () => { report.page_errors++; });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/engine-tags/registry") report.registry_requests++;
    if (request.method() === "POST" && /^\/api\/project-sessions\/[^/]+\/close$/.test(path)) report.close_requests++;
  });
  await page.goto(config.url); await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.getByLabel("Projects directory").fill(config.fixture.directory);
  await page.getByRole("button", { name: "Refresh project list" }).click(); await page.getByRole("button", { name: new RegExp(config.fixture.name) }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(1124);
  const session = await ownedSession(page, config), source = session.initial.document;
  const aggregate = source.dialogues[0], node = source.nodes.find((row) => row.id === aggregate.node_id);
  const lastLine = aggregate.document.elements.at(-1), styleLine = aggregate.document.elements.find((element) => element.kind === "line");
  const protect = async (route) => {
    const request = route.request();
    if (["GET", "HEAD"].includes(request.method())) return route.fallback();
    // Explicit read-only style resolution is not a provider request or an authoring command.
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/style-resolution/resolve") {
      const body = request.postDataJSON();
      if (body.session_id === session.sessionId && body.target_node_id === node.id) return route.fallback();
    }
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/agent-memory/resolve") {
      const body = request.postDataJSON();
      if (body.project_id === source.manifest.project_id && body.agent_id === "style_rewriter"
        && body.scope?.node_id === node.id) return route.fallback();
    }
    writeFileSync(`${config.artifacts}/unexpected-route.json`, JSON.stringify({ method: request.method(), path: new URL(request.url()).pathname }));
    report.unexpected_writes++; await route.abort();
  };
  await page.route("**/api/**", protect);
  persist("open_editor"); await (await projectTreeButton(page, node.id)).click();
  await page.getByTestId(`rf__node-${node.id}`).locator(".narrative-node-title-text").dblclick();
  const heading = page.getByRole("heading", { name: `Edit dialogue: ${node.title}`, exact: true }); await heading.waitFor();
  const editor = heading.locator("../..");
  report.stages.initial = verifyDialogueControls(await page.evaluate(observeDialogueControls), config.observeOnly);
  const row = editor.locator(`[data-canon-owner-id="${lastLine.id}"]`);
  const input = row.getByRole("textbox", { name: "Text", exact: true });
  const draft = `${lastLine.text} Local draft.`; await input.fill(draft); await expect(input).toHaveValue(draft);
  const next = row.locator("label").filter({ has: page.locator(".dialogue-field-heading").filter({ hasText: /^Next$/ }) }).locator("select");
  persist("native_select"); await input.focus(); await page.keyboard.press("Tab");
  await expect(next).toBeFocused(); await expect(next.locator("option")).toHaveCount(201);
  // Platform-native popup key commitment is not portable in headless macOS.
  // Verify keyboard access and use public selectOption for actual change events.
  await next.selectOption(aggregate.document.elements[0].id); await expect(next).toHaveValue(aggregate.document.elements[0].id);
  await next.click(); await expect(next.locator("option")).toHaveCount(201);
  // Public Playwright selection checks a distant option after actual pointer materialization.
  await next.selectOption(lastLine.id); await expect(next).toHaveValue(lastLine.id);
  await input.click(); report.stages.after_blur = verifyDialogueControls(await page.evaluate(observeDialogueControls), config.observeOnly);
  persist("style_return"); const style = editor.getByRole("button", { name: `Get style recommendation: Dialogue line ${styleLine.id}`, exact: true });
  await style.click(); await page.getByRole("heading", { name: "Style recommendation", exact: true }).waitFor();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click(); await heading.waitFor();
  await expect(style).toBeFocused(); await expect(input).toHaveValue(draft); await expect(next).toHaveValue(lastLine.id);
  report.stages.style_return = verifyDialogueControls(await page.evaluate(observeDialogueControls), config.observeOnly);
  await input.scrollIntoViewIfNeeded(); await page.screenshot({ path: `${config.artifacts}/long-dialogue.png` });
  await editor.getByRole("button", { name: "Close dialog", exact: true }).click(); await expect(heading).toBeHidden();
  expect(sameFixtureValue((await session.read()).document, source)).toBe(true); report.document_unchanged = true;
  if (!config.observeOnly) verifyDialogueRegistryRequests(report.registry_requests);
  await page.unroute("**/api/**", protect); persist("close_project");
  report.before_close_status = (await session.read()).session.save_status;
  const closing = page.waitForResponse((response) => response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/project-sessions/${session.sessionId}/close`)
    .then((response) => ({ status: response.status() }), (error) => ({ error }));
  await page.getByTitle("Close project", { exact: true }).click(); const closed = await closing;
  if (closed.error) throw closed.error; report.close_status = closed.status;
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  report.session_released = (await page.request.get(`${config.url}/api/project-sessions/${session.sessionId}/history`)).status() === 404;
  report.native_tab_and_pointer_focus = true; report.public_distant_option_selection = true; report.local_style_return = true;
  if (!report.session_released || report.unexpected_writes || report.page_errors) throw Error("long_dialogue_release_failed"); persist("complete");
} catch (error) {
  report.error_kind = error.name; report.error_message = String(error.message).slice(0, 4000); report.error_code = "long_dialogue_browser_failed";
  await page?.screenshot({ path: `${config.artifacts}/failure.png`, timeout: 5000 }).catch(() => {}); persist(report.step); process.exitCode = 1;
} finally { await browser?.close(); }

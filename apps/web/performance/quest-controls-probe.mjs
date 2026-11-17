import { chromium, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { assertOwnedFixture, ownedSession } from "./owned-session.mjs";
import { projectTreeButton } from "./project-tree-navigation.mjs";
import { sameFixtureValue } from "./protected-document-contract.mjs";
import { verifyDialogueRegistryRequests } from "./dialogue-controls-contract.mjs";
import { observeQuestControls, verifyQuestControls } from "./quest-controls-contract.mjs";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const report = { step: "launch", page_errors: 0, unexpected_writes: 0, registry_requests: 0, stages: {} };
const persist = (step) => { report.step = step; writeFileSync(config.result, JSON.stringify(report)); };
let browser, page;
try {
  assertOwnedFixture(config.fixture); browser = await chromium.launch({ headless: true }); report.browser = browser.version();
  page = await browser.newPage({ viewport: config.viewport, deviceScaleFactor: 1 }); page.setDefaultTimeout(20000);
  page.on("pageerror", () => { report.page_errors++; });
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/engine-tags/registry") report.registry_requests++; });
  await page.goto(config.url); await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.getByLabel("Projects directory").fill(config.fixture.directory); await page.getByRole("button", { name: "Refresh project list" }).click();
  await page.getByRole("button", { name: new RegExp(config.fixture.name) }).click(); await expect(page.locator(".react-flow__node")).toHaveCount(1124);
  const session = await ownedSession(page, config), source = session.initial.document;
  const aggregate = source.quests[0], node = source.nodes.find((row) => row.id === aggregate.node_id), document = aggregate.document;
  const last = document.stages.at(-1), first = document.stages[0];
  const protect = async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (["GET", "HEAD"].includes(request.method())) return route.fallback();
    if (request.method() === "POST" && path === "/api/style-resolution/resolve") {
      const body = request.postDataJSON(); if (body.session_id === session.sessionId && body.target_node_id === node.id) return route.fallback();
    }
    if (request.method() === "POST" && path === "/api/agent-memory/resolve") {
      const body = request.postDataJSON(); if (body.project_id === source.manifest.project_id && body.agent_id === "style_rewriter" && body.scope?.node_id === node.id) return route.fallback();
    }
    report.unexpected_writes++; await route.abort();
  };
  await page.route("**/api/**", protect); persist("open_editor"); await (await projectTreeButton(page, node.id)).click();
  const loaded = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/quests/${node.id}` && response.request().method() === "GET");
  await page.getByTestId(`rf__node-${node.id}`).locator(".narrative-node-title-text").dblclick(); expect((await loaded).ok()).toBe(true);
  const heading = page.getByRole("heading", { name: `Edit quest: ${node.title}`, exact: true }); await heading.waitFor(); const editor = heading.locator("../..");
  await expect(editor.locator('[aria-labelledby="quest-stages-heading"] article[data-canon-owner-id]')).toHaveCount(200);
  report.stages.initial = verifyQuestControls(await page.evaluate(observeQuestControls));
  await expect(editor.getByLabel("Quest giver", { exact: true })).toHaveValue(document.quest_giver_node_id ?? "");
  const stage = editor.locator(`[data-canon-owner-id="${last.id}"]`), branch = stage.locator(`[data-canon-owner-id="${last.branches[0].id}"]`);
  const input = stage.getByRole("textbox", { name: `Description: ${last.title}`, exact: true }), draft = `${last.description} Local draft.`;
  await input.fill(draft); const next = branch.getByRole("combobox", { name: "Internal target", exact: true });
  persist("stage_target"); await branch.getByLabel("Condition", { exact: true }).focus(); await page.keyboard.press("Tab");
  await expect(next).toBeFocused(); await expect(next.locator("option")).toHaveCount(200);
  await expect(next.locator(`option[value="${last.id}"]`)).toHaveCount(0);
  await next.selectOption(first.id); await input.click(); await expect(next).toHaveValue(first.id);
  await expect(branch.getByRole("button", { name: "Add outcome", exact: true })).toBeDisabled();
  await next.focus(); await next.selectOption(""); await expect(branch.getByRole("button", { name: "Add outcome", exact: true })).toBeEnabled();
  await next.click(); await expect(next.locator("option")).toHaveCount(200); await next.selectOption(first.id); await input.click();
  report.stages.after_edit = verifyQuestControls(await page.evaluate(observeQuestControls));
  persist("style_return"); const style = editor.getByRole("button", { name: `Get style recommendation: Stage description for ${first.title}`, exact: true });
  await style.click(); await page.getByRole("heading", { name: "Style recommendation", exact: true }).waitFor();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click(); await heading.waitFor();
  await expect(style).toBeFocused(); await expect(input).toHaveValue(draft); await expect(next).toHaveValue(first.id);
  report.stages.style_return = verifyQuestControls(await page.evaluate(observeQuestControls));
  await input.scrollIntoViewIfNeeded(); await page.screenshot({ path: `${config.artifacts}/long-quest.png` });
  await editor.getByRole("button", { name: "Close dialog", exact: true }).click(); await expect(heading).toBeHidden();
  expect(sameFixtureValue((await session.read()).document, source)).toBe(true); report.document_unchanged = true; verifyDialogueRegistryRequests(report.registry_requests);
  await page.unroute("**/api/**", protect); persist("close_project"); await page.getByTitle("Close project", { exact: true }).click();
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  report.session_released = (await page.request.get(`${config.url}/api/project-sessions/${session.sessionId}/history`)).status() === 404;
  report.own_stage_excluded = true; report.draft_and_style_return = true; report.internal_external_outcome_state = true;
  if (!report.session_released || report.unexpected_writes || report.page_errors) throw Error("long_quest_release_failed"); persist("complete");
} catch (error) {
  report.error_kind = error.name; report.error_message = String(error.message).slice(0, 4000); report.error_code = "long_quest_browser_failed";
  await page?.screenshot({ path: `${config.artifacts}/failure.png`, timeout: 5000 }).catch(() => {}); persist(report.step); process.exitCode = 1;
} finally { await browser?.close(); }

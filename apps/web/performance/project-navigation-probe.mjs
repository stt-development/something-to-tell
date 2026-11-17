import { chromium, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { assertOwnedFixture, ownedSession } from "./owned-session.mjs";
import { settledViewport } from "./zoom.mjs";
import { sameFixtureValue } from "./protected-document-contract.mjs";
import { centeredTreeTarget, treeNodeForLabel } from "./workflow-observation.mjs";
import { observeProjectNavigation, verifyProjectNavigation, projectNavigationOverflow } from "./project-navigation-contract.mjs";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const report = { step: "launch", page_errors: 0, write_attempts: 0, released_sessions: 0, stages: {} };
const persist = (step) => { report.step = step; writeFileSync(config.result, JSON.stringify(report)); };
let browser, page;
try {
  assertOwnedFixture(config.fixture); browser = await chromium.launch({ headless: true }); report.browser = browser.version();
  page = await browser.newPage({ viewport: config.viewport, deviceScaleFactor: 1 }); page.setDefaultTimeout(20000);
  page.on("pageerror", () => { report.page_errors++; });
  await page.goto(config.url); await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.getByLabel("Projects directory").fill(config.fixture.directory);
  await page.getByRole("button", { name: "Refresh project list" }).click(); await page.getByRole("button", { name: new RegExp(config.fixture.name) }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(1124); await page.evaluate(settledViewport, { minimumMs: 750 });
  const session = await ownedSession(page, config);
  const blockWrites = async (route) => {
    if (!["GET", "HEAD"].includes(route.request().method())) { report.write_attempts++; await route.abort(); } else await route.fallback();
  };
  await page.route("**/api/**", blockWrites);
  if (!await page.locator(".project-tree-row").count()) await page.getByTitle("Projects", { exact: true }).click();
  const tree = page.getByRole("list", { name: "Graph", exact: true });
  persist("initial_rows"); report.stages.initial = verifyProjectNavigation(await page.evaluate(observeProjectNavigation));
  expect(await page.evaluate(projectNavigationOverflow)).toBe(0);
  const first = tree.locator("button").first(); await first.focus(); await page.keyboard.press("End");
  await expect.poll(() => page.evaluate(() => Number(document.activeElement?.closest('[role="listitem"]')?.getAttribute("aria-posinset"))
    === Number(document.activeElement?.closest('[role="listitem"]')?.getAttribute("aria-setsize")))).toBe(true);
  const last = tree.locator("button:focus"), label = (await last.innerText()).trim();
  const targetId = await page.evaluate(treeNodeForLabel, label);
  if (!targetId) throw Error("distant_tree_visual_target_missing");
  persist("distant_focus"); await last.click(); await page.waitForFunction(centeredTreeTarget, targetId);
  report.stages.distant = verifyProjectNavigation(await page.evaluate(observeProjectNavigation));
  await last.focus(); await page.keyboard.press("Home");
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[role="listitem"]')?.getAttribute("aria-posinset"))).toBe("1");
  await page.keyboard.press("PageDown");
  await expect.poll(() => page.evaluate(() => Number(document.activeElement?.closest('[role="listitem"]')?.getAttribute("aria-posinset")))).toBeGreaterThan(1);
  await tree.hover(); const scrollBefore = await tree.evaluate((element) => element.scrollTop);
  await page.mouse.wheel(0, 700); await expect.poll(() => tree.evaluate((element) => element.scrollTop)).toBeGreaterThan(scrollBefore);
  report.stages.wheel = verifyProjectNavigation(await page.evaluate(observeProjectNavigation));
  report.horizontal_overflow = await page.evaluate(projectNavigationOverflow); expect(report.horizontal_overflow).toBe(0);
  await page.screenshot({ path: `${config.artifacts}/navigation.png` });
  expect(sameFixtureValue((await session.read()).document, session.initial.document)).toBe(true);
  await expect(page.locator(".react-flow__node")).toHaveCount(1124);
  await page.unroute("**/api/**", blockWrites); await page.getByTitle("Close project", { exact: true }).click();
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  expect((await page.request.get(`${config.url}/api/project-sessions/${session.sessionId}/history`)).status()).toBe(404); report.released_sessions++;
  report.document_unchanged = true; report.keyboard_and_native_wheel = true;
  if (report.page_errors || report.write_attempts || report.released_sessions !== 1) throw Error("project_navigation_read_only_failed"); persist("complete");
} catch (error) {
  report.error_kind = error.name; report.error_message = String(error.message).slice(0, 4000); report.error_code = "project_navigation_browser_failed";
  await page?.screenshot({ path: `${config.artifacts}/failure.png`, timeout: 5000 }).catch(() => {}); persist(report.step); process.exitCode = 1;
} finally { await browser?.close(); }

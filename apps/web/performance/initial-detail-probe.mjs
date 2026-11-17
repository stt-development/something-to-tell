import { chromium, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { assertOwnedFixture, ownedSession } from "./owned-session.mjs";
import { settledViewport } from "./zoom.mjs";
import { sameFixtureValue } from "./protected-document-contract.mjs";
import { observeInitialDetail, verifyInitialDetail } from "./initial-detail-contract.mjs";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const report = { step: "launch", page_errors: 0, write_attempts: 0, released_sessions: 0, stages: {} };
const persist = (step) => { report.step = step; writeFileSync(config.result, JSON.stringify(report)); };
let browser, page;
try {
  assertOwnedFixture(config.fixture); browser = await chromium.launch({ headless: true }); report.browser = browser.version();
  page = await browser.newPage({ viewport: config.viewport, deviceScaleFactor: 1 }); page.setDefaultTimeout(20000);
  page.on("pageerror", () => { report.page_errors++; });
  const blockWrites = async (route) => {
    if (!["GET", "HEAD"].includes(route.request().method())) { report.write_attempts++; await route.abort(); } else await route.fallback();
  };
  await page.goto(config.url); let document;
  for (const stage of ["first_open", "reopen"]) {
    persist(stage); await page.getByRole("button", { name: "Open", exact: true }).click();
    await page.getByLabel("Projects directory").fill(config.fixture.directory);
    await page.getByRole("button", { name: "Refresh project list" }).click(); await page.getByRole("button", { name: new RegExp(config.fixture.name) }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(1124);
    await page.evaluate(settledViewport, { minimumMs: 750 });
    const session = await ownedSession(page, config); await page.route("**/api/**", blockWrites);
    if (document) expect(sameFixtureValue(document, session.initial.document)).toBe(true); else document = session.initial.document;
    // No toolbar Fit/Reveal/Select or pane gesture before this observation.
    report.stages[stage] = verifyInitialDetail(await page.evaluate(observeInitialDetail));
    await page.screenshot({ path: `${config.artifacts}/${stage}.png` });
    expect(sameFixtureValue((await session.read()).document, document)).toBe(true);
    await page.unroute("**/api/**", blockWrites); await page.getByTitle("Close project", { exact: true }).click();
    await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
    expect((await page.request.get(`${config.url}/api/project-sessions/${session.sessionId}/history`)).status()).toBe(404); report.released_sessions++;
  }
  report.document_unchanged = true; report.no_explicit_fit_or_reveal = true;
  if (report.page_errors || report.write_attempts || report.released_sessions !== 2) throw Error("initial_detail_read_only_failed"); persist("complete");
} catch (error) {
  report.error_kind = error.name; report.error_message = String(error.message).slice(0, 4000); report.error_code = "initial_detail_browser_failed";
  await page?.screenshot({ path: `${config.artifacts}/failure.png`, timeout: 5000 }).catch(() => {}); persist(report.step); process.exitCode = 1;
} finally { await browser?.close(); }

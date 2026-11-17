import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// A separate opt-in capture keeps README recordings out of ordinary CI workloads.
test.use({ viewport: { width: 1280, height: 800 }, video: { mode: "on", size: { width: 1280, height: 800 } } });
test.setTimeout(120_000);

test("records Story editing and Flow branch inspection on an owned Aurora copy", async ({ page, request }, info) => {
  page.setDefaultTimeout(15_000);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const directory = await mkdtemp(join(tmpdir(), "stt-readme-story-"));
  const destination = join(directory, "Aurora.narrative");
  const origin = process.env.STT_DEMO_ORIGIN ?? "http://127.0.0.1:1425";
  const api = process.env.STT_DEMO_API ?? "http://127.0.0.1:8875/api";
  let sessionId: string | undefined;
  const started = Date.now();
  const marks: Record<string, number> = {};
  try {
    // Import a new local folder, never open the author's existing Aurora project.
    execFileSync(process.env.STT_DEMO_PYTHON ?? resolve(root, ".venv/bin/python"), [
      "-m", "services.runtime.scripts.import_project_fixture",
      resolve(root, "fixtures/projects/project-aurora-export.v1.json"), destination
    ], { cwd: root, stdio: "pipe" });
    await page.addInitScript(() => localStorage.setItem("stt.ui_locale.v1", "en"));
    await page.goto(origin);
    await page.getByRole("button", { name: "Open", exact: true }).click();
    const open = page.getByRole("heading", { name: "Open project", exact: true }).locator("../..");
    await open.getByLabel("Projects directory").fill(directory);
    await open.getByRole("button", { name: "Refresh project list" }).click();
    const opened = page.waitForResponse(response => response.url() === `${api}/project-sessions/open` && response.ok());
    await open.getByRole("button", { name: /Project Aurora Export/ }).click();
    sessionId = (await (await opened).json()).session.session_id;
    await expect(page.getByRole("heading", { name: "Project Aurora Export", exact: true })).toBeVisible();
    await page.getByTitle("Projects", { exact: true }).click();
    await page.waitForTimeout(500);

    marks.storyStart = (Date.now() - started) / 1000;
    await page.getByRole("button", { name: "Story", exact: true }).click();
    const story = page.getByLabel("Story document", { exact: true });
    await expect(story.getByRole("heading", { name: "Main Story", exact: true })).toBeVisible();
    await page.waitForTimeout(1100);
    const opening = story.getByRole("article", { name: "Scene: Opening Dock", exact: true });
    await opening.getByRole("button", { name: "Edit Opening Dock inline", exact: true }).click();
    const text = "Dawn settles over the harbor. Mara waits beside the sealed ledger.";
    await opening.getByRole("textbox", { name: "Description", exact: true }).fill("");
    await opening.getByRole("textbox", { name: "Description", exact: true }).pressSequentially(text, { delay: 25 });
    await opening.getByRole("button", { name: "Save text", exact: true }).click();
    await expect(opening).toContainText(text);
    await page.waitForTimeout(800);
    await story.evaluate(element => element.scrollBy({ top: 620, behavior: "smooth" }));
    await page.waitForTimeout(1500);
    await story.evaluate(element => element.scrollBy({ top: 530, behavior: "smooth" }));
    await page.waitForTimeout(1500);
    await page.screenshot({ path: info.outputPath("story.png") });
    marks.storyEnd = (Date.now() - started) / 1000;

    // Finish navigation/menu setup before the published Flow segment starts.
    await page.getByTitle("Projects", { exact: true }).click();
    await page.getByRole("button", { name: "Open Story Flow Smuggler Route", exact: true }).click();
    await page.getByTitle("Projects", { exact: true }).click();
    await page.getByRole("button", { name: "Flow", exact: true }).click();
    const hide = page.locator(".flow-summary-close");
    if (await hide.isVisible()) await hide.click();
    await page.locator(".react-flow__controls-fitview").click();
    // Leave room for the loopback arc above the node bounds.
    await page.locator(".react-flow__controls-zoomout").click();
    await page.waitForTimeout(600);
    marks.flowStart = (Date.now() - started) / 1000;
    await expect(page.locator(".story-flow-edge-label").filter({ hasText: "Take the covert route" })).toBeVisible();
    await page.waitForTimeout(1300);
    await page.mouse.move(660, 370, { steps: 12 });
    await page.mouse.wheel(0, -220);
    await page.waitForTimeout(1300);
    await page.mouse.wheel(0, 140);
    await page.waitForTimeout(1100);
    await expect(page.locator(".story-flow-edge-label")).toHaveCount(5);
    await expect(page.locator(".story-flow-edge-label").filter({ hasText: "Circle back past the patrol" })).toBeVisible();
    await page.mouse.move(940, 420, { steps: 15 });
    await page.waitForTimeout(1800);
    await page.locator(".react-flow__controls-fitview").click();
    await page.locator(".react-flow__controls-zoomout").click();
    await page.mouse.move(1230, 760, { steps: 15 });
    await page.waitForTimeout(1600);
    marks.flowEnd = (Date.now() - started) / 1000;
    await page.screenshot({ path: info.outputPath("flow.png") });
    const snapshot = await request.get(`${api}/project-sessions/${sessionId}`);
    expect(snapshot.ok()).toBe(true);
    expect((await snapshot.json()).document.nodes.find((node: { id: string }) => node.id === "node-opening").body).toBe(text);
    await writeFile(info.outputPath("timing.json"), JSON.stringify(marks, null, 2));
  } finally {
    if (sessionId) {
      expect((await request.post(`${api}/project-sessions/${sessionId}/discard`, { data: {} })).ok()).toBe(true);
      expect((await request.post(`${api}/project-sessions/${sessionId}/close`, { data: {} })).ok()).toBe(true);
    }
    await rm(directory, { recursive: true, force: true });
  }
});

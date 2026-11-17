import { test, expect, type Locator } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Opt-in recording: playwright test demos/readme.spec.ts, never normal e2e discovery.
test.use({ viewport: { width: 1280, height: 800 }, video: { mode: "on", size: { width: 1280, height: 800 } } });
test.setTimeout(120_000);

test("records real node creation and connection in a disposable project", async ({ page, request }, info) => {
  page.setDefaultTimeout(12_000);
  const origin = process.env.STT_DEMO_ORIGIN ?? "http://127.0.0.1:1425";
  const api = process.env.STT_DEMO_API ?? "http://127.0.0.1:8875/api";
  const directory = await mkdtemp(join(tmpdir(), "stt-readme-"));
  let sessionId: string | undefined;
  const started = Date.now();
  const marks: Record<string, number> = {};
  page.on("response", async (response) => {
    if (response.url() === `${api}/project-sessions/create` && response.ok()) {
      sessionId = (await response.json()).session.session_id;
    }
  });
  try {
    await page.addInitScript(() => localStorage.setItem("stt.ui_locale.v1", "en"));
    await page.goto(origin);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    const create = page.getByRole("heading", { name: "Create project", exact: true }).locator("../..");
    await create.getByLabel("Parent directory").fill(directory);
    await create.getByLabel("Name", { exact: true }).fill("The Lantern Gate");
    await create.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByLabel("Start empty project")).toBeVisible();
    // Keep machine-local project paths out of the published recording.
    await page.getByTitle("Projects", { exact: true }).click();
    await page.waitForTimeout(250);
    marks.createStart = (Date.now() - started) / 1000;
    await page.waitForTimeout(700);
    await page.getByRole("button", { name: "Build world", exact: true }).click();
    const world = page.getByRole("heading", { name: "Build world", exact: true }).locator("../..");
    await world.getByLabel("Name", { exact: true }).pressSequentially("The sealed gate", { delay: 40 });
    await world.getByLabel("Description").fill("An ancient gate opens only for a keeper of the lantern.");
    await world.getByRole("button", { name: "Create node", exact: true }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(1);
    await page.waitForTimeout(500);
    const lore = page.locator(".react-flow__node").filter({ hasText: "The sealed gate" });
    await addNode("Character", "Mara, lantern keeper", "She knows the gate and carries its last light.", 180, 180);
    await addNode("Event", "Open the gate", "Mara raises the lantern. The stone doors begin to move.", 850, 180);
    await page.locator(".react-flow__controls-fitview").click();
    await page.waitForTimeout(400);
    const loreBox = await lore.boundingBox();
    const titleBox = await lore.locator(".narrative-node-title-text").boundingBox();
    if (!loreBox || !titleBox) throw Error("demo_layout_missing");
    await page.mouse.move(titleBox.x + 30, titleBox.y + 8, { steps: 12 });
    await page.mouse.down();
    await page.mouse.move(330 + titleBox.x - loreBox.x + 30, 500 + titleBox.y - loreBox.y + 8, { steps: 28 });
    await page.mouse.up();
    await page.mouse.click(800, 700);
    await page.waitForTimeout(900);
    marks.createEnd = (Date.now() - started) / 1000;
    marks.connectStart = marks.createEnd;
    const mara = page.locator(".react-flow__node").filter({ hasText: "Mara, lantern keeper" });
    const event = page.locator(".react-flow__node").filter({ hasText: "Open the gate" });
    await connect(lore, event, "right", "bottom");
    await connect(mara, event, "right", "left");
    await expect(page.locator(".react-flow__edge")).toHaveCount(2);
    await page.mouse.move(1170, 690, { steps: 15 });
    await page.waitForTimeout(2200);
    marks.connectEnd = (Date.now() - started) / 1000;
    await expect.poll(() => sessionId).toBeTruthy();
    const snapshot = await request.get(`${api}/project-sessions/${sessionId}`);
    expect(snapshot.ok()).toBe(true);
    const document = (await snapshot.json()).document;
    expect(document.nodes).toHaveLength(3);
    expect(document.edges).toHaveLength(2);
    await page.screenshot({ path: info.outputPath("final.png") });
    await writeFile(info.outputPath("timing.json"), JSON.stringify(marks, null, 2));
  } finally {
    // Only the session created by this recording is discarded and released.
    if (sessionId) {
      expect((await request.post(`${api}/project-sessions/${sessionId}/discard`, { data: {} })).ok()).toBe(true);
      expect((await request.post(`${api}/project-sessions/${sessionId}/close`, { data: {} })).ok()).toBe(true);
    }
    await rm(directory, { recursive: true, force: true });
  }

  async function addNode(kind: string, title: string, text: string, x: number, y: number) {
    const count = await page.locator(".react-flow__node").count();
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.classList.contains("react-flow__pane"), { x, y })).toBe(true);
    await page.locator("nav").getByRole("button", { name: kind, exact: true }).click();
    const created = page.waitForResponse(response => response.url() === `${api}/nodes` && response.request().method() === "POST");
    await page.mouse.move(x, y, { steps: 20 });
    await page.mouse.click(x, y);
    const response = await created;
    expect(response.ok()).toBe(true);
    const node = page.getByTestId(`rf__node-${(await response.json()).id}`);
    await expect(page.locator(".react-flow__node")).toHaveCount(count + 1);
    await node.locator(".narrative-node-title-text").dblclick();
    const edit = page.getByRole("heading", { name: "Edit node", exact: true }).locator("../..");
    await edit.getByLabel("Label", { exact: true }).fill("");
    await edit.getByLabel("Label", { exact: true }).pressSequentially(title, { delay: 35 });
    await edit.getByLabel("Text", { exact: true }).fill(text);
    await page.waitForTimeout(550);
    await edit.getByRole("button", { name: "Save", exact: true }).click();
    await expect(node).toContainText(title);
    await page.waitForTimeout(500);
  }

  async function connect(source: Locator, target: Locator, sourcePort: string, targetPort: string) {
    const count = await page.locator(".react-flow__edge").count();
    await page.mouse.click(800, 700);
    await source.locator(".narrative-node-title-text").hover();
    const from = await source.locator(`.narrative-handle-${sourcePort}`).boundingBox();
    const to = await target.locator(`.narrative-handle-${targetPort}`).boundingBox();
    if (!from || !to) throw Error("demo_connection_handle_missing");
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2, { steps: 15 });
    await page.waitForTimeout(250);
    const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.outerHTML, { x: from.x + from.width / 2, y: from.y + from.height / 2 });
    expect(hit).toContain("react-flow__handle");
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 35 });
    await page.waitForTimeout(350);
    await page.mouse.up();
    // Graph exposes an explicit connection-kind choice rather than silently selecting Story.
    const relation = page.getByRole("button", { name: /^Relationship/ });
    if (await relation.isVisible()) await relation.click();
    await expect(page.locator(".react-flow__edge")).toHaveCount(count + 1);
    await page.mouse.click(650, 130);
    await page.waitForTimeout(900);
  }
});

import { chromium, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { assertOwnedFixture, ownedSession } from "./owned-session.mjs";
import { settledViewport } from "./zoom.mjs";
import { AUTOPAN_CLEARANCE, verifyLiveAutopan, verifyAutopanDocuments } from "./protected-autopan-contract.mjs";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const report = { step: "launch", page_errors: 0, gestures: [] };
const persist = (step) => { report.step = step; writeFileSync(config.result, JSON.stringify(report)); };
let browser, page;
try {
  assertOwnedFixture(config.fixture);
  browser = await chromium.launch({ headless: true }); report.browser = browser.version();
  page = await browser.newPage({ viewport: config.viewport, deviceScaleFactor: 1 });
  page.setDefaultTimeout(20000); page.on("pageerror", () => { report.page_errors++; });
  const command = async (path, method, action) => {
    const pending = page.waitForResponse((response) => response.url().endsWith(path) && response.request().method() === method)
      .then((response) => ({ response }), (error) => ({ error }));
    await action(); const result = await pending;
    if (result.error) throw result.error;
    if (!result.response.ok()) throw new Error("protected_autopan_command_failed");
    return method === "DELETE" ? null : result.response.json();
  };
  const settle = () => page.evaluate(settledViewport, { minimumMs: 350 });
  const point = async (locator) => {
    const b = await locator.boundingBox();
    if (!b) throw new Error("protected_autopan_hit_target_missing");
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const move = (p) => page.mouse.move(p.x, p.y, { steps: 8 });
  const empty = () => page.evaluate(() => {
    const c = document.querySelector(".react-flow").getBoundingClientRect();
    const boxes = [...document.querySelectorAll(".react-flow__node")].map((node) => node.getBoundingClientRect());
    for (const fy of [0.45, 0.3, 0.6]) for (const fx of [0.6, 0.4, 0.75]) {
      const x = c.x + c.width * fx, y = c.y + c.height * fy;
      if (document.elementFromPoint(x, y)?.classList.contains("react-flow__pane")
        && boxes.every((b) => x < b.left - 30 || x > b.right + 30 || y < b.top - 30 || y > b.bottom + 30)) return { x, y };
    }
    throw new Error("protected_autopan_empty_pane_missing");
  });
  const clearSelection = async () => {
    await page.getByRole("button", { name: "Pan canvas", exact: true }).click();
    await page.getByRole("button", { name: "Select", exact: true }).click();
    await expect(page.locator(".react-flow__node.selected, .react-flow__edge.selected")).toHaveCount(0);
  };
  const fit = async () => { await page.locator(".react-flow__controls-fitview").click(); await settle(); };
  persist("open"); await page.goto(config.url);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.getByLabel("Projects directory").fill(config.fixture.directory);
  await page.getByRole("button", { name: "Refresh project list" }).click();
  await page.getByRole("button", { name: new RegExp(config.fixture.name) }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(1124); await settle();
  const session = await ownedSession(page, config), before = session.initial.document;
  if (await page.locator(".project-tree-row").count()) await page.getByTitle("Projects", { exact: true }).click();
  persist("prepare_canaries");
  await page.getByRole("button", { name: "Show graph filters", exact: true }).click();
  const search = page.getByRole("textbox", { name: "Search graph", exact: true });
  await search.fill("stt-autopan-canary-no-match-7e42"); await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await page.getByRole("button", { name: "Hide graph filters", exact: true }).click();
  for (let index = 0; index < 32; index++) {
    if ((await page.evaluate(settledViewport, {})).viewport.zoom >= 0.85) break;
    await page.locator(".react-flow__controls-zoomin").click();
  }
  const ids = [];
  for (const [x, y] of [[240, 250], [620, 250], [240, 480]]) {
    await page.getByRole("button", { name: "Lore", exact: true }).click();
    ids.push((await command("/api/nodes", "POST", () => page.mouse.click(x, y))).id);
  }
  await page.getByRole("button", { name: "Show graph filters", exact: true }).click();
  await search.fill("Lore node"); await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await page.getByRole("button", { name: "Hide graph filters", exact: true }).click(); await settle();
  const created = (await session.read()).document, nodes = ids.map((id) => page.getByTestId(`rf__node-${id}`));
  const source = nodes[0];
  const begin = async (p) => {
    await move(p); await page.mouse.down(); await move({ x: p.x + 30, y: p.y });
    await expect(page.locator(".react-flow__connection-path")).toHaveCount(1);
  };
  const activeAutopan = async (name) => {
    persist(name);
    const start = (await settle()).viewport.x, c = await page.locator(".react-flow").boundingBox();
    await move({ x: c.x + c.width - 2, y: c.y + c.height * 0.25 });
    await page.waitForFunction(({ id, clearance }) => {
      const c = document.querySelector(".react-flow").getBoundingClientRect();
      const node = [...document.querySelectorAll(".react-flow__node")].find((item) => item.dataset.id === id);
      return node.getBoundingClientRect().right < c.left - clearance;
    }, { id: ids[0], clearance: AUTOPAN_CLEARANCE }, { timeout: 15000 });
    // Stop auto-pan without ending the pointer gesture before observing protection.
    await move(await empty()); const current = (await settle()).viewport.x;
    const observation = await source.evaluate((node) => {
      const article = node.querySelector("article"), c = document.querySelector(".react-flow").getBoundingClientRect();
      return { source_right: node.getBoundingClientRect().right, canvas_left: c.left,
        source_full: article.dataset.nodePresentation === "full", source_connecting: article.classList.contains("narrative-node-connecting-source"),
        connection_paths: document.querySelectorAll(".react-flow__connection-path").length,
        selected_nodes: document.querySelectorAll(".react-flow__node.selected").length,
        selected_edges: document.querySelectorAll(".react-flow__edge.selected").length,
        focus_within_source: article.contains(document.activeElement), handles: document.querySelectorAll(".narrative-handle").length };
    });
    report.gestures.push({ name, ...verifyLiveAutopan({ ...observation, camera_dx: current - start }) });
    await page.screenshot({ path: `${config.artifacts}/${name}.png` });
  };
  const targetPreview = async (node) => {
    await expect(node.locator("article")).toHaveClass(/narrative-node-connecting-target/);
    await expect(node.locator("article")).toHaveAttribute("data-node-presentation", "full");
    await expect.poll(() => node.locator(".narrative-handle").evaluateAll((ports) => ports.length === 4
      && ports.every((port) => Number(getComputedStyle(port).opacity) > 0.9))).toBe(true);
  };
  await clearSelection();
  const port = source.locator(".narrative-handle-right"); await port.hover(); await begin(await point(port));
  await activeAutopan("create_cancel");
  await expect(page.locator(".narrative-node-connecting-target")).toHaveCount(0);
  await page.mouse.up(); await settle();
  await expect(page.locator(".react-flow__connection-path, .narrative-node-connecting-source, .narrative-node-connecting-target")).toHaveCount(0);
  await expect(source.locator("article")).toHaveAttribute("data-node-presentation", config.enabled ? "shell" : "full");
  const cancelled = (await session.read()).document;
  report.cancel_releases_source = true;
  await fit(); await port.hover(); await begin(await point(port));
  const b = await nodes[1].boundingBox(); await move({ x: b.x + 30, y: b.y + b.height / 2 }); await targetPreview(nodes[1]);
  await page.mouse.up();
  await command("/api/edges", "POST", () => page.getByRole("button", { name: /^Relationship/ }).click());
  const connected = (await session.read()).document;
  const edge = connected.edges.find((item) => !created.edges.some((original) => original.id === item.id));
  if (!edge) throw new Error("protected_autopan_edge_missing");
  const rendered = page.getByTestId(`rf__edge-${edge.id}`), updater = rendered.locator(".react-flow__edgeupdater-target");
  const beginReconnect = async () => {
    await clearSelection();
    const hit = await rendered.locator(".react-flow__edge-path").evaluate((path) => {
      const p = path.getPointAtLength(path.getTotalLength() * 0.8), q = new DOMPoint(p.x, p.y).matrixTransform(path.getScreenCTM());
      return { x: q.x, y: q.y };
    });
    await move(hit);
    const p = await updater.evaluate((element) => {
      const b = element.getBoundingClientRect();
      for (const fx of [0.15, 0.25, 0.35, 0.65, 0.75, 0.85]) {
        const x = b.x + b.width * fx, y = b.y + b.height / 2;
        if (document.elementFromPoint(x, y) === element) return { x, y };
      }
      throw new Error("protected_autopan_updater_hit_missing");
    });
    await begin(p);
  };
  await beginReconnect(); await activeAutopan("reconnect");
  await expect(nodes[2].locator("article")).toHaveAttribute("data-node-presentation", config.enabled ? "shell" : "full");
  const c = await page.locator(".react-flow").boundingBox();
  await move({ x: c.x + 2, y: c.y + c.height * 0.25 });
  await page.waitForFunction((id) => {
    const c = document.querySelector(".react-flow").getBoundingClientRect();
    return [...document.querySelectorAll(".react-flow__node")].find((node) => node.dataset.id === id).getBoundingClientRect().left >= c.left + 80;
  }, ids[2], { timeout: 15000 });
  await move(await empty()); await settle();
  await move(await point(nodes[2].locator(".narrative-handle-left"))); await targetPreview(nodes[2]);
  await command(`/api/edges/${edge.id}`, "PUT", () => page.mouse.up());
  const reconnected = (await session.read()).document;
  report.return_target_materialized = true; report.target_previews_verified = 2;
  await beginReconnect(); await activeAutopan("detach");
  await expect(page.locator(".narrative-node-connecting-target")).toHaveCount(0);
  await command(`/api/edges/${edge.id}`, "DELETE", () => page.mouse.up()); await settle();
  await expect(rendered).toHaveCount(0);
  await expect(page.locator(".react-flow__connection-path, .narrative-node-connecting-source, .narrative-node-connecting-target")).toHaveCount(0);
  await expect(source.locator("article")).toHaveAttribute("data-node-presentation", config.enabled ? "shell" : "full");
  await expect(page.locator(".narrative-handle")).toHaveCount(12);
  report.detach_releases_source = true;
  const deleted = (await session.read()).document;
  Object.assign(report, verifyAutopanDocuments(before, created, cancelled, connected, reconnected, deleted, ids));
  persist("discard_close"); await page.getByTitle("Close project", { exact: true }).click();
  const decision = page.getByRole("heading", { name: "Unsaved changes", exact: true }).locator("../..");
  const discarded = await command(`/api/project-sessions/${session.sessionId}/discard`, "POST", () => decision.getByRole("button", { name: "Discard", exact: true }).click());
  report.saved_checkpoint_restored = discarded.document.checksum === before.checksum;
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  report.session_released = (await page.request.get(`${config.url}/api/project-sessions/${session.sessionId}/history`)).status() === 404;
  if (!report.saved_checkpoint_restored || !report.session_released || report.page_errors) throw new Error("protected_autopan_release_failed");
  persist("complete");
} catch (error) {
  report.error_kind = error.name; report.error_message = String(error.message).slice(0, 4000);
  report.error_code = /^protected_autopan_[a-z_]+$/.test(error.message) ? error.message : "browser_action_failed";
  await page?.screenshot({ path: `${config.artifacts}/failure.png`, timeout: 5000 }).catch(() => {});
  persist(report.step); process.exitCode = 1;
} finally { await browser?.close(); }

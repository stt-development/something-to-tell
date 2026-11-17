import { chromium, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { assertOwnedFixture, ownedSession } from "./owned-session.mjs";
import { settledViewport } from "./zoom.mjs";
import { verifyProtectedConnections } from "./protected-connections-contract.mjs";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const report = { step: "launch", page_errors: 0 };
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
    if (!result.response.ok()) throw new Error("protected_connections_command_failed");
    return method === "DELETE" ? null : result.response.json();
  };
  const settle = () => page.evaluate(settledViewport, { minimumMs: 350 });
  const point = async (locator, offsetX = 0) => {
    const b = await locator.boundingBox();
    if (!b) throw new Error("protected_connections_hit_target_missing");
    return { x: b.x + b.width / 2 + offsetX, y: b.y + b.height / 2 };
  };
  const drag = async (start, end) => {
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 12 }); await page.mouse.up();
  };
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
  await search.fill("stt-connection-canary-no-match-8c14"); await expect(page.locator(".react-flow__node")).toHaveCount(0);
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
  const created = (await session.read()).document;
  const nodes = ids.map((id) => page.getByTestId(`rf__node-${id}`));
  await page.getByRole("button", { name: "Select", exact: true }).click();

  persist("connect");
  const port = nodes[0].locator(".narrative-handle-right"); await port.hover();
  await drag(await point(port), await point(nodes[1].locator(".narrative-handle-left")));
  await command("/api/edges", "POST", () => page.getByRole("button", { name: /^Relationship/ }).click());
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  const connected = (await session.read()).document;
  const edge = connected.edges.find((item) => !created.edges.some((original) => original.id === item.id));
  if (!edge) throw new Error("protected_connections_edge_missing");
  const rendered = page.getByTestId(`rf__edge-${edge.id}`);
  // Derive a real hit target from the SVG route, not a private graph store.
  const curvePoint = () => rendered.locator(".react-flow__edge-path").evaluate((path) => {
    const p = path.getPointAtLength(path.getTotalLength() * 0.2);
    const screen = new DOMPoint(p.x, p.y).matrixTransform(path.getScreenCTM());
    return { x: screen.x, y: screen.y };
  });
  persist("label");
  const hit = await curvePoint(); await page.mouse.dblclick(hit.x, hit.y);
  const editor = page.getByRole("heading", { name: "Edit edge", exact: true }).locator("../..");
  const label = "Disposable viewport connection canary";
  await editor.getByRole("textbox", { name: "Label", exact: true }).fill(label);
  await command(`/api/edges/${edge.id}`, "PUT", () => editor.getByRole("button", { name: "Save", exact: true }).click());
  await expect(editor).toBeHidden();
  const labeled = (await session.read()).document;
  await page.mouse.click(hit.x, hit.y); await expect(rendered).toHaveClass(/selected/);

  const offscreenProtection = async (protectedIndexes) => {
    const checksum = (await session.read()).document.checksum;
    if (protectedIndexes.length) await expect(rendered).toHaveClass(/selected/);
    await page.keyboard.down("Space");
    for (let index = 0; index < 4; index++) {
      // Fit can put a node under a fixed pan origin. Hit-test empty pane so this
      // drill measures endpoint protection, not a node's click-selection policy.
      const origin = await page.evaluate(() => {
        const b = document.querySelector(".react-flow").getBoundingClientRect();
        const x = b.right - 100;
        for (const y of [b.bottom - 30, b.bottom - 60, b.top + 30]) {
          if (document.elementFromPoint(x, y)?.classList.contains("react-flow__pane")) return { x, y };
        }
        return null;
      });
      if (!origin) throw new Error("protected_connections_pan_origin_missing");
      await page.mouse.move(origin.x, origin.y); await page.mouse.down();
      await page.mouse.move(400, origin.y, { steps: 6 }); await page.mouse.up();
    }
    await page.keyboard.up("Space"); await settle();
    if (protectedIndexes.length) await expect(rendered).toHaveClass(/selected/);
    const canvas = await page.locator(".react-flow").boundingBox();
    for (const [index, node] of nodes.entries()) {
      const b = await node.boundingBox();
      if (!(b.x + b.width <= canvas.x || b.x >= canvas.x + canvas.width || b.y + b.height <= canvas.y || b.y >= canvas.y + canvas.height)) {
        throw new Error("protected_connections_pan_not_offscreen");
      }
      await expect(node).not.toHaveClass(/selected/);
      await expect(node.locator("article")).toHaveAttribute("data-node-presentation", (!config.stableTool && !config.enabled) || protectedIndexes.includes(index) ? "full" : "shell");
    }
    await expect(page.locator(".narrative-handle")).toHaveCount(12);
    if ((await session.read()).document.checksum !== checksum) throw new Error("protected_connections_pan_mutated_document");
  };
  const fit = async () => { await page.locator(".react-flow__controls-fitview").click(); await settle(); };
  persist("selected_edge_protection"); await offscreenProtection([0, 1]);
  report.selected_edge_endpoints_protected = true;
  await page.screenshot({ path: `${config.artifacts}/selected-edge-offscreen.png` }); await fit();

  persist("reconnect");
  const updater = rendered.locator(".react-flow__edgeupdater-target");
  // Updater and Handle overlap differently at each Fit zoom. Require an actual
  // updater hit rather than relying on a fixed screen-pixel offset.
  const updaterPoint = () => updater.evaluate((element) => {
    const b = element.getBoundingClientRect();
    for (const fx of [0.15, 0.25, 0.35, 0.65, 0.75, 0.85]) {
      const x = b.x + b.width * fx, y = b.y + b.height / 2;
      if (document.elementFromPoint(x, y) === element) return { x, y };
    }
    throw new Error("protected_connections_updater_hit_missing");
  });
  await command(`/api/edges/${edge.id}`, "PUT", async () => drag(await updaterPoint(), await point(nodes[2].locator(".narrative-handle-left"))));
  const reconnected = (await session.read()).document;
  if (!reconnected.edges.some((item) => item.id === edge.id && item.source_node_id === ids[0] && item.target_node_id === ids[2])) {
    throw new Error("protected_connections_retarget_not_persisted");
  }
  await expect(rendered).toHaveClass(/selected/);
  persist("retarget_protection"); await offscreenProtection([0, 2]);
  report.old_endpoint_protection_released = true;
  await page.screenshot({ path: `${config.artifacts}/retarget-offscreen.png` }); await fit();

  persist("detach_to_empty_canvas");
  const empty = await page.evaluate(() => {
    const canvas = document.querySelector(".react-flow").getBoundingClientRect();
    const bounds = [...document.querySelectorAll(".react-flow__node")].map((node) => node.getBoundingClientRect());
    for (const fy of [0.15, 0.3, 0.5, 0.75]) for (const fx of [0.25, 0.5, 0.7, 0.85]) {
      const x = canvas.x + canvas.width * fx, y = canvas.y + canvas.height * fy;
      if (document.elementFromPoint(x, y)?.closest(".react-flow__pane")
        && bounds.every((b) => x < b.left - 40 || x > b.right + 40 || y < b.top - 40 || y > b.bottom + 40)) return { x, y };
    }
    return null;
  });
  if (!empty) throw new Error("protected_connections_empty_target_missing");
  await command(`/api/edges/${edge.id}`, "DELETE", async () => drag(await updaterPoint(), empty));
  await expect(rendered).toHaveCount(0);
  const deleted = (await session.read()).document;
  Object.assign(report, verifyProtectedConnections(before, created, connected, labeled, reconnected, deleted, ids, label));
  persist("deleted_edge_protection"); await offscreenProtection([]);
  report.deleted_edge_protection_released = true; report.all_twelve_handles_retained = true; report.pan_document_unchanged = true;
  await fit(); await page.screenshot({ path: `${config.artifacts}/detached.png` });

  persist("discard_close"); await page.getByTitle("Close project", { exact: true }).click();
  const decision = page.getByRole("heading", { name: "Unsaved changes", exact: true }).locator("../..");
  const discarded = await command(`/api/project-sessions/${session.sessionId}/discard`, "POST", () => decision.getByRole("button", { name: "Discard", exact: true }).click());
  report.saved_checkpoint_restored = discarded.document.checksum === before.checksum;
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  report.session_released = (await page.request.get(`${config.url}/api/project-sessions/${session.sessionId}/history`)).status() === 404;
  if (!report.saved_checkpoint_restored || !report.session_released || report.page_errors) throw new Error("protected_connections_release_failed");
  persist("complete");
} catch (error) {
  report.error_kind = error.name; report.error_message = String(error.message).slice(0, 4000);
  report.error_code = /^protected_connections_[a-z_]+$/.test(error.message) ? error.message : "browser_action_failed";
  await page?.screenshot({ path: `${config.artifacts}/failure.png`, timeout: 5000 }).catch(() => {});
  persist(report.step); process.exitCode = 1;
} finally { await browser?.close(); }

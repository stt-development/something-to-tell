import { chromium, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { assertOwnedFixture, ownedSession } from "./owned-session.mjs";
import { settledViewport } from "./zoom.mjs";
import { centeredTreeTarget } from "./workflow-observation.mjs";
import { readCardLayout } from "./viewport-cards-contract.mjs";
import { verifyLinkedGeometry } from "./protected-linked-contract.mjs";
import { sameFixtureValue } from "./protected-document-contract.mjs";
import { specializedFixtureTargets, verifySpecializedEdit } from "./protected-editors-contract.mjs";
import { projectTreeButton } from "./project-tree-navigation.mjs";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const report = { step: "launch", page_errors: 0, unexpected_writes: 0, editors: [] };
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
  const session = await ownedSession(page, config), source = session.initial.document;
  const { scene, targets } = specializedFixtureTargets(source);
  const card = (id) => page.getByTestId(`rf__node-${id}`), rail = page.getByTitle("Projects", { exact: true });
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
    if (!result.response.ok()) throw Error("protected_editors_command_failed");
    return result.response.json();
  };
  const treeFocus = async (node) => {
    await (await projectTreeButton(page, node.id)).click();
    await page.waitForFunction(centeredTreeTarget, node.id); await rail.click(); await settle();
  };
  const focusScene = async () => {
    await treeFocus(scene);
    for (let i = 0; i < 2; i++) { await page.locator(".react-flow__controls-zoomout").click(); await settle(); }
  };
  persist("prepare_linked_editors");
  for (const target of targets) {
    await focusScene();
    await card(scene.id).getByRole("button", { name: `Add linked node to ${scene.title}`, exact: true }).click();
    const picker = page.getByRole("heading", { name: `Add linked node to ${scene.title}`, exact: true }).locator("../..");
    await command("/api/compositions/placements", "POST", () => picker.getByRole("button", { name: `${target.node.title} ${target.node.type}`, exact: true }).first().click());
    await expect(picker).toBeHidden(); await settle();
    const linked = (await session.read()).document.placements.filter((p) => !p.is_primary
      && p.canonical_node_id === target.node.id && p.container_node_id === scene.id);
    expect(linked).toHaveLength(1); target.linkedId = `placement:${linked[0].id}`;
  }
  await expect(page.locator(".react-flow__node")).toHaveCount(1126);
  report.linked_setup_count = 2;
  const baseline = await page.evaluate(readCardLayout), rootIds = baseline.geometry.nodes.map((n) => n.id).sort();
  const selected = async (id) => {
    await expect(page.locator(".react-flow__node.selected")).toHaveCount(1);
    await expect(card(id)).toHaveClass(/selected/);
    await expect(card(id).locator("article")).toHaveAttribute("data-node-presentation", "full");
  };
  const openEditor = async (target, id, text) => {
    const loadPath = `/api/${target.collection}/${target.node.id}`;
    const loaded = page.waitForResponse((r) => new URL(r.url()).pathname === loadPath && r.request().method() === "GET");
    await card(id).locator(".narrative-node-title-text").dblclick();
    expect((await loaded).ok()).toBe(true);
    const label = target.collection === "dialogues" ? "dialogue" : "quest";
    const editor = page.getByRole("heading", { name: `Edit ${label}: ${target.node.title}`, exact: true }).locator("../..");
    const input = target.elementId
      ? editor.locator(`[data-canon-owner-id="${target.elementId}"]`).getByRole("textbox", { name: "Text", exact: true })
      : editor.getByRole("textbox", { name: "Objective", exact: true });
    await expect(editor.getByRole("button", { name: `Save ${label}`, exact: true })).toBeEnabled();
    await expect(input).toHaveValue(text); await selected(id);
    return { editor, input, label };
  };
  for (const target of targets) {
    const entry = { kind: target.node.type, saves: 0, initial_nested_tags_created: 0 };
    const original = target.elementId ? source.dialogues.find((d) => d.node_id === target.node.id).document.elements.find((e) => e.id === target.elementId).text
      : source.quests.find((q) => q.node_id === target.node.id).document.objective;
    let text = original;
    for (const linked of [false, true]) {
      const id = linked ? target.linkedId : target.node.id;
      persist(`${entry.kind}_${linked ? "linked" : "primary"}`);
      if (linked) {
        await focusScene(); await card(scene.id).getByRole("button", { name: `Focus ${scene.title}`, exact: true }).click(); await settle();
        await expect(card(target.node.id)).toHaveCount(0);
        await page.getByRole("button", { name: "Select", exact: true }).click();
      } else await treeFocus(target.node);
      const before = (await session.read()).document;
      const { editor, input, label } = await openEditor(target, id, text);
      text = `${original} Disposable ${linked ? "linked" : "primary"} editor check.`;
      await input.fill(text); await editor.getByRole("button", { name: "Close dialog", exact: true }).focus();
      await expect(input).toHaveValue(text); await selected(id);
      await command(`/api/${target.collection}/${target.node.id}`, "PUT", () => editor.getByRole("button", { name: `Save ${label}`, exact: true }).click());
      await expect(editor).toBeHidden(); await selected(id);
      const after = (await session.read()).document;
      // Failure diagnostics stay in the disposable artifact directory, never the archive.
      try {
        const verified = verifySpecializedEdit(before, after, target, text);
        const totalTags = entry.initial_nested_tags_created + verified.initial_nested_tags_created;
        if (linked) expect(verified.initial_nested_tags_created).toBe(0);
        Object.assign(entry, verified, { initial_nested_tags_created: totalTags });
      }
      catch (error) {
        writeFileSync(`${config.artifacts}/before.json`, JSON.stringify(before));
        writeFileSync(`${config.artifacts}/after.json`, JSON.stringify(after));
        throw error;
      }
      entry.saves++;
      await page.screenshot({ path: `${config.artifacts}/${entry.kind}-${linked ? "linked" : "primary"}.png` });
    }
    persist(`${entry.kind}_retention`);
    // Real pane drags, never private camera setters. Selected source stays full;
    // Pan clears selection and must permit masking, then Fit restores the body.
    await page.keyboard.down("Space");
    for (let i = 0; i < 7; i++) {
      const point = await page.evaluate(() => {
        const b = document.querySelector(".react-flow").getBoundingClientRect();
        for (const x of [b.right - 24, b.right - 100]) for (const y of [b.top + 40, b.top + b.height / 2, b.bottom - 200]) {
          if (document.elementFromPoint(x, y)?.classList.contains("react-flow__pane")) return { x, y };
        }
        return null;
      });
      if (!point) throw Error("protected_editors_pan_origin_missing");
      await page.mouse.move(point.x, point.y); await page.mouse.down();
      await page.mouse.move(point.x - 500, point.y, { steps: 5 }); await page.mouse.up();
    }
    await page.keyboard.up("Space"); await settle();
    const c = await page.locator(".react-flow").boundingBox(), b = await card(target.linkedId).boundingBox();
    expect(b.x + b.width).toBeLessThan(c.x); await selected(target.linkedId);
    await expect(card(scene.id).locator("article")).toHaveAttribute("data-node-presentation", "full");
    await page.getByRole("button", { name: "Pan canvas", exact: true }).click(); await settle();
    await expect(card(target.linkedId).locator("article")).toHaveAttribute("data-node-presentation", config.enabled ? "shell" : "full");
    await expect(card(target.linkedId).locator(".narrative-handle")).toHaveCount(4);
    await page.locator(".react-flow__controls-fitview").click(); await settle();
    await page.getByRole("button", { name: "Select", exact: true }).click();
    const reopened = await openEditor(target, target.linkedId, text);
    await reopened.editor.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.getByRole("button", { name: "Exit focused frame workspace", exact: true }).click(); await settle();
    const restored = await page.evaluate(readCardLayout);
    expect(restored.geometry.nodes.map((n) => n.id).sort()).toEqual(rootIds);
    for (const id of [target.node.id, target.linkedId]) verifyLinkedGeometry(baseline, restored, id);
    await treeFocus(target.node);
    const primary = await openEditor(target, target.node.id, text);
    await primary.editor.getByRole("button", { name: "Close dialog", exact: true }).click();
    await expect(card(target.linkedId)).not.toHaveClass(/selected/);
    Object.assign(entry, { offscreen_retention_and_release: true, rematerialized_value_preserved: true, root_geometry_restored: true });
    report.editors.push(entry);
  }
  persist("discard_close");
  expect((await session.read()).session.save_status).toBe("dirty");
  await page.getByTitle("Close project", { exact: true }).click();
  const decision = page.getByRole("heading", { name: "Unsaved changes", exact: true }).locator("../..");
  const discarded = await command(`/api/project-sessions/${session.sessionId}/discard`, "POST", () => decision.getByRole("button", { name: "Discard", exact: true }).click());
  report.saved_checkpoint_restored = sameFixtureValue(discarded.document, source);
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  report.session_released = (await page.request.get(`${config.url}/api/project-sessions/${session.sessionId}/history`)).status() === 404;
  if (!report.saved_checkpoint_restored || !report.session_released || report.unexpected_writes || report.page_errors) throw Error("protected_editors_release_failed");
  persist("complete");
} catch (error) {
  report.error_kind = error.name; report.error_message = String(error.message).slice(0, 4000);
  report.error_code = /^protected_editors_[a-z_]+$/.test(error.message) ? error.message : "browser_action_failed";
  await page?.screenshot({ path: `${config.artifacts}/failure.png`, timeout: 5000 }).catch(() => {});
  persist(report.step); process.exitCode = 1;
} finally { await browser?.close(); }

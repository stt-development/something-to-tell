import { expect } from "@playwright/test";
import { ownedSession, observeCommand, assertOwnedFixture } from "./owned-session.mjs";
import { observeAction, waitStartScreen } from "./workflow-observation.mjs";
import { measureNodeAuthoring } from "./authoring.mjs";

/** All cards/folders come from the runner, not the user's catalog. */
async function openOwnedCard(page, fixture) {
  assertOwnedFixture(fixture);
  if (!await page.getByRole("button", { name: "Open", exact: true }).count()) await page.getByTitle("Projects", { exact: true }).click();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.getByLabel("Projects directory").fill(fixture.directory);
  await page.getByRole("button", { name: "Refresh project list" }).click();
  await page.getByRole("button", { name: new RegExp(fixture.name) }).click();
  await expect(page.getByRole("heading", { name: fixture.name, exact: true })).toBeVisible();
}

export async function measureLifecycle(page, config, mark = () => {}) {
  assertOwnedFixture(config.switchFixture);
  await measureNodeAuthoring(page, config, () => mark("prepare_dirty"));
  const session = await ownedSession(page, config);
  const before = session.initial;
  const rejection = async (route) => route.fulfill({ status: 503, contentType: "application/json",
    body: JSON.stringify({ detail: { code: "probe_save_rejected", message: "Intentional probe save rejection" } }) });
  const saveRoute = "**/api/project-sessions/*/save";
  await page.route(saveRoute, rejection);
  mark("save_rejected");
  let rejectedSave;
  try {
    rejectedSave = await observeAction(() => page.getByRole("button", { name: "Save project", exact: true }).click(),
      () => expect(page.locator(".save-status-error")).toBeVisible());
  } finally { await page.unroute(saveRoute, rejection); }
  const afterRejection = await session.read();
  if (afterRejection.session.saved_revision !== before.session.saved_revision || afterRejection.document.checksum !== before.document.checksum) {
    throw new Error("probe_rejected_save_changed_data");
  }
  mark("save");
  const save = await observeCommand(page, (response) => response.url().endsWith("/save") && response.request().method() === "POST",
    () => page.getByRole("button", { name: "Save project", exact: true }).click(), () => expect(page.locator(".save-status-clean")).toBeVisible());
  const checkpoint = await session.read();
  if (checkpoint.session.save_status !== "clean" || checkpoint.session.saved_revision <= before.session.saved_revision) throw new Error("probe_save_not_durable");
  await measureNodeAuthoring(page, config, () => mark("prepare_second_edit"));
  await page.getByRole("button", { name: "Show graph filters", exact: true }).click();
  await page.getByRole("textbox", { name: "Search graph", exact: true }).fill("");
  await page.getByRole("button", { name: "Hide graph filters", exact: true }).click();
  mark("close_cancel");
  const cancel = await observeAction(async () => {
    await page.getByTitle("Close project", { exact: true }).click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  }, () => expect(page.getByRole("heading", { name: config.fixture.name, exact: true })).toBeVisible());
  if ((await session.read()).session.save_status === "clean") throw new Error("probe_cancel_lost_dirty_state");
  mark("discard_close");
  const discardClose = await observeCommand(page, (response) => response.url().endsWith("/discard") && response.request().method() === "POST",
    async () => { await page.getByTitle("Close project", { exact: true }).click(); await page.getByRole("button", { name: "Discard", exact: true }).click(); },
    () => waitStartScreen(page));
  mark("reopen");
  const reopen = await observeAction(() => openOwnedCard(page, config.fixture), async () => {});
  const restored = await ownedSession(page, config);
  if (restored.initial.document.checksum !== checkpoint.document.checksum || restored.initial.session.save_status !== "clean") throw new Error("probe_discard_checkpoint_mismatch");
  mark("switch_project");
  const projectSwitch = await observeAction(() => openOwnedCard(page, config.switchFixture), async () => {});
  const switched = await ownedSession(page, { ...config, fixture: config.switchFixture });
  if (switched.initial.session.project_id === checkpoint.session.project_id) throw new Error("probe_switch_identity_unchanged");
  return { rejected_save: rejectedSave, save, close_cancel: cancel, discard_close: discardClose, reopen, project_switch: projectSwitch,
    rejected_save_preserved: true, checkpoint_restored: true, project_switch_verified: true, switched_node_count: switched.initial.document.nodes.length };
}

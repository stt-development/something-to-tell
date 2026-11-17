/** Native UI fault injection; real PostgreSQL lifecycle is verified separately. */
import type { Page } from "@playwright/test";
import { openAuroraFixture } from "./projectFixture";
import { expect, test } from "./temporaryProject";

async function installRecovery(page: Page, locale: "en" | "ru", loseReply: boolean) {
  let session: Record<string, any>;
  let head: Record<string, any>;
  let attempt = "";
  const calls: string[] = [];
  // Only this test's UUID-owned SQLite fixture is opened by the real runtime.
  // The browser receives remote metadata to exercise production recovery UI.
  await page.route("**/api/project-sessions/open", async route => {
    const response = await route.fetch();
    const value = await response.json();
    head = { protocol_version: 1, project_id: value.session.project_id,
      storage_generation: "11111111-1111-4111-8111-111111111111", authoring_revision: "1",
      saved_authoring_revision: "0", saved_revision: "0", document_checksum: value.document.checksum,
      writer_epoch: "1", state: "ready" };
    value.session = { ...value.session, session_version: 2, storage_mode: "postgresql", remote_state: "ready", remote_storage: head };
    value.document.manifest.settings.ui_locale = locale;
    session = value;
    await route.fulfill({ json: value });
  });
  await page.route("**/api/project-sessions/*/remote-storage**", async route => {
    const path = new URL(route.request().url()).pathname;
    calls.push(path);
    if (path.endsWith("/remote-storage")) return route.fulfill({ json: head });
    if (path.endsWith("/reconnect-attempts")) {
      attempt = route.request().postDataJSON().attempt_id;
      if (loseReply) return route.abort("failed");
    }
    const released = path.endsWith("/abandon");
    return route.fulfill({ json: { protocol_version: 1, project_id: head.project_id,
      storage_generation: head.storage_generation, source_session_id: session.session.session_id,
      attempt_id: attempt, status: released ? "released" : "ready", result_session_id: released ? null : "native-candidate", error_code: null } });
  });
  return calls;
}

for (const locale of ["en", "ru"] as const) {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 720 }]) {
    test(`keeps editor drafts and recovers lost result in ${locale} at ${viewport.width}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      const calls = await installRecovery(page, locale, viewport.width === 1024);
      await openAuroraFixture(page);
      await page.getByRole("button", { name: locale === "en" ? "Project settings" : "Настройки проекта", exact: true }).click();
      const settings = page.getByRole("heading", { name: locale === "en" ? "Project settings" : "Настройки проекта", exact: true }).locator("../..");
      const name = settings.getByLabel(locale === "en" ? "Name" : "Название", { exact: true }).first();
      await name.fill("Unsent recovery draft");
      const launch = settings.getByRole("button", { name: locale === "en" ? "Remote storage status and recovery" : "Состояние и восстановление удалённого хранилища" });
      // The new header may appear under the previous settings-button pointer.
      // Make an actual pointer entry, not a stationary hit-test after mounting.
      await page.mouse.move(0, 0);
      await launch.hover();
      await expect(page.getByRole("tooltip")).toBeVisible();
      await launch.click();
      const recovery = page.getByRole("dialog", { name: locale === "en" ? "Remote storage recovery" : "Восстановление удалённого хранилища", exact: true });
      await expect(recovery).toBeVisible();
      const reconnect = recovery.getByRole("button", { name: locale === "en" ? "Reconnect" : "Переподключиться", exact: true });
      await expect(reconnect).toBeDisabled();
      expect(calls).toHaveLength(0);
      const boxes = recovery.getByRole("checkbox"); await boxes.first().check();
      await reconnect.click();
      const lookup = recovery.getByRole("button", { name: locale === "en" ? "Check reconnect result" : "Проверить результат подключения", exact: true });
      await expect(lookup).toBeEnabled();
      if (viewport.width === 1024) await expect(recovery.getByRole("alert")).toBeVisible();
      await lookup.click();
      await expect(recovery.getByRole("button", { name: locale === "en" ? "Load remote working data" : "Загрузить рабочие данные сервера", exact: true })).toBeEnabled();
      expect(calls.filter(path => path.endsWith("/reconnect-attempts"))).toHaveLength(1);
      await expect(name).toHaveValue("Unsent recovery draft");
      const section = recovery.locator("section");
      expect(await section.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      const bounds = await section.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
      await page.screenshot({ path: testInfo.outputPath(`recovery-${locale}.png`) });
      await recovery.getByRole("button", { name: locale === "en" ? "Release reconnect result" : "Освободить результат подключения", exact: true }).click();
      await expect(recovery.getByRole("button", { name: locale === "en" ? "Check reconnect result" : "Проверить результат подключения" })).toBeEnabled();
      await recovery.getByRole("button", { name: locale === "en" ? "Close dialog" : "Закрыть окно", exact: true }).click();
      await expect(launch).toBeFocused(); await expect(name).toHaveValue("Unsent recovery draft");
      expect(calls.some(path => /\/save|\/discard/.test(path))).toBe(false);
    });
  }
}

/** Visible review uses deterministic HTTP fixtures; live SQL is verified separately. */
import type { Page } from "@playwright/test";
import { openAuroraFixture } from "./projectFixture";
import { expect, test } from "./temporaryProject";

const profile = { profile_id: "admin", label: "Review administrator", host: "localhost", port: 5432, database: "disposable", username: "operator", tls_policy: "verify-full" };
const plan = { protocol_version: 1, plan_id: "a037e1ca-9000-4000-8000-000000000001", plan_fingerprint: "a".repeat(64), action: "upgrade",
  source_schema_revision: "v9", target_schema_revision: "v11", migration_revisions: ["v10", "v11"], expires_at: "2026-12-01T16:00:00Z", backup_required: true };

async function installAdministration(page: Page, unknown = false) {
  const calls: string[] = [];
  await page.route("**/api/storage-profiles/**", async route => {
    const path = new URL(route.request().url()).pathname;
    calls.push(path);
    const value = path.endsWith("/available") ? { profiles: [profile] }
      : path.endsWith("/inspect") ? { protocol_version: 1, server_major: 17, schema_status: "older", schema_revision: "v9", tls_policy: "verify-full", tls_active: true, identity_verified: true, privileges: "administrator" }
      : path.endsWith("/backup-attestations") ? { protocol_version: 1, backup_attestation_id: "a037e1ca-9000-4000-8000-000000000002", plan_id: plan.plan_id, plan_fingerprint: plan.plan_fingerprint, expires_at: plan.expires_at }
      : path.endsWith("/execute") ? unknown ? { detail: { code: "remote_commit_unknown", message_key: "remote_storage.error.remote_commit_unknown", parameters: {} } }
        : { protocol_version: 1, plan_id: plan.plan_id, action: "upgrade", schema_revision: "v11", status: "completed" }
      : plan;
    await route.fulfill({ status: unknown && path.endsWith("/execute") ? 503 : 200, json: value });
  });
  return calls;
}

for (const locale of ["en", "ru"] as const) {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 720 }]) {
    test(`reviews unopened-folder schema in ${locale} at ${viewport.width}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.addInitScript(value => localStorage.setItem("stt.ui_locale.v1", value), locale);
      const calls = await installAdministration(page, viewport.width === 1024);
      // No folder, session or SQL is opened/created by this UI-only case.
      await page.route("**/api/project-sessions/catalog*", route => route.fulfill({ json: { directory: "/tmp/schema-ui", projects: [{
        name: "Schema review fixture", path: "/tmp/schema-ui/review.narrative", project_id: "schema-ui", description: "Unopened fixture", format_version: 2, updated_at: "2026-11-06T00:00:00Z"
      }] } }));
      await page.goto("http://127.0.0.1:1420");
      await page.getByRole("button", { name: locale === "en" ? "Open" : "Открыть", exact: true }).click();
      const title = locale === "en" ? "Database schema" : "Схема базы данных";
      const launch = page.getByRole("button", { name: title, exact: true });
      await launch.hover();
      await expect(page.getByRole("tooltip")).toContainText("Schema review fixture");
      await launch.click();
      const dialog = page.getByRole("heading", { name: title }).locator("../..");
      await expect(page.getByRole("heading", { name: locale === "en" ? "Open project" : "Открытие проекта" })).toBeHidden();
      const select = dialog.getByRole("combobox");
      await expect(select).toBeEnabled(); await expect(select).toHaveValue("");
      expect(calls.length).toBeGreaterThan(0);
      // React development StrictMode may repeat safe read-only discovery.
      expect(calls.every(path => path === "/api/storage-profiles/available")).toBe(true);
      await select.selectOption("admin");
      await dialog.getByRole("button", { name: locale === "en" ? "Inspect schema" : "Проверить схему" }).click();
      await dialog.getByRole("button", { name: locale === "en" ? "Review changes" : "Просмотреть изменения" }).click();
      const execute = dialog.getByRole("button", { name: locale === "en" ? "Apply reviewed changes" : "Применить изменения" });
      await expect(execute).toBeDisabled();
      const boxes = dialog.getByRole("checkbox");
      await boxes.nth(0).check(); await expect(execute).toBeDisabled(); await boxes.nth(1).check();
      await execute.scrollIntoViewIfNeeded();
      const bounds = await dialog.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
      expect(bounds!.y).toBeGreaterThanOrEqual(0); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await execute.evaluate(element => getComputedStyle(element).color !== getComputedStyle(element).backgroundColor)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`schema-review-${locale}.png`) });
      await execute.click();
      if (viewport.width === 1024) await expect(dialog.getByRole("alert")).toBeVisible();
      else await expect(dialog.getByRole("status")).toContainText("v11");
      await expect(execute).toHaveCount(0);
      expect(calls.filter(path => path.endsWith("/execute"))).toHaveLength(1);
      await dialog.getByRole("button", { name: locale === "en" ? "Close" : "Закрыть", exact: true }).click();
      await expect(launch).toBeFocused();
    });
  }
}

test("preserves an unsent settings draft across administration", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installAdministration(page);
  await openAuroraFixture(page);
  await page.getByRole("button", { name: "Project settings", exact: true }).click();
  const settings = page.getByRole("heading", { name: "Project settings" }).locator("../..");
  await settings.getByLabel("Name", { exact: true }).first().fill("Unsent settings draft");
  const launch = settings.getByRole("button", { name: "Database schema", exact: true });
  await launch.click();
  await expect(settings).toBeHidden();
  const admin = page.getByRole("heading", { name: "Database schema" }).locator("../..");
  await admin.getByRole("button", { name: "Close", exact: true }).click();
  await expect(settings.getByLabel("Name", { exact: true }).first()).toHaveValue("Unsent settings draft");
  await expect(launch).toBeFocused();
});

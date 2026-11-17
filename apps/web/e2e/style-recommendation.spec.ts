import type { Page, Route } from "@playwright/test";
import type {
  StyleRewriteRequestV1,
  StyleRewriteRetryV1,
  StyleRewriteRunV1
} from "@something-to-tell/contracts/style-rewrite";
import { openAuroraFixture, openRussianAuroraFixture } from "./projectFixture";
import { expect, test } from "./temporaryProject";

const SOURCE_TEXT = "Dialogue beat where the player learns why legal passage is blocked.";
const REWRITTEN_TEXT = "Rain tightens the harbor while the blocked passage closes around the player.";

test("reviews and retries a bounded Style recommendation in the wide workspace", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installStyleRewriteApi(page);
  await openAuroraFixture(page);
  await openNodeStyleRecommendation(
    page,
    "Get style recommendation: Text for Dockmaster Warning",
    "Get style recommendation"
  );

  const request = page.getByLabel("Style recommendation");
  await expect(request).toContainText(SOURCE_TEXT);
  await expect(request).toContainText("Luna harbor test");
  await expect(request).toContainText("Opening Dock");
  await request.getByLabel("Additional details (optional)").fill("Keep the blocked passage explicit.");
  await request.getByLabel("I consent to sending this content for this request.").check();
  await request.getByRole("button", { name: "Request recommendation" }).click();

  await expect(request).toContainText("The revision adds maritime pressure without changing the blocked route.");
  await expect(request).toContainText("The route must remain blocked until the authored outcome.");
  await expect(request.getByRole("button", { name: "Approve" })).toBeEnabled();
  await expect(request.getByRole("button", { name: "Reject" })).toBeEnabled();
  for (const tab of ["Before", "After", "Changes"]) {
    await request.getByRole("tab", { name: tab }).click();
    await expect(request.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
  }

  await request.getByLabel("Additional details (optional)").fill("Use shorter beats.");
  await request.getByLabel("I consent to sending this content for this request.").check();
  await request.getByRole("button", { name: "Request again" }).click();
  await expect(request.getByRole("option", { name: "Version 2 · Luna harbor test" })).toBeAttached();
  await page.screenshot({ path: "/tmp/p6-style-recommendation-en-1440x900.png" });
  await request.getByRole("button", { name: "Reject" }).click();
  await expect(page.getByRole("button", {
    name: "Get style recommendation: Text for Dockmaster Warning"
  })).toBeFocused();
});

test("keeps Russian controls and English project prose inside the compact workspace", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 720 });
  await installStyleRewriteApi(page);
  await openRussianAuroraFixture(page);
  await openNodeStyleRecommendation(
    page,
    "Получить рекомендацию по стилю: Текст узла «Dockmaster Warning»",
    "Получить рекомендацию по стилю"
  );

  const request = page.getByLabel("Рекомендация по стилю");
  await request.getByLabel("Я согласен отправить это содержимое для данного запроса.").check();
  await request.getByRole("button", { name: "Запросить рекомендацию" }).click();
  await expect(request).toContainText("Проверка рекомендации");
  await expect(request).toContainText("The revision adds maritime pressure without changing the blocked route.");
  await expect(request).toContainText("Английский");
  await expect(request.getByRole("button", { name: "Принять" })).toBeEnabled();
  await expect(request.getByRole("button", { name: "Отклонить" })).toBeEnabled();

  const dialog = request.locator("xpath=ancestor::section[1]");
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1024);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(720);
  await page.screenshot({ path: "/tmp/p6-style-recommendation-ru-1024x720.png" });
  await request.getByRole("button", { name: "Принять" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/p6-style-recommendation-ru-review-1024x720.png" });
});

/** Opens a real editor and verifies the delegated tooltip before launching review. */
async function openNodeStyleRecommendation(
  page: Page,
  actionName: string,
  tooltipText: string
): Promise<void> {
  await page.getByTestId("rf__node-node-dock-dialogue").dblclick();
  const action = page.getByRole("button", { name: actionName });
  await action.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toHaveText(tooltipText);
  const tooltipBounds = await tooltip.boundingBox();
  const viewport = page.viewportSize();
  expect(tooltipBounds).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(tooltipBounds!.x).toBeGreaterThanOrEqual(0);
  expect(tooltipBounds!.x + tooltipBounds!.width).toBeLessThanOrEqual(viewport!.width);
  await action.click();
}

/** Keeps project/style resolution real while replacing only the remote provider boundary. */
async function installStyleRewriteApi(page: Page): Promise<void> {
  let firstRequest: StyleRewriteRequestV1 | null = null;
  let version = 0;

  await page.route("**/api/project-sessions/open", async (route) => {
    const response = await route.fetch();
    const body = await response.json() as {
      document: { manifest: { settings: { style_system: Record<string, unknown> } } };
    };
    body.document.manifest.settings.style_system.agent_mode = "configured";
    body.document.manifest.settings.style_system.content_policy = "explicit_consent";
    await route.fulfill({ response, json: body });
  });

  await page.route("**/api/style-rewrites/runs**", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    if (requestUrl.pathname.endsWith("/runs")) {
      firstRequest = route.request().postDataJSON() as StyleRewriteRequestV1;
      version = 1;
      await fulfillRun(route, buildCompletedRun(firstRequest, version, null));
      return;
    }
    if (requestUrl.pathname.endsWith("/retry") && firstRequest) {
      const retry = route.request().postDataJSON() as StyleRewriteRetryV1;
      const predecessor = `style-run-${version}`;
      version += 1;
      firstRequest = {
        ...firstRequest,
        observed_source_checksum: retry.observed_source_checksum,
        expected_history_revision: retry.expected_history_revision,
        additional_instructions: retry.additional_instructions,
        content_consent: retry.content_consent
      };
      await fulfillRun(route, buildCompletedRun(firstRequest, version, predecessor));
      return;
    }
    await route.continue();
  });
}

/** Builds schema-valid provider output without exposing a real credential to Playwright. */
function buildCompletedRun(
  request: StyleRewriteRequestV1,
  version: number,
  predecessorRunId: string | null
): StyleRewriteRunV1 {
  const runId = `style-run-${version}`;
  return {
    run_version: 1,
    id: runId,
    project_id: "project-e2e",
    request,
    style_profile_id: "style-aurora-test-luna",
    style_profile_name: "Luna harbor test",
    source_checksum: request.observed_source_checksum,
    source_text_checksum: "a".repeat(64),
    history_revision: request.expected_history_revision,
    predecessor_run_id: predecessorRunId,
    status: "completed",
    progress: 100,
    recommendation: {
      recommendation_version: 1,
      id: `style-recommendation-${version}`,
      source_text: SOURCE_TEXT,
      rewritten_text: REWRITTEN_TEXT,
      explanation: "The revision adds maritime pressure without changing the blocked route.",
      applied_traits: ["tense", "concise sentences"],
      factual_risks: ["The route must remain blocked until the authored outcome."],
      protected_value_results: [{ kind: "quoted_term", value: "blocked", preserved: true }],
      provider_disclosure: {
        provider: "openai",
        provider_profile_id: "e2e-provider",
        model_id: "gpt-5.6-luna",
        content_locale: "en"
      },
      patch: {
        patch_version: 1,
        patch_id: `style-patch-${version}`,
        project_id: "project-e2e",
        source_checksum: request.observed_source_checksum,
        target_checksum: "b".repeat(64),
        operations: [{
          op: "put_record",
          collection: "nodes",
          record_id: "node-dock-dialogue",
          record: { id: "node-dock-dialogue", summary: REWRITTEN_TEXT, body: REWRITTEN_TEXT }
        }]
      },
      diff: [
        { kind: "delete", text: SOURCE_TEXT },
        { kind: "insert", text: REWRITTEN_TEXT }
      ],
      validation_status: "valid",
      validation_diagnostics: []
    },
    error_code: null,
    started_at: "2026-09-10T10:00:00Z",
    completed_at: "2026-09-10T10:00:01Z"
  };
}

async function fulfillRun(route: Route, run: StyleRewriteRunV1): Promise<void> {
  await route.fulfill({
    body: JSON.stringify({ response_version: 1, run }),
    contentType: "application/json",
    status: 200
  });
}

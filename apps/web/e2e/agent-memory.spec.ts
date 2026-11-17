import type { Locator, Page, Route } from "@playwright/test";
import type {
  AgentMemoryCandidateRequestV1,
  AgentMemoryCandidateRunV1
} from "@something-to-tell/contracts/agent-memory";
import {
  openAuroraFixture,
  openConflictingMemoryAuroraFixture,
  openRussianAuroraFixture
} from "./projectFixture";
import { expect, test } from "./temporaryProject";

test("reviews project memory and a process-local candidate in the wide workspace", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installCandidateApi(page);
  await openAuroraFixture(page);
  const settings = await openSettings(page, "Project settings");
  const manager = settings.getByLabel("Agent memory");
  await manager.scrollIntoViewIfNeeded();
  await expect(manager).toContainText("Harbor terminology");
  await expect(manager.getByText("Updating agent memory…")).toHaveCount(0);

  const launch = manager.getByRole("button", { name: "Suggest memory with agent" });
  await launch.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toHaveText("Suggest memory with agent");
  await expectInsideViewport(page, tooltip);
  const review = await openCandidateReview(manager, launch, "Review memory suggestion", "Project settings");
  await review.getByLabel("What should the agent remember?").fill("Keep every custody change explicit.");
  await review.getByLabel("I consent to sending the selected target content for this request.").check();
  await review.getByRole("button", { name: "Request suggestion" }).click();
  await expect(review).toContainText("Explicit custody changes");
  await expect(review).toContainText("openai · memory-model");
  await page.screenshot({ path: "/tmp/p62-agent-memory-candidate-en-1440x900.png" });
  await review.getByRole("button", { name: "Reject" }).click();
  await expect(review.getByRole("button", { name: "Request again" })).toBeEnabled();
  await review.getByRole("button", { name: "Close" }).click();
  await expect(launch).toBeFocused();

  await manager.getByRole("button", { name: "Archive memory" }).click();
  await expect(manager.getByRole("button", { name: "Restore memory" })).toBeVisible();
  await manager.getByRole("button", { name: "Restore memory" }).click();
  await manager.getByRole("button", { name: "Review memory deletion" }).click();
  await expect(manager.getByRole("alertdialog", { name: "Delete agent memory?" })).toBeVisible();
});

test("keeps Russian memory review usable at the minimum desktop viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 720 });
  await installCandidateApi(page);
  await openRussianAuroraFixture(page);
  const settings = await openSettings(page, "Настройки проекта");
  const manager = settings.getByLabel("Память агентов");
  await manager.scrollIntoViewIfNeeded();
  await expect(manager.getByText("Обновление памяти агента…")).toHaveCount(0);
  const launch = manager.getByRole("button", { name: "Предложить память с помощью агента" });
  const review = await openCandidateReview(manager, launch, "Проверка предложения памяти", "Настройки проекта");
  await review.getByLabel("Что должен запомнить агент?").fill("Сохраняй явные переходы владения.");
  await review.getByLabel("Я согласен отправить содержимое выбранной цели для этого запроса.").check();
  await review.getByRole("button", { name: "Запросить предложение" }).click();
  await expect(review).toContainText("Язык содержимогоАнглийский");
  await expect(review).toContainText("Explicit custody changes");
  await expectInsideViewport(page, review);
  await page.screenshot({ path: "/tmp/p62-agent-memory-candidate-ru-1024x720.png" });
});

test("blocks a Style request when applicable memory conflicts", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openConflictingMemoryAuroraFixture(page);
  await page.getByTestId("rf__node-node-dock-dialogue").dblclick();
  await page.getByRole("button", {
    name: "Get style recommendation: Text for Dockmaster Warning"
  }).click();

  const request = page.getByLabel("Style recommendation");
  await expect(request).toContainText("Remote request blocked until memory conflicts or broken owners are repaired.");
  await expect(request.getByRole("button", { name: "Request recommendation" })).toBeDisabled();
  await request.getByRole("button", { name: "Manage agent memory" }).hover();
  await expect(page.getByRole("tooltip")).toHaveText("Manage agent memory");
  await page.screenshot({ path: "/tmp/p62-agent-memory-conflict-en-1440x900.png" });
});

async function openSettings(page: Page, title: string): Promise<Locator> {
  await page.getByRole("button", { name: title }).click();
  return page.getByRole("heading", { name: title }).locator("..").locator("..");
}

/** Confirms the review survived any final async settings reload before interaction. */
async function openCandidateReview(
  manager: Locator,
  launch: Locator,
  reviewLabel: string,
  settingsLabel: string
): Promise<Locator> {
  const review = manager.getByLabel(reviewLabel);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!await manager.isVisible()) {
      await manager.page().getByRole("button", { name: settingsLabel }).click();
      await expect(manager).toBeVisible();
    }
    await launch.scrollIntoViewIfNeeded();
    await launch.click();
    await review.waitFor({ state: "visible", timeout: 1_000 }).catch(() => undefined);
    await manager.page().waitForTimeout(100);
    if (await review.isVisible()) return review;
  }
  await expect(review).toBeVisible();
  return review;
}

/** Replaces only remote candidate generation; project commands stay on the runtime. */
async function installCandidateApi(page: Page): Promise<void> {
  let retained: AgentMemoryCandidateRequestV1 | null = null;
  await page.route("**/api/agent-memory/candidate-runs**", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/candidate-runs")) {
      retained = route.request().postDataJSON() as AgentMemoryCandidateRequestV1;
      await fulfillRun(route, candidateRun(retained, "completed"), 201);
      return;
    }
    if (url.pathname.endsWith("/reject") && retained) {
      await fulfillRun(route, candidateRun(retained, "rejected"), 200);
      return;
    }
    await route.continue();
  });
}

function candidateRun(
  request: AgentMemoryCandidateRequestV1,
  status: "completed" | "rejected"
): AgentMemoryCandidateRunV1 {
  const russian = request.content_locale === "ru";
  return {
    run_version: 1,
    id: "run-e2e-memory",
    project_id: request.project_id,
    request,
    source_checksum: request.observed_source_checksum,
    history_revision: request.expected_history_revision,
    status,
    progress: 100,
    predecessor_run_id: null,
    candidate: {
      candidate_version: 1,
      id: "candidate-e2e-memory",
      project_id: request.project_id,
      agent_id: request.agent_id,
      namespace: request.namespace,
      scope: request.scope,
      content_locale: request.content_locale,
      title: russian ? "Явные изменения владения" : "Explicit custody changes",
      instruction: russian
        ? "Сохраняй каждую передачу предмета как явное событие."
        : "Keep every item transfer as an explicit authored event.",
      rationale: russian ? "Это сохраняет временную целостность." : "This preserves temporal integrity.",
      source_checksum: request.observed_source_checksum,
      history_revision: request.expected_history_revision,
      semantic_fingerprint: "b".repeat(64),
      created_at: "2026-09-17T10:00:00Z"
    },
    provider_disclosure: {
      provider: "openai",
      provider_profile_id: "e2e-provider",
      model_id: "memory-model"
    },
    error_code: null,
    started_at: "2026-09-17T10:00:00Z",
    completed_at: "2026-09-17T10:00:01Z"
  };
}

async function fulfillRun(
  route: Route,
  run: AgentMemoryCandidateRunV1,
  status: number
): Promise<void> {
  await route.fulfill({
    body: JSON.stringify({ response_version: 1, run }),
    contentType: "application/json",
    status
  });
}

async function expectInsideViewport(page: Page, locator: Locator): Promise<void> {
  const bounds = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport!.width);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport!.height);
}

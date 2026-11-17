import type { Page, Route } from "@playwright/test";
import type {
  ImpactResolutionRequest,
  ImpactResolutionRun,
  ImpactSolutionAlternative
} from "@something-to-tell/contracts/impact-resolution";
import { openAuroraFixture, openRussianAuroraFixture } from "./projectFixture";
import { expect, test } from "./temporaryProject";

const TARGET_CHECKSUM = "b".repeat(64);

test("reviews provider resolutions through cancellation, failure, staleness, approval, and history", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await installResolutionApi(page);
  await openAuroraFixture(page);
  await openImpactFindings(page, "Mara Vale", "Analyze current selection", "Impact analysis", "Analyze");

  const review = page.getByRole("region", { name: "Resolution review" });
  await review.getByRole("button", { name: /Resolution review/ }).click();
  await review.getByLabel(/Send the selected findings/).check();

  api.nextStatus = "queued";
  await review.getByRole("button", { name: "Explain findings" }).click();
  await expect(
    review.getByRole("status").filter({ hasText: "Generating resolution alternatives" })
  ).toBeVisible();
  await review.getByRole("button", { name: "Cancel" }).click();
  await expect(review).toContainText("cancelled");

  api.nextStatus = "failed";
  await review.getByRole("button", { name: "Request new alternatives" }).click();
  await expect(review).toContainText("could not be completed");

  api.nextStatus = "stale";
  await review.getByRole("button", { name: "Request new alternatives" }).click();
  await expect(review.getByRole("button", { name: "Approve" })).toBeDisabled();
  await expect(review).toContainText("older project snapshot");
  await expect(review).toContainText("Visual preview is inactive");

  api.nextStatus = "completed";
  await review.getByRole("button", { name: "Request new alternatives" }).click();
  await expect(review).toContainText("Connect the executable outcome");
  for (const mode of ["Before", "After", "Changes"]) {
    await review.getByRole("button", { name: mode }).click();
    await expect(review.getByRole("button", { name: mode })).toHaveAttribute("aria-pressed", "true");
  }

  await review.getByRole("button", { name: "Edit" }).click();
  const draft = review.getByLabel("Project patch draft");
  const edited = JSON.parse(await draft.inputValue()) as Record<string, unknown>;
  edited.patch_id = "patch-edited";
  await draft.fill(JSON.stringify(edited));
  await review.getByRole("button", { name: "Validate draft" }).click();
  expect(api.editedPatchId).toBe("patch-edited");

  await review.getByRole("button", { name: "Reject" }).click();
  expect(api.reviewedDecisions).toEqual(["rejected"]);
  await review.getByRole("button", { name: "Approve" }).click();
  expect(api.reviewedDecisions).toEqual(["rejected", "approved"]);
  await expect(review).toContainText("Applied change needs verification");

  const undo = page.getByRole("button", { name: "Undo Approve Impact Resolution proposal" });
  await expect(undo).toBeEnabled();
  await undo.click();
  const redo = page.getByRole("button", { name: "Redo Approve Impact Resolution proposal" });
  await expect(redo).toBeEnabled();
  await redo.click();
  await expect(undo).toBeEnabled();
  await page.screenshot({ path: "/tmp/p5-5-impact-resolution-en-1440x900.png" });
});

test("keeps completed resolution review localized inside the compact viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 720 });
  const api = await installResolutionApi(page, "ru");
  api.nextStatus = "completed";
  await openRussianAuroraFixture(page);
  await openImpactFindings(page, "Mara Vale", "Анализировать текущее выделение", "Анализ влияния", "Анализировать");

  const review = page.getByRole("region", { name: "Разбор решений" });
  await review.getByRole("button", { name: /Разбор решений/ }).click();
  await review.getByLabel(/Отправить выбранные замечания/).check();
  await review.getByRole("button", { name: "Объяснить замечания" }).click();
  await expect(review).toContainText("Исполняемый результат недоступен");
  await expect(review.getByRole("button", { name: "Принять" })).toBeEnabled();
  await expect(review.getByRole("button", { name: "Отклонить" })).toBeEnabled();
  await expect(review.getByRole("button", { name: "Изменить" })).toBeEnabled();

  const workspace = page.getByRole("complementary", { name: "Анализ влияния" });
  const bounds = await workspace.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1024);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(720);
  await page.screenshot({ path: "/tmp/p5-5-impact-resolution-ru-1024x720.png" });
});

/** Opens a real deterministic Impact run before provider responses are isolated. */
async function openImpactFindings(page: Page, node: string, selectionAction: string, workspaceName: string, analyze: string): Promise<void> {
  await page.getByTestId("rf__node-node-hero").click();
  await page.getByRole("button", { name: selectionAction }).click();
  const workspace = page.getByRole("complementary", { name: workspaceName });
  await workspace.getByRole("button", { name: analyze, exact: true }).click();
  await expect(workspace).toContainText(node);
  await expect(workspace.locator(".impact-finding-row").first()).toBeVisible();
}

interface ResolutionApiState {
  nextStatus: ImpactResolutionRun["status"];
  editedPatchId: string | null;
  reviewedDecisions: string[];
}

interface OpenProjectResponse {
  document: {
    manifest: {
      settings: Record<string, unknown>;
    };
  };
  [key: string]: unknown;
}

/** Supplies deterministic provider output while preserving the real project and Impact APIs. */
async function installResolutionApi(page: Page, locale: "en" | "ru" = "en"): Promise<ResolutionApiState> {
  const state: ResolutionApiState = { nextStatus: "completed", editedPatchId: null, reviewedDecisions: [] };
  let currentRun: ImpactResolutionRun | null = null;
  let historyRevision = 0;
  let historyDirection: "undo" | "redo" | null = null;

  await page.route("**/api/project-sessions/open", async (route) => {
    const response = await route.fetch();
    const body = await response.json() as OpenProjectResponse;
    const settings = body.document.manifest.settings;
    settings.agent_providers = {
      agent_providers_version: 1,
      default_provider_profile_id: "e2e-provider",
      agents: {
        canon_checker: { provider_source: "project_default", provider_profile_override_id: null, model_id: null },
        impact_resolver: { provider_source: "project_default", provider_profile_override_id: null, model_id: "e2e-model" }
      }
    };
    settings.impact_resolver = { impact_resolver_version: 1, agent_mode: "configured", content_policy: "bounded_evidence" };
    await route.fulfill({ response, json: body });
  });

  await page.route("**/api/project-sessions/*/impact-analysis/resolution-runs**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname.endsWith("/resolution-runs") && method === "POST") {
      const request = route.request().postDataJSON() as ImpactResolutionRequest;
      currentRun = buildRun(request, state.nextStatus, locale);
      await fulfillJson(route, { response_version: 1, run: currentRun }, 201);
      return;
    }
    if (url.pathname.endsWith("/cancel") && method === "POST" && currentRun) {
      currentRun = buildRun(currentRun.request, "cancelled", locale);
      await fulfillJson(route, { response_version: 1, run: currentRun });
      return;
    }
    if (url.pathname.endsWith("/edit") && method === "POST" && currentRun) {
      const command = route.request().postDataJSON() as { patch: { patch_id: string } };
      state.editedPatchId = command.patch.patch_id;
      currentRun.alternatives[0]!.patch = command.patch as ImpactSolutionAlternative["patch"];
      await fulfillJson(route, { response_version: 1, run: currentRun });
      return;
    }
    if ((url.pathname.endsWith("/approve") || url.pathname.endsWith("/reject")) && method === "POST" && currentRun) {
      const approved = url.pathname.endsWith("/approve");
      const command = route.request().postDataJSON() as { alternative_id: string; proposal_semantic_fingerprint: string };
      state.reviewedDecisions.push(approved ? "approved" : "rejected");
      if (!approved) {
        currentRun.alternatives = currentRun.alternatives.filter((item) => item.id !== command.alternative_id);
        currentRun.visual_projections = currentRun.visual_projections.filter((item) => item.alternative_fingerprint !== command.proposal_semantic_fingerprint);
      } else {
        currentRun = { ...currentRun, status: "stale" };
        historyRevision = 1;
        historyDirection = "undo";
      }
      await fulfillJson(route, {
        response_version: 1,
        decision: {
          decision_version: 1,
          finding_fingerprints: currentRun.request.finding_ids,
          proposal_semantic_fingerprint: command.proposal_semantic_fingerprint,
          source_checksum: currentRun.source_checksum,
          decision: approved ? "approved" : "rejected",
          decided_at: "2026-09-02T10:00:02Z"
        },
        run: currentRun
      });
      return;
    }
    if (method === "GET" && currentRun) {
      await fulfillJson(route, { response_version: 1, run: currentRun });
      return;
    }
    await route.continue();
  });

  await page.route("**/api/project-sessions/*/history**", async (route) => {
    if (route.request().method() === "GET" && historyRevision === 0) {
      await route.continue();
      return;
    }
    if (route.request().method() === "GET") {
      await fulfillJson(route, historySummary(historyRevision, historyDirection));
      return;
    }
    const sessionUrl = route.request().url().replace(/\/history\/(undo|redo)$/, "");
    const response = await page.request.get(sessionUrl);
    const project = await response.json();
    if (route.request().url().endsWith("/undo")) {
      historyRevision += 1;
      historyDirection = "redo";
    } else {
      historyRevision += 1;
      historyDirection = "undo";
    }
    await fulfillJson(route, { project, history: historySummary(historyRevision, historyDirection) });
  });
  return state;
}

function historySummary(revision: number, direction: "undo" | "redo" | null) {
  const command = {
    command_id: "impact-resolution-e2e",
    command_kind: "approve_impact_resolution",
    label_key: "history.command.approveImpactResolution",
    label_parameters: {}
  };
  return {
    history_version: 1,
    history_revision: revision,
    capacity: 10,
    undo_depth: direction === "undo" ? 1 : 0,
    redo_depth: direction === "redo" ? 1 : 0,
    next_undo: direction === "undo" ? command : null,
    next_redo: direction === "redo" ? command : null
  };
}

function buildRun(request: ImpactResolutionRequest, status: ImpactResolutionRun["status"], locale: "en" | "ru"): ImpactResolutionRun {
  const alternatives = locale === "ru"
    ? [alternative(request, "primary", "Соединить исполняемый результат", locale), alternative(request, "fallback", "Добавить резервный переход", locale)]
    : [alternative(request, "primary", "Connect the executable outcome", locale), alternative(request, "fallback", "Add a guarded fallback", locale)];
  const visibleAlternatives = status === "completed" || status === "stale" ? alternatives : [];
  return {
    run_version: 1,
    id: `resolution-${status}`,
    project_id: "project-e2e",
    saved_revision: 1,
    history_revision: 0,
    source_checksum: request.source_checksum,
    request,
    status,
    explanation: ["completed", "stale"].includes(status) ? {
      explanation_version: 1,
      summary: locale === "ru" ? "Исполняемый результат недоступен из выбранной ветки истории." : "The executable outcome is unreachable from the selected story path.",
      why_it_matters: [locale === "ru" ? "Проигрывание не достигает заданного результата." : "Playback cannot reach the authored result."],
      assumptions: [locale === "ru" ? "Выбранная ветка должна оставаться исполняемой." : "The selected route should remain executable."],
      limitations: [locale === "ru" ? "Авторский текст не переписывается." : "No authored prose is rewritten."],
      cited_evidence: []
    } : null,
    alternatives: visibleAlternatives,
    visual_projections: visibleAlternatives.map((item) => ({
      projection_version: 1,
      alternative_fingerprint: item.semantic_fingerprint!,
      source_checksum: request.source_checksum,
      target_checksum: TARGET_CHECKSUM,
      changes: [{
        visual_change_version: 1,
        id: `visual-${item.id}`,
        kind: "modify",
        surface: "graph",
        before_resource: { owner_type: "node", owner_id: "node-hero", context_type: null, context_id: null },
        after_resource: { owner_type: "node", owner_id: "node-hero", context_type: null, context_id: null },
        field_changes: [{ path: "body", before: "Old route", after: "Reachable route" }],
        before_placement: null,
        after_placement: null
      }]
    })),
    diagnostics: ["failed", "cancelled", "stale"].includes(status) ? [{
      diagnostic_version: 1,
      code: status === "failed" ? "impact_resolution_run_failed" : status === "cancelled" ? "impact_resolution_run_cancelled" : "impact_resolution_run_stale",
      severity: "error",
      message_key: `impactResolution.error.impact_resolution_run_${status}`,
      parameters: {}
    }] : [],
    started_at: "2026-09-02T10:00:00Z",
    completed_at: ["queued", "running"].includes(status) ? null : "2026-09-02T10:00:01Z"
  };
}

function alternative(request: ImpactResolutionRequest, suffix: string, title: string, locale: "en" | "ru"): ImpactSolutionAlternative {
  return {
    alternative_version: 1,
    id: `alternative-${suffix}`,
    finding_ids: request.finding_ids,
    semantic_fingerprint: (suffix === "primary" ? "c" : "d").repeat(64),
    title,
    rationale: locale === "ru" ? "Добавляет явный переход без изменения авторского текста." : "Adds an explicit transition without rewriting narrative prose.",
    tradeoffs: [locale === "ru" ? "Добавляет одну исполняемую зависимость." : "Adds one executable dependency."],
    expected_outcomes: [locale === "ru" ? "Проигрывание достигает заданного результата." : "Playback reaches the authored outcome."],
    patch: {
      patch_version: 1,
      patch_id: `patch-${suffix}`,
      project_id: "project-e2e",
      source_checksum: request.source_checksum,
      target_checksum: TARGET_CHECKSUM,
      operations: [{ op: "put_record", collection: "flow_transitions", record_id: `transition-${suffix}`, record: { id: `transition-${suffix}` } }]
    },
    validation: { validation_version: 1, status: "valid", diagnostics: [] },
    comparison: {
      comparison_version: 1,
      source_checksum: request.source_checksum,
      target_checksum: TARGET_CHECKSUM,
      impact_before: impactSummary(2),
      impact_after: impactSummary(0),
      dependencies: { added: 1, removed: 0, changed: 0 },
      reachability: { added: 1, removed: 0, changed: 0 },
      state_paths: { added: 0, removed: 0, changed: 0 },
      canon_facts: { added: 0, removed: 0, changed: 0 },
      affected_issue_count: 1
    }
  };
}

function impactSummary(count: number) {
  return {
    summary_version: 1 as const,
    finding_count: count,
    direct_count: count ? 1 : 0,
    transitive_count: count ? count - 1 : 0,
    propagation: { required: count, conditional: 0, contextual: 0 },
    truncated: false,
    omitted_count: 0
  };
}

async function fulfillJson(route: Route, json: unknown, status = 200): Promise<void> {
  await route.fulfill({ contentType: "application/json", json, status });
}

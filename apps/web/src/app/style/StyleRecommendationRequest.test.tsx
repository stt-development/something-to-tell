import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { EffectiveStyleResolutionV1 } from "@something-to-tell/contracts/style-system";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18next } from "../../localization/i18n";
import type { RuntimeApiClient } from "../../runtime/apiClient";
import type { StyleRewriteRunV1 } from "@something-to-tell/contracts/style-rewrite";
import { StyleRecommendationRequest, styleMemoryScope, type StyleRecommendationLaunch } from "./StyleRecommendationRequest";

const CHECKSUM = "a".repeat(64);
const launch: StyleRecommendationLaunch = {
  actionId: "node-text-node-one",
  label: "Text for Gatehouse",
  nodeId: "node-one",
  placementId: null,
  sourceText: "Rain silvered the gate.",
  target: { kind: "node_text", node_id: "node-one" }
};
const resolved: EffectiveStyleResolutionV1 = {
  resolution_version: 1,
  target_node_id: "node-one",
  status: "resolved",
  source: "project_default",
  scene_context: null,
  candidate_contexts: [],
  style_profile_id: "style-one",
  profile: { id: "style-one", name: "Harbor noir", description: "Restrained prose." },
  unavailable_reason: null
};

function completedRun(id = "run-one", predecessorRunId: string | null = null): StyleRewriteRunV1 {
  return {
    run_version: 1,
    id,
    project_id: "project-one",
    request: {
      request_version: 1,
      session_id: "session-one",
      target: launch.target,
      style_context: null,
      observed_source_checksum: CHECKSUM,
      expected_history_revision: 4,
      additional_instructions: id === "run-one" ? "Keep the rain image." : "Use shorter beats.",
      content_consent: true
    },
    style_profile_id: "style-one",
    style_profile_name: "Harbor noir",
    source_checksum: CHECKSUM,
    source_text_checksum: "b".repeat(64),
    history_revision: 4,
    predecessor_run_id: predecessorRunId,
    status: "completed",
    progress: 100,
    recommendation: {
      recommendation_version: 1,
      id: `recommendation-${id}`,
      source_text: launch.sourceText,
      rewritten_text: "Rain sharpened every edge of the gate.",
      explanation: "The revision tightens the image while preserving the event.",
      applied_traits: ["restrained", "precise"],
      factual_risks: [],
      protected_value_results: [],
      provider_disclosure: {
        provider: "openai",
        provider_profile_id: "provider-one",
        model_id: "writer-model",
        content_locale: "en"
      },
      patch: {
        patch_version: 1,
        patch_id: `patch-${id}`,
        project_id: "project-one",
        source_checksum: CHECKSUM,
        target_checksum: "c".repeat(64),
        operations: [{ op: "put_record", collection: "nodes", record_id: "node-one", record: { id: "node-one" } }]
      },
      diff: [
        { kind: "delete", text: "Rain silvered" },
        { kind: "insert", text: "Rain sharpened" },
        { kind: "equal", text: " the gate." }
      ],
      validation_status: "valid",
      validation_diagnostics: []
    },
    error_code: null,
    started_at: "2026-09-08T10:00:00Z",
    completed_at: "2026-09-08T10:00:01Z"
  };
}

function persistence(resolution: EffectiveStyleResolutionV1 = resolved) {
  return {
    loadAgentMemoryWorkspace: vi.fn().mockResolvedValue({
      catalog: { catalog_version: 1, project_id: "project-one", entries: [] },
      source_checksum: CHECKSUM,
      history_revision: 4,
      owners: []
    }),
    resolveAgentMemory: vi.fn().mockResolvedValue({
      resolution_version: 1,
      project_id: "project-one",
      agent_id: "style_rewriter",
      content_locale: "en",
      source_checksum: CHECKSUM,
      history_revision: 4,
      status: "resolved",
      entries: [],
      included_characters: 0,
      omitted_entries: 0,
      omissions: [],
      conflicts: []
    }),
    resolveEffectiveStyle: vi.fn().mockResolvedValue(resolution),
    inspectProjectSession: vi.fn().mockResolvedValue({ document: { checksum: CHECKSUM } }),
    inspectProjectHistory: vi.fn().mockResolvedValue({ history_revision: 4 }),
    startStyleRewrite: vi.fn().mockResolvedValue({
      id: "run-one",
      status: "queued",
      progress: 0
    }),
    inspectStyleRewrite: vi.fn().mockResolvedValue({
      id: "run-one",
      status: "completed",
      progress: 100
    }),
    cancelStyleRewrite: vi.fn(),
    retryStyleRewrite: vi.fn(),
    approveStyleRewrite: vi.fn()
  } as unknown as RuntimeApiClient;
}

describe("StyleRecommendationRequest", () => {
  beforeEach(async () => {
    await i18next.changeLanguage("en");
  });

  it("maps Scene, node, and exact Dialogue fields to typed memory scopes", () => {
    expect(styleMemoryScope({ kind: "node_text", node_id: "scene-one" }, "scene-one"))
      .toEqual({ scope_version: 1, kind: "scene", scene_node_id: "scene-one" });
    expect(styleMemoryScope({ kind: "node_text", node_id: "node-one" }, "scene-one"))
      .toEqual({ scope_version: 1, kind: "node", node_id: "node-one" });
    expect(styleMemoryScope({
      kind: "dialogue_field",
      node_id: "dialogue-one",
      field_kind: "option_text",
      element_id: "choice-one",
      option_id: "answer-one"
    }, null)).toEqual({
      scope_version: 1,
      kind: "dialogue_field",
      node_id: "dialogue-one",
      field_kind: "option_text",
      element_id: "choice-one",
      option_id: "answer-one"
    });
  });

  it("submits the exact target with a fresh checksum, history revision, details, and consent", async () => {
    const runtime = persistence();
    render(<StyleRecommendationRequest launch={launch} onApproved={vi.fn()} onClose={vi.fn()} persistence={runtime} providerConfigured sessionId="session-one" />);

    expect(await screen.findByText("Harbor noir")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Additional details (optional)"), { target: { value: "Keep the rain image." } });
    fireEvent.click(screen.getByLabelText("I consent to sending this content for this request."));
    fireEvent.click(screen.getByRole("button", { name: "Request recommendation" }));

    await waitFor(() => expect(runtime.startStyleRewrite).toHaveBeenCalledWith({
      request_version: 1,
      session_id: "session-one",
      target: launch.target,
      style_context: null,
      observed_source_checksum: CHECKSUM,
      expected_history_revision: 4,
      additional_instructions: "Keep the rain image.",
      content_consent: true
    }));
  });

  it("requires explicit Scene selection for shared content", async () => {
    const runtime = persistence({
      resolution_version: 1,
      target_node_id: "node-one",
      status: "context_required",
      source: null,
      scene_context: null,
      candidate_contexts: [
        { scene_node_id: "scene-a", scene_title: "Arrival" },
        { scene_node_id: "scene-b", scene_title: "Departure" }
      ],
      style_profile_id: null,
      profile: null,
      unavailable_reason: null
    });
    runtime.resolveEffectiveStyle = vi.fn()
      .mockResolvedValueOnce({
        resolution_version: 1,
        target_node_id: "node-one",
        status: "context_required",
        source: null,
        scene_context: null,
        candidate_contexts: [
          { scene_node_id: "scene-a", scene_title: "Arrival" },
          { scene_node_id: "scene-b", scene_title: "Departure" }
        ],
        style_profile_id: null,
        profile: null,
        unavailable_reason: null
      })
      .mockResolvedValueOnce({ ...resolved, scene_context: { scene_node_id: "scene-b", scene_title: "Departure" } });

    render(<StyleRecommendationRequest launch={launch} onApproved={vi.fn()} onClose={vi.fn()} persistence={runtime} providerConfigured sessionId="session-one" />);
    fireEvent.change(await screen.findByLabelText("Scene context"), { target: { value: "scene-b" } });

    await waitFor(() => expect(runtime.resolveEffectiveStyle).toHaveBeenLastCalledWith(
      "session-one",
      "node-one",
      { context_version: 1, scene_node_id: "scene-b", placement_id: null }
    ));
    expect(await screen.findByText("Departure")).toBeInTheDocument();
  });

  it("explains unavailable provider configuration instead of enabling a fake request", async () => {
    render(<StyleRecommendationRequest launch={launch} onApproved={vi.fn()} onClose={vi.fn()} persistence={persistence()} providerConfigured={false} sessionId="session-one" />);
    expect(await screen.findByText("Configure the Style Rewriter provider and model in Project Settings.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request recommendation" })).toBeDisabled();
  });

  it("keeps an empty target and an unconfigured style actionable but non-runnable", async () => {
    const runtime = persistence({
      resolution_version: 1,
      target_node_id: "node-one",
      status: "unconfigured",
      source: "unconfigured",
      scene_context: null,
      candidate_contexts: [],
      style_profile_id: null,
      profile: null,
      unavailable_reason: null
    });
    render(<StyleRecommendationRequest launch={{ ...launch, sourceText: "" }} onApproved={vi.fn()} onClose={vi.fn()} persistence={runtime} providerConfigured sessionId="session-one" />);
    expect(await screen.findByText("Add and save Text before requesting a recommendation.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request recommendation" })).toBeDisabled();
  });

  it("exposes cancellation while a request is queued or running", async () => {
    const runtime = persistence();
    runtime.cancelStyleRewrite = vi.fn().mockResolvedValue({ id: "run-one", status: "cancelled", progress: 100 });
    render(<StyleRecommendationRequest launch={launch} onApproved={vi.fn()} onClose={vi.fn()} persistence={runtime} providerConfigured sessionId="session-one" />);
    await screen.findByText("Harbor noir");
    fireEvent.click(screen.getByLabelText("I consent to sending this content for this request."));
    fireEvent.click(screen.getByRole("button", { name: "Request recommendation" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(runtime.cancelStyleRewrite).toHaveBeenCalledWith("session-one", "run-one"));
    expect(await screen.findByText("The recommendation request was cancelled.")).toBeInTheDocument();
  });

  it("reviews and approves the exact validated recommendation", async () => {
    const runtime = persistence();
    runtime.startStyleRewrite = vi.fn().mockResolvedValue(completedRun());
    runtime.approveStyleRewrite = vi.fn().mockResolvedValue({ result: { project: {}, history: {} } });
    const onApproved = vi.fn();
    render(<StyleRecommendationRequest launch={launch} onApproved={onApproved} onClose={vi.fn()} persistence={runtime} providerConfigured sessionId="session-one" />);

    await screen.findByText("Harbor noir");
    fireEvent.change(screen.getByLabelText("Additional details (optional)"), { target: { value: "Keep the rain image." } });
    fireEvent.click(screen.getByLabelText("I consent to sending this content for this request."));
    fireEvent.click(screen.getByRole("button", { name: "Request recommendation" }));
    expect(await screen.findByText("The revision tightens the image while preserving the event.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(runtime.approveStyleRewrite).toHaveBeenCalledWith("session-one", "run-one", {
      approval_version: 1,
      recommendation_id: "recommendation-run-one",
      source_checksum: CHECKSUM,
      expected_history_revision: 4
    }));
    expect(onApproved).toHaveBeenCalledTimes(1);
  });

  it("requests another version and keeps the prior version available", async () => {
    const runtime = persistence();
    runtime.startStyleRewrite = vi.fn().mockResolvedValue(completedRun());
    runtime.retryStyleRewrite = vi.fn().mockResolvedValue(completedRun("run-two", "run-one"));
    render(<StyleRecommendationRequest launch={launch} onApproved={vi.fn()} onClose={vi.fn()} persistence={runtime} providerConfigured sessionId="session-one" />);

    await screen.findByText("Harbor noir");
    fireEvent.click(screen.getByLabelText("I consent to sending this content for this request."));
    fireEvent.click(screen.getByRole("button", { name: "Request recommendation" }));
    await screen.findByRole("button", { name: "Request again" });
    fireEvent.change(screen.getByLabelText("Additional details (optional)"), { target: { value: "Use shorter beats." } });
    fireEvent.click(screen.getByLabelText("I consent to sending this content for this request."));
    fireEvent.click(screen.getByRole("button", { name: "Request again" }));

    await waitFor(() => expect(runtime.retryStyleRewrite).toHaveBeenCalledWith("session-one", "run-one", {
      retry_version: 1,
      observed_source_checksum: CHECKSUM,
      expected_history_revision: 4,
      additional_instructions: "Use shorter beats.",
      content_consent: true
    }));
    expect(await screen.findByRole("option", { name: "Version 2 · Harbor noir" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Version"), { target: { value: "run-one" } });
    expect(screen.getByText("Keep the rain image.")).toBeInTheDocument();
  });
});

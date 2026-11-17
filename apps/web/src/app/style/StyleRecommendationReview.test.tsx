import { fireEvent, render, screen } from "@testing-library/react";
import type { StyleRewriteRunV1 } from "@something-to-tell/contracts/style-rewrite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18next } from "../../localization/i18n";
import { StyleRecommendationReview } from "./StyleRecommendationReview";

const CHECKSUM = "a".repeat(64);

function reviewRun(blocked = false, contentLocale: "en" | "ru" = "en"): StyleRewriteRunV1 {
  return {
    run_version: 1,
    id: "run-one",
    project_id: "project-one",
    request: {
      request_version: 1,
      session_id: "session-one",
      target: { kind: "node_text", node_id: "node-one" },
      style_context: null,
      observed_source_checksum: CHECKSUM,
      expected_history_revision: 2,
      additional_instructions: "Keep the image.",
      content_consent: true
    },
    style_profile_id: "style-one",
    style_profile_name: "Harbor noir",
    source_checksum: CHECKSUM,
    source_text_checksum: "b".repeat(64),
    history_revision: 2,
    predecessor_run_id: null,
    status: "completed",
    progress: 100,
    recommendation: {
      recommendation_version: 1,
      id: "recommendation-one",
      source_text: "The gate was wet.",
      rewritten_text: contentLocale === "ru" ? "Дождь покрыл ворота." : "Rain glazed the gate.",
      explanation: contentLocale === "ru" ? "Образ стал конкретнее." : "The image is more concrete.",
      applied_traits: ["precise"],
      factual_risks: blocked ? ["The material of the gate may be inferred."] : [],
      protected_value_results: blocked ? [{ kind: "name", value: "Mara", preserved: false }] : [],
      provider_disclosure: { provider: "openai", provider_profile_id: "provider-one", model_id: "model-one", content_locale: contentLocale },
      patch: blocked ? null : {
        patch_version: 1,
        patch_id: "patch-one",
        project_id: "project-one",
        source_checksum: CHECKSUM,
        target_checksum: "c".repeat(64),
        operations: [{ op: "put_record", collection: "nodes", record_id: "node-one", record: { id: "node-one" } }]
      },
      diff: [
        { kind: "delete", text: "The gate was wet." },
        { kind: "insert", text: "Rain glazed the gate." }
      ],
      validation_status: blocked ? "blocked" : "valid",
      validation_diagnostics: blocked ? [{ code: "fact_changed", message_key: "Fact changed", blocking: true, parameters: {} }] : []
    },
    error_code: null,
    started_at: "2026-09-08T10:00:00Z",
    completed_at: "2026-09-08T10:00:01Z"
  };
}

describe("StyleRecommendationReview", () => {
  beforeEach(async () => {
    await i18next.changeLanguage("en");
  });

  it("switches readable comparison tabs and delegates review decisions", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const onRequestAgain = vi.fn();
    render(<StyleRecommendationReview approving={false} onApprove={onApprove} onReject={onReject} onRequestAgain={onRequestAgain} onSelectVersion={vi.fn()} retryDisabled={false} run={reviewRun()} versions={[reviewRun()]} />);

    expect(screen.getByText("The image is more concrete.")).toBeInTheDocument();
    expect(screen.getByText("No factual risks detected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "After" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Rain glazed the gate.");
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    fireEvent.click(screen.getByRole("button", { name: "Request again" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onReject).toHaveBeenCalledOnce();
    expect(onRequestAgain).toHaveBeenCalledOnce();
    expect(onApprove).toHaveBeenCalledOnce();
  });

  it("shows factual warnings and blocks an invalid recommendation", () => {
    const run = reviewRun(true);
    render(<StyleRecommendationReview approving={false} onApprove={vi.fn()} onReject={vi.fn()} onRequestAgain={vi.fn()} onSelectVersion={vi.fn()} retryDisabled={false} run={run} versions={[run]} />);

    expect(screen.getByText("The material of the gate may be inferred.")).toBeInTheDocument();
    expect(screen.getByText("Protected value may have changed: Mara")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  });

  it("localizes controls independently from generated content language", async () => {
    const run = reviewRun(false, "ru");
    const firstRender = render(<StyleRecommendationReview approving={false} onApprove={vi.fn()} onReject={vi.fn()} onRequestAgain={vi.fn()} onSelectVersion={vi.fn()} retryDisabled={false} run={run} versions={[run]} />);

    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByText("Образ стал конкретнее.")).toBeInTheDocument();
    expect(screen.getByText("Russian")).toBeInTheDocument();

    // Remove the English UI before switching locales so assertions cannot pass
    // against controls left behind by the first render.
    firstRender.unmount();
    await i18next.changeLanguage("ru");
    const englishRun = reviewRun();
    render(<StyleRecommendationReview approving={false} onApprove={vi.fn()} onReject={vi.fn()} onRequestAgain={vi.fn()} onSelectVersion={vi.fn()} retryDisabled={false} run={englishRun} versions={[englishRun]} />);
    expect(screen.getByRole("button", { name: "Принять" })).toBeInTheDocument();
    expect(screen.getByText("The image is more concrete.")).toBeInTheDocument();
    expect(screen.getByText("Английский")).toBeInTheDocument();
  });
});

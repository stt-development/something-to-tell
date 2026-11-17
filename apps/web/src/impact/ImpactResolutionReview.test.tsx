import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImpactResolutionRun } from "@something-to-tell/contracts/impact-resolution";
import { applyProjectLocale } from "../localization/i18n";
import { ImpactResolutionReview, type ImpactResolutionReviewProps } from "./ImpactResolutionReview";

const SOURCE = "a".repeat(64);
const TARGET = "b".repeat(64);
const OWNER = { owner_type: "node", owner_id: "gate", context_type: null, context_id: null };
const IMPACT_SUMMARY = {
  summary_version: 1 as const,
  finding_count: 2,
  direct_count: 1,
  transitive_count: 1,
  propagation: { required: 1, conditional: 1, contextual: 0 },
  truncated: false,
  omitted_count: 0
};

function resolutionRun(status: ImpactResolutionRun["status"] = "completed"): ImpactResolutionRun {
  return {
    run_version: 1,
    id: "resolution-run",
    project_id: "project",
    saved_revision: 3,
    history_revision: 2,
    source_checksum: SOURCE,
    request: {
      request_version: 1,
      impact_run_id: "impact-run",
      finding_ids: ["finding-1"],
      source_checksum: SOURCE,
      provider_source: "project_default",
      provider_profile_id: null,
      model_id: "structured-model",
      content_consent: true,
      requested_alternative_count: 3,
      limits: {
        limits_version: 1,
        max_findings: 50,
        max_context_resources: 200,
        max_context_characters: 120000,
        max_patch_operations: 200,
        max_visual_changes: 500
      }
    },
    status,
    explanation: status === "queued" || status === "running" ? null : {
      explanation_version: 1,
      summary: "The gate outcome is disconnected from the executable route.",
      why_it_matters: ["Playback cannot reach the promised outcome."],
      assumptions: ["The main route should stay executable."],
      limitations: ["Authored prose was not rewritten."],
      cited_evidence: []
    },
    alternatives: status === "completed" || status === "stale" ? [{
      alternative_version: 1,
      id: "alternative-1",
      finding_ids: ["finding-1"],
      semantic_fingerprint: "proposal-fingerprint",
      title: "Connect the gate outcome",
      rationale: "Adds the missing executable transition.",
      tradeoffs: ["Introduces one route dependency."],
      expected_outcomes: ["The outcome becomes reachable."],
      patch: {
        patch_version: 1,
        patch_id: "patch-1",
        project_id: "project",
        source_checksum: SOURCE,
        target_checksum: TARGET,
        operations: [{ op: "put_record", collection: "flow_transitions", record_id: "transition-1", record: { id: "transition-1" } }]
      },
      validation: { validation_version: 1, status: "valid", diagnostics: [] },
      comparison: {
        comparison_version: 1,
        source_checksum: SOURCE,
        target_checksum: TARGET,
        impact_before: IMPACT_SUMMARY,
        impact_after: { ...IMPACT_SUMMARY, finding_count: 0, direct_count: 0, transitive_count: 0, propagation: { required: 0, conditional: 0, contextual: 0 } },
        dependencies: { added: 1, removed: 0, changed: 0 },
        reachability: { added: 1, removed: 0, changed: 0 },
        state_paths: { added: 0, removed: 0, changed: 0 },
        canon_facts: { added: 0, removed: 0, changed: 0 },
        affected_issue_count: 1
      }
    }]: [],
    visual_projections: status === "completed" || status === "stale" ? [{
      projection_version: 1,
      alternative_fingerprint: "proposal-fingerprint",
      source_checksum: SOURCE,
      target_checksum: TARGET,
      changes: [{
        visual_change_version: 1,
        id: "visual-1",
        kind: "modify",
        surface: "flow",
        before_resource: OWNER,
        after_resource: OWNER,
        field_changes: [{ path: "title", before: "Gate", after: "Open gate" }],
        before_placement: null,
        after_placement: null
      }, {
        visual_change_version: 1,
        id: "visual-2",
        kind: "add",
        surface: "quest",
        before_resource: null,
        after_resource: { owner_type: "quest_stage", owner_id: "stage-1", context_type: "node", context_id: "gate" },
        field_changes: [],
        before_placement: null,
        after_placement: { x: 10, y: 20, width: 180, height: 80, preview_only: true }
      }]
    }] : [],
    diagnostics: status === "failed" ? [{
      diagnostic_version: 1,
      code: "impact_resolution_run_failed",
      severity: "error",
      message_key: "impactResolution.error.impact_resolution_run_failed",
      parameters: {}
    }] : [],
    started_at: "2026-09-01T10:00:00Z",
    completed_at: ["queued", "running"].includes(status) ? null : "2026-09-01T10:00:01Z"
  };
}

function props(overrides: Partial<ImpactResolutionReviewProps> = {}): ImpactResolutionReviewProps {
  return {
    error: null,
    findingIds: ["finding-1"],
    historyRevision: 2,
    operation: null,
    providerConfigured: true,
    run: null,
    onCancel: vi.fn(),
    onApprove: vi.fn(),
    onEdit: vi.fn(),
    onNavigate: vi.fn(),
    onReject: vi.fn(),
    onRun: vi.fn(),
    onVerifyCanon: vi.fn(),
    onVerifyImpact: vi.fn(),
    resourceLabel: (owner) => owner.owner_id === "gate" ? "Citadel gate" : "Quest stage",
    verificationPending: false,
    ...overrides
  };
}

afterEach(async () => applyProjectLocale("en"));

describe("ImpactResolutionReview", () => {
  it("keeps idle provider assistance collapsed and requires disclosed consent", () => {
    const onRun = vi.fn();
    const { container } = render(<ImpactResolutionReview {...props({ onRun })} />);

    expect(screen.queryByLabelText(/Send the selected findings/)).not.toBeInTheDocument();
    expect(container.querySelector(".lucide-bot")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Resolution review/ }));
    const runButton = screen.getByRole("button", { name: "Explain findings" });
    expect(runButton).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/Send the selected findings/));
    fireEvent.click(runButton);
    expect(onRun).toHaveBeenCalledWith(["finding-1"], false);
  });

  it("opens provider controls immediately for an explicit solution-exploration entry", () => {
    render(<ImpactResolutionReview {...props({ initiallyExpanded: true })} />);

    expect(screen.getByRole("button", { name: /Resolution review/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText(/Send the selected findings/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Explain findings" })).toBeDisabled();
  });

  it("shows configuration guidance without hiding the deterministic workflow", () => {
    render(<ImpactResolutionReview {...props({ providerConfigured: false })} />);
    fireEvent.click(screen.getByRole("button", { name: /Resolution review/ }));

    expect(screen.getByText(/Configure an Impact Resolution provider/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Explain findings" })).toBeDisabled();
  });

  it("shows queued and running progress with cancellable controls", async () => {
    const onCancel = vi.fn();
    const { rerender } = render(<ImpactResolutionReview {...props({ onCancel, run: resolutionRun("queued") })} />);
    expect(await screen.findByRole("status")).toHaveTextContent("Generating resolution alternatives");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();

    rerender(<ImpactResolutionReview {...props({ operation: "cancelling", run: resolutionRun("running") })} />);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("compares a completed alternative, filters visual changes, and opens the exact source", async () => {
    const onNavigate = vi.fn();
    const run = resolutionRun();
    render(<ImpactResolutionReview {...props({ onNavigate, run })} />);

    expect(await screen.findByText("The gate outcome is disconnected from the executable route.")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Connect the gate outcome/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("2").closest("span")).toHaveTextContent("findings before");
    expect(screen.getByText("Citadel gate")).toBeInTheDocument();
    expect(screen.getByText("Quest stage")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Authoring surface"), { target: { value: "quest" } });
    expect(screen.queryByText("Citadel gate")).not.toBeInTheDocument();
    const changeRow = screen.getByText("Quest stage").closest<HTMLElement>(".impact-resolution-change")!;
    expect(within(changeRow).getByText("Preview placement")).toBeInTheDocument();
    fireEvent.click(within(changeRow).getByRole("button", { name: "Open source: Quest stage" }));
    expect(onNavigate).toHaveBeenCalledWith(run.visual_projections[0]!.changes[1]);

    fireEvent.click(screen.getByRole("button", { name: "Before" }));
    expect(screen.getByText(/No changes match/)).toBeInTheDocument();
  });

  it("approves, rejects, and submits a locally edited patch for revalidation", async () => {
    const onApprove = vi.fn();
    const onEdit = vi.fn();
    const onReject = vi.fn();
    const run = resolutionRun();
    render(<ImpactResolutionReview {...props({ onApprove, onEdit, onReject, run })} />);

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(onApprove).toHaveBeenCalledWith(run.alternatives[0]);
    expect(onReject).toHaveBeenCalledWith(run.alternatives[0]);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = screen.getByLabelText("Project patch draft");
    fireEvent.change(editor, { target: { value: "{" } });
    fireEvent.click(screen.getByRole("button", { name: "Validate draft" }));
    expect(screen.getByRole("alert")).toHaveTextContent("valid JSON");
    expect(onEdit).not.toHaveBeenCalled();

    const editedPatch = { ...run.alternatives[0]!.patch!, patch_id: "edited-patch" };
    fireEvent.change(editor, { target: { value: JSON.stringify(editedPatch) } });
    fireEvent.click(screen.getByRole("button", { name: "Validate draft" }));
    expect(onEdit).toHaveBeenCalledWith(run.alternatives[0], editedPatch);
  });

  it("can explicitly request rejected alternatives and keeps stale review read-only", async () => {
    const onRun = vi.fn();
    const { rerender } = render(<ImpactResolutionReview {...props({ onRun, run: resolutionRun() })} />);
    fireEvent.click(await screen.findByLabelText(/Include previously rejected alternatives/));
    fireEvent.click(screen.getByLabelText(/Send the selected findings/));
    fireEvent.click(screen.getByRole("button", { name: "Request new alternatives" }));
    expect(onRun).toHaveBeenCalledWith(["finding-1"], true);

    rerender(<ImpactResolutionReview {...props({ onRun, run: resolutionRun("stale") })} />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(screen.queryByText("Citadel gate")).not.toBeInTheDocument();
    expect(screen.getByText(/This alternative targets an older project snapshot/)).toBeInTheDocument();
    expect(screen.getByText(/Visual preview is inactive/)).toBeInTheDocument();
  });

  it("offers explicit deterministic verification after approval", async () => {
    const onVerifyCanon = vi.fn();
    const onVerifyImpact = vi.fn();
    render(<ImpactResolutionReview {...props({
      onVerifyCanon,
      onVerifyImpact,
      run: resolutionRun("stale"),
      verificationPending: true
    })} />);

    fireEvent.click(await screen.findByRole("button", { name: "Rerun Impact" }));
    fireEvent.click(screen.getByRole("button", { name: "Rerun Canon" }));
    expect(onVerifyImpact).toHaveBeenCalledOnce();
    expect(onVerifyCanon).toHaveBeenCalledOnce();
  });

  it("preserves the selected alternative across a retry response", async () => {
    const first = resolutionRun();
    const secondAlternative = {
      ...first.alternatives[0]!,
      id: "alternative-2",
      semantic_fingerprint: "proposal-fingerprint-2",
      title: "Document the blocked route"
    };
    const { rerender } = render(<ImpactResolutionReview {...props({
      run: { ...first, alternatives: [...first.alternatives, secondAlternative] }
    })} />);
    fireEvent.click(await screen.findByRole("tab", { name: /Document the blocked route/ }));

    const retried = resolutionRun();
    rerender(<ImpactResolutionReview {...props({
      run: { ...retried, id: "resolution-run-retry", alternatives: [...retried.alternatives, secondAlternative] }
    })} />);

    expect(screen.getByRole("tab", { name: /Document the blocked route/ })).toHaveAttribute("aria-selected", "true");
  });

  it.each(["failed", "cancelled", "stale"] as const)("preserves readable review controls for %s runs", async (status) => {
    render(<ImpactResolutionReview {...props({ run: resolutionRun(status) })} />);
    expect(await screen.findByRole("button", { name: "Request new alternatives" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
    if (status === "stale") expect(screen.getByRole("tab", { name: /Connect the gate outcome/ })).toBeInTheDocument();
  });

  it("renders completed review controls in Russian", async () => {
    await applyProjectLocale("ru");
    render(<ImpactResolutionReview {...props({ run: resolutionRun() })} />);

    expect(await screen.findByRole("region", { name: "Разбор решений" })).toBeInTheDocument();
    expect(screen.getByText("Варианты решения")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "До" })).toHaveAttribute("title", "Показать ресурсы до предложенного изменения");
    expect(screen.getByLabelText("Рабочая поверхность")).toBeInTheDocument();
  });
});

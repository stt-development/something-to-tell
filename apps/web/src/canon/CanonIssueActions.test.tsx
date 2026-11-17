import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CanonIssueProjection } from "@something-to-tell/contracts/canon-check";
import { CanonIssueActionProvider, CanonIssueActions, CanonIssueActionsForId, CanonIssueInlineDetail } from "./CanonIssueActions";

const issue = {
  id: "issue-1",
  project_id: "project",
  title: "Invalid condition",
  description: "Choose a declared flag.",
  severity: "critical",
  status: "open",
  repair: { capability_version: 1, kind: "deterministic_patch", action: "request_fix", available: true, unavailable_reason: null, source_checksum: "a".repeat(64) },
  metadata: {
    issue_version: 1,
    origin: "canon_rule",
    rule_id: "condition.unresolved-path",
    rule_version: 1,
    fingerprint: "b".repeat(64),
    category: "conditions",
    scope: { owner_type: "node", owner_id: "node-1", context_type: null, context_id: null },
    message_key: "canon.issue.condition.unresolved-path.message",
    message_parameters: { path: "flags.route" },
    recommendation_key: "canon.issue.condition.unresolved-path.recommendation",
    recommendation_parameters: {},
    targets: [{ owner_type: "node", owner_id: "node-1", context_type: null, context_id: null }],
    evidence: [],
    agent_explanation: null,
    agent_recommendation: null,
    saved_revision: 1,
    source_checksum: "a".repeat(64),
    first_seen_at: "2026-09-03T00:00:00Z",
    last_seen_at: "2026-09-03T00:00:00Z",
    resolved_at: null,
    resolution_reason: null
  }
} satisfies CanonIssueProjection;

describe("CanonIssueActions", () => {
  it("dispatches review and runtime-advertised repair actions", () => {
    const onReview = vi.fn();
    const onRepair = vi.fn();
    render(<CanonIssueActions busy={false} issue={issue} onNavigate={vi.fn()} onRepair={onRepair} onReview={onReview} />);

    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    fireEvent.click(screen.getByRole("button", { name: "Ignore" }));
    fireEvent.click(screen.getByRole("button", { name: "Request suggestion" }));

    expect(onReview).toHaveBeenNthCalledWith(1, "review");
    expect(onReview).toHaveBeenNthCalledWith(2, "ignored");
    expect(onRepair).toHaveBeenCalledOnce();
  });

  it("uses the shared projection and disables unavailable capabilities", () => {
    const unavailable = { ...issue, repair: { ...issue.repair, available: false, unavailable_reason: "canon.repair.unavailable.owner_missing" } };
    render(
      <CanonIssueActionProvider value={{ busy: false, error: null, issues: [unavailable], notice: null, onNavigate: vi.fn(), onRepair: vi.fn(), onReview: vi.fn() }}>
        <CanonIssueActionsForId issueId={issue.id} />
      </CanonIssueActionProvider>
    );

    expect(screen.getByRole("button", { name: "Request suggestion" })).toBeDisabled();
    expect(screen.getByText("Open")).toBeInTheDocument();
  });

  it("shows localized detail and shared command feedback inline", () => {
    render(
      <CanonIssueActionProvider value={{ busy: false, error: "Revision changed", issues: [issue], notice: "Status updated", onNavigate: vi.fn(), onRepair: vi.fn(), onReview: vi.fn() }}>
        <CanonIssueInlineDetail issue={issue} />
      </CanonIssueActionProvider>
    );

    expect(screen.getByText(/condition references state/i)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Revision changed");
    expect(screen.getByRole("status")).toHaveTextContent("Status updated");
  });
});

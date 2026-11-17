import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  CanonCheckRun,
  CanonFixSuggestion,
  CanonIssueListResponse,
  CanonIssueProjection
} from "@something-to-tell/contracts/canon-check";
import { applyProjectLocale } from "../localization/i18n";
import { CanonWorkspace, type CanonWorkspaceProps } from "./CanonWorkspace";

const CHECKSUM = "a".repeat(64);
const NOW = "2026-08-21T10:00:00Z";

function issue(
  id: string,
  severity: CanonIssueProjection["severity"],
  status: CanonIssueProjection["status"],
  ruleId: string,
  targetId: string
): CanonIssueProjection {
  const target = { owner_type: "node", owner_id: targetId, context_type: null, context_id: null };
  return {
    id,
    project_id: "project",
    title: `canon.issue.${ruleId}.message`,
    description: `canon.issue.${ruleId}.recommendation`,
    severity,
    status,
    repair: {
      capability_version: 1,
      kind: "deterministic_patch",
      action: "request_fix",
      available: true,
      unavailable_reason: null,
      source_checksum: CHECKSUM
    },
    metadata: {
      issue_version: 1,
      origin: "canon_rule",
      rule_id: ruleId,
      rule_version: 1,
      fingerprint: id.padEnd(64, "0"),
      category: ruleId.split(".")[0]!,
      scope: { owner_type: "project", owner_id: "project", context_type: null, context_id: null },
      message_key: `canon.issue.${ruleId}.message`,
      message_parameters: {},
      recommendation_key: `canon.issue.${ruleId}.recommendation`,
      recommendation_parameters: {},
      targets: [target],
      evidence: [{
        owner: target,
        field_path: "condition",
        message_key: "canon.evidence.authored-value",
        message_parameters: {},
        excerpt: "flags.route_open"
      }],
      agent_explanation: null,
      agent_recommendation: null,
      saved_revision: 3,
      source_checksum: CHECKSUM,
      first_seen_at: NOW,
      last_seen_at: NOW,
      resolved_at: null,
      resolution_reason: null
    }
  };
}

const ISSUES: CanonIssueListResponse = {
  project_id: "project",
  issues: [
    issue("critical", "critical", "open", "condition.unresolved-path", "locked-door"),
    issue("warning", "warning", "review", "ownership.custody-disagreement", "ledger")
  ],
  active_count: 2,
  severity: { critical: 1, warning: 1, info: 0 }
};

const RUN: CanonCheckRun = {
  run_version: 1,
  id: "run",
  project_id: "project",
  saved_revision: 3,
  source_checksum: CHECKSUM,
  rule_pack_version: 1,
  mode: "deterministic",
  scope: [],
  status: "completed",
  started_at: NOW,
  completed_at: NOW,
  summary: {
    fact_count: 14,
    candidate_count: 2,
    opened_count: 2,
    retained_count: 0,
    resolved_count: 0,
    severity: { critical: 1, warning: 1, info: 0 }
  },
  diagnostics: []
};

const FIX_SUGGESTION: CanonFixSuggestion = {
  suggestion_version: 1,
  id: "fix-1",
  issue_id: "critical",
  project_id: "project",
  status: "pending",
  why: "The route condition references state that never becomes true.",
  how: "Replace the condition with the authored ledger acquisition flag.",
  patch: {
    patch_version: 1,
    patch_id: "patch-1",
    project_id: "project",
    source_checksum: CHECKSUM,
    target_checksum: "b".repeat(64),
    operations: [{
      op: "put_record",
      collection: "flow_transitions",
      record_id: "locked-door",
      record: { id: "locked-door", condition: "flags.route_open == true" }
    }]
  }
};

function props(overrides: Partial<CanonWorkspaceProps> = {}): CanonWorkspaceProps {
  return {
    error: null,
    issues: ISSUES,
    mode: "deterministic",
    notice: null,
    operation: null,
    providerConfigured: false,
    revision: 3,
    run: RUN,
    selectedIssueId: null,
    suggestion: null,
    onCancel: vi.fn(),
    onClose: vi.fn(),
    onModeChange: vi.fn(),
    onNavigate: vi.fn(),
    onReview: vi.fn(),
    onSelectIssue: vi.fn(),
    onRun: vi.fn(),
    onRepair: vi.fn(),
    onSuggestionDecision: vi.fn(),
    onAnalyzeSuggestion: vi.fn(),
    suggestionBlocked: false,
    ...overrides
  };
}

describe("CanonWorkspace", () => {
  it("runs directly against the current working project", () => {
    const onRun = vi.fn();
    render(<CanonWorkspace {...props({ onRun })} />);

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(onRun).toHaveBeenCalledWith(false);
  });

  it("shows explicit progress while waiting for a configured agent", () => {
    render(<CanonWorkspace {...props({
      mode: "configured_agent",
      operation: "running",
      providerConfigured: true
    })} />);

    expect(screen.getByRole("status", { name: "" })).toHaveTextContent("Agent is analyzing canon evidence");
    expect(screen.getByText("Waiting for the configured provider response.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Running" })).toBeDisabled();
  });

  it("filters issues and exposes non-color severity labels", () => {
    render(<CanonWorkspace {...props()} />);

    expect(screen.getAllByRole("img", { name: "Critical" })).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Severity"), { target: { value: "warning" } });
    expect(screen.queryByText(/condition references state/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/semantic ownership disagrees/i)).toHaveLength(3);
  });

  it("localizes rule and category names while preserving the stable rule id", async () => {
    const localized = issue("localized", "warning", "open", "condition.unresolved-path", "door");
    localized.metadata.category = "conditions";
    await applyProjectLocale("ru");
    try {
      render(<CanonWorkspace {...props({
        issues: {
          project_id: "project",
          issues: [localized],
          active_count: 1,
          severity: { critical: 0, warning: 1, info: 0 }
        }
      })} />);

      expect(screen.getByRole("option", { name: "Условия" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "Неразрешимый путь условия" })).toBeInTheDocument();
      expect(screen.getByText(/Условия · Открыто/)).toBeInTheDocument();
      expect(screen.getByText(/Неразрешимый путь условия · condition\.unresolved-path v1/)).toBeInTheDocument();
    } finally {
      await applyProjectLocale("en");
    }
  });

  it("hides historical issues by default and distinguishes their statuses", () => {
    const historicalIssues = {
      ...ISSUES,
      issues: [
        ...ISSUES.issues,
        issue("resolved", "info", "resolved", "integrity.error-fact", "resolved-node"),
        issue("ignored", "info", "ignored", "integrity.error-fact", "ignored-node")
      ]
    };
    render(<CanonWorkspace {...props({ issues: historicalIssues })} />);

    expect(document.querySelector('[data-status="resolved"]')).not.toBeInTheDocument();
    expect(document.querySelector('[data-status="ignored"]')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "all" } });
    expect(document.querySelector('[data-status="resolved"]')).toBeInTheDocument();
    expect(document.querySelector('[data-status="ignored"]')).toBeInTheDocument();
  });

  it("supports keyboard issue selection and renders evidence and targets", () => {
    const onNavigate = vi.fn();
    render(<CanonWorkspace {...props({ onNavigate })} />);
    const list = screen.getByRole("listbox", { name: "Canon issues" });

    fireEvent.keyDown(list, { key: "ArrowDown" });

    expect(screen.getByText("ledger")).toBeInTheDocument();
    expect(screen.getByText("flags.route_open")).toBeInTheDocument();
    expect(screen.getByText("condition")).toBeInTheDocument();
    expect(onNavigate).not.toHaveBeenCalled();

    fireEvent.keyDown(list, { key: "Enter" });
    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ owner_id: "ledger" }), "source");
  });

  it("shows concrete domain and fact identity for V2 integrity issues", () => {
    const concrete = issue("integrity", "critical", "open", "integrity.error-fact", "dialogue-1");
    concrete.metadata = {
      ...concrete.metadata,
      issue_version: 2,
      message_key: "canon.issue.integrity.known.message",
      message_parameters: {
        problem_key: "canon.fact.dialogue.dead_end",
        owner_type: "dialogue_element",
        owner_id: "answer-1",
        field_path: "next_element_id"
      },
      diagnostic: {
        diagnostic_version: 1,
        fact_code: "dialogue.dead_end",
        domain: "dialogue",
        parameters: {},
        identity_parameters: {},
        targets: concrete.metadata.targets,
        evidence: concrete.metadata.evidence
      }
    };

    render(<CanonWorkspace {...props({
      issues: { project_id: "project", issues: [concrete], active_count: 1, severity: { critical: 1, warning: 0, info: 0 } }
    })} />);

    expect(screen.getByText("dialogue / dialogue.dead_end")).toBeInTheDocument();
    expect(screen.getAllByText(/dialogue branch has no continuation/i)).toHaveLength(3);
  });

  it("selects on one click and focuses the primary owner only on double click", () => {
    const onNavigate = vi.fn();
    render(<CanonWorkspace {...props({ onNavigate })} />);
    const issueRow = screen.getByRole("option", { name: /semantic ownership disagrees/i });

    fireEvent.click(issueRow);
    expect(onNavigate).not.toHaveBeenCalled();

    fireEvent.doubleClick(issueRow);
    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ owner_id: "ledger" }), "source");
  });

  it("dispatches review and suggestion actions for the selected issue", () => {
    const onReview = vi.fn();
    const onRepair = vi.fn();
    const onNavigate = vi.fn();
    render(<CanonWorkspace {...props({ onNavigate, onReview, onRepair })} />);

    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    fireEvent.click(screen.getByRole("button", { name: "Request suggestion" }));
    fireEvent.click(screen.getByRole("button", { name: "Open source" }));
    fireEvent.click(screen.getByRole("button", { name: "Graph" }));

    expect(onReview).toHaveBeenCalledWith("critical", "review");
    expect(onRepair).toHaveBeenCalledWith("critical");
    expect(onNavigate).toHaveBeenNthCalledWith(1, expect.objectContaining({ owner_id: "locked-door" }), "source");
    expect(onNavigate).toHaveBeenNthCalledWith(2, expect.objectContaining({ owner_id: "locked-door" }), "graph");
  });

  it("renders only the server-owned repair action for every capability state", () => {
    const onNavigate = vi.fn();
    const deterministic = issue("fix", "warning", "open", "condition.unresolved-path", "fix-node");
    const agent = issue("agent", "warning", "open", "ownership.custody-disagreement", "agent-node");
    agent.repair = {
      capability_version: 1,
      kind: "agent_review",
      action: "explore_solutions",
      available: true,
      unavailable_reason: null,
      source_checksum: CHECKSUM
    };
    const navigation = issue("navigate", "info", "open", "integrity.error-fact", "source-node");
    navigation.repair = {
      capability_version: 1,
      kind: "navigate_only",
      action: "open_source",
      available: true,
      unavailable_reason: null,
      source_checksum: CHECKSUM
    };
    const none = issue("none", "info", "resolved", "integrity.error-fact", "missing-node");
    none.repair = {
      capability_version: 1,
      kind: "none",
      action: "none",
      available: false,
      unavailable_reason: "canon.repair.unavailable.owner_missing",
      source_checksum: CHECKSUM
    };
    const capabilities = {
      project_id: "project",
      issues: [deterministic, agent, navigation, none],
      active_count: 3,
      severity: { critical: 0, warning: 2, info: 1 }
    };
    const { rerender } = render(<CanonWorkspace {...props({ issues: capabilities, onNavigate })} />);

    expect(screen.getByRole("button", { name: "Request suggestion" })).toBeEnabled();
    fireEvent.click(screen.getByRole("option", { name: /semantic ownership disagrees/i }));
    const explore = screen.getByRole("button", { name: "Explore solutions" });
    expect(explore).toBeEnabled();
    fireEvent.click(screen.getByRole("option", { name: /domain integrity check/i }));
    fireEvent.click(within(screen.getByLabelText("Review actions")).getByRole("button", { name: "Open source" }));
    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ owner_id: "source-node" }), "source");

    rerender(<CanonWorkspace {...props({
      canNavigate: () => false,
      issues: { ...capabilities, issues: [none], active_count: 0, severity: { critical: 0, warning: 0, info: 0 } },
      onNavigate
    })} />);
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "all" } });
    expect(screen.queryByRole("button", { name: "Request suggestion" })).not.toBeInTheDocument();
    expect(screen.getByText(/referenced source no longer exists/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open source" })).toBeDisabled();
    expect(document.querySelector('[data-canon-evidence-owner="missing-node"]')).toHaveAttribute("tabindex", "-1");
  });

  it("previews affected records before approving or rejecting a Canon fix", () => {
    const onSuggestionDecision = vi.fn();
    render(<CanonWorkspace {...props({ onSuggestionDecision, suggestion: FIX_SUGGESTION })} />);

    const preview = screen.getByLabelText("Proposed forward changes");
    expect(preview).toHaveTextContent("Why this should change");
    expect(preview).toHaveTextContent("The route condition references state");
    expect(preview).toHaveTextContent("How it will be fixed");
    expect(preview).toHaveTextContent("authored ledger acquisition flag");
    expect(preview).toHaveTextContent("flow_transitions");
    expect(preview).toHaveTextContent("locked-door");
    const actionButtons = within(preview).getAllByRole("button");
    expect(actionButtons).toHaveLength(3);
    expect(actionButtons.every((button) => button.classList.contains("canon-suggestion-action"))).toBe(true);
    expect(screen.queryByText("flags.route_open == true")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Technical changes (JSON)"));
    fireEvent.click(screen.getByText("flow_transitions"));
    expect(preview).toHaveTextContent("flags.route_open == true");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    expect(onSuggestionDecision).toHaveBeenNthCalledWith(1, "approved");
    expect(onSuggestionDecision).toHaveBeenNthCalledWith(2, "rejected");
  });

  it("opens Impact Analysis for the exact Canon patch and blocks stale approval", () => {
    const onAnalyzeSuggestion = vi.fn();
    const onSuggestionDecision = vi.fn();
    render(<CanonWorkspace {...props({
      onAnalyzeSuggestion,
      onSuggestionDecision,
      suggestion: FIX_SUGGESTION,
      suggestionBlocked: true
    })} />);

    fireEvent.click(screen.getByRole("button", { name: "Analyze impact" }));
    expect(onAnalyzeSuggestion).toHaveBeenCalledWith(expect.any(HTMLButtonElement));
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Approve" })).toHaveAttribute("title", expect.stringMatching(/stale/i));
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(onSuggestionDecision).toHaveBeenCalledWith("rejected");
  });

  it("requires fresh consent for every configured-provider run", () => {
    const onRun = vi.fn();
    render(<CanonWorkspace {...props({ mode: "configured_agent", providerConfigured: true, onRun })} />);
    const run = screen.getByRole("button", { name: "Run" });

    expect(run).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/I confirm this run/i));
    expect(run).toBeEnabled();
    fireEvent.click(run);

    expect(onRun).toHaveBeenCalledWith(true);
    expect(run).toBeDisabled();
  });

  it("shows validated agent prose separately from deterministic evidence", () => {
    const enriched = {
      ...ISSUES,
      issues: ISSUES.issues.map((item, index) => index === 0 ? {
        ...item,
        metadata: {
          ...item.metadata,
          agent_explanation: "The provider found a continuity mismatch.",
          agent_recommendation: "Review the route condition."
        }
      } : item)
    };

    render(<CanonWorkspace {...props({ issues: enriched })} />);

    expect(screen.getByText("Agent explanation")).toBeInTheDocument();
    expect(screen.getByText("The provider found a continuity mismatch.")).toBeInTheDocument();
    expect(screen.getByText("Review the route condition.")).toBeInTheDocument();
  });

  it("keeps loading, running, cancelling, stale, failed, and empty states inside the stable workspace", () => {
    const { rerender } = render(<CanonWorkspace {...props({ issues: null, operation: "loading", run: null })} />);
    expect(screen.getByText("Loading canon issues")).toBeInTheDocument();

    rerender(<CanonWorkspace {...props({ operation: "running", run: { ...RUN, status: "running", completed_at: null } })} />);
    expect(screen.getAllByText("Running")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Running" })).toBeDisabled();

    rerender(<CanonWorkspace {...props({ operation: "cancelling", run: { ...RUN, status: "running", completed_at: null } })} />);
    expect(screen.getByText("Cancelling")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    rerender(<CanonWorkspace {...props({ run: { ...RUN, status: "stale", completed_at: NOW } })} />);
    expect(screen.getByText("Stale")).toBeInTheDocument();

    rerender(<CanonWorkspace {...props({ issues: { ...ISSUES, issues: [], active_count: 0 }, run: { ...RUN, status: "completed" } })} />);
    expect(screen.getByText(/No contradictions found/i)).toBeInTheDocument();

    rerender(<CanonWorkspace {...props({ error: "Run failed", run: { ...RUN, status: "failed", diagnostics: [] } })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Run failed");
  });
});

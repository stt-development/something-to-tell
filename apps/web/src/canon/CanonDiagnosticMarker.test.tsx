import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CanonIssueProjection } from "@something-to-tell/contracts/canon-check";
import { applyProjectLocale } from "../localization/i18n";
import { CanonDiagnosticMarker, canonFocusMatches } from "./CanonDiagnosticMarker";

const owner = { owner_type: "quest_branch", owner_id: "branch", context_type: "quest_stage", context_id: "stage" };
const issue = {
  id: "issue",
  project_id: "project",
  title: "Fallback problem",
  description: "Fallback repair",
  severity: "warning",
  status: "open",
  repair: { capability_version: 1, kind: "agent_review", action: "explore_solutions", available: false, unavailable_reason: "canon.repair.unavailable.agent_bridge_pending", source_checksum: "a".repeat(64) },
  metadata: {
    issue_version: 1,
    origin: "canon_rule",
    rule_id: "outcome.specialized-ownership",
    rule_version: 1,
    fingerprint: "b".repeat(64),
    category: "quest",
    scope: owner,
    message_key: "canon.issue.outcome.specialized-ownership.message",
    message_parameters: {},
    recommendation_key: "canon.issue.outcome.specialized-ownership.recommendation",
    recommendation_parameters: {},
    targets: [owner],
    evidence: [],
    agent_explanation: null,
    agent_recommendation: null,
    saved_revision: 1,
    source_checksum: "a".repeat(64),
    first_seen_at: "2026-09-02T10:00:00Z",
    last_seen_at: "2026-09-02T10:00:00Z",
    resolved_at: null,
    resolution_reason: null
  }
} satisfies CanonIssueProjection;

describe("CanonDiagnosticMarker", () => {
  it("matches only the exact nested owner and exposes localized detail", async () => {
    await applyProjectLocale("ru");
    const focus = { issue, owner };
    render(<CanonDiagnosticMarker focus={focus} />);

    expect(canonFocusMatches(focus, "branch")).toBe(true);
    expect(canonFocusMatches(focus, "stage")).toBe(false);
    expect(screen.getByRole("status")).toHaveAttribute("aria-label", expect.stringContaining("специализированный результат"));
    expect(screen.getByRole("status")).toHaveAttribute("tabindex", "0");
    await applyProjectLocale("en");
  });
});

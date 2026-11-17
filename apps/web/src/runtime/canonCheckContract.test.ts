import {
  CANON_CANDIDATE_VERSION,
  CANON_FACT_VERSION,
  CANON_FIX_SUGGESTION_VERSION,
  CANON_ISSUE_VERSION,
  CANON_REPAIR_CAPABILITY_VERSION,
  CANON_RULE_DESCRIPTOR_VERSION,
  CANON_RUN_VERSION,
  orderCanonOwnerRefs,
  type CanonCheckRun,
  type CanonCheckInput,
  type CanonIssueCandidate,
  type CanonIssueMetadataV1,
  type CanonRunStart
} from "@something-to-tell/contracts/canon-check";
import { describe, expect, it } from "vitest";

describe("shared canon-check contract", () => {
  it("mirrors all runtime-owned Phase 4 contract versions", () => {
    expect({
      run: CANON_RUN_VERSION,
      fact: CANON_FACT_VERSION,
      rule: CANON_RULE_DESCRIPTOR_VERSION,
      candidate: CANON_CANDIDATE_VERSION,
      issue: CANON_ISSUE_VERSION,
      repair: CANON_REPAIR_CAPABILITY_VERSION
    }).toEqual({ run: 1, fact: 1, rule: 1, candidate: 1, issue: 1, repair: 1 });
    expect(CANON_FIX_SUGGESTION_VERSION).toBe(1);
  });

  it("orders owner references without mutating the API payload", () => {
    const owners = [
      { owner_type: "node", owner_id: "b", context_type: null, context_id: null },
      { owner_type: "flow", owner_id: "main", context_type: null, context_id: null },
      { owner_type: "node", owner_id: "a", context_type: "flow", context_id: "main" }
    ];
    const before = structuredClone(owners);

    const ordered = orderCanonOwnerRefs(owners);

    expect(ordered.map((item) => `${item.owner_type}:${item.owner_id}`)).toEqual([
      "flow:main",
      "node:a",
      "node:b"
    ]);
    expect(owners).toEqual(before);
  });

  it("types run, candidate, and generated Issue envelopes", () => {
    const owner = { owner_type: "node", owner_id: "event", context_type: null, context_id: null };
    const evidence = {
      owner,
      field_path: "condition",
      message_key: "canon.evidence.condition",
      message_parameters: {},
      excerpt: "flags.route_open"
    };
    const candidate = {
      candidate_version: CANON_CANDIDATE_VERSION,
      rule_id: "flow.unresolved-condition",
      rule_version: 1,
      category: "continuity",
      severity: "warning",
      scope: { ...owner, owner_type: "flow", owner_id: "main" },
      message_key: "canon.rule.unresolvedCondition",
      message_parameters: {},
      recommendation_key: null,
      recommendation_parameters: {},
      targets: [owner],
      evidence: [evidence],
      fingerprint: "a".repeat(64),
      agent_explanation: null,
      agent_recommendation: null
    } satisfies CanonIssueCandidate;
    const metadata = {
      issue_version: CANON_ISSUE_VERSION,
      origin: "canon_rule",
      rule_id: candidate.rule_id,
      rule_version: candidate.rule_version,
      fingerprint: candidate.fingerprint,
      category: candidate.category,
      scope: candidate.scope,
      message_key: candidate.message_key,
      message_parameters: candidate.message_parameters,
      recommendation_key: candidate.recommendation_key,
      recommendation_parameters: candidate.recommendation_parameters,
      targets: candidate.targets,
      evidence: candidate.evidence,
      agent_explanation: null,
      agent_recommendation: null,
      saved_revision: 4,
      source_checksum: "b".repeat(64),
      first_seen_at: "2026-08-20T10:00:00Z",
      last_seen_at: "2026-08-20T10:00:00Z",
      resolved_at: null,
      resolution_reason: null
    } satisfies CanonIssueMetadataV1;
    const run = {
      run_version: CANON_RUN_VERSION,
      id: "run-1",
      project_id: "project",
      saved_revision: 4,
      source_checksum: "b".repeat(64),
      rule_pack_version: 1,
      mode: "deterministic",
      scope: [],
      status: "completed",
      started_at: "2026-08-20T10:00:00Z",
      completed_at: "2026-08-20T10:00:01Z",
      summary: {
        fact_count: 1,
        candidate_count: 1,
        opened_count: 1,
        retained_count: 0,
        resolved_count: 0,
        severity: { info: 0, warning: 1, critical: 0 }
      },
      diagnostics: []
    } satisfies CanonCheckRun;

    expect(metadata.fingerprint).toBe(candidate.fingerprint);
    expect(run.summary.severity.warning).toBe(1);

    const start = {
      session_id: "session",
      observed_saved_revision: 4,
      expected_history_revision: 0,
      mode: "deterministic",
      remote_consent: false,
      scope: [owner],
      enabled_rule_overrides: {},
      severity_overrides: {}
    } satisfies CanonRunStart;
    expect(start.scope).toEqual([owner]);
  });

  it("types one complete saved-revision input without transient editor state", () => {
    const input = {
      input_version: 1,
      project_id: "project",
      saved_revision: 4,
      source_checksum: "a".repeat(64),
      rule_pack_version: 1,
      document: { document_version: 3 },
      facts: []
    } satisfies CanonCheckInput<{ document_version: 3 }>;

    expect(input.document.document_version).toBe(3);
    expect(Object.keys(input)).not.toContain("selection");
    expect(Object.keys(input)).not.toContain("playback_session");
  });
});

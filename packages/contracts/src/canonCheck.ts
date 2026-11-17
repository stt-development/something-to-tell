import type { ProjectHistorySummary } from "./projectHistory";
import type { ProjectPatch } from "./projectPatch";
import type { ProjectSessionResponse } from "./projectSession";

/**
 * Shared TypeScript mirror of the runtime-owned Phase 4 models in
 * services/runtime/stt_runtime/schemas/canon_check.py.
 *
 * The runtime remains the sole fingerprint authority. Browser code receives
 * the stable digest and must not derive a competing identity implementation.
 */

export const CANON_RUN_VERSION = 1 as const;
export const CANON_FACT_VERSION = 1 as const;
export const CANON_RULE_DESCRIPTOR_VERSION = 1 as const;
export const CANON_CANDIDATE_VERSION = 1 as const;
export const CANON_ISSUE_VERSION = 1 as const;
export const CANON_DIAGNOSTIC_VERSION = 1 as const;
export const CANON_REPAIR_CAPABILITY_VERSION = 1 as const;
export const CANON_FIX_SUGGESTION_VERSION = 1 as const;

export type CanonDomain =
  | "graph"
  | "composition"
  | "flow"
  | "dialogue"
  | "quest"
  | "temporal"
  | "playback";
export type CanonFactLevel = "info" | "warning" | "error";
export type CanonIssueSeverity = "info" | "warning" | "critical";
export type CanonIssueStatus = "open" | "review" | "ignored" | "resolved";
export type CanonIssueOrigin = "canon_rule" | "canon_agent";
export type CanonIssueResolutionReason = "candidate_absent" | "rule_disabled";
export type CanonRunMode = "deterministic" | "configured_agent";
export type CanonRunStatus =
  | "queued"
  | "running"
  | "reconciling"
  | "completed"
  | "failed"
  | "cancelled"
  | "stale";

export interface CanonOwnerRef {
  owner_type: string;
  owner_id: string;
  context_type: string | null;
  context_id: string | null;
}

export interface CanonEvidenceRef {
  owner: CanonOwnerRef;
  field_path: string | null;
  message_key: string;
  message_parameters: Record<string, unknown>;
  excerpt: string | null;
}

export interface CanonFact {
  fact_version: typeof CANON_FACT_VERSION;
  code: string;
  domain: CanonDomain;
  level: CanonFactLevel;
  scope: CanonOwnerRef;
  owners: CanonOwnerRef[];
  evidence: CanonEvidenceRef[];
  parameters: Record<string, unknown>;
  source_revision: number;
}

export type CanonDiagnosticParameter = string | number | boolean;

/** Runtime-redacted domain fact identity; arbitrary exception payloads are forbidden. */
export interface CanonDiagnosticV1 {
  diagnostic_version: typeof CANON_DIAGNOSTIC_VERSION;
  fact_code: string;
  domain: CanonDomain;
  parameters: Record<string, CanonDiagnosticParameter>;
  identity_parameters: Record<string, CanonDiagnosticParameter>;
  targets: CanonOwnerRef[];
  evidence: CanonEvidenceRef[];
}

export interface CanonRuleDescriptor {
  descriptor_version: typeof CANON_RULE_DESCRIPTOR_VERSION;
  id: string;
  version: number;
  category: string;
  default_severity: CanonIssueSeverity;
  input_domains: CanonDomain[];
  supported_severity_overrides: CanonIssueSeverity[];
}

export interface ResolvedCanonRule {
  descriptor: CanonRuleDescriptor;
  severity: CanonIssueSeverity;
}

export interface CanonIssueCandidate {
  candidate_version: typeof CANON_CANDIDATE_VERSION;
  rule_id: string;
  rule_version: number;
  category: string;
  severity: CanonIssueSeverity;
  scope: CanonOwnerRef;
  message_key: string;
  message_parameters: Record<string, unknown>;
  recommendation_key: string | null;
  recommendation_parameters: Record<string, unknown>;
  targets: CanonOwnerRef[];
  evidence: CanonEvidenceRef[];
  fingerprint: string;
  diagnostic?: CanonDiagnosticV1 | null;
  agent_explanation: string | null;
  agent_recommendation: string | null;
}

export interface CanonIssueMetadataV1 {
  issue_version: typeof CANON_ISSUE_VERSION;
  origin: CanonIssueOrigin;
  rule_id: string;
  rule_version: number;
  fingerprint: string;
  category: string;
  scope?: CanonOwnerRef | null;
  message_key: string;
  message_parameters: Record<string, unknown>;
  recommendation_key: string | null;
  recommendation_parameters: Record<string, unknown>;
  targets: CanonOwnerRef[];
  evidence: CanonEvidenceRef[];
  agent_explanation: string | null;
  agent_recommendation: string | null;
  saved_revision: number;
  source_checksum: string;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  resolution_reason: CanonIssueResolutionReason | null;
}

/** V2 preserves the normalized domain fact independently of localized prose. */
export interface CanonIssueMetadataV2 extends Omit<CanonIssueMetadataV1, "issue_version"> {
  issue_version: 2;
  diagnostic: CanonDiagnosticV1;
}

export type CanonIssueMetadata = CanonIssueMetadataV1 | CanonIssueMetadataV2;

export interface CanonIssueProjection {
  id: string;
  project_id: string;
  title: string;
  description: string;
  severity: CanonIssueSeverity;
  status: CanonIssueStatus;
  metadata: CanonIssueMetadata;
  repair: CanonRepairCapability;
}

export type CanonRepairKind = "deterministic_patch" | "agent_review" | "navigate_only" | "none";
export type CanonRepairAction = "request_fix" | "explore_solutions" | "open_source" | "none";

/** Runtime-owned action state bound to the exact active project checksum. */
export interface CanonRepairCapability {
  capability_version: typeof CANON_REPAIR_CAPABILITY_VERSION;
  kind: CanonRepairKind;
  action: CanonRepairAction;
  available: boolean;
  unavailable_reason: string | null;
  source_checksum: string;
}

export interface CanonIssueCounts {
  info: number;
  warning: number;
  critical: number;
}

export interface CanonRunSummary {
  fact_count: number;
  candidate_count: number;
  opened_count: number;
  retained_count: number;
  resolved_count: number;
  severity: CanonIssueCounts;
}

export interface CanonRunDiagnostic {
  code: string;
  message_key: string;
  parameters: Record<string, unknown>;
}

export interface CanonCheckRun {
  run_version: typeof CANON_RUN_VERSION;
  id: string;
  project_id: string;
  saved_revision: number;
  source_checksum: string;
  rule_pack_version: number;
  mode: CanonRunMode;
  scope: CanonOwnerRef[];
  status: CanonRunStatus;
  started_at: string;
  completed_at: string | null;
  summary: CanonRunSummary;
  diagnostics: CanonRunDiagnostic[];
}

export interface CanonRunStart {
  session_id: string;
  observed_saved_revision: number;
  expected_history_revision: number;
  mode: CanonRunMode;
  remote_consent: boolean;
  scope: CanonOwnerRef[];
  enabled_rule_overrides: Record<string, boolean>;
  severity_overrides: Record<string, CanonIssueSeverity>;
}

export interface CanonIssueListResponse {
  project_id: string;
  issues: CanonIssueProjection[];
  active_count: number;
  severity: CanonIssueCounts;
}

export interface CanonIssueStatusChange {
  session_id: string;
  expected_history_revision: number;
  status: "open" | "review" | "ignored";
}

export interface CanonIssueSuggestionRequest {
  session_id: string;
  source_checksum: string;
}

/** Snapshot tokens for the runtime-owned Canon-to-Impact bridge. */
export interface CanonIssueImpactRequest {
  session_id: string;
  expected_history_revision: number;
  source_checksum: string;
}

export interface CanonIssueSuggestionResponse {
  issue_id: string;
  status: "unavailable" | "created";
  suggestion_id: string | null;
  message_key: string;
  suggestion: CanonFixSuggestion | null;
}

export interface CanonFixSuggestion {
  suggestion_version: typeof CANON_FIX_SUGGESTION_VERSION;
  id: string;
  issue_id: string;
  project_id: string;
  status: "pending" | "approved" | "rejected";
  why: string | null;
  how: string | null;
  patch: ProjectPatch;
}

export interface CanonFixSuggestionDecision {
  session_id: string;
  expected_history_revision: number;
}

export interface CanonFixSuggestionDecisionResponse<TDialogueDocument, TQuestDocument> {
  suggestion: CanonFixSuggestion;
  project: ProjectSessionResponse<TDialogueDocument, TQuestDocument>;
  history: ProjectHistorySummary;
}

export interface CanonCheckInput<ProjectDocumentT = unknown> {
  remote_storage?: import("./remoteStorage").RemoteStorageHeadV1;
  input_version: 1;
  project_id: string;
  saved_revision: number;
  source_checksum: string;
  rule_pack_version: number;
  document: ProjectDocumentT;
  facts: CanonFact[];
}

/** Returns a stable display/navigation order without mutating API payloads. */
export function orderCanonOwnerRefs(owners: readonly CanonOwnerRef[]): CanonOwnerRef[] {
  const key = (owner: CanonOwnerRef) => [
    owner.owner_type,
    owner.owner_id,
    owner.context_type ?? "",
    owner.context_id ?? ""
  ].join("\u0000");
  return [...owners].sort((left, right) => key(left).localeCompare(key(right)));
}

import type { CanonEvidenceRef, CanonOwnerRef } from "./canonCheck";
import type { ImpactFinding, ImpactSummary } from "./impactAnalysis";
import type { ProjectPatch } from "./projectPatch";
import type { ApprovedAgentMemoryV1 } from "./agentMemory";

/**
 * Shared TypeScript mirror of the runtime-owned Phase 5.5 schemas in
 * services/runtime/stt_runtime/schemas/impact_resolution.py.
 *
 * Python owns validation and every fingerprint. Browser code may only present
 * already-validated alternatives and visual changes.
 */

export const IMPACT_RESOLUTION_LIMITS_VERSION = 1 as const;
export const IMPACT_RESOLUTION_REQUEST_VERSION = 1 as const;
export const IMPACT_RESOLUTION_CONTEXT_VERSION = 1 as const;
export const IMPACT_RESOLUTION_EXPLANATION_VERSION = 1 as const;
export const IMPACT_RESOLUTION_ALTERNATIVE_VERSION = 1 as const;
export const IMPACT_RESOLUTION_VALIDATION_VERSION = 1 as const;
export const IMPACT_RESOLUTION_COMPARISON_VERSION = 1 as const;
export const IMPACT_RESOLUTION_DIAGNOSTIC_VERSION = 1 as const;
export const IMPACT_RESOLUTION_RUN_VERSION = 1 as const;
export const IMPACT_RESOLUTION_RESPONSE_VERSION = 1 as const;
export const IMPACT_RESOLUTION_VISUAL_CHANGE_VERSION = 1 as const;
export const IMPACT_RESOLUTION_VISUAL_PROJECTION_VERSION = 1 as const;
export const IMPACT_RESOLUTION_DECISION_VERSION = 1 as const;
export const IMPACT_RESOLUTION_REVIEW_COMMAND_VERSION = 1 as const;
export const IMPACT_RESOLUTION_DRAFT_EDIT_VERSION = 1 as const;

export const IMPACT_RESOLUTION_DEFAULT_ALTERNATIVES = 3 as const;
export const IMPACT_RESOLUTION_MAX_ALTERNATIVES = 3 as const;
export const IMPACT_RESOLUTION_MAX_FINDINGS = 50 as const;
export const IMPACT_RESOLUTION_MAX_CONTEXT_RESOURCES = 200 as const;
export const IMPACT_RESOLUTION_MAX_CONTEXT_CHARACTERS = 120_000 as const;
export const IMPACT_RESOLUTION_MAX_PATCH_OPERATIONS = 200 as const;
export const IMPACT_RESOLUTION_MAX_VISUAL_CHANGES = 500 as const;

export type ImpactResolutionProviderSource = "project_default" | "override";
export type ImpactResolutionRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "stale";
export type ImpactSolutionValidationStatus =
  | "pending"
  | "valid"
  | "invalid"
  | "explanation_only";
export type ImpactResolutionDiagnosticSeverity = "info" | "warning" | "error";
export type ImpactResolutionDecisionValue = "approved" | "rejected";
export type ImpactVisualChangeKind = "add" | "remove" | "modify" | "move" | "unchanged";
export type ImpactVisualSurface =
  | "graph"
  | "composition"
  | "flow"
  | "story"
  | "dialogue"
  | "quest"
  | "temporal"
  | "canon";
export type ImpactVisualMode = "before" | "after" | "changes";
export type ImpactResolutionErrorCode =
  | "impact_resolution_limit_invalid"
  | "impact_resolution_consent_required"
  | "impact_resolution_provider_invalid"
  | "impact_resolution_provider_unavailable"
  | "impact_resolution_provider_timeout"
  | "impact_resolution_model_incompatible"
  | "impact_resolution_run_not_found"
  | "impact_resolution_run_capacity_reached"
  | "impact_resolution_owner_invalid"
  | "impact_resolution_finding_invalid"
  | "impact_resolution_patch_invalid"
  | "impact_resolution_patch_stale"
  | "impact_resolution_operation_unsupported"
  | "impact_resolution_response_invalid"
  | "impact_resolution_visual_diff_invalid"
  | "impact_resolution_run_stale"
  | "impact_resolution_run_cancelled"
  | "impact_resolution_run_failed";

export interface ImpactResolutionLimits {
  limits_version: typeof IMPACT_RESOLUTION_LIMITS_VERSION;
  max_findings: number;
  max_context_resources: number;
  max_context_characters: number;
  max_patch_operations: number;
  max_visual_changes: number;
}

export interface ImpactResolutionRequest {
  request_version: typeof IMPACT_RESOLUTION_REQUEST_VERSION;
  impact_run_id: string;
  finding_ids: string[];
  source_checksum: string;
  provider_source: ImpactResolutionProviderSource;
  provider_profile_id: string | null;
  model_id: string;
  content_consent: true;
  requested_alternative_count: number;
  include_rejected?: boolean;
  limits: ImpactResolutionLimits;
}

export interface ImpactResolutionContextResource {
  resource: CanonOwnerRef;
  domain: "graph" | "composition" | "flow" | "dialogue" | "quest" | "temporal" | "playback" | "canon";
  title: string | null;
  authored_fields: Record<string, unknown>;
  evidence: CanonEvidenceRef[];
}

export interface ImpactResolutionGlossaryEntry {
  resource: CanonOwnerRef;
  label: string;
  kind: string;
}

/** This provider payload deliberately cannot contain a complete ProjectDocument. */
export interface ImpactResolutionContextPackage {
  context_version: typeof IMPACT_RESOLUTION_CONTEXT_VERSION;
  project_id: string;
  saved_revision: number;
  history_revision: number;
  source_checksum: string;
  approved_memory: ApprovedAgentMemoryV1;
  request: ImpactResolutionRequest;
  findings: ImpactFinding[];
  resources: ImpactResolutionContextResource[];
  glossary: ImpactResolutionGlossaryEntry[];
  omitted_resource_count: number;
  omitted_domains: string[];
}

export interface ImpactResolutionExplanation {
  explanation_version: typeof IMPACT_RESOLUTION_EXPLANATION_VERSION;
  summary: string;
  why_it_matters: string[];
  assumptions: string[];
  limitations: string[];
  cited_evidence: CanonEvidenceRef[];
}

export interface ImpactResolutionDiagnostic {
  diagnostic_version: typeof IMPACT_RESOLUTION_DIAGNOSTIC_VERSION;
  code: ImpactResolutionErrorCode;
  severity: ImpactResolutionDiagnosticSeverity;
  message_key: string;
  parameters: Record<string, unknown>;
}

export interface ImpactResolutionDeltaCounts {
  added: number;
  removed: number;
  changed: number;
}

export interface ImpactResolutionComparison {
  comparison_version: typeof IMPACT_RESOLUTION_COMPARISON_VERSION;
  source_checksum: string;
  target_checksum: string;
  impact_before: ImpactSummary;
  impact_after: ImpactSummary;
  dependencies: ImpactResolutionDeltaCounts;
  reachability: ImpactResolutionDeltaCounts;
  state_paths: ImpactResolutionDeltaCounts;
  canon_facts: ImpactResolutionDeltaCounts;
  affected_issue_count: number;
}

export interface ImpactSolutionValidation {
  validation_version: typeof IMPACT_RESOLUTION_VALIDATION_VERSION;
  status: ImpactSolutionValidationStatus;
  diagnostics: ImpactResolutionDiagnostic[];
}

export interface ImpactSolutionAlternative {
  alternative_version: typeof IMPACT_RESOLUTION_ALTERNATIVE_VERSION;
  id: string;
  finding_ids: string[];
  semantic_fingerprint: string | null;
  title: string;
  rationale: string;
  tradeoffs: string[];
  expected_outcomes: string[];
  patch: ProjectPatch | null;
  validation: ImpactSolutionValidation;
  comparison: ImpactResolutionComparison | null;
}

export interface ImpactPreviewPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
  preview_only: boolean;
}

export interface ImpactVisualFieldChange {
  path: string;
  before: unknown;
  after: unknown;
}

export interface ImpactVisualChange {
  visual_change_version: typeof IMPACT_RESOLUTION_VISUAL_CHANGE_VERSION;
  id: string;
  kind: ImpactVisualChangeKind;
  surface: ImpactVisualSurface;
  before_resource: CanonOwnerRef | null;
  after_resource: CanonOwnerRef | null;
  field_changes: ImpactVisualFieldChange[];
  before_placement: ImpactPreviewPlacement | null;
  after_placement: ImpactPreviewPlacement | null;
}

export interface ImpactVisualDiffProjection {
  projection_version: typeof IMPACT_RESOLUTION_VISUAL_PROJECTION_VERSION;
  alternative_fingerprint: string;
  source_checksum: string;
  target_checksum: string;
  changes: ImpactVisualChange[];
}

export interface ImpactResolutionDecision {
  decision_version: typeof IMPACT_RESOLUTION_DECISION_VERSION;
  finding_fingerprints: string[];
  proposal_semantic_fingerprint: string;
  source_checksum: string;
  decision: ImpactResolutionDecisionValue;
  decided_at: string;
}

export interface ImpactResolutionReviewCommand {
  command_version: typeof IMPACT_RESOLUTION_REVIEW_COMMAND_VERSION;
  alternative_id: string;
  proposal_semantic_fingerprint: string;
  source_checksum: string;
  expected_history_revision: number;
}

export interface ImpactResolutionDraftEdit {
  edit_version: typeof IMPACT_RESOLUTION_DRAFT_EDIT_VERSION;
  alternative_id: string;
  patch: ProjectPatch;
}

export interface ImpactResolutionDecisionResponse {
  response_version: typeof IMPACT_RESOLUTION_RESPONSE_VERSION;
  decision: ImpactResolutionDecision;
  run: ImpactResolutionRun;
}

export interface ImpactResolutionRun {
  run_version: typeof IMPACT_RESOLUTION_RUN_VERSION;
  id: string;
  project_id: string;
  saved_revision: number;
  history_revision: number;
  source_checksum: string;
  request: ImpactResolutionRequest;
  status: ImpactResolutionRunStatus;
  explanation: ImpactResolutionExplanation | null;
  alternatives: ImpactSolutionAlternative[];
  visual_projections: ImpactVisualDiffProjection[];
  diagnostics: ImpactResolutionDiagnostic[];
  started_at: string;
  completed_at: string | null;
}

export interface ImpactResolutionResponse {
  response_version: typeof IMPACT_RESOLUTION_RESPONSE_VERSION;
  run: ImpactResolutionRun;
}

const visualKindOrder: Record<ImpactVisualChangeKind, number> = {
  add: 0,
  remove: 1,
  modify: 2,
  move: 3,
  unchanged: 4
};

const ownerKey = (owner: CanonOwnerRef | null): string => owner
  ? [owner.owner_type, owner.owner_id, owner.context_type ?? "", owner.context_id ?? ""].join("\u0000")
  : "";

/** Orders validated visual changes without mutating a runtime response. */
export function orderImpactVisualChanges(
  changes: readonly ImpactVisualChange[]
): ImpactVisualChange[] {
  return [...changes].sort((left, right) => {
    const kind = visualKindOrder[left.kind] - visualKindOrder[right.kind];
    if (kind !== 0) return kind;
    const surface = left.surface.localeCompare(right.surface);
    if (surface !== 0) return surface;
    const before = ownerKey(left.before_resource).localeCompare(ownerKey(right.before_resource));
    if (before !== 0) return before;
    const after = ownerKey(left.after_resource).localeCompare(ownerKey(right.after_resource));
    return after !== 0 ? after : left.id.localeCompare(right.id);
  });
}

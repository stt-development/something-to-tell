import type { CanonEvidenceRef, CanonOwnerRef } from "./canonCheck";
import type { ProjectPatch } from "./projectPatch";

/**
 * Shared TypeScript mirror of the runtime-owned Phase 5 schemas in
 * services/runtime/stt_runtime/schemas/impact_analysis.py.
 *
 * Python owns validation and finding fingerprints. Browser code may order
 * already-validated findings for presentation but must not derive identities.
 */

export const IMPACT_DEPENDENCY_VERSION = 1 as const;
export const IMPACT_SEED_VERSION = 1 as const;
export const IMPACT_SCENARIO_VERSION = 1 as const;
export const IMPACT_PATH_VERSION = 1 as const;
export const IMPACT_FINDING_VERSION = 1 as const;
export const IMPACT_SUMMARY_VERSION = 1 as const;
export const IMPACT_DIAGNOSTIC_VERSION = 1 as const;
export const IMPACT_LIMITS_VERSION = 1 as const;
export const IMPACT_REQUEST_VERSION = 1 as const;
export const IMPACT_RUN_VERSION = 1 as const;
export const IMPACT_RESPONSE_VERSION = 1 as const;
export const IMPACT_INPUT_VERSION = 1 as const;

export const IMPACT_DEFAULT_DEPTH = 3 as const;
export const IMPACT_MAX_DEPTH = 10 as const;
export const IMPACT_DEFAULT_PATHS_PER_TARGET = 3 as const;
export const IMPACT_MAX_PATHS_PER_TARGET = 3 as const;
export const IMPACT_DEFAULT_TARGETS = 500 as const;
export const IMPACT_MAX_TARGETS = 500 as const;

export const IMPACT_DOMAINS = [
  "graph",
  "composition",
  "flow",
  "dialogue",
  "quest",
  "temporal",
  "playback",
  "canon"
] as const;

export type ImpactResourceRef = CanonOwnerRef;
export type ImpactEvidenceRef = CanonEvidenceRef;
export type ImpactDomain = (typeof IMPACT_DOMAINS)[number];
export type ImpactRequestDirection = "upstream" | "downstream" | "both";
export type ImpactPathDirection = "upstream" | "downstream";
export type ImpactPropagation = "required" | "conditional" | "contextual";
export type ImpactSelectionIntent = "modify" | "delete";
export type ImpactType =
  | "structural"
  | "execution"
  | "state"
  | "ownership"
  | "reference"
  | "integrity";
export type ImpactRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "stale";
export type ImpactErrorCode =
  | "impact_direction_invalid"
  | "impact_domain_invalid"
  | "impact_propagation_invalid"
  | "impact_depth_invalid"
  | "impact_path_limit_invalid"
  | "impact_target_limit_invalid"
  | "impact_seed_not_found"
  | "impact_patch_invalid"
  | "impact_patch_stale"
  | "impact_run_stale"
  | "impact_run_cancelled"
  | "impact_run_failed"
  | "impact_result_limit_reached";

export interface ImpactSeed {
  seed_version: typeof IMPACT_SEED_VERSION;
  resource: ImpactResourceRef;
}

export interface SelectionImpactScenario {
  scenario_version: typeof IMPACT_SCENARIO_VERSION;
  type: "selection";
  intent: ImpactSelectionIntent;
  seeds: ImpactSeed[];
}

export interface PatchImpactScenario {
  scenario_version: typeof IMPACT_SCENARIO_VERSION;
  type: "patch";
  patch: ProjectPatch;
}

export type ImpactScenario = SelectionImpactScenario | PatchImpactScenario;

export interface ImpactDependency {
  dependency_version: typeof IMPACT_DEPENDENCY_VERSION;
  source: ImpactResourceRef;
  target: ImpactResourceRef;
  domain: ImpactDomain;
  kind: string;
  propagation: ImpactPropagation;
  message_key: string;
  message_parameters: Record<string, unknown>;
  evidence: ImpactEvidenceRef[];
}

export interface ImpactPath {
  path_version: typeof IMPACT_PATH_VERSION;
  direction: ImpactPathDirection;
  propagation: ImpactPropagation;
  resources: ImpactResourceRef[];
  dependencies: ImpactDependency[];
}

export interface ImpactFinding {
  finding_version: typeof IMPACT_FINDING_VERSION;
  id: string;
  seeds: ImpactSeed[];
  target: ImpactResourceRef;
  domain: ImpactDomain;
  direction: ImpactPathDirection;
  impact_type: ImpactType;
  propagation: ImpactPropagation;
  distance: number;
  message_key: string;
  message_parameters: Record<string, unknown>;
  paths: ImpactPath[];
}

export interface ImpactCounts {
  required: number;
  conditional: number;
  contextual: number;
}

export interface ImpactSummary {
  summary_version: typeof IMPACT_SUMMARY_VERSION;
  finding_count: number;
  direct_count: number;
  transitive_count: number;
  propagation: ImpactCounts;
  truncated: boolean;
  omitted_count: number;
}

export interface ImpactDiagnostic {
  diagnostic_version: typeof IMPACT_DIAGNOSTIC_VERSION;
  code: ImpactErrorCode;
  message_key: string;
  parameters: Record<string, unknown>;
}

export interface ImpactAnalysisLimits {
  limits_version: typeof IMPACT_LIMITS_VERSION;
  max_depth: number;
  max_paths_per_target: number;
  max_targets: number;
}

export interface ImpactAnalysisRequest {
  request_version: typeof IMPACT_REQUEST_VERSION;
  observed_saved_revision: number;
  expected_history_revision: number;
  source_checksum: string;
  scenario: ImpactScenario;
  direction: ImpactRequestDirection;
  domains: ImpactDomain[];
  limits: ImpactAnalysisLimits;
}

export interface ImpactAnalysisRun {
  run_version: typeof IMPACT_RUN_VERSION;
  id: string;
  project_id: string;
  saved_revision: number;
  history_revision: number;
  source_checksum: string;
  status: ImpactRunStatus;
  request: ImpactAnalysisRequest;
  findings: ImpactFinding[];
  summary: ImpactSummary;
  diagnostics: ImpactDiagnostic[];
  started_at: string;
  completed_at: string | null;
}

export interface ImpactAnalysisResponse {
  response_version: typeof IMPACT_RESPONSE_VERSION;
  run: ImpactAnalysisRun;
}

export interface ImpactAnalysisInput<ProjectDocumentT = unknown> {
  remote_storage?: import("./remoteStorage").RemoteStorageHeadV1;
  input_version: typeof IMPACT_INPUT_VERSION;
  project_id: string;
  saved_revision: number;
  history_revision: number;
  source_checksum: string;
  document: ProjectDocumentT;
  request: ImpactAnalysisRequest;
}

const propagationOrder: Record<ImpactPropagation, number> = {
  required: 0,
  conditional: 1,
  contextual: 2
};

const resourceKey = (resource: ImpactResourceRef): string => [
  resource.owner_type,
  resource.owner_id,
  resource.context_type ?? "",
  resource.context_id ?? ""
].join("\u0000");

/** Orders validated findings without localized messages or mutation. */
export function orderImpactFindings(findings: readonly ImpactFinding[]): ImpactFinding[] {
  return [...findings].sort((left, right) => {
    const distance = left.distance - right.distance;
    if (distance !== 0) return distance;
    const propagation = propagationOrder[left.propagation] - propagationOrder[right.propagation];
    if (propagation !== 0) return propagation;
    const domain = IMPACT_DOMAINS.indexOf(left.domain) - IMPACT_DOMAINS.indexOf(right.domain);
    if (domain !== 0) return domain;
    const target = resourceKey(left.target).localeCompare(resourceKey(right.target));
    if (target !== 0) return target;
    const direction = left.direction.localeCompare(right.direction);
    if (direction !== 0) return direction;
    const type = left.impact_type.localeCompare(right.impact_type);
    return type !== 0 ? type : left.id.localeCompare(right.id);
  });
}

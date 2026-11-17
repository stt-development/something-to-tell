import type { ProjectPatch } from "./projectPatch";
import type { CanonEvidenceRef, CanonFact, CanonOwnerRef } from "./canonCheck";
import type { ApprovedAgentMemoryV1 } from "./agentMemory";

export const CANON_PROVIDERS = ["openai", "google_gemini", "anthropic"] as const;
export type CanonProvider = (typeof CANON_PROVIDERS)[number];
export type AgentModelCapability = "text_generation" | "structured_output";

export interface CanonProviderProfileSummary {
  profile_id: string;
  label: string;
  provider: CanonProvider;
}

export interface CanonProviderProfileCreate {
  session_id?: string | null;
  label: string;
  provider: CanonProvider;
  api_key: string;
}

export interface CanonProviderProfileUpdate {
  session_id?: string | null;
  label: string;
  provider: CanonProvider;
  api_key: string | null;
}

export interface CanonProviderProfileDeleteResponse {
  deleted_profile_id: string;
}

export interface CanonProviderProfilesResponse {
  profiles: CanonProviderProfileSummary[];
}

export interface CanonProviderModel {
  id: string;
  label: string;
  owned_by: string | null;
  capabilities: AgentModelCapability[];
}

export interface CanonProviderModelsResponse {
  profile: CanonProviderProfileSummary;
  models: CanonProviderModel[];
}

export interface CanonAgentEvidenceIssue {
  fingerprint: string;
  rule_id: string;
  category: string;
  severity: "info" | "warning" | "critical";
  targets: CanonOwnerRef[];
  evidence: CanonEvidenceRef[];
}

/** This boundary intentionally cannot contain a complete ProjectDocument. */
export interface CanonAgentEvidencePayload {
  payload_version: 1;
  project_id: string;
  saved_revision: number;
  source_checksum: string;
  content_policy: "evidence_only";
  approved_memory: ApprovedAgentMemoryV1;
  facts: CanonFact[];
  issues: CanonAgentEvidenceIssue[];
}

export interface CanonAgentResponse {
  response_version: 1;
  explanations: Array<{
    fingerprint: string;
    explanation: string;
    recommendation: string | null;
  }>;
  proposals: Array<{ fingerprint: string; patch: ProjectPatch }>;
}

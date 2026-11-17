/** Shared browser boundary for reviewed, project-owned agent memory. */

export const AGENT_MEMORY_VERSION = 1 as const;
export const AGENT_MEMORY_SCOPE_VERSION = 1 as const;
export const AGENT_MEMORY_CANDIDATE_VERSION = 1 as const;
export const AGENT_MEMORY_ACCEPTANCE_VERSION = 1 as const;
export const AGENT_MEMORY_RESOLUTION_VERSION = 1 as const;
export const AGENT_MEMORY_COMMAND_VERSION = 1 as const;
export const AGENT_MEMORY_RESPONSE_VERSION = 1 as const;
export const AGENT_MEMORY_CANDIDATE_RUN_VERSION = 1 as const;
export const AGENT_MEMORY_CANDIDATE_REQUEST_VERSION = 1 as const;
export const AGENT_MEMORY_CANDIDATE_RETRY_VERSION = 1 as const;
export const AGENT_MEMORY_CANDIDATE_REVIEW_VERSION = 1 as const;
export const AGENT_MEMORY_MAX_GUIDANCE_CHARACTERS = 1_000 as const;
export const AGENT_MEMORY_MAX_TITLE_CHARACTERS = 120 as const;
export const AGENT_MEMORY_MAX_INSTRUCTION_CHARACTERS = 4_000 as const;
export const AGENT_MEMORY_MAX_RATIONALE_CHARACTERS = 2_000 as const;
export const AGENT_MEMORY_MAX_ENTRIES = 1_000 as const;
export const AGENT_MEMORY_MAX_RESOLVED_ENTRIES = 32 as const;
export const AGENT_MEMORY_MAX_CONTEXT_CHARACTERS = 16_000 as const;

export type AgentMemoryAgentId = "canon_checker" | "impact_resolver" | "style_rewriter";
export type AgentMemoryLocale = "en" | "ru";
export type AgentMemoryStatus = "active" | "archived";
export type AgentMemoryResolutionStatus = "resolved" | "blocked";
export type AgentMemoryOmissionReason =
  | "archived" | "superseded" | "missing_owner" | "stale_owner"
  | "out_of_scope" | "conflict" | "resolution_blocked"
  | "entry_limit" | "character_limit";
export type AgentMemoryErrorCode =
  | "agent_memory_invalid"
  | "agent_memory_version_unsupported"
  | "agent_memory_agent_unsupported"
  | "agent_memory_locale_unsupported"
  | "agent_memory_scope_invalid"
  | "agent_memory_duplicate"
  | "agent_memory_supersession_cycle"
  | "agent_memory_secret_forbidden"
  | "agent_memory_control_payload_forbidden"
  | "agent_memory_injection_forbidden"
  | "agent_memory_oversized"
  | "agent_memory_resolution_stale"
  | "agent_memory_resolution_target_missing"
  | "agent_memory_resolution_context_required"
  | "agent_memory_resolution_context_invalid"
  | "agent_memory_not_found"
  | "agent_memory_delete_review_required"
  | "agent_memory_delete_impact_stale"
  | "agent_memory_candidate_stale"
  | "agent_memory_candidate_provider_invalid"
  | "agent_memory_candidate_provider_unavailable"
  | "agent_memory_candidate_provider_timeout"
  | "agent_memory_candidate_response_invalid"
  | "agent_memory_candidate_run_capacity_reached"
  | "agent_memory_candidate_run_failed"
  | "agent_memory_candidate_run_active"
  | "agent_memory_candidate_run_cancelled"
  | "agent_memory_candidate_run_not_found"
  | "agent_memory_candidate_invalid"
  | "agent_memory_supersedes_missing"
  | "agent_memory_supersedes_invalid";

interface ScopeBaseV1 { scope_version: typeof AGENT_MEMORY_SCOPE_VERSION }
export interface ProjectMemoryScopeV1 extends ScopeBaseV1 { kind: "project" }
export interface SceneMemoryScopeV1 extends ScopeBaseV1 { kind: "scene"; scene_node_id: string }
export interface NodeMemoryScopeV1 extends ScopeBaseV1 { kind: "node"; node_id: string }
export interface DialogueFieldMemoryScopeV1 extends ScopeBaseV1 {
  kind: "dialogue_field";
  node_id: string;
  field_kind: "line_text" | "choice_prompt" | "option_text";
  element_id: string;
  option_id: string | null;
}
export interface StoryFlowMemoryScopeV1 extends ScopeBaseV1 { kind: "story_flow"; flow_id: string }
export type AgentMemoryScopeV1 =
  | ProjectMemoryScopeV1
  | SceneMemoryScopeV1
  | NodeMemoryScopeV1
  | DialogueFieldMemoryScopeV1
  | StoryFlowMemoryScopeV1;

interface AgentMemoryIdentityV1 {
  project_id: string;
  agent_id: AgentMemoryAgentId;
  namespace: AgentMemoryAgentId;
  scope: AgentMemoryScopeV1;
  content_locale: AgentMemoryLocale;
}

export interface AgentMemoryEntryV1 extends AgentMemoryIdentityV1 {
  memory_version: typeof AGENT_MEMORY_VERSION;
  id: string;
  title: string;
  instruction: string;
  rationale: string | null;
  status: AgentMemoryStatus;
  supersedes_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentMemoryCandidateV1 extends AgentMemoryIdentityV1 {
  candidate_version: typeof AGENT_MEMORY_CANDIDATE_VERSION;
  id: string;
  title: string;
  instruction: string;
  rationale: string | null;
  source_checksum: string;
  history_revision: number;
  semantic_fingerprint: string;
  created_at: string;
}

export interface AgentMemoryCandidateAcceptanceV1 extends AgentMemoryIdentityV1 {
  acceptance_version: typeof AGENT_MEMORY_ACCEPTANCE_VERSION;
  candidate_id: string;
  source_checksum: string;
  expected_history_revision: number;
  semantic_fingerprint: string;
  supersedes_id: string | null;
}

export type AgentMemoryCandidateRunStatus =
  | "queued" | "running" | "completed" | "failed" | "cancelled"
  | "stale" | "rejected" | "accepted";

export interface AgentMemoryCandidateRequestV1 extends AgentMemoryIdentityV1 {
  request_version: typeof AGENT_MEMORY_CANDIDATE_REQUEST_VERSION;
  session_id: string;
  observed_source_checksum: string;
  expected_history_revision: number;
  guidance_request: string;
  content_consent: true;
}

export interface AgentMemoryCandidateRetryV1 {
  retry_version: typeof AGENT_MEMORY_CANDIDATE_RETRY_VERSION;
  observed_source_checksum: string;
  expected_history_revision: number;
  guidance_request: string;
  content_consent: true;
}

export interface AgentMemoryCandidateReviewV1 {
  review_version: typeof AGENT_MEMORY_CANDIDATE_REVIEW_VERSION;
  candidate_id: string;
  semantic_fingerprint: string;
}

export interface AgentMemoryCandidateProviderDisclosureV1 {
  provider: "openai" | "google_gemini" | "anthropic";
  provider_profile_id: string;
  model_id: string;
}

export interface AgentMemoryCandidateRunV1 {
  run_version: typeof AGENT_MEMORY_CANDIDATE_RUN_VERSION;
  id: string;
  project_id: string;
  request: AgentMemoryCandidateRequestV1;
  source_checksum: string;
  history_revision: number;
  status: AgentMemoryCandidateRunStatus;
  progress: number;
  predecessor_run_id: string | null;
  candidate: AgentMemoryCandidateV1 | null;
  provider_disclosure: AgentMemoryCandidateProviderDisclosureV1 | null;
  error_code: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface AgentMemoryCandidateRunResponseV1 {
  response_version: typeof AGENT_MEMORY_RESPONSE_VERSION;
  run: AgentMemoryCandidateRunV1;
}

export interface AgentMemoryCandidateAcceptanceResponseV1 {
  response_version: typeof AGENT_MEMORY_RESPONSE_VERSION;
  result: Record<string, unknown>;
  run: AgentMemoryCandidateRunV1;
}

export interface AgentMemoryCatalogV1 {
  catalog_version: typeof AGENT_MEMORY_VERSION;
  project_id: string;
  entries: AgentMemoryEntryV1[];
}

export interface AgentMemoryResolutionRequestV1 extends AgentMemoryIdentityV1 {
  resolution_version: typeof AGENT_MEMORY_RESOLUTION_VERSION;
  context_scope: ProjectMemoryScopeV1 | SceneMemoryScopeV1 | StoryFlowMemoryScopeV1;
  source_checksum: string;
  history_revision: number;
}

export interface AgentMemoryOmissionV1 {
  memory_id: string;
  reason: AgentMemoryOmissionReason;
}

export interface AgentMemoryConflictV1 {
  memory_ids: string[];
  repair_actions: ["archive", "supersede"];
}

export interface AgentMemoryResolutionV1 {
  resolution_version: typeof AGENT_MEMORY_RESOLUTION_VERSION;
  project_id: string;
  agent_id: AgentMemoryAgentId;
  content_locale: AgentMemoryLocale;
  source_checksum: string;
  history_revision: number;
  status: AgentMemoryResolutionStatus;
  entries: AgentMemoryEntryV1[];
  included_characters: number;
  omitted_entries: number;
  omissions: AgentMemoryOmissionV1[];
  conflicts: AgentMemoryConflictV1[];
}

/** Minimal reviewed instruction allowed inside provider-visible request data. */
export interface ApprovedAgentMemoryEntryV1 {
  memory_id: string;
  title: string;
  instruction: string;
  scope: AgentMemoryScopeV1;
}

/** Bounded memory payload kept separate from every runtime system policy. */
export interface ApprovedAgentMemoryV1 {
  approved_memory_version: 1;
  agent_id: AgentMemoryAgentId;
  content_locale: AgentMemoryLocale;
  entries: ApprovedAgentMemoryEntryV1[];
}

export interface AgentMemoryProviderDataV1 {
  approved_memory: ApprovedAgentMemoryV1;
}

export interface AgentMemoryMutationCommandV1 {
  command_version: typeof AGENT_MEMORY_COMMAND_VERSION;
  command_id: string;
  action: "create" | "update" | "archive" | "restore" | "delete";
  memory_id: string;
  entry: AgentMemoryEntryV1 | null;
  expected_source_checksum: string;
  expected_history_revision: number;
  reviewed_impact_fingerprint: string | null;
}

export interface AgentMemoryDeletionImpactV1 {
  impact_version: 1;
  project_id: string;
  memory_id: string;
  direct_successor_ids: string[];
  rebase_to_id: string | null;
  impact_fingerprint: string;
}

export interface AgentMemoryListResponseV1 {
  response_version: typeof AGENT_MEMORY_RESPONSE_VERSION;
  catalog: AgentMemoryCatalogV1;
  source_checksum: string;
  history_revision: number;
}
export interface AgentMemoryCandidateResponseV1 {
  response_version: typeof AGENT_MEMORY_RESPONSE_VERSION;
  candidate: AgentMemoryCandidateV1;
}
export interface AgentMemoryMutationResponseV1 {
  response_version: typeof AGENT_MEMORY_RESPONSE_VERSION;
  entry: AgentMemoryEntryV1 | null;
  source_checksum: string;
  history_revision: number;
}

export class AgentMemoryContractError extends Error {
  /** Stable code is safe to localize without exposing rejected content. */
  constructor(public readonly code: AgentMemoryErrorCode) {
    super(code);
    this.name = "AgentMemoryContractError";
  }
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;
const CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const AGENTS = new Set<unknown>(["canon_checker", "impact_resolver", "style_rewriter"]);
const LOCALES = new Set<unknown>(["en", "ru"]);
const SECRET_PATTERNS = [
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}\b/i,
  /\bAIza[A-Za-z0-9_-]{20,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~-]{20,}\b/i
];
const INJECTION_PATTERNS = [
  /\bignore\s+(?:all\s+)?(?:previous|system|developer)\s+instructions?\b/i,
  /\b(?:reveal|print|return)\b.{0,48}\b(?:system|developer)\s+(?:prompt|message)\b/i,
  /\bbypass\b.{0,48}\b(?:policy|safety|permission)\b/i
];

/** Validates every discriminated scope before it can cross a browser boundary. */
export function assertAgentMemoryScope(value: unknown): asserts value is AgentMemoryScopeV1 {
  if (!isRecord(value)) fail("agent_memory_scope_invalid");
  if (value.scope_version !== AGENT_MEMORY_SCOPE_VERSION) {
    fail(valueVersion(value) ? "agent_memory_version_unsupported" : "agent_memory_scope_invalid");
  }
  if (value.kind === "project") return assertKeys(value, ["scope_version", "kind"], "agent_memory_scope_invalid");
  if (value.kind === "scene") {
    assertKeys(value, ["scope_version", "kind", "scene_node_id"], "agent_memory_scope_invalid");
    return assertId(value.scene_node_id, "agent_memory_scope_invalid");
  }
  if (value.kind === "node") {
    assertKeys(value, ["scope_version", "kind", "node_id"], "agent_memory_scope_invalid");
    return assertId(value.node_id, "agent_memory_scope_invalid");
  }
  if (value.kind === "story_flow") {
    assertKeys(value, ["scope_version", "kind", "flow_id"], "agent_memory_scope_invalid");
    return assertId(value.flow_id, "agent_memory_scope_invalid");
  }
  if (value.kind !== "dialogue_field") fail("agent_memory_scope_invalid");
  assertKeys(value, ["scope_version", "kind", "node_id", "field_kind", "element_id", "option_id"], "agent_memory_scope_invalid");
  assertId(value.node_id, "agent_memory_scope_invalid");
  assertId(value.element_id, "agent_memory_scope_invalid");
  const field = value.field_kind;
  if (field !== "line_text" && field !== "choice_prompt" && field !== "option_text") fail("agent_memory_scope_invalid");
  if (field === "option_text") assertId(value.option_id, "agent_memory_scope_invalid");
  else if (value.option_id !== null) fail("agent_memory_scope_invalid");
}

/** Validates one durable entry and excludes provider-specific payload fields. */
export function assertAgentMemoryEntry(value: unknown): asserts value is AgentMemoryEntryV1 {
  assertVersionedRecord(value, "memory_version", AGENT_MEMORY_VERSION);
  assertKeys(value, [
    "memory_version", "id", "project_id", "agent_id", "namespace", "scope",
    "content_locale", "title", "instruction", "rationale", "status",
    "supersedes_id", "created_at", "updated_at"
  ], "agent_memory_invalid");
  assertIdentity(value);
  assertId(value.id, "agent_memory_invalid");
  if (value.supersedes_id !== null) assertId(value.supersedes_id, "agent_memory_invalid");
  if (value.id === value.supersedes_id) fail("agent_memory_supersession_cycle");
  assertMemoryText(value.title, AGENT_MEMORY_MAX_TITLE_CHARACTERS);
  assertMemoryText(value.instruction, AGENT_MEMORY_MAX_INSTRUCTION_CHARACTERS);
  if (value.rationale !== null) assertMemoryText(value.rationale, AGENT_MEMORY_MAX_RATIONALE_CHARACTERS);
  if (value.status !== "active" && value.status !== "archived") fail("agent_memory_invalid");
  assertTimestampOrder(value.created_at, value.updated_at);
}

/** Validates a process-local candidate with source and semantic bindings. */
export function assertAgentMemoryCandidate(value: unknown): asserts value is AgentMemoryCandidateV1 {
  assertVersionedRecord(value, "candidate_version", AGENT_MEMORY_CANDIDATE_VERSION);
  assertKeys(value, [
    "candidate_version", "id", "project_id", "agent_id", "namespace", "scope",
    "content_locale", "title", "instruction", "rationale", "source_checksum",
    "history_revision", "semantic_fingerprint", "created_at"
  ], "agent_memory_invalid");
  assertIdentity(value);
  assertId(value.id, "agent_memory_invalid");
  assertMemoryText(value.title, AGENT_MEMORY_MAX_TITLE_CHARACTERS);
  assertMemoryText(value.instruction, AGENT_MEMORY_MAX_INSTRUCTION_CHARACTERS);
  if (value.rationale !== null) assertMemoryText(value.rationale, AGENT_MEMORY_MAX_RATIONALE_CHARACTERS);
  assertChecksum(value.source_checksum);
  assertChecksum(value.semantic_fingerprint);
  assertRevision(value.history_revision);
  assertTimestamp(value.created_at);
}

/** Validates the stale-safe command used to accept a reviewed candidate. */
export function assertAgentMemoryCandidateAcceptance(value: unknown): asserts value is AgentMemoryCandidateAcceptanceV1 {
  assertVersionedRecord(value, "acceptance_version", AGENT_MEMORY_ACCEPTANCE_VERSION);
  assertKeys(value, [
    "acceptance_version", "candidate_id", "project_id", "agent_id", "namespace",
    "scope", "content_locale", "source_checksum", "expected_history_revision",
    "semantic_fingerprint", "supersedes_id"
  ], "agent_memory_invalid");
  assertIdentity(value);
  assertId(value.candidate_id, "agent_memory_invalid");
  assertChecksum(value.source_checksum);
  assertChecksum(value.semantic_fingerprint);
  assertRevision(value.expected_history_revision);
  if (value.supersedes_id !== null) assertId(value.supersedes_id, "agent_memory_invalid");
}

/** Validates explicit consent and exact state bindings before starting provider work. */
export function assertAgentMemoryCandidateRequest(value: unknown): asserts value is AgentMemoryCandidateRequestV1 {
  assertVersionedRecord(value, "request_version", AGENT_MEMORY_CANDIDATE_REQUEST_VERSION);
  assertKeys(value, [
    "request_version", "session_id", "project_id", "agent_id", "namespace", "scope",
    "content_locale", "observed_source_checksum", "expected_history_revision",
    "guidance_request", "content_consent"
  ], "agent_memory_invalid");
  assertIdentity(value);
  assertBoundedString(value.session_id, 128);
  assertChecksum(value.observed_source_checksum);
  assertRevision(value.expected_history_revision);
  assertMemoryText(value.guidance_request, AGENT_MEMORY_MAX_GUIDANCE_CHARACTERS);
  if (value.content_consent !== true) fail("agent_memory_invalid");
}

/** Validates a process-local run without permitting provider payload extensions. */
export function assertAgentMemoryCandidateRun(value: unknown): asserts value is AgentMemoryCandidateRunV1 {
  assertVersionedRecord(value, "run_version", AGENT_MEMORY_CANDIDATE_RUN_VERSION);
  assertKeys(value, [
    "run_version", "id", "project_id", "request", "source_checksum", "history_revision",
    "status", "progress", "predecessor_run_id", "candidate", "provider_disclosure",
    "error_code", "started_at", "completed_at"
  ], "agent_memory_invalid");
  assertId(value.id, "agent_memory_invalid");
  assertId(value.project_id, "agent_memory_invalid");
  assertAgentMemoryCandidateRequest(value.request);
  assertChecksum(value.source_checksum);
  assertRevision(value.history_revision);
  const statuses = new Set<unknown>([
    "queued", "running", "completed", "failed", "cancelled", "stale", "rejected", "accepted"
  ]);
  if (!statuses.has(value.status) || !Number.isSafeInteger(value.progress) || Number(value.progress) < 0 || Number(value.progress) > 100) {
    fail("agent_memory_invalid");
  }
  if (value.predecessor_run_id !== null) assertId(value.predecessor_run_id, "agent_memory_invalid");
  if (value.provider_disclosure !== null) assertCandidateProviderDisclosure(value.provider_disclosure);
  assertTimestamp(value.started_at);
  const terminal = !["queued", "running"].includes(String(value.status));
  if (terminal !== (value.completed_at !== null)) fail("agent_memory_invalid");
  if (value.completed_at !== null) assertTimestamp(value.completed_at);
  const carriesCandidate = ["completed", "rejected", "accepted"].includes(String(value.status));
  if (carriesCandidate !== (value.candidate !== null)) fail("agent_memory_invalid");
  if (value.candidate !== null) {
    assertAgentMemoryCandidate(value.candidate);
    if (value.candidate.project_id !== value.project_id ||
        value.candidate.source_checksum !== value.source_checksum ||
        value.candidate.history_revision !== value.history_revision) fail("agent_memory_invalid");
  }
  const carriesError = ["failed", "cancelled", "stale"].includes(String(value.status));
  if (carriesError !== (typeof value.error_code === "string" && value.error_code.length > 0)) fail("agent_memory_invalid");
  if (value.request.project_id !== value.project_id ||
      value.request.observed_source_checksum !== value.source_checksum ||
      value.request.expected_history_revision !== value.history_revision) fail("agent_memory_invalid");
}

/** Validates the safe polling envelope returned by all non-accept lifecycle routes. */
export function assertAgentMemoryCandidateRunResponse(value: unknown): asserts value is AgentMemoryCandidateRunResponseV1 {
  assertVersionedRecord(value, "response_version", AGENT_MEMORY_RESPONSE_VERSION);
  assertKeys(value, ["response_version", "run"], "agent_memory_invalid");
  assertAgentMemoryCandidateRun(value.run);
}

/** Validates the consumed run while history owns the opaque project mutation result. */
export function assertAgentMemoryCandidateAcceptanceResponse(
  value: unknown
): asserts value is AgentMemoryCandidateAcceptanceResponseV1 {
  assertVersionedRecord(value, "response_version", AGENT_MEMORY_RESPONSE_VERSION);
  assertKeys(value, ["response_version", "result", "run"], "agent_memory_invalid");
  if (!isRecord(value.result)) fail("agent_memory_invalid");
  assertAgentMemoryCandidateRun(value.run);
  if (value.run.status !== "accepted") fail("agent_memory_invalid");
}

/** Validates collection-wide ownership, active identity, and supersession invariants. */
export function assertAgentMemoryCatalog(value: unknown): asserts value is AgentMemoryCatalogV1 {
  assertVersionedRecord(value, "catalog_version", AGENT_MEMORY_VERSION);
  assertKeys(value, ["catalog_version", "project_id", "entries"], "agent_memory_invalid");
  assertId(value.project_id, "agent_memory_invalid");
  if (!Array.isArray(value.entries)) fail("agent_memory_invalid");
  if (value.entries.length > AGENT_MEMORY_MAX_ENTRIES) fail("agent_memory_oversized");
  value.entries.forEach(assertAgentMemoryEntry);
  if (value.entries.some((entry) => entry.project_id !== value.project_id)) fail("agent_memory_invalid");
  const byId = new Map(value.entries.map((entry) => [entry.id, entry]));
  if (byId.size !== value.entries.length) fail("agent_memory_duplicate");
  const active = value.entries.filter((entry) => entry.status === "active").map((entry) =>
    `${entry.agent_id}|${entry.content_locale}|${scopeIdentity(entry.scope)}|${entry.title.trim().toLocaleLowerCase("en-US")}`
  );
  if (new Set(active).size !== active.length) fail("agent_memory_duplicate");
  for (const entry of value.entries) {
    if (entry.supersedes_id !== null && !byId.has(entry.supersedes_id)) fail("agent_memory_invalid");
    const superseded = entry.supersedes_id === null ? undefined : byId.get(entry.supersedes_id);
    if (superseded && (superseded.agent_id !== entry.agent_id || superseded.content_locale !== entry.content_locale)) {
      fail("agent_memory_invalid");
    }
    const visited = new Set<string>();
    let current: AgentMemoryEntryV1 | undefined = entry;
    while (current) {
      if (visited.has(current.id)) fail("agent_memory_supersession_cycle");
      visited.add(current.id);
      current = current.supersedes_id === null ? undefined : byId.get(current.supersedes_id);
    }
  }
}

/** Validates explicit target/context and stale-check bindings before resolution. */
export function assertAgentMemoryResolutionRequest(value: unknown): asserts value is AgentMemoryResolutionRequestV1 {
  assertVersionedRecord(value, "resolution_version", AGENT_MEMORY_RESOLUTION_VERSION);
  assertKeys(value, [
    "resolution_version", "project_id", "agent_id", "namespace", "scope",
    "content_locale", "context_scope", "source_checksum", "history_revision"
  ], "agent_memory_invalid");
  assertIdentity(value);
  assertAgentMemoryScope(value.context_scope);
  if (value.context_scope.kind !== "project" && value.context_scope.kind !== "scene" && value.context_scope.kind !== "story_flow") {
    fail("agent_memory_scope_invalid");
  }
  assertChecksum(value.source_checksum);
  assertRevision(value.history_revision);
}

/** Validates bounded resolver output before disclosure or provider assembly. */
export function assertAgentMemoryResolution(value: unknown): asserts value is AgentMemoryResolutionV1 {
  assertVersionedRecord(value, "resolution_version", AGENT_MEMORY_RESOLUTION_VERSION);
  assertKeys(value, [
    "resolution_version", "project_id", "agent_id", "content_locale", "source_checksum",
    "history_revision", "status", "entries", "included_characters", "omitted_entries",
    "omissions", "conflicts"
  ], "agent_memory_invalid");
  assertId(value.project_id, "agent_memory_invalid");
  assertAgent(value.agent_id);
  assertLocale(value.content_locale);
  assertChecksum(value.source_checksum);
  assertRevision(value.history_revision);
  if (value.status !== "resolved" && value.status !== "blocked") fail("agent_memory_invalid");
  if (!Array.isArray(value.entries)) fail("agent_memory_invalid");
  if (value.entries.length > AGENT_MEMORY_MAX_RESOLVED_ENTRIES) fail("agent_memory_oversized");
  value.entries.forEach(assertAgentMemoryEntry);
  if (value.entries.some((entry) => entry.project_id !== value.project_id || entry.agent_id !== value.agent_id || entry.content_locale !== value.content_locale || entry.status !== "active")) fail("agent_memory_invalid");
  const characters = value.entries.reduce(
    (total, entry) => total + [...entry.title].length + [...entry.instruction].length,
    0
  );
  if (value.included_characters !== characters || characters > AGENT_MEMORY_MAX_CONTEXT_CHARACTERS) fail("agent_memory_invalid");
  assertRevision(value.omitted_entries);
  if (!Array.isArray(value.omissions) || value.omissions.length !== value.omitted_entries) fail("agent_memory_invalid");
  const omissions = value.omissions;
  const omissionReasons = new Set<unknown>([
    "archived", "superseded", "missing_owner", "stale_owner", "out_of_scope",
    "conflict", "resolution_blocked", "entry_limit", "character_limit"
  ]);
  const omittedIds = new Set<string>();
  for (const omission of omissions) {
    if (!isRecord(omission)) fail("agent_memory_invalid");
    assertKeys(omission, ["memory_id", "reason"], "agent_memory_invalid");
    assertId(omission.memory_id, "agent_memory_invalid");
    if (!omissionReasons.has(omission.reason) || omittedIds.has(omission.memory_id)) fail("agent_memory_invalid");
    omittedIds.add(omission.memory_id);
  }
  if ([...omittedIds].sort().some((id, index) => id !== omissions[index]?.memory_id)) fail("agent_memory_invalid");
  if (value.entries.some((entry) => omittedIds.has(entry.id))) fail("agent_memory_invalid");
  if (!Array.isArray(value.conflicts)) fail("agent_memory_invalid");
  const conflicts = value.conflicts;
  const conflictIds = new Set<string>();
  const conflictKeys: string[] = [];
  for (const conflict of conflicts) {
    if (!isRecord(conflict)) fail("agent_memory_invalid");
    assertKeys(conflict, ["memory_ids", "repair_actions"], "agent_memory_invalid");
    if (!Array.isArray(conflict.memory_ids) || conflict.memory_ids.length < 2) fail("agent_memory_invalid");
    const memoryIds = conflict.memory_ids.map((id) => {
      assertId(id, "agent_memory_invalid");
      return id;
    });
    if (new Set(memoryIds).size !== memoryIds.length ||
        [...memoryIds].sort().some((id, index) => id !== memoryIds[index])) fail("agent_memory_invalid");
    if (memoryIds.some((id) => conflictIds.has(id))) fail("agent_memory_invalid");
    memoryIds.forEach((id) => conflictIds.add(id));
    conflictKeys.push(memoryIds.join("\u0000"));
    if (!Array.isArray(conflict.repair_actions) || conflict.repair_actions.length !== 2 ||
        conflict.repair_actions[0] !== "archive" || conflict.repair_actions[1] !== "supersede") fail("agent_memory_invalid");
  }
  if ([...conflictKeys].sort().some((key, index) => key !== conflictKeys[index])) fail("agent_memory_invalid");
  const hasBrokenOwner = omissions.some((item) => isRecord(item) &&
    (item.reason === "missing_owner" || item.reason === "stale_owner"));
  if ((value.status === "blocked") !== (conflicts.length > 0 || hasBrokenOwner) ||
      (value.status === "blocked" && value.entries.length > 0)) fail("agent_memory_invalid");
  for (const id of conflictIds) {
    const omission = omissions.find((item) => isRecord(item) && item.memory_id === id);
    if (!omission || omission.reason !== "conflict") fail("agent_memory_invalid");
  }
}

/** Validates the only Agent Memory envelope permitted in provider user data. */
export function assertAgentMemoryProviderData(value: unknown): asserts value is AgentMemoryProviderDataV1 {
  if (!isRecord(value)) fail("agent_memory_invalid");
  assertKeys(value, ["approved_memory"], "agent_memory_invalid");
  const approved = value.approved_memory;
  assertVersionedRecord(approved, "approved_memory_version", 1);
  assertKeys(approved, ["approved_memory_version", "agent_id", "content_locale", "entries"], "agent_memory_invalid");
  assertAgent(approved.agent_id);
  assertLocale(approved.content_locale);
  if (!Array.isArray(approved.entries) || approved.entries.length > AGENT_MEMORY_MAX_RESOLVED_ENTRIES) {
    fail("agent_memory_oversized");
  }
  for (const entry of approved.entries) {
    if (!isRecord(entry)) fail("agent_memory_invalid");
    assertKeys(entry, ["memory_id", "title", "instruction", "scope"], "agent_memory_invalid");
    assertId(entry.memory_id, "agent_memory_invalid");
    assertMemoryText(entry.title, AGENT_MEMORY_MAX_TITLE_CHARACTERS);
    assertMemoryText(entry.instruction, AGENT_MEMORY_MAX_INSTRUCTION_CHARACTERS);
    assertAgentMemoryScope(entry.scope);
  }
}

/** Validates optimistic mutation commands before runtime dispatch. */
export function assertAgentMemoryMutationCommand(value: unknown): asserts value is AgentMemoryMutationCommandV1 {
  assertVersionedRecord(value, "command_version", AGENT_MEMORY_COMMAND_VERSION);
  assertKeys(value, ["command_version", "command_id", "action", "memory_id", "entry", "expected_source_checksum", "expected_history_revision", "reviewed_impact_fingerprint"], "agent_memory_invalid");
  assertId(value.command_id, "agent_memory_invalid");
  assertId(value.memory_id, "agent_memory_invalid");
  const actions = new Set(["create", "update", "archive", "restore", "delete"]);
  if (!actions.has(String(value.action))) fail("agent_memory_invalid");
  const needsEntry = value.action === "create" || value.action === "update";
  if (needsEntry) {
    assertAgentMemoryEntry(value.entry);
    if (value.entry.id !== value.memory_id) fail("agent_memory_invalid");
  } else if (value.entry !== null) fail("agent_memory_invalid");
  assertChecksum(value.expected_source_checksum);
  assertRevision(value.expected_history_revision);
  if (value.action === "delete") {
    if (value.reviewed_impact_fingerprint === null) fail("agent_memory_delete_review_required");
    assertChecksum(value.reviewed_impact_fingerprint);
  }
  else if (value.reviewed_impact_fingerprint !== null) fail("agent_memory_delete_review_required");
}

/** Validates the deterministic dependency review required by Delete. */
export function assertAgentMemoryDeletionImpact(value: unknown): asserts value is AgentMemoryDeletionImpactV1 {
  assertVersionedRecord(value, "impact_version", 1);
  assertKeys(value, [
    "impact_version", "project_id", "memory_id", "direct_successor_ids",
    "rebase_to_id", "impact_fingerprint"
  ], "agent_memory_invalid");
  assertId(value.project_id, "agent_memory_invalid");
  assertId(value.memory_id, "agent_memory_invalid");
  if (!Array.isArray(value.direct_successor_ids)) fail("agent_memory_invalid");
  const successors = value.direct_successor_ids.map((id) => {
    assertId(id, "agent_memory_invalid");
    return id;
  });
  if (new Set(successors).size !== successors.length ||
      [...successors].sort().some((id, index) => id !== successors[index])) fail("agent_memory_invalid");
  if (value.rebase_to_id !== null) assertId(value.rebase_to_id, "agent_memory_invalid");
  assertChecksum(value.impact_fingerprint);
}

/** Safe response validators intentionally expose no provider request or session data. */
export function assertAgentMemoryListResponse(value: unknown): asserts value is AgentMemoryListResponseV1 {
  assertVersionedRecord(value, "response_version", AGENT_MEMORY_RESPONSE_VERSION);
  assertKeys(value, ["response_version", "catalog", "source_checksum", "history_revision"], "agent_memory_invalid");
  assertAgentMemoryCatalog(value.catalog);
  assertChecksum(value.source_checksum);
  assertRevision(value.history_revision);
}

export function assertAgentMemoryCandidateResponse(value: unknown): asserts value is AgentMemoryCandidateResponseV1 {
  assertVersionedRecord(value, "response_version", AGENT_MEMORY_RESPONSE_VERSION);
  assertKeys(value, ["response_version", "candidate"], "agent_memory_invalid");
  assertAgentMemoryCandidate(value.candidate);
}

export function assertAgentMemoryMutationResponse(value: unknown): asserts value is AgentMemoryMutationResponseV1 {
  assertVersionedRecord(value, "response_version", AGENT_MEMORY_RESPONSE_VERSION);
  assertKeys(value, ["response_version", "entry", "source_checksum", "history_revision"], "agent_memory_invalid");
  if (value.entry !== null) assertAgentMemoryEntry(value.entry);
  assertChecksum(value.source_checksum);
  assertRevision(value.history_revision);
}

function assertIdentity(value: Record<string, unknown>): void {
  assertId(value.project_id, "agent_memory_invalid");
  assertAgent(value.agent_id);
  assertAgent(value.namespace);
  if (value.agent_id !== value.namespace) fail("agent_memory_agent_unsupported");
  assertAgentMemoryScope(value.scope);
  assertLocale(value.content_locale);
}

function assertAgent(value: unknown): asserts value is AgentMemoryAgentId {
  if (!AGENTS.has(value)) fail("agent_memory_agent_unsupported");
}

function assertLocale(value: unknown): asserts value is AgentMemoryLocale {
  if (!LOCALES.has(value)) fail("agent_memory_locale_unsupported");
}

function assertMemoryText(value: unknown, maximum: number): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) fail("agent_memory_invalid");
  if (value.trim().length > maximum) fail("agent_memory_oversized");
  if (CONTROL_PATTERN.test(value)) fail("agent_memory_control_payload_forbidden");
  if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) fail("agent_memory_secret_forbidden");
  if (INJECTION_PATTERNS.some((pattern) => pattern.test(value))) fail("agent_memory_injection_forbidden");
}

function assertBoundedString(value: unknown, maximum: number): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) fail("agent_memory_invalid");
}

function assertCandidateProviderDisclosure(value: unknown): asserts value is AgentMemoryCandidateProviderDisclosureV1 {
  if (!isRecord(value)) fail("agent_memory_invalid");
  assertKeys(value, ["provider", "provider_profile_id", "model_id"], "agent_memory_invalid");
  if (value.provider !== "openai" && value.provider !== "google_gemini" && value.provider !== "anthropic") fail("agent_memory_invalid");
  assertBoundedString(value.provider_profile_id, 128);
  assertBoundedString(value.model_id, 256);
}

function assertVersionedRecord(value: unknown, field: string, version: number): asserts value is Record<string, unknown> {
  if (!isRecord(value)) fail("agent_memory_invalid");
  if (value[field] !== version) fail("agent_memory_version_unsupported");
}

function assertKeys(value: Record<string, unknown>, allowed: string[], code: AgentMemoryErrorCode): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail(code);
}

function assertId(value: unknown, code: AgentMemoryErrorCode): asserts value is string {
  if (typeof value !== "string" || !ID_PATTERN.test(value.trim())) fail(code);
}

function assertChecksum(value: unknown): asserts value is string {
  if (typeof value !== "string" || !CHECKSUM_PATTERN.test(value)) fail("agent_memory_invalid");
}

function assertRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail("agent_memory_invalid");
}

function assertTimestamp(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail("agent_memory_invalid");
}

function assertTimestampOrder(created: unknown, updated: unknown): void {
  assertTimestamp(created);
  assertTimestamp(updated);
  if (Date.parse(updated) < Date.parse(created)) fail("agent_memory_invalid");
}

function scopeIdentity(scope: AgentMemoryScopeV1): string {
  switch (scope.kind) {
    case "project": return "project";
    case "scene": return `scene:${scope.scene_node_id}`;
    case "node": return `node:${scope.node_id}`;
    case "story_flow": return `story_flow:${scope.flow_id}`;
    case "dialogue_field": return `dialogue_field:${scope.node_id}:${scope.field_kind}:${scope.element_id}:${scope.option_id ?? ""}`;
  }
}

function valueVersion(value: Record<string, unknown>): boolean {
  return "scope_version" in value && value.scope_version !== AGENT_MEMORY_SCOPE_VERSION;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: AgentMemoryErrorCode): never {
  throw new AgentMemoryContractError(code);
}

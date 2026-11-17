/** ADR 0025 guarded remote storage wire boundary; counters never round via Number. */
export const REMOTE_STORAGE_VERSION = 1 as const;
export const REMOTE_COUNTER_MAX = "9223372036854775807";
export const REMOTE_SUPPORTED_POSTGRES_MAJORS = [17] as const;
export const REMOTE_LEASE_TTL_SECONDS = 60;
export const REMOTE_LEASE_RENEW_SECONDS = 15;
export const REMOTE_TRANSACTION_TIMEOUT_SECONDS = 20;
export const REMOTE_CONNECT_TIMEOUT_SECONDS = 5;
export const REMOTE_POOL_TIMEOUT_SECONDS = 5;
export const REMOTE_STATEMENT_TIMEOUT_SECONDS = 10;
export const REMOTE_LOCK_TIMEOUT_SECONDS = 3;
export const REMOTE_SCHEMA_PLAN_TTL_SECONDS = 300;

/** Canonical nonnegative signed-bigint decimal string; never convert to Number. */
export type RemoteCounter = string;
export type RemoteSchemaStatus = "empty" | "current" | "older" | "future" | "unknown" | "partial";
export type RemoteSessionState = "ready" | "busy" | "unavailable" | "stale" | "writer_lost" | "outcome_unknown" | "recovery_required" | "schema_blocked";
export type RemoteStorageErrorCode =
  | "remote_contract_invalid" | "remote_storage_protocol_unsupported"
  | "remote_project_scope_mismatch" | "remote_project_busy" | "remote_writer_lost"
  | "remote_revision_stale" | "remote_generation_mismatch" | "remote_command_reused"
  | "remote_commit_unknown" | "remote_storage_unavailable" | "remote_storage_timeout"
  | "remote_tls_failed" | "remote_auth_failed" | "remote_schema_upgrade_required"
  | "remote_schema_future" | "remote_schema_unknown" | "remote_schema_partial"
  | "remote_schema_busy" | "remote_admin_required" | "remote_storage_binding_required"
  | "remote_server_version_unsupported" | "remote_revision_exhausted" | "remote_local_publication_required"
  | "remote_project_not_provisioned"
  | "remote_schema_plan_stale" | "remote_schema_plan_limit" | "remote_schema_backup_required";

export interface RemoteContractV1 { protocol_version: typeof REMOTE_STORAGE_VERSION }

export interface RemoteStorageHeadV1 extends RemoteContractV1 {
  project_id: string;
  storage_generation: string;
  authoring_revision: RemoteCounter;
  saved_authoring_revision: RemoteCounter;
  saved_revision: RemoteCounter;
  document_checksum: string;
  writer_epoch: RemoteCounter;
  state: RemoteSessionState;
}

/** Opaque owner tokens remain runtime-only, not fields of this browser guard. */
export interface RemoteCommandGuardV1 extends RemoteContractV1 {
  project_id: string;
  storage_generation: string;
  command_id: string;
  writer_epoch: RemoteCounter;
  expected_revision: RemoteCounter;
}

export interface RemoteCommandReceiptV1 extends RemoteContractV1 {
  project_id: string;
  storage_generation: string;
  command_id: string;
  request_digest: string;
  base_revision: RemoteCounter;
  result_revision: RemoteCounter;
  document_checksum: string;
  result: "changed" | "no_change";
}

export type RemoteCommandOutcomeV1 = RemoteContractV1 & {
  project_id: string; storage_generation: string; command_id: string;
} & (
  | { status: "committed"; receipt: RemoteCommandReceiptV1 }
  | { status: "not_committed" | "unknown"; receipt: null }
);

export interface RemoteStorageReconnectV1 extends RemoteContractV1 {
  storage_generation: string;
  observed_revision: RemoteCounter;
  unresolved_command_id: string | null;
}

/** Explicit lifecycle consent; not an authoring command or a request to Save. */
export interface RemoteStorageReleaseV1 extends RemoteContractV1 {
  storage_generation: string;
  confirmation: "leave_remote_working_data_unchanged";
}

/** Runtime-local correlation only; restart returns unknown, never replay permission. */
export interface RemoteReconnectScopeV1 extends RemoteContractV1 {
  project_id: string;
  storage_generation: string;
  attempt_id: string;
}
export interface RemoteReconnectBeginV1 extends RemoteReconnectScopeV1 {
  observed_revision: RemoteCounter;
  unresolved_command_id: string | null;
  confirmation: "reload_remote_working_data";
}
export interface RemoteReconnectAbandonV1 extends RemoteReconnectScopeV1 {
  confirmation: "leave_remote_working_data_unchanged";
}
export interface RemoteReconnectOutcomeV1 extends RemoteReconnectScopeV1 {
  source_session_id: string;
  status: "unknown" | "pending" | "ready" | "failed" | "releasing" | "release_failed" | "released";
  result_session_id: string | null;
  error_code: RemoteStorageErrorCode | null;
}

const reconnectScopeKeys = ["protocol_version", "project_id", "storage_generation", "attempt_id"];
function assertReconnectScope(record: Record<string, unknown>): void {
  assertRemoteId(record.project_id); assertRemoteUuid(record.storage_generation); assertRemoteUuid(record.attempt_id);
}
export function assertRemoteReconnectBegin(value: unknown): asserts value is RemoteReconnectBeginV1 {
  const record = remoteRecord(value, [...reconnectScopeKeys, "observed_revision", "unresolved_command_id", "confirmation"]);
  assertReconnectScope(record); assertRemoteCounter(record.observed_revision);
  if (record.unresolved_command_id !== null) assertRemoteUuid(record.unresolved_command_id);
  if (record.confirmation !== "reload_remote_working_data") throw new Error("remote_contract_invalid");
}
export function assertRemoteReconnectAbandon(value: unknown): asserts value is RemoteReconnectAbandonV1 {
  const record = remoteRecord(value, [...reconnectScopeKeys, "confirmation"]);
  assertReconnectScope(record);
  if (record.confirmation !== "leave_remote_working_data_unchanged") throw new Error("remote_contract_invalid");
}
export function assertRemoteReconnectOutcome(value: unknown): asserts value is RemoteReconnectOutcomeV1 {
  const record = remoteRecord(value, [...reconnectScopeKeys, "source_session_id", "status", "result_session_id", "error_code"]);
  assertReconnectScope(record); assertRemoteId(record.source_session_id);
  const statuses = ["unknown", "pending", "ready", "failed", "releasing", "release_failed", "released"];
  if (!statuses.includes(String(record.status))
      || (record.result_session_id !== null) !== ["ready", "release_failed"].includes(String(record.status))
      || (record.error_code !== null) !== ["failed", "release_failed"].includes(String(record.status))) throw new Error("remote_contract_invalid");
  if (record.result_session_id !== null) {
    assertRemoteId(record.result_session_id);
    if (record.result_session_id === record.source_session_id) throw new Error("remote_contract_invalid");
  }
  if (record.error_code !== null && !remoteReconnectErrors.includes(record.error_code as RemoteStorageErrorCode)) throw new Error("remote_contract_invalid");
}

// These are lifecycle failures, not raw driver text or unrelated application errors.
const remoteReconnectErrors: readonly RemoteStorageErrorCode[] = [
  "remote_contract_invalid", "remote_storage_protocol_unsupported", "remote_project_scope_mismatch", "remote_project_busy",
  "remote_writer_lost", "remote_revision_stale", "remote_generation_mismatch", "remote_command_reused", "remote_commit_unknown",
  "remote_storage_unavailable", "remote_storage_timeout", "remote_tls_failed", "remote_auth_failed", "remote_schema_upgrade_required",
  "remote_schema_future", "remote_schema_unknown", "remote_schema_partial", "remote_schema_busy", "remote_admin_required",
  "remote_storage_binding_required", "remote_server_version_unsupported", "remote_revision_exhausted", "remote_local_publication_required",
  "remote_project_not_provisioned", "remote_schema_plan_stale", "remote_schema_plan_limit", "remote_schema_backup_required"
];

/** Local resources released; no document, Saved status or server-lease guarantee. */
export interface RemoteStorageReleaseResultV1 extends RemoteContractV1 {
  session_id: string;
  project_id: string;
  storage_generation: string;
  status: "local_session_released";
}

export function assertRemoteStorageRelease(value: unknown): asserts value is RemoteStorageReleaseV1 {
  const record = remoteRecord(value, ["protocol_version", "storage_generation", "confirmation"]);
  assertRemoteUuid(record.storage_generation);
  if (record.confirmation !== "leave_remote_working_data_unchanged") throw new Error("remote_contract_invalid");
}

export function assertRemoteStorageReleaseResult(value: unknown): asserts value is RemoteStorageReleaseResultV1 {
  const record = remoteRecord(value, ["protocol_version", "session_id", "project_id", "storage_generation", "status"]);
  assertRemoteId(record.session_id); assertRemoteId(record.project_id); assertRemoteUuid(record.storage_generation);
  if (record.status !== "local_session_released") throw new Error("remote_contract_invalid");
}

export interface RemoteStorageInspectionV1 extends RemoteContractV1 {
  server_major: number;
  schema_status: RemoteSchemaStatus;
  schema_revision: string | null;
  tls_policy: "disable" | "require" | "verify-full";
  tls_active: boolean;
  identity_verified: boolean;
  privileges: "runtime" | "administrator" | "insufficient";
}

export interface RemoteStorageFolderRequestV1 extends RemoteContractV1 {
  project_path: string;
}

export interface RemoteStorageInspectRequestV1 extends RemoteStorageFolderRequestV1 {
  profile_id: string;
}

export interface RemoteSchemaPlanRequestV1 extends RemoteStorageInspectRequestV1 {
  action: "provision" | "upgrade";
  expected_schema_revision: string | null;
}

export interface RemoteSchemaExecuteRequestV1 extends RemoteStorageInspectRequestV1 {
  plan_id: string;
  plan_fingerprint: string;
  backup_attestation_id: string | null;
}

/** Review metadata; neither the fingerprint nor the DTO authorizes DDL. */
export interface RemoteSchemaPlanV1 extends RemoteContractV1 {
  plan_id: string;
  plan_fingerprint: string;
  action: "provision" | "upgrade";
  source_schema_revision: string | null;
  target_schema_revision: string;
  migration_revisions: readonly string[];
  expires_at: string;
  backup_required: boolean;
}

/** Operator assertion of an externally verified backup/restore, not dump contents. */
export interface RemoteSchemaBackupAttestationRequestV1 extends RemoteStorageInspectRequestV1 {
  plan_id: string;
  plan_fingerprint: string;
  confirmation: "backup_and_restore_verified";
}

export interface RemoteSchemaBackupAttestationV1 extends RemoteContractV1 {
  backup_attestation_id: string;
  plan_id: string;
  plan_fingerprint: string;
  expires_at: string;
}

/** Returned after known commit, never a durable replay receipt or a pending job. */
export interface RemoteSchemaExecutionV1 extends RemoteContractV1 {
  plan_id: string;
  action: "provision" | "upgrade";
  schema_revision: string;
  status: "completed";
}

export function assertRemoteSchemaExecution(value: unknown): asserts value is RemoteSchemaExecutionV1 {
  const record = remoteRecord(value, ["protocol_version", "plan_id", "action", "schema_revision", "status"]);
  assertRemoteUuid(record.plan_id);
  assertSchemaRevision(record.schema_revision);
  if ((record.action !== "provision" && record.action !== "upgrade") || record.status !== "completed") {
    throw new Error("remote_contract_invalid");
  }
}

/** Untrusted transport JSON must pass runtime checks, not just TS interfaces. */
export function assertRemoteCounter(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value)
      || BigInt(value) > BigInt(REMOTE_COUNTER_MAX)) throw new Error("remote_contract_invalid");
}

export function assertRemoteUuid(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new Error("remote_contract_invalid");
  }
}

function assertRemoteId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim() !== value || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$/.test(value)) {
    throw new Error("remote_contract_invalid");
  }
}

export function assertRemoteStorageHead(value: unknown): asserts value is RemoteStorageHeadV1 {
  const keys = ["protocol_version", "project_id", "storage_generation", "authoring_revision", "saved_authoring_revision",
    "saved_revision", "document_checksum", "writer_epoch", "state"];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("remote_contract_invalid");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some(key => !(key in record)) || record.protocol_version !== 1
      || typeof record.document_checksum !== "string" || !/^[0-9a-f]{64}$/.test(record.document_checksum)
      || !["ready", "busy", "unavailable", "stale", "writer_lost", "outcome_unknown", "recovery_required", "schema_blocked"].includes(String(record.state))) {
    throw new Error("remote_contract_invalid");
  }
  assertRemoteId(record.project_id);
  assertRemoteUuid(record.storage_generation);
  for (const key of ["authoring_revision", "saved_authoring_revision", "saved_revision", "writer_epoch"]) assertRemoteCounter(record[key]);
  if (BigInt(record.saved_authoring_revision as string) > BigInt(record.authoring_revision as string)
      || (record.state === "ready" && record.writer_epoch === "0")) throw new Error("remote_contract_invalid");
}

function remoteRecord(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("remote_contract_invalid");
  const result = value as Record<string, unknown>;
  if (result.protocol_version !== 1 || Object.keys(result).length !== keys.length || keys.some(key => !(key in result))) {
    throw new Error("remote_contract_invalid");
  }
  return result;
}

function assertSchemaRevision(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim() !== value || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    throw new Error("remote_contract_invalid");
  }
}

export function assertRemoteStorageInspection(value: unknown): asserts value is RemoteStorageInspectionV1 {
  const record = remoteRecord(value, ["protocol_version", "server_major", "schema_status", "schema_revision",
    "tls_policy", "tls_active", "identity_verified", "privileges"]);
  if (!Number.isInteger(record.server_major) || (record.server_major as number) < 10 || (record.server_major as number) > 99
      || !["empty", "current", "older", "future", "unknown", "partial"].includes(record.schema_status as string)
      || !["disable", "require", "verify-full"].includes(record.tls_policy as string)
      || !["runtime", "administrator", "insufficient"].includes(record.privileges as string)
      || typeof record.tls_active !== "boolean" || typeof record.identity_verified !== "boolean") {
    throw new Error("remote_contract_invalid");
  }
  if (record.schema_revision !== null) assertSchemaRevision(record.schema_revision);
  if ((record.schema_status === "empty" && record.schema_revision !== null)
      || (["current", "older", "future"].includes(record.schema_status as string) && record.schema_revision === null)
      || (record.tls_policy === "disable" && record.tls_active)
      || (record.identity_verified && (!record.tls_active || record.tls_policy !== "verify-full"))) {
    throw new Error("remote_contract_invalid");
  }
}

function assertPlanIdentity(record: Record<string, unknown>): void {
  if (typeof record.plan_id !== "string" || record.plan_id.length !== 36) throw new Error("remote_contract_invalid");
  assertRemoteUuid(record.plan_id);
  if (typeof record.plan_fingerprint !== "string" || record.plan_fingerprint.length !== 64
      || !/^[a-f0-9]{64}$/.test(record.plan_fingerprint)) {
    throw new Error("remote_contract_invalid");
  }
  const expiry = record.expires_at;
  if (typeof expiry !== "string" || !expiry.endsWith("Z") || expiry.slice(0, 4) === "0000"
      || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$/.test(expiry)
      || !Number.isFinite(Date.parse(expiry)) || new Date(expiry).toISOString().slice(0, 19) !== expiry.slice(0, 19)) {
    throw new Error("remote_contract_invalid");
  }
}

export function assertRemoteSchemaPlan(value: unknown): asserts value is RemoteSchemaPlanV1 {
  const record = remoteRecord(value, ["protocol_version", "plan_id", "plan_fingerprint", "action",
    "source_schema_revision", "target_schema_revision", "migration_revisions", "expires_at", "backup_required"]);
  assertPlanIdentity(record);
  assertSchemaRevision(record.target_schema_revision);
  if (record.source_schema_revision !== null) assertSchemaRevision(record.source_schema_revision);
  const revisions = record.migration_revisions;
  if ((record.action !== "provision" && record.action !== "upgrade") || typeof record.backup_required !== "boolean"
      || (record.action === "provision") !== (record.source_schema_revision === null)
      || record.backup_required !== (record.action === "upgrade")
      || !Array.isArray(revisions) || revisions.length < 1 || revisions.length > 128) {
    throw new Error("remote_contract_invalid");
  }
  revisions.forEach(assertSchemaRevision);
  if (new Set(revisions).size !== revisions.length || revisions.at(-1) !== record.target_schema_revision
      || revisions.includes(record.source_schema_revision)) throw new Error("remote_contract_invalid");
}

export function assertRemoteSchemaBackupAttestation(value: unknown): asserts value is RemoteSchemaBackupAttestationV1 {
  const record = remoteRecord(value, ["protocol_version", "backup_attestation_id", "plan_id", "plan_fingerprint", "expires_at"]);
  assertPlanIdentity(record);
  if (typeof record.backup_attestation_id !== "string" || record.backup_attestation_id.length !== 36) {
    throw new Error("remote_contract_invalid");
  }
  assertRemoteUuid(record.backup_attestation_id);
}

export function assertRemoteCommandReceipt(value: unknown): asserts value is RemoteCommandReceiptV1 {
  const record = remoteRecord(value, ["protocol_version", "project_id", "storage_generation", "command_id",
    "request_digest", "base_revision", "result_revision", "document_checksum", "result"]);
  if (typeof record.project_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$/.test(record.project_id)) throw new Error("remote_contract_invalid");
  assertRemoteUuid(record.storage_generation);
  assertRemoteUuid(record.command_id);
  assertRemoteCounter(record.base_revision);
  assertRemoteCounter(record.result_revision);
  for (const key of ["document_checksum", "request_digest"]) {
    if (typeof record[key] !== "string" || !/^[0-9a-f]{64}$/.test(record[key])) throw new Error("remote_contract_invalid");
  }
  if (!["changed", "no_change"].includes(String(record.result))
      || BigInt(record.result_revision) !== BigInt(record.base_revision) + (record.result === "changed" ? 1n : 0n)) {
    throw new Error("remote_contract_invalid");
  }
}

export function assertRemoteCommandOutcome(value: unknown): asserts value is RemoteCommandOutcomeV1 {
  const record = remoteRecord(value, ["protocol_version", "project_id", "storage_generation", "command_id", "status", "receipt"]);
  if (typeof record.project_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$/.test(record.project_id)) throw new Error("remote_contract_invalid");
  assertRemoteUuid(record.storage_generation);
  assertRemoteUuid(record.command_id);
  if (record.status === "committed") {
    assertRemoteCommandReceipt(record.receipt);
    if (["project_id", "storage_generation", "command_id"].some(key => record[key] !== (record.receipt as unknown as Record<string, unknown>)[key])) {
      throw new Error("remote_contract_invalid");
    }
  } else if (!["not_committed", "unknown"].includes(String(record.status)) || record.receipt !== null) throw new Error("remote_contract_invalid");
}

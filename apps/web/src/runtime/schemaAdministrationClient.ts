/** Reviewed schema administration, separate from authoring/history and secret configuration. */
import {
  assertRemoteSchemaBackupAttestation, assertRemoteSchemaExecution, assertRemoteSchemaPlan,
  assertRemoteStorageInspection,
  type RemoteSchemaBackupAttestationRequestV1, type RemoteSchemaBackupAttestationV1,
  type RemoteSchemaExecuteRequestV1, type RemoteSchemaExecutionV1,
  type RemoteSchemaPlanRequestV1, type RemoteSchemaPlanV1,
  type RemoteStorageInspectionV1, type RemoteStorageInspectRequestV1
} from "@something-to-tell/contracts/remote-storage";
import type { StorageFolderProfileCreateRequest, StorageProfileSummary, StorageProfilesResponse } from "@something-to-tell/contracts/storage";
import { RuntimeApiError, type RuntimeTransport } from "./transport";

export interface RuntimeSchemaAdministration {
  addProfile(command: StorageFolderProfileCreateRequest): Promise<StorageProfileSummary>;
  listProfiles(projectPath: string): Promise<StorageProfilesResponse>;
  inspect(command: RemoteStorageInspectRequestV1): Promise<RemoteStorageInspectionV1>;
  prepare(command: RemoteSchemaPlanRequestV1): Promise<RemoteSchemaPlanV1>;
  attest(command: RemoteSchemaBackupAttestationRequestV1): Promise<RemoteSchemaBackupAttestationV1>;
  execute(command: RemoteSchemaExecuteRequestV1, reviewed: RemoteSchemaPlanV1): Promise<RemoteSchemaExecutionV1>;
}

function invalid(): never {
  throw new RuntimeApiError("remote_contract_invalid", "remote_contract_invalid", 400);
}

function validate<T>(value: unknown, check: (value: unknown) => asserts value is T): T {
  try { check(value); } catch { invalid(); }
  return value;
}

function assertProfiles(value: unknown): asserts value is StorageProfilesResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== 1 || !("profiles" in value) || !Array.isArray(value.profiles)) invalid();
  const ids = new Set<string>();
  const keys = ["profile_id", "label", "host", "port", "database", "username", "tls_policy"];
  for (const profile of value.profiles) {
    if (!profile || typeof profile !== "object" || Array.isArray(profile)
        || Object.keys(profile).length !== keys.length || keys.some(key => !(key in profile))
        || keys.filter(key => key !== "port").some(key => typeof profile[key] !== "string" || !profile[key].length)
        || !Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535
        || !["disable", "require", "verify-full"].includes(profile.tls_policy)
        || ids.has(profile.profile_id)) invalid();
    ids.add(profile.profile_id);
  }
}

/** A bounded transport call is not a retry; Execute failures require fresh inspection. */
export function createSchemaAdministrationClient(transport: RuntimeTransport): RuntimeSchemaAdministration {
  const post = (path: string, body: unknown) => transport.requestJsonWithTimeout<unknown>(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  }, 45000);
  return {
    async addProfile(command) {
      const profiles = validate({ profiles: [await post("/storage-profiles/folder", command)] }, assertProfiles);
      return profiles.profiles[0]!;
    },
    async listProfiles(projectPath) {
      return validate(await post("/storage-profiles/available", { protocol_version: 1, project_path: projectPath }), assertProfiles);
    },
    async inspect(command) {
      return validate(await post("/storage-profiles/inspect", command), assertRemoteStorageInspection);
    },
    async prepare(command) {
      const plan = validate(await post("/storage-profiles/schema-plans", command), assertRemoteSchemaPlan);
      if (plan.action !== command.action || plan.source_schema_revision !== command.expected_schema_revision) invalid();
      return plan;
    },
    async attest(command) {
      const ack = validate(await post("/storage-profiles/schema-plans/backup-attestations", command), assertRemoteSchemaBackupAttestation);
      if (ack.plan_id !== command.plan_id || ack.plan_fingerprint !== command.plan_fingerprint) invalid();
      return ack;
    },
    async execute(command, reviewed) {
      validate(reviewed, assertRemoteSchemaPlan);
      if (command.plan_id !== reviewed.plan_id || command.plan_fingerprint !== reviewed.plan_fingerprint) invalid();
      let response: unknown;
      try { response = await post("/storage-profiles/schema-plans/execute", command); }
      catch (error) {
        if (error instanceof RuntimeApiError) throw error;
        throw new RuntimeApiError("remote_commit_unknown", "remote_commit_unknown", 503,
          "remote_storage.error.remote_commit_unknown");
      }
      const result = validate(response, assertRemoteSchemaExecution);
      if (result.plan_id !== reviewed.plan_id || result.action !== reviewed.action
          || result.schema_revision !== reviewed.target_schema_revision) invalid();
      return result;
    }
  };
}

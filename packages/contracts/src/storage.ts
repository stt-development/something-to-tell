import type { StorageMode } from "./projectManifest";
import type { ProjectSessionResponse } from "./projectSession";
import type { RemoteStorageFolderRequestV1 } from "./remoteStorage";

export type TlsPolicy = "disable" | "require" | "verify-full";

/** Secret-free profile metadata mirrored from the runtime-owned registry. */
export interface StorageProfileSummary {
  profile_id: string;
  label: string;
  host: string;
  port: number;
  database: string;
  username: string;
  tls_policy: TlsPolicy;
}

export interface StorageProfileCreateRequest {
  session_id: string;
  label: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  tls_policy: TlsPolicy;
}

/** Existing connection fields with canonical folder scope instead of an Open session. */
export type StorageFolderProfileCreateRequest = RemoteStorageFolderRequestV1 & Omit<StorageProfileCreateRequest, "session_id">;

export interface StorageProfilesResponse {
  profiles: StorageProfileSummary[];
}

export interface StorageProfileTestResponse {
  profile: StorageProfileSummary;
  connected: boolean;
  tls_active: boolean;
  schema_status: "current" | "empty";
  schema_revision: string | null;
  permissions_valid: boolean;
}

export interface StorageMigrationRequest {
  session_id: string;
  expected_revision: number;
  target_mode: StorageMode;
  target_profile_id: string | null;
}

export interface StorageMigrationResponse<TDialogueDocument, TQuestDocument> {
  source_mode: StorageMode;
  target_mode: StorageMode;
  verified_checksum: string;
  record_count: number;
  project: ProjectSessionResponse<TDialogueDocument, TQuestDocument>;
}

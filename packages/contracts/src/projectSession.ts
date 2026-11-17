import type { ProjectDocument } from "./projectDocument";
import type { ProjectSettings } from "./projectManifest";

/**
 * Shared transport contract for runtime-owned project lifecycle sessions.
 * File access, locks, migrations, and database engines remain runtime-only.
 */

export const PROJECT_SESSION_VERSION = 1 as const;

export interface ProjectSessionCreate {
  path: string;
  name: string;
  description: string;
  settings: ProjectSettings;
}

export interface ProjectSessionSettingsUpdate {
  name: string;
  description: string;
  settings: ProjectSettings;
  expected_history_revision: number;
}

export interface ProjectSessionOpen {
  path: string;
  recover_stale_lock: boolean;
  recovery_mode?: "cancel" | "recover" | "last_saved";
  expected_lock_session_id?: string;
  remote_profile_id?: string;
  initialize_remote_storage?: boolean;
}

export interface ProjectSessionSave {
  expected_revision: number;
  reason: "manual" | "autosave" | "close" | "migration";
}

export interface ProjectSessionSaveAs {
  path: string;
  expected_revision: number;
  identity: "preserve" | "regenerate";
  replace_existing: boolean;
}

export interface ProjectSessionSaveAsResponse {
  source_session: ProjectSessionState;
  destination_path: string;
  project_id: string;
  saved_revision: number;
  backup_path: string | null;
}

export interface ProjectSessionExit {
  expected_revision: number;
}

export interface ProjectCatalogEntry {
  project_id: string;
  name: string;
  description: string;
  path: string;
  format_version: number;
  updated_at: string;
}

export interface ProjectCatalogResponse {
  directory: string;
  is_default: boolean;
  projects: ProjectCatalogEntry[];
}

export interface ProjectDirectoryEntry {
  name: string;
  path: string;
}

export interface ProjectDirectoryListingResponse {
  directory: string;
  parent: string | null;
  directories: ProjectDirectoryEntry[];
}

export interface ProjectSessionState {
  session_version: typeof PROJECT_SESSION_VERSION | 2;
  remote_storage?: import("./remoteStorage").RemoteStorageHeadV1;
  remote_state?: import("./remoteStorage").RemoteSessionState;
  session_id: string;
  project_id: string;
  project_path: string;
  storage_mode: "local_sqlite" | "postgresql";
  loaded_revision: number;
  saved_revision: number;
  save_status: "clean" | "dirty" | "saving" | "error";
  lifecycle: "open" | "closed";
  opened_at: string;
  last_saved_at: string | null;
  save_error: string | null;
}

export interface ProjectSessionResponse<TDialogueDocument, TQuestDocument> {
  session: ProjectSessionState;
  document: ProjectDocument<TDialogueDocument, TQuestDocument>;
}

export interface ProjectSessionErrorDetail {
  code: string;
  message_key: string;
  parameters: Record<string, unknown>;
}

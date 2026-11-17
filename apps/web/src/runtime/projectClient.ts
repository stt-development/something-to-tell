/* Project runtime endpoint ownership. */
import type { ProjectHistoryMutationResponse, ProjectHistorySummary } from "@something-to-tell/contracts/project-history";
import { assertPortableProjectSettings } from "@something-to-tell/contracts/project-manifest";
import type { ProjectCatalogResponse, ProjectDirectoryListingResponse, ProjectSessionCreate, ProjectSessionExit, ProjectSessionOpen, ProjectSessionSave, ProjectSessionSaveAs, ProjectSessionSaveAsResponse, ProjectSessionSettingsUpdate, ProjectSessionState } from "@something-to-tell/contracts/project-session";
import type { StorageMigrationRequest, StorageMigrationResponse, StorageProfileCreateRequest, StorageProfileSummary, StorageProfileTestResponse, StorageProfilesResponse } from "@something-to-tell/contracts/storage";
import type { DialogueDocument } from "../dialogue/contracts";
import type { QuestDocument } from "../quest/contracts";
import type { RuntimeGraphSnapshot, RuntimeProjectClientPersistence, RuntimeProjectSessionResponse } from "./apiTypes";
import { projectSessionToGraphSnapshot } from "./projections";
import type { RuntimeTransport } from "./transport";
export function createProjectRuntimeClient(transport: RuntimeTransport): RuntimeProjectClientPersistence {
  const { getJson, requestJson, requestJsonWithTimeout, sendJson } = transport;
  return {
    /** Creates/resolves the default catalog or scans a user-selected directory. */
    async listProjectCatalog(directory?: string): Promise<ProjectCatalogResponse> {
      const query = directory?.trim()
        ? `?path=${encodeURIComponent(directory.trim())}`
        : "";
      return getJson<ProjectCatalogResponse>(`/project-sessions/catalog${query}`);
    },
    /** Resolves one folder level for the lazy directory tree picker. */
    async listProjectDirectories(directory?: string): Promise<ProjectDirectoryListingResponse> {
      const query = directory?.trim()
        ? `?path=${encodeURIComponent(directory.trim())}`
        : "";
      return getJson<ProjectDirectoryListingResponse>(`/project-sessions/directories${query}`);
    },
    /** Lists only safe profile metadata; credentials never cross this API. */
    async listStorageProfiles(sessionId: string): Promise<StorageProfilesResponse> {
      return getJson<StorageProfilesResponse>(`/storage-profiles?session_id=${encodeURIComponent(sessionId)}`);
    },
    /** Encrypts one project-owned profile; the password is never returned. */
    async createStorageProfile(command: StorageProfileCreateRequest): Promise<StorageProfileSummary> {
      return sendJson<StorageProfileSummary>("POST", "/storage-profiles", command);
    },
    /** Validates one runtime-resolved profile by opaque identifier. */
    async testStorageProfile(sessionId: string, profileId: string): Promise<StorageProfileTestResponse> {
      return sendJson<StorageProfileTestResponse>("POST", "/storage-profiles/test", { profile_id: profileId, session_id: sessionId });
    },
    /** Copies and verifies a clean project before switching its authority. */
    async migrateStorage(command: StorageMigrationRequest): Promise<StorageMigrationResponse<DialogueDocument, QuestDocument>> {
      return sendJson<StorageMigrationResponse<DialogueDocument, QuestDocument>>("POST", "/storage-migrations", command);
    },
    /** Creates and locks one durable project before any authoring state is exposed. */
    async createProjectSession(command: ProjectSessionCreate): Promise<RuntimeProjectSessionResponse> {
      assertPortableProjectSettings(command.settings);
      return sendJson<RuntimeProjectSessionResponse>("POST", "/project-sessions/create", command);
    },
    /** Opens a validated project folder and returns its complete canonical document. */
    async openProjectSession(command: ProjectSessionOpen): Promise<RuntimeProjectSessionResponse> {
      return sendJson<RuntimeProjectSessionResponse>("POST", "/project-sessions/open", command);
    },
    /** Reads the authoritative save state and complete project revision. */
    async inspectProjectSession(sessionId: string): Promise<RuntimeProjectSessionResponse> {
      return getJson<RuntimeProjectSessionResponse>(`/project-sessions/${encodeURIComponent(sessionId)}`);
    },
    /** Publishes one manual, autosave, close, or migration checkpoint. */
    async saveProjectSession(sessionId: string, command: ProjectSessionSave): Promise<RuntimeProjectSessionResponse> {
      return requestJsonWithTimeout<RuntimeProjectSessionResponse>(`/project-sessions/${encodeURIComponent(sessionId)}/save`, {
        body: JSON.stringify(command),
        headers: { "Content-Type": "application/json" },
        method: "POST"
      }, 30000);
    },
    /** Installs a checkpoint-consistent portable copy without moving this session. */
    async saveProjectSessionAs(sessionId: string, command: ProjectSessionSaveAs): Promise<ProjectSessionSaveAsResponse> {
      return sendJson<ProjectSessionSaveAsResponse>("POST", `/project-sessions/${encodeURIComponent(sessionId)}/save-as`, command);
    },
    /** Publishes validated project metadata and behavior settings. */
    async updateProjectSettings(sessionId: string, command: ProjectSessionSettingsUpdate): Promise<RuntimeProjectSessionResponse> {
      assertPortableProjectSettings(command.settings);
      return sendJson<RuntimeProjectSessionResponse>("PUT", `/project-sessions/${encodeURIComponent(sessionId)}/settings`, command);
    },
    /** Restores the last successful checkpoint without releasing the lock. */
    async discardProjectSession(sessionId: string): Promise<RuntimeProjectSessionResponse> {
      return sendJson<RuntimeProjectSessionResponse>("POST", `/project-sessions/${encodeURIComponent(sessionId)}/discard`, {});
    },
    /** Releases the runtime-owned project lock and database resources. */
    async closeProjectSession(sessionId: string): Promise<RuntimeProjectSessionResponse> {
      return sendJson<RuntimeProjectSessionResponse>("POST", `/project-sessions/${encodeURIComponent(sessionId)}/close`, {});
    },
    /**
      * Keeps the confirmed page-exit request alive after the document unloads so
      * the runtime can checkpoint dirty state and release its process-owned lock.
      */
    async exitProjectSession(sessionId: string, command: ProjectSessionExit): Promise<ProjectSessionState> {
      return requestJson<ProjectSessionState>(`/project-sessions/${encodeURIComponent(sessionId)}/exit`, {
        body: JSON.stringify(command),
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        method: "POST"
      });
    },
    /** Reloads the complete session document for optimistic mutation reconciliation. */
    async loadProjectSessionSnapshot(sessionId: string): Promise<RuntimeGraphSnapshot> {
      const response = await getJson<RuntimeProjectSessionResponse>(`/project-sessions/${encodeURIComponent(sessionId)}`);
      return projectSessionToGraphSnapshot(response);
    },
    /** Reads the process-local bounded command stack for the active session. */
    async inspectProjectHistory(sessionId: string): Promise<ProjectHistorySummary> {
      return getJson<ProjectHistorySummary>(`/project-sessions/${encodeURIComponent(sessionId)}/history`);
    },
    /** Applies one inverse patch and returns the authoritative project document. */
    async undoProjectHistory(sessionId: string, expectedHistoryRevision: number) {
      return sendJson<ProjectHistoryMutationResponse<DialogueDocument, QuestDocument>>("POST", `/project-sessions/${encodeURIComponent(sessionId)}/history/undo`, { expected_history_revision: expectedHistoryRevision });
    },
    /** Reapplies one previously undone patch and returns the authoritative project document. */
    async redoProjectHistory(sessionId: string, expectedHistoryRevision: number) {
      return sendJson<ProjectHistoryMutationResponse<DialogueDocument, QuestDocument>>("POST", `/project-sessions/${encodeURIComponent(sessionId)}/history/redo`, { expected_history_revision: expectedHistoryRevision });
    }
  };
}

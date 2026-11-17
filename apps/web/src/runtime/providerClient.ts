/* Provider runtime endpoint ownership. */
import type { CanonProviderModelsResponse, CanonProviderProfileCreate, CanonProviderProfileDeleteResponse, CanonProviderProfileUpdate, CanonProviderProfilesResponse } from "@something-to-tell/contracts/canon-agent";
import type { RuntimeProviderPersistence } from "./apiTypes";
import type { RuntimeTransport } from "./transport";
export function createProviderRuntimeClient(transport: RuntimeTransport): RuntimeProviderPersistence {
  const { getJson, requestJson, sendJson } = transport;
  return {
    /** Lists secret-free provider profile metadata for project settings. */
    async listCanonProviderProfiles(sessionId?: string | null): Promise<CanonProviderProfilesResponse> {
      return getJson<CanonProviderProfilesResponse>(`/canon-provider-profiles${sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ""}`);
    },
    /** Sends a credential once and receives only its verified live model list. */
    async createCanonProviderProfile(command: CanonProviderProfileCreate): Promise<CanonProviderModelsResponse> {
      return sendJson<CanonProviderModelsResponse>("POST", "/canon-provider-profiles", command);
    },
    /** Verifies changed provider data before replacing the encrypted profile. */
    async updateCanonProviderProfile(profileId: string, command: CanonProviderProfileUpdate): Promise<CanonProviderModelsResponse> {
      return sendJson<CanonProviderModelsResponse>("PUT", `/canon-provider-profiles/${encodeURIComponent(profileId)}`, command);
    },
    /** Removes one machine-local profile without mutating the project document. */
    async deleteCanonProviderProfile(sessionId: string | null | undefined, profileId: string): Promise<CanonProviderProfileDeleteResponse> {
      return requestJson<CanonProviderProfileDeleteResponse>(`/canon-provider-profiles/${encodeURIComponent(profileId)}${sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ""}`, { method: "DELETE" });
    },
    /** Resolves an encrypted credential server-side before loading models. */
    async listCanonProviderModels(sessionId: string | null | undefined, profileId: string): Promise<CanonProviderModelsResponse> {
      return getJson<CanonProviderModelsResponse>(`/canon-provider-profiles/${encodeURIComponent(profileId)}/models${sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ""}`);
    }
  };
}

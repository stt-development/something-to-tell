import type { RemoteCommandOutcomeV1, RemoteStorageHeadV1, RemoteStorageReconnectV1 } from "@something-to-tell/contracts/remote-storage";
import { assertRemoteCommandOutcome, assertRemoteStorageHead } from "@something-to-tell/contracts/remote-storage";
import type { RuntimeProjectSessionResponse } from "./apiTypes";
import type { RuntimeTransport } from "./transport";
import { RuntimeApiError } from "./transport";
import { createTrackedReconnectClient } from "./remoteReconnectClient";
import { assertRemoteStorageRelease, assertRemoteStorageReleaseResult, type RemoteStorageReleaseV1 } from "@something-to-tell/contracts/remote-storage";

/** Explicit receipt lookup/reload. This surface never blindly retries a command. */
export function createRemoteStorageClient(transport: RuntimeTransport) {
  return {
    ...createTrackedReconnectClient(transport),
    /** A local-release ACK never installs a graph, marks Saved or retries a request. */
    async releaseRemoteStorage(sessionId: string, projectId: string, command: RemoteStorageReleaseV1) {
      const invalid = () => new RuntimeApiError("remote_contract_invalid", "remote_contract_invalid", 400);
      try { assertRemoteStorageRelease(command); } catch { throw invalid(); }
      let result: unknown;
      try {
        result = await transport.requestJsonWithTimeout<unknown>(`/project-sessions/${encodeURIComponent(sessionId)}/remote-storage/release`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command)
        }, 45000);
      } catch (error) {
        if (error instanceof RuntimeApiError) throw error;
        throw new RuntimeApiError("remote_storage_unavailable", "remote_storage_unavailable", 503);
      }
      try { assertRemoteStorageReleaseResult(result); } catch { throw invalid(); }
      if (result.session_id !== sessionId || result.project_id !== projectId || result.storage_generation !== command.storage_generation) throw invalid();
      return result;
    },
    async inspectRemoteStorage(sessionId: string) {
      const head = await transport.getJson<RemoteStorageHeadV1>(`/project-sessions/${encodeURIComponent(sessionId)}/remote-storage`);
      try { assertRemoteStorageHead(head); }
      catch { throw new RuntimeApiError("remote_contract_invalid", "remote_contract_invalid", 400); }
      return head;
    },
    async resolveRemoteCommand(sessionId: string, commandId: string, generation: string) {
      const outcome = await transport.getJson<RemoteCommandOutcomeV1>(`/project-sessions/${encodeURIComponent(sessionId)}/remote-commands/${encodeURIComponent(commandId)}?generation=${encodeURIComponent(generation)}`);
      try { assertRemoteCommandOutcome(outcome); }
      catch { throw new RuntimeApiError("remote_contract_invalid", "remote_contract_invalid", 400); }
      return outcome;
    },
    reconnectRemoteStorage(sessionId: string, command: RemoteStorageReconnectV1) {
      return transport.sendJson<RuntimeProjectSessionResponse>("POST", `/project-sessions/${encodeURIComponent(sessionId)}/remote-storage/reconnect`, command);
    }
  };
}

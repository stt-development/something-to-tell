/** Runtime client for the checksum-bound Engine Tag registry workspace. */
import type { EngineTagIntegrityReportV1, EngineTagMutationCommandV1, EngineTagMutationResponseV1, EngineTagProjectionV1 } from "@something-to-tell/contracts/engine-tags";
import type { RuntimeEngineTagPersistence } from "./apiTypes";
import type { RuntimeTransport } from "./transport";

function assertMutationResponse(value: unknown): asserts value is EngineTagMutationResponseV1 {
  if (!value || typeof value !== "object" || !("catalog" in value) || !("source_checksum" in value)) {
    throw new Error("Invalid engine tag registry response");
  }
}

function assertProjection(value: unknown): asserts value is EngineTagProjectionV1 {
  if (!value || typeof value !== "object" || !("projection_version" in value) || !("entries" in value)) {
    throw new Error("Invalid engine tag projection response");
  }
}

function assertIntegrity(value: unknown): asserts value is EngineTagIntegrityReportV1 {
  if (!value || typeof value !== "object" || !("report_version" in value) || !("findings" in value)) {
    throw new Error("Invalid engine tag integrity response");
  }
}

export function createEngineTagRuntimeClient(transport: Pick<RuntimeTransport, "getJson" | "sendJson">): RuntimeEngineTagPersistence {
  const registryReads = new Map<string, Promise<EngineTagMutationResponseV1>>();
  return {
    loadEngineTagRegistry(sessionId) {
      const existing = registryReads.get(sessionId);
      if (existing) return existing;
      const pending = (async () => {
        const response = await transport.getJson<unknown>(`/engine-tags/registry?session_id=${encodeURIComponent(sessionId)}`);
        assertMutationResponse(response);
        return response;
      })().finally(() => {
        // A retired request must not delete a newer read started after a command.
        if (registryReads.get(sessionId) === pending) registryReads.delete(sessionId);
      });
      registryReads.set(sessionId, pending);
      return pending;
    },
    async previewEngineTagRegistry(sessionId, target) {
      const response = await transport.sendJson<unknown>("POST", `/engine-tags/registry/preview?session_id=${encodeURIComponent(sessionId)}`, { target });
      assertProjection(response);
      return response;
    },
    async inspectEngineTagIntegrity(sessionId) {
      const response = await transport.getJson<unknown>(`/engine-tags/registry/integrity?session_id=${encodeURIComponent(sessionId)}`);
      assertIntegrity(response);
      return response;
    },
    async applyEngineTagCommand(command) {
      // Share only overlapping reads, never reuse a pre/during-command snapshot later.
      registryReads.clear();
      try {
        const response = await transport.sendJson<unknown>("POST", "/engine-tags/registry/commands", command);
        assertMutationResponse(response);
        return response;
      } finally { registryReads.clear(); }
    }
  };
}

/** Runtime client for durable manual Agent Memory authoring. */

import {
  assertAgentMemoryCandidateAcceptanceResponse,
  assertAgentMemoryCandidateRunResponse,
  assertAgentMemoryCatalog,
  assertAgentMemoryDeletionImpact,
  assertAgentMemoryListResponse,
  assertAgentMemoryMutationResponse,
  assertAgentMemoryResolution,
  type AgentMemoryMutationCommandV1,
  type AgentMemoryMutationResponseV1,
  type AgentMemoryCandidateAcceptanceV1,
  type AgentMemoryCandidateRequestV1,
  type AgentMemoryCandidateRetryV1,
  type AgentMemoryCandidateReviewV1,
  type AgentMemoryResolutionRequestV1,
  type AgentMemoryResolutionV1,
  type AgentMemoryScopeV1
} from "@something-to-tell/contracts/agent-memory";
import type {
  AgentMemoryOwnerOption,
  AgentMemoryWorkspaceSnapshot,
  RuntimeAgentMemoryPersistence,
  RuntimeProjectSessionResponse
} from "./apiTypes";
import type { RuntimeTransport } from "./transport";

/** Combines portable memory with typed owner labels from the same session document. */
export function createAgentMemoryRuntimeClient(
  transport: RuntimeTransport
): RuntimeAgentMemoryPersistence {
  return {
    async loadAgentMemoryWorkspace(sessionId: string): Promise<AgentMemoryWorkspaceSnapshot> {
      const query = encodeURIComponent(sessionId);
      const [memory, project] = await Promise.all([
        transport.getJson<unknown>(`/agent-memory?session_id=${query}`),
        transport.getJson<RuntimeProjectSessionResponse>(`/project-sessions/${query}`)
      ]);
      assertAgentMemoryListResponse(memory);
      assertAgentMemoryCatalog(memory.catalog);
      return {
        catalog: memory.catalog,
        source_checksum: memory.source_checksum,
        history_revision: memory.history_revision,
        owners: ownerOptions(project)
      };
    },
    async applyAgentMemoryCommand(
      command: AgentMemoryMutationCommandV1
    ): Promise<AgentMemoryMutationResponseV1> {
      const response = await transport.sendJson<unknown>(
        "POST",
        "/agent-memory/commands",
        command
      );
      assertAgentMemoryMutationResponse(response);
      return response;
    },
    async inspectAgentMemoryDeletionImpact(sessionId, memoryId) {
      const response = await transport.getJson<unknown>(
        `/agent-memory/${encodeURIComponent(memoryId)}/deletion-impact?session_id=${encodeURIComponent(sessionId)}`
      );
      assertAgentMemoryDeletionImpact(response);
      return response;
    },
    async resolveAgentMemory(
      request: AgentMemoryResolutionRequestV1
    ): Promise<AgentMemoryResolutionV1> {
      const response = await transport.sendJson<unknown>(
        "POST",
        "/agent-memory/resolve",
        request
      );
      assertAgentMemoryResolution(response);
      return response;
    },
    async startAgentMemoryCandidate(request: AgentMemoryCandidateRequestV1) {
      const response = await transport.sendJson<unknown>(
        "POST",
        "/agent-memory/candidate-runs",
        request
      );
      assertAgentMemoryCandidateRunResponse(response);
      return response.run;
    },
    async inspectAgentMemoryCandidate(sessionId, runId) {
      const response = await transport.getJson<unknown>(
        candidatePath(runId, sessionId)
      );
      assertAgentMemoryCandidateRunResponse(response);
      return response.run;
    },
    async cancelAgentMemoryCandidate(sessionId, runId) {
      return candidateAction(transport, sessionId, runId, "cancel", {});
    },
    async retryAgentMemoryCandidate(
      sessionId,
      runId,
      request: AgentMemoryCandidateRetryV1
    ) {
      return candidateAction(transport, sessionId, runId, "retry", request);
    },
    async rejectAgentMemoryCandidate(
      sessionId,
      runId,
      review: AgentMemoryCandidateReviewV1
    ) {
      return candidateAction(transport, sessionId, runId, "reject", review);
    },
    async acceptAgentMemoryCandidate(
      sessionId,
      runId,
      acceptance: AgentMemoryCandidateAcceptanceV1
    ) {
      const response = await transport.sendJson<unknown>(
        "POST",
        candidateActionPath(runId, sessionId, "accept"),
        acceptance
      );
      assertAgentMemoryCandidateAcceptanceResponse(response);
      return response;
    }
  };
}

/** Keeps candidate route encoding identical across every process-local action. */
function candidatePath(runId: string, sessionId: string): string {
  return `/agent-memory/candidate-runs/${encodeURIComponent(runId)}?session_id=${encodeURIComponent(sessionId)}`;
}

function candidateActionPath(
  runId: string,
  sessionId: string,
  action: "accept" | "cancel" | "retry" | "reject"
): string {
  return `/agent-memory/candidate-runs/${encodeURIComponent(runId)}/${action}?session_id=${encodeURIComponent(sessionId)}`;
}

async function candidateAction(
  transport: RuntimeTransport,
  sessionId: string,
  runId: string,
  action: "cancel" | "retry" | "reject",
  body: unknown
) {
  const response = await transport.sendJson<unknown>(
    "POST",
    candidateActionPath(runId, sessionId, action),
    body
  );
  assertAgentMemoryCandidateRunResponse(response);
  return response.run;
}

function ownerOptions(project: RuntimeProjectSessionResponse): AgentMemoryOwnerOption[] {
  const nodes = project.document.nodes;
  const nodeOptions = nodes.flatMap((node): AgentMemoryOwnerOption[] => {
    const options: AgentMemoryOwnerOption[] = [{
      scope: { scope_version: 1, kind: "node", node_id: node.id },
      label: node.title,
      detail: node.type,
      search_text: `${node.title} ${node.type}`.toLocaleLowerCase()
    }];
    if (node.type === "Scene") options.push({
      scope: { scope_version: 1, kind: "scene", scene_node_id: node.id },
      label: node.title,
      detail: "Scene",
      search_text: `${node.title} scene`.toLocaleLowerCase()
    });
    return options;
  });
  const flowOptions = project.document.story_flows.map((flow): AgentMemoryOwnerOption => ({
    scope: { scope_version: 1, kind: "story_flow", flow_id: flow.id },
    label: flow.name,
    detail: "Story Flow",
    search_text: `${flow.name} story flow`.toLocaleLowerCase()
  }));
  const dialogueOptions = project.document.dialogues.flatMap((owned) => {
    const title = nodes.find((node) => node.id === owned.node_id)?.title ?? owned.node_id;
    return owned.document.elements.flatMap((element): AgentMemoryOwnerOption[] => {
      if (element.kind === "line") return [dialogueFieldOption(
        title,
        element.text,
        {
          scope_version: 1,
          kind: "dialogue_field",
          node_id: owned.node_id,
          field_kind: "line_text",
          element_id: element.id,
          option_id: null
        }
      )];
      return [
        dialogueFieldOption(title, element.prompt, {
          scope_version: 1,
          kind: "dialogue_field",
          node_id: owned.node_id,
          field_kind: "choice_prompt",
          element_id: element.id,
          option_id: null
        }),
        ...element.options.map((option) => dialogueFieldOption(title, option.text, {
          scope_version: 1,
          kind: "dialogue_field",
          node_id: owned.node_id,
          field_kind: "option_text",
          element_id: element.id,
          option_id: option.id
        }))
      ];
    });
  });
  return [
    {
      scope: { scope_version: 1, kind: "project" },
      label: project.document.manifest.name,
      detail: "Project",
      search_text: `${project.document.manifest.name} project`.toLocaleLowerCase()
    },
    ...nodeOptions,
    ...flowOptions,
    ...dialogueOptions
  ];
}

function dialogueFieldOption(
  dialogueTitle: string,
  text: string,
  scope: AgentMemoryScopeV1
): AgentMemoryOwnerOption {
  const preview = text.trim() || "Untitled field";
  return {
    scope,
    label: `${dialogueTitle}: ${preview}`,
    detail: scope.kind === "dialogue_field" ? scope.field_kind : "Dialogue",
    search_text: `${dialogueTitle} ${preview}`.toLocaleLowerCase()
  };
}

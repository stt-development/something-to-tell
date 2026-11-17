/** Agent Memory client tests cover typed owner projection and stable routes. */

import { describe, expect, it, vi } from "vitest";
import type {
  AgentMemoryMutationCommandV1,
  AgentMemoryResolutionRequestV1
} from "@something-to-tell/contracts/agent-memory";
import { createAgentMemoryRuntimeClient } from "./agentMemoryClient";
import type { RuntimeProjectSessionResponse } from "./apiTypes";
import type { RuntimeTransport } from "./transport";

const checksum = "a".repeat(64);

describe("agent memory runtime client", () => {
  it("projects typed owners and sends reviewed commands through stable routes", async () => {
    const project = {
      document: {
        manifest: { name: "Project Aurora" },
        nodes: [
          { id: "scene-harbor", type: "Scene", title: "Glass Harbor" },
          { id: "dialogue-gate", type: "Dialogue", title: "Gate dialogue" }
        ],
        story_flows: [{ id: "flow-main", name: "Main Story" }],
        dialogues: [{
          node_id: "dialogue-gate",
          document: {
            dialogue_version: 1,
            entry_element_id: "line-one",
            participants: [],
            elements: [
              { id: "line-one", kind: "line", speaker_node_id: "character-one", text: "Halt.", next_element_id: "choice-one" },
              { id: "choice-one", kind: "choice", prompt: "How do you answer?", options: [{ id: "answer-one", text: "Show the ledger.", condition: "", next_element_id: null }] }
            ]
          }
        }]
      }
    } as unknown as RuntimeProjectSessionResponse;
    const list = {
      response_version: 1,
      catalog: { catalog_version: 1, project_id: "project-aurora", entries: [] },
      source_checksum: checksum,
      history_revision: 4
    };
    const impact = {
      impact_version: 1,
      project_id: "project-aurora",
      memory_id: "memory:one",
      direct_successor_ids: [],
      rebase_to_id: null,
      impact_fingerprint: "b".repeat(64)
    };
    const mutation = {
      response_version: 1,
      entry: null,
      source_checksum: "c".repeat(64),
      history_revision: 5
    };
    const getJson = vi.fn(async (path: string) => {
      if (path.startsWith("/project-sessions/")) return project;
      if (path.includes("deletion-impact")) return impact;
      return list;
    });
    const resolution = {
      resolution_version: 1,
      project_id: "project-aurora",
      agent_id: "canon_checker",
      content_locale: "en",
      source_checksum: checksum,
      history_revision: 4,
      status: "resolved",
      entries: [],
      included_characters: 0,
      omitted_entries: 0,
      omissions: [],
      conflicts: []
    };
    const sendJson = vi.fn(async (_method: string, path: string) =>
      path === "/agent-memory/resolve" ? resolution : mutation
    );
    const client = createAgentMemoryRuntimeClient({ getJson, sendJson } as unknown as RuntimeTransport);

    const workspace = await client.loadAgentMemoryWorkspace("session/one");
    expect(workspace.owners.map((owner) => owner.scope.kind)).toEqual([
      "project", "node", "scene", "node", "story_flow",
      "dialogue_field", "dialogue_field", "dialogue_field"
    ]);
    expect(workspace.owners.at(-1)?.label).toContain("Show the ledger.");

    const command = {
      command_version: 1,
      command_id: "command-delete",
      action: "delete",
      memory_id: "memory-one",
      entry: null,
      expected_source_checksum: checksum,
      expected_history_revision: 4,
      reviewed_impact_fingerprint: impact.impact_fingerprint
    } satisfies AgentMemoryMutationCommandV1;
    await expect(client.applyAgentMemoryCommand(command)).resolves.toEqual(mutation);
    await expect(client.inspectAgentMemoryDeletionImpact("session/one", "memory:one")).resolves.toEqual(impact);
    const request = {
      resolution_version: 1,
      project_id: "project-aurora",
      agent_id: "canon_checker",
      namespace: "canon_checker",
      scope: { scope_version: 1, kind: "project" },
      content_locale: "en",
      context_scope: { scope_version: 1, kind: "project" },
      source_checksum: checksum,
      history_revision: 4
    } satisfies AgentMemoryResolutionRequestV1;
    await expect(client.resolveAgentMemory(request)).resolves.toEqual(resolution);

    expect(sendJson).toHaveBeenCalledWith("POST", "/agent-memory/commands", command);
    expect(sendJson).toHaveBeenCalledWith("POST", "/agent-memory/resolve", request);
    expect(getJson).toHaveBeenCalledWith(
      "/agent-memory/memory%3Aone/deletion-impact?session_id=session%2Fone"
    );
  });

  it("owns the complete process-local candidate route lifecycle", async () => {
    const request = {
      request_version: 1,
      session_id: "session/one",
      project_id: "project-aurora",
      agent_id: "canon_checker",
      namespace: "canon_checker",
      scope: { scope_version: 1, kind: "project" },
      content_locale: "en",
      observed_source_checksum: checksum,
      expected_history_revision: 4,
      guidance_request: "Suggest one reusable canon instruction.",
      content_consent: true
    } as const;
    const candidate = {
      candidate_version: 1,
      id: "candidate-one",
      project_id: request.project_id,
      agent_id: request.agent_id,
      namespace: request.namespace,
      scope: request.scope,
      content_locale: request.content_locale,
      title: "Harbor continuity",
      instruction: "Keep harbor ownership changes explicit.",
      rationale: "This avoids contradictory later checks.",
      source_checksum: checksum,
      history_revision: 4,
      semantic_fingerprint: "b".repeat(64),
      created_at: "2026-09-17T10:00:00Z"
    } as const;
    const completed = {
      run_version: 1,
      id: "run-one",
      project_id: request.project_id,
      request,
      source_checksum: checksum,
      history_revision: 4,
      status: "completed",
      progress: 100,
      predecessor_run_id: null,
      candidate,
      provider_disclosure: {
        provider: "openai",
        provider_profile_id: "provider-one",
        model_id: "model-one"
      },
      error_code: null,
      started_at: "2026-09-17T10:00:00Z",
      completed_at: "2026-09-17T10:00:01Z"
    } as const;
    const sendJson = vi.fn(async (_method: string, path: string) => ({
      response_version: 1,
      ...(path.includes("/accept")
        ? { result: {}, run: { ...completed, status: "accepted" } }
        : { run: completed })
    }));
    const getJson = vi.fn(async () => ({ response_version: 1, run: completed }));
    const client = createAgentMemoryRuntimeClient({ getJson, sendJson } as unknown as RuntimeTransport);

    await expect(client.startAgentMemoryCandidate(request)).resolves.toEqual(completed);
    await expect(client.inspectAgentMemoryCandidate("session/one", "run/one")).resolves.toEqual(completed);
    await expect(client.cancelAgentMemoryCandidate("session/one", "run/one")).resolves.toEqual(completed);
    await expect(client.retryAgentMemoryCandidate("session/one", "run/one", {
      retry_version: 1,
      observed_source_checksum: checksum,
      expected_history_revision: 4,
      guidance_request: "Refine the instruction.",
      content_consent: true
    })).resolves.toEqual(completed);
    await expect(client.rejectAgentMemoryCandidate("session/one", "run/one", {
      review_version: 1,
      candidate_id: candidate.id,
      semantic_fingerprint: candidate.semantic_fingerprint
    })).resolves.toEqual(completed);
    await expect(client.acceptAgentMemoryCandidate("session/one", "run/one", {
      acceptance_version: 1,
      candidate_id: candidate.id,
      project_id: candidate.project_id,
      agent_id: candidate.agent_id,
      namespace: candidate.namespace,
      scope: candidate.scope,
      content_locale: candidate.content_locale,
      source_checksum: candidate.source_checksum,
      expected_history_revision: candidate.history_revision,
      semantic_fingerprint: candidate.semantic_fingerprint,
      supersedes_id: null
    })).resolves.toEqual(expect.objectContaining({ run: expect.objectContaining({ status: "accepted" }) }));

    expect(getJson).toHaveBeenCalledWith(
      "/agent-memory/candidate-runs/run%2Fone?session_id=session%2Fone"
    );
    expect(sendJson).toHaveBeenCalledWith(
      "POST",
      "/agent-memory/candidate-runs/run%2Fone/accept?session_id=session%2Fone",
      expect.objectContaining({ candidate_id: "candidate-one" })
    );
  });
});

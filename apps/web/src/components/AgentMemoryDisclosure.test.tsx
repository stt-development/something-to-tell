/** Contextual Agent Memory disclosure tests cover precedence and dispatch blocks. */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentMemoryEntryV1 } from "@something-to-tell/contracts/agent-memory";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18next } from "../localization/i18n";
import type { RuntimeAgentMemoryPersistence } from "../runtime/apiTypes";
import { AgentMemoryDisclosure } from "./AgentMemoryDisclosure";

const checksum = "a".repeat(64);
const entries: AgentMemoryEntryV1[] = [
  memory("memory-exact", "Exact wording", { scope_version: 1, kind: "node", node_id: "node-gate" }),
  memory("memory-scene", "Scene weather", { scope_version: 1, kind: "scene", scene_node_id: "scene-harbor" }),
  memory("memory-project", "Project terminology", { scope_version: 1, kind: "project" })
];

describe("AgentMemoryDisclosure", () => {
  beforeEach(async () => i18next.changeLanguage("en"));

  it("shows exact, context, and project precedence before enabling dispatch", async () => {
    const onAvailabilityChange = vi.fn();
    render(<AgentMemoryDisclosure
      onAvailabilityChange={onAvailabilityChange}
      persistence={persistence({ status: "resolved", entries, omissions: [], conflicts: [] })}
      sessionId="session-one"
      target={{
        agentId: "style_rewriter",
        contentLocale: "en",
        scope: { scope_version: 1, kind: "node", node_id: "node-gate" },
        contextScope: { scope_version: 1, kind: "scene", scene_node_id: "scene-harbor" }
      }}
    />);

    expect(await screen.findByText("Exact wording")).toBeInTheDocument();
    expect(screen.getByText("Exact target")).toBeInTheDocument();
    expect(screen.getByText("Context")).toBeInTheDocument();
    expect(screen.getByText("Project")).toBeInTheDocument();
    expect(screen.getByText(/characters included · 0 omitted/)).toBeInTheDocument();
    expect(onAvailabilityChange).toHaveBeenLastCalledWith(true);
  });

  it("blocks dispatch for stale owners and opens typed management actions", async () => {
    const onCreate = vi.fn();
    const onManage = vi.fn();
    const onAvailabilityChange = vi.fn();
    render(<AgentMemoryDisclosure
      onAvailabilityChange={onAvailabilityChange}
      onCreate={onCreate}
      onManage={onManage}
      persistence={persistence({
        status: "blocked",
        entries: [],
        omissions: [{ memory_id: "memory-exact", reason: "stale_owner" }],
        conflicts: []
      })}
      sessionId="session-one"
      target={{
        agentId: "impact_resolver",
        contentLocale: "en",
        scope: { scope_version: 1, kind: "story_flow", flow_id: "flow-main" },
        contextScope: { scope_version: 1, kind: "story_flow", flow_id: "flow-main" }
      }}
    />);

    expect(await screen.findByText(/Remote request blocked/)).toBeInTheDocument();
    expect(onAvailabilityChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "Manage agent memory" }));
    fireEvent.click(screen.getByRole("button", { name: "Add memory for this context" }));
    expect(onManage).toHaveBeenCalledOnce();
    expect(onCreate).toHaveBeenCalledWith({
      agent_id: "impact_resolver",
      content_locale: "en",
      scope: { scope_version: 1, kind: "story_flow", flow_id: "flow-main" }
    });
  });
});

function memory(
  id: string,
  title: string,
  scope: AgentMemoryEntryV1["scope"]
): AgentMemoryEntryV1 {
  return {
    memory_version: 1,
    id,
    project_id: "project-one",
    agent_id: "style_rewriter",
    namespace: "style_rewriter",
    scope,
    content_locale: "en",
    title,
    instruction: "Keep this reviewed instruction.",
    rationale: null,
    status: "active",
    supersedes_id: null,
    created_at: "2026-09-16T10:00:00Z",
    updated_at: "2026-09-16T10:00:00Z"
  };
}

function persistence(result: {
  status: "resolved" | "blocked";
  entries: AgentMemoryEntryV1[];
  omissions: Array<{ memory_id: string; reason: "stale_owner" }>;
  conflicts: Array<{ memory_ids: string[]; repair_actions: ["archive", "supersede"] }>;
}): RuntimeAgentMemoryPersistence {
  return {
    loadAgentMemoryWorkspace: vi.fn().mockResolvedValue({
      catalog: { catalog_version: 1, project_id: "project-one", entries },
      source_checksum: checksum,
      history_revision: 4,
      owners: []
    }),
    resolveAgentMemory: vi.fn().mockResolvedValue({
      resolution_version: 1,
      project_id: "project-one",
      agent_id: result.entries[0]?.agent_id ?? "impact_resolver",
      content_locale: "en",
      source_checksum: checksum,
      history_revision: 4,
      included_characters: result.entries.reduce((total, item) => total + item.title.length + item.instruction.length, 0),
      omitted_entries: result.omissions.length,
      ...result
    }),
    applyAgentMemoryCommand: vi.fn(),
    inspectAgentMemoryDeletionImpact: vi.fn(),
    startAgentMemoryCandidate: vi.fn(),
    inspectAgentMemoryCandidate: vi.fn(),
    cancelAgentMemoryCandidate: vi.fn(),
    retryAgentMemoryCandidate: vi.fn(),
    rejectAgentMemoryCandidate: vi.fn(),
    acceptAgentMemoryCandidate: vi.fn()
  };
}

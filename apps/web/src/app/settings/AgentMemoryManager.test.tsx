/** Agent Memory settings tests cover typed scopes and reviewed lifecycle actions. */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentMemoryEntryV1 } from "@something-to-tell/contracts/agent-memory";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18next } from "../../localization/i18n";
import type {
  AgentMemoryWorkspaceSnapshot,
  RuntimeAgentMemoryPersistence
} from "../../runtime/apiTypes";
import { AgentMemoryManager } from "./AgentMemoryManager";

const checksum = "a".repeat(64);
const memory: AgentMemoryEntryV1 = {
  memory_version: 1,
  id: "memory-harbor",
  project_id: "project-one",
  agent_id: "canon_checker",
  namespace: "canon_checker",
  scope: { scope_version: 1, kind: "project" },
  content_locale: "en",
  title: "Harbor ownership",
  instruction: "Treat ownership changes as explicit authored events.",
  rationale: "This protects the blockade branch.",
  status: "active",
  supersedes_id: null,
  created_at: "2026-09-14T10:00:00Z",
  updated_at: "2026-09-14T10:00:00Z"
};

function workspace(entries: AgentMemoryEntryV1[] = [memory]): AgentMemoryWorkspaceSnapshot {
  return {
    catalog: { catalog_version: 1, project_id: "project-one", entries },
    source_checksum: checksum,
    history_revision: 3,
    owners: [
      {
        scope: { scope_version: 1, kind: "project" },
        label: "Project One",
        detail: "Project",
        search_text: "project one project"
      },
      {
        scope: { scope_version: 1, kind: "scene", scene_node_id: "scene-harbor" },
        label: "Glass Harbor",
        detail: "Scene",
        search_text: "glass harbor scene"
      },
      {
        scope: {
          scope_version: 1,
          kind: "dialogue_field",
          node_id: "dialogue-gate",
          field_kind: "option_text",
          element_id: "choice-route",
          option_id: "answer-ledger"
        },
        label: "Gate dialogue: Show the ledger",
        detail: "option_text",
        search_text: "gate dialogue show the ledger"
      }
    ]
  };
}

function persistence(source = workspace()): RuntimeAgentMemoryPersistence {
  return {
    loadAgentMemoryWorkspace: vi.fn().mockResolvedValue(source),
    applyAgentMemoryCommand: vi.fn().mockResolvedValue({
      response_version: 1,
      entry: memory,
      source_checksum: "b".repeat(64),
      history_revision: 4
    }),
    inspectAgentMemoryDeletionImpact: vi.fn().mockResolvedValue({
      impact_version: 1,
      project_id: "project-one",
      memory_id: memory.id,
      direct_successor_ids: ["memory-successor"],
      rebase_to_id: null,
      impact_fingerprint: "c".repeat(64)
    }),
    resolveAgentMemory: vi.fn(),
    startAgentMemoryCandidate: vi.fn(),
    inspectAgentMemoryCandidate: vi.fn(),
    cancelAgentMemoryCandidate: vi.fn(),
    retryAgentMemoryCandidate: vi.fn(),
    rejectAgentMemoryCandidate: vi.fn(),
    acceptAgentMemoryCandidate: vi.fn()
  };
}

describe("AgentMemoryManager", () => {
  beforeEach(async () => {
    await i18next.changeLanguage("en");
  });

  it("preserves the project field focus when an existing memory finishes loading", async () => {
    let resolveLoad!: (snapshot: AgentMemoryWorkspaceSnapshot) => void;
    const runtime = persistence();
    vi.mocked(runtime.loadAgentMemoryWorkspace).mockReturnValue(new Promise(resolve => { resolveLoad = resolve; }));
    render(<><input aria-label="Project name draft" /><AgentMemoryManager activeSessionId="session-one" contentLocale="en" persistence={runtime} projectId="project-one" /></>);
    const projectName = screen.getByRole("textbox", { name: "Project name draft" });
    projectName.focus();
    await act(async () => { resolveLoad(workspace()); });
    expect(screen.getByLabelText("Title")).toHaveValue(memory.title);
    expect(projectName).toHaveFocus();
  });

  it("focuses a new memory only after an explicit Create from a loaded entry", async () => {
    render(<AgentMemoryManager activeSessionId="session-one" contentLocale="en" persistence={persistence()} projectId="project-one" />);
    await screen.findByDisplayValue(memory.title);
    const create = screen.getByRole("button", { name: "Create memory" });
    create.focus();
    fireEvent.click(create);
    expect(screen.getByLabelText("Title")).toHaveValue("");
    expect(screen.getByLabelText("Title")).toHaveFocus();
  });

  it("creates a Scene-scoped entry through searchable typed owners", async () => {
    const runtime = persistence(workspace([]));
    render(<AgentMemoryManager activeSessionId="session-one" contentLocale="en" persistence={runtime} projectId="project-one" />);

    fireEvent.click(await screen.findByRole("button", { name: "Create memory" }));
    expect(screen.getByLabelText("Title")).toHaveFocus();
    const scopeFields = screen.getAllByLabelText("Scope");
    fireEvent.change(scopeFields.at(-1)!, { target: { value: "scene" } });
    fireEvent.change(screen.getByLabelText("Find owner"), { target: { value: "glass" } });
    expect(screen.getByRole("option", { name: "Glass Harbor" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Harbor weather" } });
    const instruction = screen.getByLabelText("Instruction");
    fireEvent.change(instruction, { target: { value: "Keep rain present in harbor scenes." } });
    fireEvent.keyDown(instruction, { key: "Enter", ctrlKey: true });

    await waitFor(() => expect(runtime.applyAgentMemoryCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "create",
        entry: expect.objectContaining({
          scope: { scope_version: 1, kind: "scene", scene_node_id: "scene-harbor" }
        })
      })
    ));
  });

  it("opens a contextual shortcut as a preselected manual draft", async () => {
    render(<AgentMemoryManager
      activeSessionId="session-one"
      contentLocale="en"
      initialDraft={{
        agent_id: "impact_resolver",
        content_locale: "ru",
        scope: { scope_version: 1, kind: "scene", scene_node_id: "scene-harbor" }
      }}
      persistence={persistence()}
      projectId="project-one"
    />);

    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveFocus());
    expect(screen.getAllByLabelText("Agent").at(-1)).toHaveValue("impact_resolver");
    expect(screen.getAllByLabelText("Content language").at(-1)).toHaveValue("ru");
    expect(screen.getAllByLabelText("Scope").at(-1)).toHaveValue("scene");
    expect(screen.getByLabelText("Owner")).toHaveValue(JSON.stringify({
      scope_version: 1,
      kind: "scene",
      scene_node_id: "scene-harbor"
    }));
  });

  it("filters text and exposes copy and archive commands", async () => {
    const other = { ...memory, id: "memory-other", title: "Mountain law" };
    const runtime = persistence(workspace([memory, other]));
    render(<AgentMemoryManager activeSessionId="session-one" contentLocale="en" persistence={runtime} projectId="project-one" />);

    await screen.findByText("Harbor ownership");
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "mountain" } });
    expect(screen.queryByText("Harbor ownership")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Archive memory" })).toHaveAttribute("data-tooltip", "Archive memory");
    fireEvent.click(screen.getByRole("button", { name: "Archive memory" }));
    await waitFor(() => expect(runtime.applyAgentMemoryCommand).toHaveBeenCalledWith(
      expect.objectContaining({ action: "archive", entry: null })
    ));
    fireEvent.click(screen.getByRole("button", { name: "Copy to selected agent" }));
    await waitFor(() => expect(runtime.applyAgentMemoryCommand).toHaveBeenCalledWith(
      expect.objectContaining({ action: "create", entry: expect.objectContaining({ agent_id: "impact_resolver" }) })
    ));
  });

  it("shows supersession impact before sending a reviewed delete", async () => {
    const successor = {
      ...memory,
      id: "memory-successor",
      title: "Revised harbor ownership",
      supersedes_id: memory.id
    };
    const runtime = persistence(workspace([memory, successor]));
    render(<AgentMemoryManager activeSessionId="session-one" contentLocale="en" persistence={runtime} projectId="project-one" />);

    fireEvent.click(await screen.findByRole("button", { name: "Review memory deletion" }));
    expect(await screen.findByText("Delete agent memory?")).toBeInTheDocument();
    expect(screen.getByText("Affected successors: Revised harbor ownership")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(runtime.applyAgentMemoryCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "delete",
        reviewed_impact_fingerprint: "c".repeat(64)
      })
    ));
  });

  it("renders the compact empty state in Russian", async () => {
    await i18next.changeLanguage("ru");
    render(<AgentMemoryManager activeSessionId="session-one" contentLocale="ru" persistence={persistence(workspace([]))} projectId="project-one" />);

    expect(await screen.findByText("Память агентов")).toBeInTheDocument();
    expect(screen.getByText("Память агентов пока пуста.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Создать запись памяти" })).toBeInTheDocument();
  });

  it("keeps Russian UI labels independent from English memory content", async () => {
    await i18next.changeLanguage("ru");
    render(<AgentMemoryManager activeSessionId="session-one" contentLocale="en" persistence={persistence(workspace([]))} projectId="project-one" />);

    fireEvent.click(await screen.findByRole("button", { name: "Создать запись памяти" }));
    expect(screen.getByLabelText("Название")).toHaveFocus();
    expect(screen.getByLabelText("Язык содержимого")).toHaveValue("en");
  });

  it("opens candidate review and restores focus to its launcher", async () => {
    render(<AgentMemoryManager activeSessionId="session-one" contentLocale="en" persistence={persistence()} projectId="project-one" />);

    const launch = await screen.findByRole("button", { name: "Suggest memory with agent" });
    fireEvent.click(launch);
    expect(screen.getByLabelText("Review memory suggestion")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(launch).toHaveFocus());
  });

  it("keeps compact layout stable while reporting load progress and errors", async () => {
    let rejectLoad: (reason: Error) => void = () => undefined;
    const pending = new Promise<AgentMemoryWorkspaceSnapshot>((_resolve, reject) => {
      rejectLoad = reject;
    });
    const runtime = persistence();
    vi.mocked(runtime.loadAgentMemoryWorkspace).mockReturnValue(pending);
    const { container } = render(<AgentMemoryManager activeSessionId="session-one" contentLocale="en" persistence={runtime} projectId="project-one" />);

    expect(screen.getByText("Updating agent memory…")).toBeInTheDocument();
    expect(container.querySelector(".grid-cols-1.xl\\:grid-cols-\\[minmax\\(13rem\\,0\\.75fr\\)_minmax\\(20rem\\,1\\.25fr\\)\\]"))
      .toBeInTheDocument();

    rejectLoad(new Error("Memory catalog unavailable"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Memory catalog unavailable");
    await waitFor(() => expect(screen.queryByText("Updating agent memory…")).not.toBeInTheDocument());
  });
});

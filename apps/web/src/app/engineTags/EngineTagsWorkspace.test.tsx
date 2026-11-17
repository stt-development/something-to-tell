import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineTagDefinitionV1, EngineTagMutationResponseV1 } from "@something-to-tell/contracts/engine-tags";
import { i18next } from "../../localization/i18n";
import type { RuntimeEngineTagPersistence } from "../../runtime/apiTypes";
import { EngineTagsWorkspace } from "./EngineTagsWorkspace";

const definition: EngineTagDefinitionV1 = {
  tag_version: 1,
  id: "definition-one",
  project_id: "project-one",
  key: "Story.Main",
  normalized_key: "story.main",
  description: "Main story route",
  status: "active",
  aliases: [],
  created_at: "2026-09-19T10:00:00Z",
  updated_at: "2026-09-19T10:00:00Z"
};

function response(overrides: Partial<EngineTagMutationResponseV1> = {}): EngineTagMutationResponseV1 {
  return {
    response_version: 1 as const,
    catalog: { catalog_version: 1 as const, project_id: "project-one", definitions: [definition], bindings: [], legacy_count: 0 },
    source_checksum: "a".repeat(64),
    history_revision: 2,
    ...overrides
  };
}

function persistence(): RuntimeEngineTagPersistence {
  return {
    loadEngineTagRegistry: vi.fn().mockResolvedValue(response()),
    inspectEngineTagIntegrity: vi.fn().mockResolvedValue({ report_version: 1, project_id: "project-one", source_checksum: "a".repeat(64), findings: [], error_count: 0, warning_count: 0, info_count: 0 }),
    previewEngineTagRegistry: vi.fn().mockResolvedValue({
      projection_version: 1, project_id: "project-one", source_checksum: "a".repeat(64), target: "generic", entries: [], omitted: [], diagnostics: []
    }),
    applyEngineTagCommand: vi.fn().mockResolvedValue(response({ history_revision: 3, source_checksum: "b".repeat(64) }))
  };
}

describe("EngineTagsWorkspace", () => {
  beforeEach(async () => { await i18next.changeLanguage("en"); });

  it("loads definitions, filters them, and exposes the target preview", async () => {
    const runtime = persistence();
    vi.mocked(runtime.inspectEngineTagIntegrity).mockResolvedValue({
      report_version: 1,
      project_id: "project-one",
      source_checksum: "a".repeat(64),
      findings: [{
        finding_version: 1,
        code: "target_incompatibility",
        severity: "info",
        message_key: "engine_tags.integrity.target-incompatibility",
        definition_id: definition.id,
        binding_id: null,
        owner: null,
        details: { target: "ink" }
      }],
      error_count: 0,
      warning_count: 0,
      info_count: 1
    });
    render(<EngineTagsWorkspace onClose={vi.fn()} persistence={runtime} projectName="Project Aurora" sessionId="session-one" />);
    expect((await screen.findAllByText("Story.Main")).length).toBeGreaterThan(0);
    expect(await screen.findByText("Target alias is not configured")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: /Story/ }).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Story.Main" })).toHaveClass("engine-tags-definition-key");
    expect(screen.getByRole("heading", { name: "Story.Main" })).toHaveAttribute("title", "Story.Main");
    expect(screen.getByLabelText(/Optional identifier used instead/)).toHaveAttribute("data-tooltip");
    expect(screen.queryByRole("option", { name: "Unreal Engine" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Unity" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Identifier target")).toHaveValue("ink");
    fireEvent.change(screen.getByPlaceholderText("Search definitions"), { target: { value: "missing" } });
    expect(screen.getByText("No definitions match the current filters.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Generate preview" }));
    await waitFor(() => expect(runtime.previewEngineTagRegistry).toHaveBeenCalledWith("session-one", "generic"));
  });

  it("opens an explicit creation form before sending a definition command", async () => {
    const runtime = persistence();
    render(<EngineTagsWorkspace onClose={vi.fn()} persistence={runtime} projectName="Project Aurora" sessionId="session-one" />);

    expect((await screen.findAllByText("Story.Main")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole("button", { name: "Create" })[0]!);
    expect(runtime.applyEngineTagCommand).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Canonical key"), { target: { value: "Quest.OptionalRoute" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Optional quest route" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Create" }).at(-1)!);

    await waitFor(() => expect(runtime.applyEngineTagCommand).toHaveBeenCalledWith(expect.objectContaining({
      action: "create_definition",
      key: "Quest.OptionalRoute",
      description: "Optional quest route",
      expected_history_revision: 2,
      expected_source_checksum: "a".repeat(64)
    })));
  });

  it("uses one aligned command style for create, save, and archive actions", async () => {
    render(<EngineTagsWorkspace onClose={vi.fn()} persistence={persistence()} projectName="Project Aurora" sessionId="session-one" />);

    const create = await screen.findByRole("button", { name: "Create" });
    const save = screen.getByRole("button", { name: "Save definition" });
    const archive = screen.getByRole("button", { name: "Archive" });
    expect(create).toHaveClass("engine-tags-command", "engine-tags-command-secondary");
    expect(save).toHaveClass("engine-tags-command", "engine-tags-command-primary");
    expect(archive).toHaveClass("engine-tags-command", "engine-tags-command-secondary");
  });

  it("sends a checksum-bound definition command and supports Russian labels", async () => {
    await i18next.changeLanguage("ru");
    const runtime = persistence();
    render(<EngineTagsWorkspace onClose={vi.fn()} persistence={runtime} projectName="Project Aurora" sessionId="session-one" />);
    fireEvent.click(await screen.findByRole("button", { name: "Сохранить определение" }));
    await waitFor(() => expect(runtime.applyEngineTagCommand).toHaveBeenCalledWith(expect.objectContaining({
      action: "rename_definition",
      definition_id: "definition-one",
      expected_history_revision: 2,
      expected_source_checksum: "a".repeat(64)
    })));
  });

  it("localizes projection targets, diagnostics, and omissions in Russian", async () => {
    await i18next.changeLanguage("ru");
    const runtime = persistence();
    vi.mocked(runtime.previewEngineTagRegistry).mockResolvedValue({
      projection_version: 1,
      project_id: "project-one",
      source_checksum: "a".repeat(64),
      target: "ink",
      entries: [],
      diagnostics: [{
        code: "target_collision",
        message_key: "engine_tags.projection.target-collision",
        details: { identifier: "Story.Main" }
      }],
      omitted: [{ definition_id: "definition-one", code: "missing_target_alias", details: { target: "ink" } }]
    });
    render(<EngineTagsWorkspace onClose={vi.fn()} persistence={runtime} projectName="Project Aurora" sessionId="session-one" />);
    expect((await screen.findAllByText("Story.Main")).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText("Цель предпросмотра экспорта"), { target: { value: "ink" } });
    fireEvent.click(screen.getByRole("button", { name: "Сформировать предпросмотр" }));

    expect(await screen.findByText("Несколько привязок используют один идентификатор цели")).toBeInTheDocument();
    expect(screen.getByText("Алиас для цели не задан")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Общий формат" })).toBeInTheDocument();
  });

  it("navigates from a binding through one localized command", async () => {
    const runtime = persistence();
    const owner = { owner_version: 1 as const, kind: "node" as const, project_id: "project-one", node_id: "node-main" };
    vi.mocked(runtime.loadEngineTagRegistry).mockResolvedValue(response({
      catalog: {
        catalog_version: 1,
        project_id: "project-one",
        definitions: [definition],
        bindings: [{
          tag_version: 1,
          id: "binding-one",
          project_id: "project-one",
          definition_id: definition.id,
          owner,
          value: "",
          created_at: "2026-09-19T10:00:00Z",
          updated_at: "2026-09-19T10:00:00Z"
        }],
        legacy_count: 0
      }
    }));
    const onNavigateOwner = vi.fn();
    render(<EngineTagsWorkspace onClose={vi.fn()} onNavigateOwner={onNavigateOwner} persistence={runtime} projectName="Project Aurora" sessionId="session-one" />);

    fireEvent.click(await screen.findByRole("button", { name: "Open owning element" }));
    expect(onNavigateOwner).toHaveBeenCalledWith(owner);
  });
});

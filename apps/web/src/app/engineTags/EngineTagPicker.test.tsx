import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18next } from "../../localization/i18n";
import type { EngineTagOwnerV1 } from "@something-to-tell/contracts/engine-tags";
import type { RuntimeEngineTagPersistence } from "../../runtime/apiTypes";
import { EngineTagPicker } from "./EngineTagPicker";

function persistence(boundOwner?: EngineTagOwnerV1): RuntimeEngineTagPersistence {
  return {
    loadEngineTagRegistry: vi.fn().mockResolvedValue({
      response_version: 1,
      catalog: {
        catalog_version: 1,
        project_id: "project-one",
        definitions: [{ tag_version: 1, id: "tag-one", project_id: "project-one", key: "Story.Main", normalized_key: "story.main", description: "Main route", status: "active", aliases: [], created_at: "now", updated_at: "now" }],
        bindings: boundOwner ? [{
          tag_version: 1, id: "binding-one", project_id: "project-one", definition_id: "tag-one",
          owner: boundOwner, value: "", created_at: "now", updated_at: "now"
        }] : [],
        legacy_count: 0
      },
      source_checksum: "a".repeat(64),
      history_revision: 4
    }),
    inspectEngineTagIntegrity: vi.fn(),
    previewEngineTagRegistry: vi.fn(),
    applyEngineTagCommand: vi.fn().mockResolvedValue({
      response_version: 1,
      catalog: { catalog_version: 1, project_id: "project-one", definitions: [], bindings: [], legacy_count: 0 },
      source_checksum: "b".repeat(64),
      history_revision: 5
    })
  };
}

describe("EngineTagPicker", () => {
  beforeEach(async () => { await i18next.changeLanguage("en"); });

  it("offers a compact tag disclosure with a localized tooltip and unchanged assignment editor", async () => {
    const runtime = persistence();
    const owners = ["one", "two"].map(node_id => ({ kind: "node" as const, project_id: "project-one", node_id }));
    render(<EngineTagPicker compact label="Bind Export ID to selection" owners={owners} persistence={runtime} sessionId="session-compact" />);
    const trigger = screen.getByRole("button", { name: "Bind Export ID to selection" });
    expect(trigger).toHaveAttribute("data-tooltip", "Bind Export ID to selection");
    expect(trigger).toHaveTextContent("2");
    expect(trigger.querySelector("svg")).toHaveClass("lucide-tags");
    const picker = trigger.closest("details");
    expect(picker).toHaveClass("engine-tag-picker-compact");
    expect(picker).not.toHaveAttribute("open");
    fireEvent.click(trigger);
    expect(picker).toHaveAttribute("open");
    fireEvent.click(await screen.findByRole("button", { name: "Add identifier" }));
    fireEvent.click(screen.getByRole("button", { name: "Assign: Story.Main" }));
    await waitFor(() => expect(runtime.applyEngineTagCommand).toHaveBeenCalledWith(expect.objectContaining({ action: "batch_bind", owners })));
    fireEvent.click(trigger);
    expect(picker).not.toHaveAttribute("open");
  });

  it("hides unassigned definitions until the searchable catalog opens", async () => {
    const runtime = persistence();
    render(<EngineTagPicker owners={[{ kind: "node", project_id: "project-one", node_id: "node-one" }]} persistence={runtime} sessionId="session-one" />);
    await screen.findByText("0 assigned");
    expect(screen.queryByText("Story.Main")).not.toBeInTheDocument();
    const picker = screen.getByText("Export ID").closest("details");
    expect(picker).not.toHaveAttribute("open");
    fireEvent.click(picker!.querySelector("summary")!);
    expect(picker).toHaveAttribute("open");
    fireEvent.click(screen.getByRole("button", { name: "Add identifier" }));
    expect(screen.getByText("Story.Main")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "missing" } });
    expect(screen.queryByText("Story.Main")).not.toBeInTheDocument();
    expect(screen.getByText("No matching identifiers available.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "story" } });
    fireEvent.click(screen.getByRole("button", { name: "Assign: Story.Main" }));
    await waitFor(() => expect(runtime.applyEngineTagCommand).toHaveBeenCalledWith(expect.objectContaining({
      action: "bind",
      definition_id: "tag-one",
      expected_history_revision: 4,
      owner: { kind: "node", project_id: "project-one", node_id: "node-one" }
    })));
    expect(screen.getByRole("button", { name: "Add identifier" })).toHaveAttribute("aria-expanded", "false");
  });

  it("generates an editable tag key from element metadata and creates it already assigned", async () => {
    const runtime = persistence();
    render(<EngineTagPicker
      owners={[{ kind: "node", project_id: "project-one", node_id: "node-one" }]}
      persistence={runtime}
      sessionId="session-create"
      suggestionDescription="Reach the reopened route"
      suggestionLabel="Quest Smuggler Route"
    />);
    await screen.findByText("0 assigned");
    fireEvent.click(screen.getByText("Export ID").closest("details")!.querySelector("summary")!);
    fireEvent.click(screen.getByRole("button", { name: "Add identifier" }));
    fireEvent.click(screen.getByRole("button", { name: "Generate a new identifier" }));
    expect(screen.getByLabelText("Canonical key")).toHaveValue("Node.QuestSmugglerRoute");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(runtime.applyEngineTagCommand).toHaveBeenCalledWith(expect.objectContaining({
      action: "create_and_bind",
      key: "Node.QuestSmugglerRoute",
      description: "Reach the reopened route",
      owner: { kind: "node", project_id: "project-one", node_id: "node-one" }
    })));
  });

  it("edits an existing definition directly in the contextual picker", async () => {
    const owner = { kind: "node", project_id: "project-one", node_id: "node-one" } as const;
    const runtime = persistence(owner);
    render(<EngineTagPicker owners={[owner]} persistence={runtime} sessionId="session-edit" />);
    await screen.findByText("Story.Main");
    expect(screen.getByText("1 assigned")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Export ID").closest("details")!.querySelector("summary")!);
    fireEvent.click(screen.getByRole("button", { name: "Edit Story.Main" }));
    fireEvent.change(screen.getByLabelText("Canonical key"), { target: { value: "Story.Primary" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(runtime.applyEngineTagCommand).toHaveBeenCalledWith(expect.objectContaining({
      action: "rename_definition",
      definition_id: "tag-one",
      key: "Story.Primary"
    })));
  });

  it("does not mutate the registry when an unbound contextual picker opens", async () => {
    const runtime = persistence();
    render(<EngineTagPicker
      owners={[{ kind: "quest_stage", project_id: "project-one", quest_node_id: "quest-one", stage_id: "stage-one" }]}
      persistence={runtime}
      sessionId="session-observational"
      suggestionDescription="Enter through the flooded tunnel"
      suggestionLabel="Quest Smuggler Route Flooded Tunnel"
    />);
    await screen.findByText("0 assigned");
    fireEvent.click(screen.getByText("Export ID").closest("details")!.querySelector("summary")!);
    expect(screen.queryByText("Story.Main")).not.toBeInTheDocument();
    expect(runtime.loadEngineTagRegistry).toHaveBeenCalledTimes(1);
    expect(runtime.applyEngineTagCommand).not.toHaveBeenCalled();
  });

  it("does not recreate a tag when runtime owner JSON contains optional null fields", async () => {
    const owner = { kind: "node", project_id: "project-one", node_id: "node-one" } as const;
    const runtimeOwner = { ...owner, edge_id: null, dialogue_node_id: null, line_id: null } as unknown as EngineTagOwnerV1;
    const runtime = persistence(runtimeOwner);
    render(<EngineTagPicker owners={[owner]} persistence={runtime} sessionId="session-existing" suggestionLabel="Quest Existing" />);
    await screen.findByText("Story.Main");
    expect(runtime.applyEngineTagCommand).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Export ID").closest("details")!.querySelector("summary")!);

    expect(screen.getByRole("button", { name: "Remove: Story.Main" })).toBeInTheDocument();
    expect(runtime.loadEngineTagRegistry).toHaveBeenCalledTimes(1);
    expect(runtime.applyEngineTagCommand).not.toHaveBeenCalled();
  });
});

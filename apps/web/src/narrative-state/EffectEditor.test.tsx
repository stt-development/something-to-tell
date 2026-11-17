import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Node } from "@xyflow/react";
import { describe, expect, it, vi } from "vitest";
import type { NarrativeNodeData } from "../types";
import type { RuntimeNarrativeStatePersistence } from "./contracts";
import { NarrativeEffectEditor, RelationshipInitialHolderControl, SearchableEntitySelect } from "./EffectEditor";

const nodes: Node<NarrativeNodeData>[] = [
  { id: "item-ledger", position: { x: 0, y: 0 }, data: { kind: "Item", label: "Ledger", title: "Sealed Ledger", summary: "Evidence", tags: [] } },
  { id: "character-mara", position: { x: 0, y: 0 }, data: { kind: "Character", label: "Mara", title: "Mara", summary: "Courier", tags: [] } }
];

function persistence(): RuntimeNarrativeStatePersistence {
  return {
    getNarrativeStateSnapshot: vi.fn().mockResolvedValue({ project_id: "project-1", initial_states: [], effects: [], bindings: [], integrity: { project_id: "project-1", facts: [] } }),
    createNarrativeEffect: vi.fn(async (_projectId, effect) => effect),
    updateNarrativeEffect: vi.fn(async (_projectId, effect) => effect),
    getNarrativeEffectImpact: vi.fn(),
    deleteNarrativeEffect: vi.fn(),
    createNarrativeEffectBinding: vi.fn(),
    deleteNarrativeEffectBinding: vi.fn(),
    reorderNarrativeEffectBindings: vi.fn(),
    previewRelationshipInitialState: vi.fn(),
    applyRelationshipInitialState: vi.fn()
  };
}

describe("Narrative effect editor", () => {
  it("filters selectors with the keyboard and restores trigger focus on Escape", async () => {
    const onChange = vi.fn();
    render(<SearchableEntitySelect label="Item" onChange={onChange} options={[{ id: "ledger", label: "Sealed Ledger" }, { id: "key", label: "Iron Key" }]} value="" />);
    const trigger = screen.getByRole("button", { name: "Select an entity" });
    fireEvent.click(trigger);
    const search = screen.getByRole("combobox", { name: "Search available entities" });
    fireEvent.change(search, { target: { value: "iron" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("key");
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("loads only when expanded and restores focus when closed", async () => {
    const client = persistence();
    const { container } = render(<NarrativeEffectEditor nodes={nodes} owner={{ owner_version: 1, owner_kind: "node_entry", owner_id: "character-mara" }} persistence={client} projectId="project-1" />);
    const trigger = screen.getByRole("button", { name: "State effects" });
    expect(trigger).toContainElement(container.querySelector(".lucide-git-compare-arrows"));
    expect(client.getNarrativeStateSnapshot).not.toHaveBeenCalled();
    fireEvent.click(trigger);
    await waitFor(() => expect(client.getNarrativeStateSnapshot).toHaveBeenCalledWith("project-1"));
    fireEvent.click(screen.getByRole("button", { name: "Close state effects" }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("creates a typed effect before attaching it to the current owner", async () => {
    const client = persistence();
    render(<NarrativeEffectEditor nodes={nodes} owner={{ owner_version: 1, owner_kind: "node_entry", owner_id: "character-mara" }} persistence={client} projectId="project-1" />);
    fireEvent.click(screen.getByRole("button", { name: "State effects" }));
    await screen.findByText("No state changes at this step.");
    fireEvent.change(screen.getByLabelText("Readable explanation"), { target: { value: "Mara finds the ledger." } });
    fireEvent.click(screen.getByRole("button", { name: "Add effect" }));
    await waitFor(() => expect(client.createNarrativeEffect).toHaveBeenCalled());
    expect(client.createNarrativeEffectBinding).toHaveBeenCalledWith("project-1", expect.stringMatching(/^effect-/), expect.objectContaining({ owner_kind: "node_entry" }), 0);
  });

  it("requires an explicit relationship preview before applying initial custody", async () => {
    const client = persistence();
    vi.mocked(client.previewRelationshipInitialState).mockResolvedValue({ project_id: "project-1", edge_id: "edge-owns", flow_id: "flow-main", custody: { custody_version: 1, item_node_id: "item-ledger", holder: { holder_version: 1, kind: "character", node_id: "character-mara" } }, already_applied: false, conflict_holder: null });
    vi.mocked(client.applyRelationshipInitialState).mockResolvedValue({ changed: true, initial_state: { id: "state-main", state_version: 1, project_id: "project-1", flow_id: "flow-main", flags: {}, item_custody: [], quest_statuses: {}, created_at: "2026-08-07T10:00:00Z", updated_at: "2026-08-07T10:00:00Z" } });
    const flow = { flow: { id: "flow-main", name: "Main Story" } } as never;
    render(<RelationshipInitialHolderControl edge={{ id: "edge-owns", data: { label: "owns", relationshipType: "owns" } }} flows={[flow]} persistence={client} projectId="project-1" />);

    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByText("Review complete. This relationship can initialize the selected Flow.");
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(client.applyRelationshipInitialState).toHaveBeenCalledWith("project-1", "edge-owns", "flow-main"));
  });

  it("closes the application-order gap after deleting an owner effect", async () => {
    const client = persistence();
    const owner = { owner_version: 1 as const, owner_kind: "node_entry" as const, owner_id: "character-mara" };
    const timestamp = "2026-08-07T10:00:00Z";
    vi.mocked(client.getNarrativeStateSnapshot).mockResolvedValue({
      project_id: "project-1",
      initial_states: [],
      effects: [
        { effect_version: 1, id: "effect-1", project_id: "project-1", operation: "set_flag", payload: { flag: "first" }, repeat_policy: "once", explanation: "First" },
        { effect_version: 1, id: "effect-2", project_id: "project-1", operation: "set_flag", payload: { flag: "second" }, repeat_policy: "once", explanation: "Second" }
      ],
      bindings: [
        { binding_version: 1, id: "binding-1", project_id: "project-1", effect_id: "effect-1", owner, application_order: 0, created_at: timestamp, updated_at: timestamp },
        { binding_version: 1, id: "binding-2", project_id: "project-1", effect_id: "effect-2", owner, application_order: 1, created_at: timestamp, updated_at: timestamp }
      ],
      integrity: { project_id: "project-1", facts: [] }
    });
    render(<NarrativeEffectEditor nodes={nodes} owner={owner} persistence={client} projectId="project-1" />);
    fireEvent.click(screen.getByRole("button", { name: "State effects" }));
    await screen.findByText("First");
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]!);

    await waitFor(() => expect(client.reorderNarrativeEffectBindings).toHaveBeenCalledWith("project-1", owner, [
      { binding_id: "binding-2", application_order: 0 }
    ]));
  });
});

import { fireEvent, render } from "@testing-library/react";
import type { Node } from "@xyflow/react";
import { expect, it, vi } from "vitest";
import type { QuestDocument } from "../../quest/contracts";
import type { NarrativeNodeData } from "../../types";
import { QuestEditorDialog, QuestReferencePicker } from "./QuestEditorDialog";

const node: Node<NarrativeNodeData> = { id: "quest", position: { x: 0, y: 0 },
  data: { kind: "Quest", title: "Gate", label: "Gate", summary: "Text", tags: [] } };
const document: QuestDocument = { quest_version: 1, objective: "Open the gate", quest_giver_node_id: null,
  entry_stage_id: null, prerequisite_node_ids: [], reward_node_ids: [], stages: [] };
const actions = () => ({ onClose: vi.fn(), onCreateTransition: vi.fn(), onDeleteTransition: vi.fn(), onSave: vi.fn(), onSaveNodeText: vi.fn(), onUpdateTransition: vi.fn() });

it("does not reprepare 1000 immutable reference node kinds on a local objective edit", () => {
  let reads = 0;
  const nodes: Node<NarrativeNodeData>[] = Array.from({ length: 1000 }, (_, i) => ({ ...node, id: `lore-${i}`,
    data: { ...node.data, get kind() { reads++; return "Lore" as const; } } }));
  const props = { document, node, nodes, transitions: [], ...actions() };
  const view = render(<QuestEditorDialog {...props} />), first = reads;
  expect(first).toBe(3000);
  fireEvent.change(view.getByLabelText("Objective"), { target: { value: "Changed locally" } });
  expect(reads - first).toBe(0);
  const before = reads;
  view.rerender(<QuestEditorDialog {...props} nodes={[...nodes]} />);
  expect(reads - before).toBe(3000);
});

it("keeps 100 stage descriptions visible without mounting every stage in each inactive branch select", () => {
  const count = 100;
  const long: QuestDocument = { ...document, entry_stage_id: "stage-0", stages: Array.from({ length: count }, (_, i) => ({
    id: `stage-${i}`, title: `Stage ${i}`, description: `Description ${i}`,
    branches: [{ id: `branch-${i}`, label: `Branch ${i}`, condition: "", target_stage_id: null }] })) };
  const view = render(<QuestEditorDialog document={long} node={node} nodes={[]} transitions={[]} {...actions()} />);
  // Count controls directly; do not benchmark JSDOM's quadratic accessible-name traversal.
  expect(view.container.querySelectorAll('textarea[id^="quest-stage-description-"]')).toHaveLength(count);
  const selectors = [...view.container.querySelectorAll("select")];
  // Quest giver is the only non-stage selector in this fixture.
  const next = selectors.slice(1); expect(next).toHaveLength(count);
  expect(next.reduce((total, select) => total + select.options.length, 0)).toBeLessThanOrEqual(count * 2);
});

it("preserves reference search text and uses current labels, selection and toggle callbacks", () => {
  const item = { ...node, id: "item", data: { ...node.data, kind: "Item" as const, title: "Key", summary: "Magic key" } };
  const firstToggle = vi.fn(), latestToggle = vi.fn();
  const view = render(<QuestReferencePicker label="Rewards" nodes={[item]} selectedIds={[]} onToggle={firstToggle} />);
  const search = view.getByLabelText("Search Rewards"); fireEvent.change(search, { target: { value: "magic" } });
  const renamed = { ...item, data: { ...item.data, title: "Silver key" } };
  view.rerender(<QuestReferencePicker label="Rewards" nodes={[renamed]} selectedIds={[item.id]} onToggle={latestToggle} />);
  expect(search).toHaveValue("magic"); const checkbox = view.getByRole("checkbox", { name: "Silver key" });
  expect(checkbox).toBeChecked(); fireEvent.click(checkbox); expect(latestToggle).toHaveBeenCalledWith("item");
  expect(firstToggle).not.toHaveBeenCalled();
});

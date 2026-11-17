import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { Node } from "@xyflow/react";
import type { DialogueDocument } from "../../dialogue/contracts";
import type { NarrativeNodeData } from "../../types";
import { DialogueBranchEditor } from "./DialogueEditorDialog";

it("keeps all branch text/controls available without mounting N targets in every inactive selector", () => {
  const count = 100;
  const node: Node<NarrativeNodeData> = { id: "dialogue", position: { x: 0, y: 0 },
    data: { kind: "Dialogue", title: "Gate", label: "Gate", summary: "", tags: [] } };
  const character = { ...node, id: "actor", data: { ...node.data, kind: "Character" as const } };
  const document: DialogueDocument = { dialogue_version: 1, participants: [character.id], entry_element_id: "line-0",
    elements: Array.from({ length: count }, (_, i) => ({ id: `line-${i}`, kind: "line", text: `Line ${i}`,
      speaker_node_id: character.id, next_element_id: i ? "line-0" : null })) };
  const view = render(<DialogueBranchEditor characters={[character]} dialogueNode={node} document={document} persistedDocument={document}
    issues={[]} nodes={[node, character]} transitions={[]} placementId={null} onChange={vi.fn()}
    onCreateTransition={vi.fn()} onDeleteTransition={vi.fn()} onUpdateTransition={vi.fn()} />);
  expect(view.getAllByRole("textbox", { name: "Text" })).toHaveLength(count);
  const selectors = view.getAllByLabelText("Next"); expect(selectors).toHaveLength(count);
  expect(selectors.reduce((total, select) => total + select.querySelectorAll("option").length, 0)).toBeLessThanOrEqual(count * 2);
});

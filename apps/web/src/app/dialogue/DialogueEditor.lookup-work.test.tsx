import { act, render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import type { DialogueDocument } from "../../dialogue/contracts";
import type { NarrativeEdgeData, NarrativeIssue, NarrativeNodeData } from "../../types";
import { DialogueBranchEditor } from "./DialogueEditorDialog";

it("builds persisted/transition/issue lookups once and retains them on draft text changes", () => {
  const count = 50, reads = { persisted: 0, transition: 0, issue: 0 };
  const node: Node<NarrativeNodeData> = { id: "dialogue", position: { x: 0, y: 0 },
    data: { kind: "Dialogue", title: "Gate", label: "Gate", summary: "", tags: [] } };
  const character = { ...node, id: "actor", data: { ...node.data, kind: "Character" as const } };
  const document: DialogueDocument = { dialogue_version: 1, participants: [character.id], entry_element_id: "line-0",
    elements: Array.from({ length: count }, (_, i) => ({ id: `line-${i}`, kind: "line", text: `Line ${i}`,
      speaker_node_id: character.id, next_element_id: null })) };
  const persistedDocument = { ...document, elements: document.elements.map((element) => ({ ...element,
    get id() { reads.persisted++; return element.id; } })) };
  const transitions: Edge<NarrativeEdgeData>[] = document.elements.map((element, i) => ({ id: `edge-${i}`, source: node.id, target: character.id,
    data: { get dialogueElementId() { reads.transition++; return element.id; } } as NarrativeEdgeData }));
  const issues: NarrativeIssue[] = document.elements.map((element, i) => ({ id: `issue-${i}`, projectId: "project",
    title: "Check branch", description: "Fix branch", severity: "warning", status: "open",
    get dialogueOwnerIds() { reads.issue++; return [element.id]; } }));
  const props = { characters: [character], dialogueNode: node, document, persistedDocument, transitions, issues, nodes: [node, character],
    placementId: null, onChange: vi.fn(), onCreateTransition: vi.fn(), onDeleteTransition: vi.fn(), onUpdateTransition: vi.fn() };
  const view = render(<DialogueBranchEditor {...props} />);
  expect(reads).toEqual({ persisted: count, transition: count, issue: count });
  const input = view.getByDisplayValue("Line 0"); act(() => input.focus());
  view.rerender(<DialogueBranchEditor {...props} document={{ ...document,
    elements: document.elements.map((element, i) => i ? element : { ...element, text: "Typed locally" }) }} />);
  expect(reads).toEqual({ persisted: count, transition: count, issue: count });
  expect(view.getByDisplayValue("Typed locally")).toBe(input); expect(input).toHaveFocus();
  view.rerender(<DialogueBranchEditor {...props} persistedDocument={{ ...persistedDocument }} transitions={[...transitions]} issues={[...issues]} />);
  expect(reads).toEqual({ persisted: count * 2, transition: count * 2, issue: count * 2 });
});

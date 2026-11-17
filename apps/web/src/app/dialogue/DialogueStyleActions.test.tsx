import { fireEvent, render, screen } from "@testing-library/react";
import type { Node } from "@xyflow/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DialogueDocument } from "../../dialogue/contracts";
import { i18next } from "../../localization/i18n";
import type { NarrativeNodeData } from "../../types";
import { DialogueBranchEditor } from "./DialogueEditorDialog";

const dialogueNode: Node<NarrativeNodeData> = {
  id: "dialogue-one",
  position: { x: 0, y: 0 },
  data: { kind: "Dialogue", label: "Gate", title: "Gate", summary: "A guarded exchange.", tags: [] }
};
const character: Node<NarrativeNodeData> = {
  id: "character-one",
  position: { x: 0, y: 0 },
  data: { kind: "Character", label: "Guard", title: "Guard", summary: "", tags: [] }
};
const dialogue: DialogueDocument = {
  dialogue_version: 1,
  entry_element_id: "line-one",
  participants: [character.id],
  elements: [
    { id: "line-one", kind: "line", next_element_id: "choice-one", speaker_node_id: character.id, text: "State your purpose." },
    {
      id: "choice-one",
      kind: "choice",
      prompt: "How do you answer?",
      options: [{ id: "option-one", condition: "", next_element_id: null, text: "I carry the ledger." }]
    }
  ]
};

describe("Dialogue Style actions", () => {
  beforeEach(async () => {
    await i18next.changeLanguage("en");
  });

  it("launches exact stable targets for a line, prompt, and answer", () => {
    const onStyleLaunch = vi.fn();
    render(
      <DialogueBranchEditor
        characters={[character]}
        dialogueNode={dialogueNode}
        document={dialogue}
        issues={[]}
        nodes={[dialogueNode, character]}
        onChange={vi.fn()}
        onCreateTransition={vi.fn()}
        onDeleteTransition={vi.fn()}
        onStyleLaunch={onStyleLaunch}
        onUpdateTransition={vi.fn()}
        persistedDocument={dialogue}
        placementId="placement-dialogue"
        transitions={[]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Get style recommendation: Dialogue line line-one" }));
    fireEvent.click(screen.getByRole("button", { name: "Get style recommendation: Choice prompt choice-one" }));
    fireEvent.click(screen.getByRole("button", { name: "Get style recommendation: Answer option-one" }));

    expect(onStyleLaunch.mock.calls.map(([value]) => value.target)).toEqual([
      { kind: "dialogue_field", node_id: "dialogue-one", field_kind: "line_text", element_id: "line-one", option_id: null },
      { kind: "dialogue_field", node_id: "dialogue-one", field_kind: "choice_prompt", element_id: "choice-one", option_id: null },
      { kind: "dialogue_field", node_id: "dialogue-one", field_kind: "option_text", element_id: "choice-one", option_id: "option-one" }
    ]);
  });

  it("disables optional empty prompts and unsaved line text", () => {
    const changed: DialogueDocument = {
      ...dialogue,
      elements: [
        { ...dialogue.elements[0], text: "Changed locally." } as DialogueDocument["elements"][number],
        { ...dialogue.elements[1], prompt: "" } as DialogueDocument["elements"][number]
      ]
    };
    render(
      <DialogueBranchEditor
        characters={[character]}
        dialogueNode={dialogueNode}
        document={changed}
        issues={[]}
        nodes={[dialogueNode, character]}
        onChange={vi.fn()}
        onCreateTransition={vi.fn()}
        onDeleteTransition={vi.fn()}
        onStyleLaunch={vi.fn()}
        onUpdateTransition={vi.fn()}
        persistedDocument={dialogue}
        placementId={null}
        transitions={[]}
      />
    );

    expect(screen.getByRole("button", { name: "Get style recommendation: Dialogue line line-one" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Get style recommendation: Choice prompt choice-one" })).toBeDisabled();
  });
});

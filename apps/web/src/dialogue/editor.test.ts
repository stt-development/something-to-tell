import { describe, expect, it } from "vitest";
import { validateDialogueDocument, type DialogueDocument } from "./contracts";
import {
  appendChoiceOption,
  appendDialogueElement,
  deleteDialogueElement,
  dialogueDeletionImpact,
  duplicateDialogueElement,
  moveDialogueElement,
  updateChoiceOption,
  updateDialogueLine
} from "./editor";

describe("dialogue editor operations", () => {
  it("builds a valid linear conversation from an empty document", () => {
    let document: DialogueDocument = { dialogue_version: 1, elements: [], entry_element_id: null, participants: ["character-a"] };
    document = appendDialogueElement(document, "line");
    document = appendDialogueElement(document, "line");
    document = updateDialogueLine(document, "line-1", { next_element_id: "line-2", text: "Hello." });
    document = updateDialogueLine(document, "line-2", { text: "Welcome." });

    expect(document.entry_element_id).toBe("line-1");
    expect(document.elements).toHaveLength(2);
    expect(validateDialogueDocument(document)).toEqual([]);
  });

  it("adds and duplicates a branching choice with globally unique answer ids", () => {
    let document: DialogueDocument = {
      dialogue_version: 1,
      elements: [{ id: "line-1", kind: "line", next_element_id: null, speaker_node_id: "character-a", text: "Choose." }],
      entry_element_id: "line-1",
      participants: ["character-a"]
    };
    document = appendDialogueElement(document, "choice");
    document = appendChoiceOption(document, "choice-1");
    document = updateChoiceOption(document, "choice-1", "answer-1", { next_element_id: "line-1", text: "Loop." });
    document = duplicateDialogueElement(document, "choice-1");

    expect(document.elements.map((element) => element.id)).toEqual(["line-1", "choice-1", "choice-2"]);
    expect(document.elements[2]).toMatchObject({ kind: "choice", options: [{ id: "answer-2", next_element_id: "line-1" }] });
    expect(validateDialogueDocument(document)).toEqual([]);
  });

  it("reorders cyclic elements without changing their references", () => {
    const document: DialogueDocument = {
      dialogue_version: 1,
      entry_element_id: "line-a",
      participants: ["character-a"],
      elements: [
        { id: "line-a", kind: "line", next_element_id: "line-b", speaker_node_id: "character-a", text: "Again?" },
        { id: "line-b", kind: "line", next_element_id: "line-a", speaker_node_id: "character-a", text: "Again." }
      ]
    };

    const reordered = moveDialogueElement(document, "line-b", "up");

    expect(reordered.elements.map((element) => element.id)).toEqual(["line-b", "line-a"]);
    expect(validateDialogueDocument(reordered)).toEqual([]);
  });

  it("reports affected branches and safely converts them to endings on deletion", () => {
    const document: DialogueDocument = {
      dialogue_version: 1,
      entry_element_id: "line-target",
      participants: ["character-a"],
      elements: [
        { id: "line-target", kind: "line", next_element_id: null, speaker_node_id: "character-a", text: "Target" },
        { id: "line-source", kind: "line", next_element_id: "line-target", speaker_node_id: "character-a", text: "Source" },
        {
          id: "choice-1",
          kind: "choice",
          prompt: "Choose",
          options: [{ condition: "", id: "answer-1", next_element_id: "line-target", text: "Target" }]
        }
      ]
    };

    expect(dialogueDeletionImpact(document, "line-target")).toEqual({
      incomingOrigins: ["line-source", "answer-1"],
      removesEntry: true
    });
    const deleted = deleteDialogueElement(document, "line-target");
    expect(deleted.entry_element_id).toBe("line-source");
    expect(deleted.elements).toMatchObject([
      { id: "line-source", next_element_id: null },
      { id: "choice-1", options: [{ id: "answer-1", next_element_id: null }] }
    ]);
    expect(validateDialogueDocument(deleted)).toEqual([]);
  });
});

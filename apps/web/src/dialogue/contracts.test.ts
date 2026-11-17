import { describe, expect, it } from "vitest";
import { createEmptyDialogueDocument, type DialogueDocument, validateDialogueDocument } from "./contracts";

describe("dialogue contracts", () => {
  it("accepts a branching multi-character dialogue", () => {
    const document: DialogueDocument = {
      dialogue_version: 1,
      entry_element_id: "line-question",
      participants: ["character-keeper", "character-player"],
      elements: [
        {
          id: "line-question",
          kind: "line",
          speaker_node_id: "character-keeper",
          text: "Why should I open the door?",
          next_element_id: "choice-answer"
        },
        {
          id: "choice-answer",
          kind: "choice",
          prompt: "Choose an answer",
          options: [
            { id: "answer-truth", text: "Show the seal.", condition: "seal_acquired", next_element_id: null },
            { id: "answer-leave", text: "Leave.", condition: "", next_element_id: null }
          ]
        }
      ]
    };

    expect(validateDialogueDocument(document)).toEqual([]);
  });

  it("accepts cycles and an empty document", () => {
    const cycle: DialogueDocument = {
      dialogue_version: 1,
      entry_element_id: "line-a",
      participants: ["character-a", "character-b"],
      elements: [
        { id: "line-a", kind: "line", speaker_node_id: "character-a", text: "Again?", next_element_id: "line-b" },
        { id: "line-b", kind: "line", speaker_node_id: "character-b", text: "Again.", next_element_id: "line-a" }
      ]
    };

    expect(validateDialogueDocument(cycle)).toEqual([]);
    expect(validateDialogueDocument(createEmptyDialogueDocument())).toEqual([]);
  });

  it("reports malformed references and duplicate ids", () => {
    const document: DialogueDocument = {
      dialogue_version: 1,
      entry_element_id: "missing-entry",
      participants: ["character-a", "character-a"],
      elements: [
        { id: "line-a", kind: "line", speaker_node_id: "character-missing", text: "Hello", next_element_id: "missing-next" },
        {
          id: "choice-a",
          kind: "choice",
          prompt: "Answer",
          options: [{ id: "line-a", text: "Duplicate id", condition: "", next_element_id: null }]
        }
      ]
    };

    expect(validateDialogueDocument(document).map((issue) => issue.code)).toEqual([
      "duplicate_participant",
      "invalid_speaker",
      "invalid_next",
      "duplicate_id",
      "invalid_entry"
    ]);
  });

  it("reports empty authored line and answer text before runtime persistence", () => {
    const document: DialogueDocument = {
      dialogue_version: 1,
      entry_element_id: "line-empty",
      participants: ["character-a"],
      elements: [
        { id: "line-empty", kind: "line", speaker_node_id: "character-a", text: "", next_element_id: "choice-empty" },
        {
          id: "choice-empty",
          kind: "choice",
          prompt: "Choose",
          options: [{ id: "answer-empty", text: "", condition: "", next_element_id: null }]
        }
      ]
    };

    expect(validateDialogueDocument(document).map((issue) => issue.code)).toEqual(["empty_text", "empty_text"]);
  });
});

import { describe, expect, it } from "vitest";
import type { DialogueDocument } from "./contracts";
import { dialogueCanvasMetrics } from "./presentation";

describe("dialogue canvas presentation", () => {
  it("returns zero metrics for legacy and empty dialogues", () => {
    expect(dialogueCanvasMetrics(undefined)).toEqual({ choices: 0, endings: 0, lines: 0, participants: 0 });
    expect(dialogueCanvasMetrics({ dialogue_version: 1, elements: [], entry_element_id: null, participants: [] })).toEqual({
      choices: 0,
      endings: 0,
      lines: 0,
      participants: 0
    });
  });

  it("counts lines, choices, participants, and terminal branches", () => {
    const document: DialogueDocument = {
      dialogue_version: 1,
      entry_element_id: "line-a",
      participants: ["character-a", "character-b"],
      elements: [
        { id: "line-a", kind: "line", next_element_id: "choice-a", speaker_node_id: "character-a", text: "Choose." },
        {
          id: "choice-a",
          kind: "choice",
          prompt: "Answer",
          options: [
            { condition: "", id: "answer-end", next_element_id: null, text: "Stay." },
            { condition: "", id: "answer-action", next_element_id: "line-b", text: "Act." }
          ]
        },
        { id: "line-b", kind: "line", next_element_id: null, speaker_node_id: "character-b", text: "Go." }
      ]
    };

    expect(dialogueCanvasMetrics(document)).toEqual({ choices: 1, endings: 2, lines: 2, participants: 2 });
    expect(dialogueCanvasMetrics(document, ["line-b"])).toEqual({ choices: 1, endings: 1, lines: 2, participants: 2 });
  });
});

import { describe, expect, it } from "vitest";
import { createQuestDocument, validateQuestDocument } from "./contracts";

describe("Quest contracts", () => {
  it("lazily initializes a valid one-stage document", () => {
    const document = createQuestDocument("Smuggler Route", "Open the harbor route.");

    expect(document.objective).toBe("Open the harbor route.");
    expect(document.entry_stage_id).toBe("stage-1");
    expect(validateQuestDocument(document)).toEqual([]);
  });

  it("reports duplicate ids and dangling stage targets", () => {
    const document = createQuestDocument("Route", "");
    document.stages[0]!.branches = [
      { id: "same", label: "", condition: "", target_stage_id: "missing" },
      { id: "same", label: "Second", condition: "", target_stage_id: null }
    ];

    expect(validateQuestDocument(document).map((entry) => entry.code)).toEqual([
      "empty_branch_label",
      "duplicate_id",
      "invalid_stage_target"
    ]);
  });
});

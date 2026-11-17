import { describe, expect, it } from "vitest";
import { createQuestDocument, validateQuestDocument } from "./contracts";
import { appendQuestBranch, appendQuestStage, deleteQuestStage, duplicateQuestStage, moveQuestStage, questStageDeletionImpact, updateQuestBranch } from "./editor";

describe("Quest editor operations", () => {
  it("adds, duplicates, and reorders stages without rewriting stable ids", () => {
    let document = appendQuestStage(createQuestDocument("Route", "Leave harbor"));
    const secondId = document.stages[1]!.id;
    document = duplicateQuestStage(document, secondId);
    const duplicateId = document.stages[2]!.id;
    document = moveQuestStage(document, duplicateId, "up");

    expect(document.stages.map((stage) => stage.id)).toEqual(["stage-1", duplicateId, secondId]);
    expect(new Set(document.stages.map((stage) => stage.id)).size).toBe(3);
    expect(validateQuestDocument(document)).toEqual([]);
  });

  it("reports deletion impact and detaches incoming branches", () => {
    let document = appendQuestStage(createQuestDocument("Route", "Leave harbor"));
    const secondId = document.stages[1]!.id;
    document = appendQuestBranch(document, "stage-1");
    const branchId = document.stages[0]!.branches[0]!.id;
    document = updateQuestBranch(document, "stage-1", branchId, { target_stage_id: secondId });

    expect(questStageDeletionImpact(document, secondId)).toEqual({ incomingBranchIds: [branchId], removesEntry: false });
    expect(deleteQuestStage(document, secondId).stages[0]!.branches[0]!.target_stage_id).toBeNull();
  });
});

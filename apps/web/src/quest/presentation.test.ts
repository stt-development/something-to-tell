import { describe, expect, it } from "vitest";
import { createQuestDocument } from "./contracts";
import { questCanvasMetrics } from "./presentation";

describe("Quest presentation", () => {
  it("derives stage, branch, prerequisite, and reward counts", () => {
    const document = createQuestDocument("Route", "Leave harbor");
    document.prerequisite_node_ids = ["condition-ledger"];
    document.reward_node_ids = ["item-pass"];
    document.stages[0]!.branches = [{ id: "branch-leave", label: "Leave", condition: "", target_stage_id: null }];

    expect(questCanvasMetrics(document)).toEqual({ branches: 1, prerequisites: 1, rewards: 1, stages: 1 });
  });
});

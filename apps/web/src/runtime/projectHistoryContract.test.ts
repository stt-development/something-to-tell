import {
  PROJECT_HISTORY_CAPACITY,
  PROJECT_HISTORY_VERSION,
  type ProjectHistorySummary
} from "@something-to-tell/contracts/project-history";
import { describe, expect, it } from "vitest";

describe("shared bounded project history contract", () => {
  it("exposes only bounded command metadata and no reversible patch payload", () => {
    const history: ProjectHistorySummary = {
      history_version: PROJECT_HISTORY_VERSION,
      history_revision: 3,
      capacity: PROJECT_HISTORY_CAPACITY,
      undo_depth: 1,
      redo_depth: 0,
      next_undo: {
        command_id: "command-3",
        command_kind: "update_node",
        label_key: "history.command.updateNode",
        label_parameters: { name: "Harbor" }
      },
      next_redo: null
    };

    expect(history.capacity).toBe(10);
    expect(history.next_undo?.label_parameters).toEqual({ name: "Harbor" });
    expect(history.next_undo).not.toHaveProperty("forward_patch");
    expect(history.next_undo).not.toHaveProperty("inverse_patch");
  });
});

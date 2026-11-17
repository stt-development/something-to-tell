import {
  PROJECT_PATCH_VERSION,
  PROJECT_RECORD_COLLECTIONS,
  projectPatchOperationTarget,
  projectPatchRecordId,
  type ProjectPatch
} from "@something-to-tell/contracts/project-patch";
import { describe, expect, it } from "vitest";

describe("shared reversible project patch contract", () => {
  it("mirrors every runtime-owned ProjectDocument collection in stable order", () => {
    expect(PROJECT_RECORD_COLLECTIONS).toHaveLength(24);
    expect(PROJECT_RECORD_COLLECTIONS).toEqual([
      "nodes", "edges", "issues", "suggestions", "engine_tags",
      "engine_tag_definitions", "engine_tag_bindings", "legacy_engine_tags", "placements",
      "dialogues", "quests", "story_flows", "story_flow_nodes", "flow_transitions",
      "scene_flow_boundaries", "flow_invocations", "flow_exits", "flow_exit_bindings",
      "flow_initial_states", "narrative_effects", "narrative_effect_bindings",
      "style_profiles", "scene_style_assignments", "agent_memories"
    ]);
  });

  it("uses node ownership for specialized documents and id ownership elsewhere", () => {
    expect(projectPatchRecordId("dialogues", { node_id: "dialogue-1" })).toBe("dialogue-1");
    expect(projectPatchRecordId("quests", { node_id: "quest-1" })).toBe("quest-1");
    expect(projectPatchRecordId("nodes", { id: "node-1" })).toBe("node-1");
    expect(() => projectPatchRecordId("edges", { id: "" })).toThrow(/non-empty id/);
  });

  it("exposes deterministic operation targets for frontend reconciliation", () => {
    const patch: ProjectPatch = {
      patch_version: PROJECT_PATCH_VERSION,
      patch_id: "patch-1",
      project_id: "project-1",
      source_checksum: "a".repeat(64),
      target_checksum: "b".repeat(64),
      operations: [
        { op: "replace_project_metadata", value: {} },
        { op: "remove_record", collection: "nodes", record_id: "node-1" }
      ]
    };

    expect(patch.operations.map(projectPatchOperationTarget)).toEqual([
      "1:project_metadata",
      "02:nodes:node-1"
    ]);
  });
});

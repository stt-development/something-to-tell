import { describe, expect, it } from "vitest";
import { createCanvasSelection, NARRATIVE_EDGE_TYPES, NARRATIVE_NODE_KINDS, SCENE_ANALYSIS_PATCH_OPERATIONS } from "./types";

describe("shared frontend contracts", () => {
  it("exposes scene analysis patch operations used by the runtime schema", () => {
    expect(SCENE_ANALYSIS_PATCH_OPERATIONS).toEqual(["create_node", "update_node", "create_edge", "update_edge"]);
  });

  it("keeps phase 3 analysis contracts aligned with graph taxonomy constants", () => {
    expect(NARRATIVE_NODE_KINDS).toContain("Scene");
    expect(NARRATIVE_NODE_KINDS).toContain("Dialogue");
    expect(NARRATIVE_EDGE_TYPES).toContain("reveals");
    expect(NARRATIVE_EDGE_TYPES).toContain("depends_on");
  });

  it("keeps transient canvas selections ordered and duplicate-free", () => {
    expect(createCanvasSelection(["node-a", "node-a", "node-b"], ["edge-a", "edge-a"])).toEqual({
      edgeIds: ["edge-a"],
      nodeIds: ["node-a", "node-b"]
    });
  });
});

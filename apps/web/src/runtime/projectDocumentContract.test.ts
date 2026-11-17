import {
  PROJECT_DOCUMENT_VERSION,
  type ProjectDocument
} from "@something-to-tell/contracts/project-document";
import {
  PROJECT_SETTINGS_VERSION,
  createDefaultProjectSettings
} from "@something-to-tell/contracts/project-manifest";
import { describe, expect, it } from "vitest";
import type { DialogueDocument } from "../dialogue/contracts";
import type { QuestDocument } from "../quest/contracts";
import type { RuntimeProjectDocument } from "./projectDocumentContract";

describe("shared complete project document contract", () => {
  it("exposes one versioned snapshot without transient playback or UI fields", () => {
    const document = emptyDocument();

    expect(document.document_version).toBe(PROJECT_DOCUMENT_VERSION);
    expect(Object.keys(document)).not.toContain("playback_sessions");
    expect(Object.keys(document)).not.toContain("selection");
    expect(Object.keys(document)).not.toContain("search_query");
  });

  it("binds existing Dialogue and Quest document contracts as owned sections", () => {
    const document: RuntimeProjectDocument = emptyDocument();
    const dialogue: DialogueDocument = {
      dialogue_version: 1,
      entry_element_id: null,
      participants: [],
      elements: []
    };
    const quest: QuestDocument = {
      quest_version: 1,
      objective: "",
      quest_giver_node_id: null,
      entry_stage_id: null,
      prerequisite_node_ids: [],
      reward_node_ids: [],
      stages: []
    };

    document.dialogues.push({ node_id: "dialogue", document: dialogue });
    document.quests.push({ node_id: "quest", document: quest });

    expect(document.dialogues[0]?.document.dialogue_version).toBe(1);
    expect(document.quests[0]?.document.quest_version).toBe(1);
  });
});

function emptyDocument(): ProjectDocument<DialogueDocument, QuestDocument> {
  const now = "2026-07-28T12:00:00+00:00";
  return {
    document_version: PROJECT_DOCUMENT_VERSION,
    checksum: "0".repeat(64),
    manifest: {
      format_version: 2,
      project_id: "project",
      name: "Project",
      description: "",
      created_at: now,
      updated_at: now,
      saved_revision: 0,
      settings_version: PROJECT_SETTINGS_VERSION,
      settings: createDefaultProjectSettings(),
      asset_paths: []
    },
    project_metadata: {},
    nodes: [],
    edges: [],
    issues: [],
    suggestions: [],
    engine_tags: [],
    placements: [],
    dialogues: [],
    quests: [],
    story_flows: [],
    story_flow_nodes: [],
    flow_transitions: [],
    scene_flow_boundaries: [],
    flow_invocations: [],
    flow_exits: [],
    flow_exit_bindings: [],
    flow_initial_states: [],
    narrative_effects: [],
    narrative_effect_bindings: [],
    style_profiles: [],
    scene_style_assignments: [],
    agent_memories: []
  };
}

import { describe, expect, it } from "vitest";
import { projectFixture } from "../testFixtures/projectFixtures";
import {
  type PlaybackCanonicalNode,
  type PlaybackDefinition,
  type PlaybackTypedEffect,
  validatePlaybackDefinition
} from "./contracts";

const PROJECT_AURORA_STORY_FLOWS = projectFixture("aurora").storyFlows;

function node(id: string, type = "Event"): PlaybackCanonicalNode {
  return {
    node_version: 1,
    id,
    project_id: "project-aurora",
    type,
    title: id,
    summary: "",
    body: "",
    status: "canon",
    metadata: {}
  };
}

function effect(updates: Partial<PlaybackTypedEffect> = {}): PlaybackTypedEffect {
  return {
    effect_version: 1,
    id: "effect-ledger",
    project_id: "project-aurora",
    flow_id: "flow-main-story",
    owner_node_id: null,
    owner_transition_id: "flow-transition-opening-dialogue",
    review_status: "accepted",
    repeatable: false,
    explanation: "Record that the ledger was acquired.",
    operation: "set_flag",
    payload: { flag: "ledger_acquired" },
    ...updates
  } as PlaybackTypedEffect;
}

function definition(): PlaybackDefinition {
  const flow = structuredClone(PROJECT_AURORA_STORY_FLOWS[0]!);
  return {
    definition_version: 1,
    project_id: "project-aurora",
    flow_snapshot: flow,
    canonical_nodes: flow.nodes.map((membership) =>
      node(
        membership.node_id,
        membership.node_id === "node-dock-dialogue" ? "Dialogue" : "Event"
      )
    ),
    dialogue_documents: {},
    quest_documents: {},
    typed_effect_definitions: [effect()],
    initial_state: { state_version: 1, flags: {}, inventory_node_ids: [], item_holders: {}, quest_states: {}, dialogue_choice_ids: {}, visited_node_ids: [], applied_effect_ids: [] },
    source_revision: "aurora-revision-1"
  };
}

describe("Playback contracts", () => {
  it("accepts a complete runtime-owned definition mirror", () => {
    expect(validatePlaybackDefinition(definition())).toEqual([]);
  });

  it("reports missing members, extra nodes, and stale specialized owners", () => {
    const value = definition();
    value.canonical_nodes = [
      ...value.canonical_nodes.filter((candidate) => candidate.id !== "node-sealed-ledger"),
      node("outside-flow")
    ];
    value.quest_documents = {
      "node-dock-dialogue": {
        quest_version: 1,
        objective: "",
        quest_giver_node_id: null,
        entry_stage_id: null,
        prerequisite_node_ids: [],
        reward_node_ids: [],
        stages: []
      }
    };

    expect(validatePlaybackDefinition(value).map((entry) => entry.code)).toEqual([
      "missing_member",
      "stale_ownership",
      "stale_ownership"
    ]);
  });

  it("reports duplicate ids and stale effect ownership deterministically", () => {
    const value = definition();
    value.typed_effect_definitions = [
      effect(),
      effect({ owner_node_id: "node-dock-dialogue", owner_transition_id: "missing-transition" })
    ];

    expect(validatePlaybackDefinition(value)).toEqual([
      {
        code: "duplicate_effect_id",
        message: "Duplicate effect id: effect-ledger",
        owner_id: "effect-ledger"
      },
      {
        code: "stale_ownership",
        message: "Effect has stale ownership: effect-ledger",
        owner_id: "effect-ledger"
      }
    ]);
  });
});

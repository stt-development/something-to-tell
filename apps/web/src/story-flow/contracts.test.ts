import { describe, expect, it } from "vitest";
import {
  FLOW_TRANSITION_KINDS,
  STORY_FLOW_KINDS,
  type FlowTransition,
  type SceneFlowBoundary,
  type StoryFlow,
  type StoryFlowNode,
  type StoryFlowSnapshot,
  validateStoryFlowSnapshot
} from "./contracts";

function flow(updates: Partial<StoryFlow> = {}): StoryFlow {
  return {
    flow_version: 1,
    id: "flow-main",
    project_id: "project-aurora",
    name: "Main Story",
    description: "Primary playable order.",
    kind: "main",
    status: "active",
    entry_node_id: "event-entry",
    metadata: {},
    created_at: "2026-07-22T10:00:00Z",
    updated_at: "2026-07-22T10:00:00Z",
    ...updates
  };
}

function member(nodeId: string, presentationOrder: number, updates: Partial<StoryFlowNode> = {}): StoryFlowNode {
  return {
    flow_node_version: 1,
    id: `membership-${nodeId}`,
    project_id: "project-aurora",
    flow_id: "flow-main",
    node_id: nodeId,
    presentation_order: presentationOrder,
    metadata: {},
    created_at: "2026-07-22T10:00:00Z",
    updated_at: "2026-07-22T10:00:00Z",
    ...updates
  };
}

function transition(id: string, source: string, target: string, priority: number, updates: Partial<FlowTransition> = {}): FlowTransition {
  return {
    transition_version: 1,
    id,
    project_id: "project-aurora",
    flow_id: "flow-main",
    source_node_id: source,
    target_node_id: target,
    kind: "next",
    label: "",
    condition: "",
    priority,
    is_default: false,
    metadata: {},
    created_at: "2026-07-22T10:00:00Z",
    updated_at: "2026-07-22T10:00:00Z",
    ...updates
  };
}

function boundary(updates: Partial<SceneFlowBoundary> = {}): SceneFlowBoundary {
  return {
    boundary_version: 1,
    id: "boundary-dock",
    project_id: "project-aurora",
    flow_id: "flow-main",
    scene_node_id: "scene-dock",
    entry_node_id: "dialogue-warning",
    exit_node_ids: ["event-departure"],
    metadata: {},
    created_at: "2026-07-22T10:00:00Z",
    updated_at: "2026-07-22T10:00:00Z",
    ...updates
  };
}

function validSnapshot(): StoryFlowSnapshot {
  return {
    snapshot_version: 1,
    flow: flow(),
    nodes: [
      member("event-entry", 0),
      member("scene-dock", 1),
      member("dialogue-warning", 2),
      member("event-departure", 3)
    ],
    transitions: [
      transition("transition-enter", "event-entry", "scene-dock", 0),
      transition("transition-dialogue", "scene-dock", "dialogue-warning", 0),
      transition("transition-departure", "dialogue-warning", "event-departure", 0, { kind: "branch", condition: "ledger_acquired" })
    ],
    scene_boundaries: [boundary()],
    scene_children: { "scene-dock": ["dialogue-warning", "event-departure"] }
  };
}

describe("Story Flow contracts", () => {
  it("mirrors the accepted flow and transition taxonomies", () => {
    expect(STORY_FLOW_KINDS).toEqual(["main", "side", "standalone"]);
    expect(FLOW_TRANSITION_KINDS).toEqual(["next", "branch", "optional", "return"]);
    expect(validateStoryFlowSnapshot(validSnapshot())).toEqual([]);
  });

  it("accepts an empty draft and rejects invalid active entry states", () => {
    expect(validateStoryFlowSnapshot({ ...validSnapshot(), flow: flow({ status: "draft", entry_node_id: null }), nodes: [], transitions: [], scene_boundaries: [], scene_children: {} })).toEqual([]);
    expect(validateStoryFlowSnapshot({ ...validSnapshot(), flow: flow({ entry_node_id: null }), nodes: [], transitions: [], scene_boundaries: [], scene_children: {} }).map((entry) => entry.code)).toEqual(["active_without_members"]);
    expect(validateStoryFlowSnapshot({ ...validSnapshot(), flow: flow({ entry_node_id: null }) }).map((entry) => entry.code)).toContain("missing_entry");
    expect(validateStoryFlowSnapshot({ ...validSnapshot(), flow: flow({ entry_node_id: "missing" }) }).map((entry) => entry.code)).toContain("invalid_entry");
  });

  it("reports project, flow, duplicate membership, and presentation ownership", () => {
    const snapshot = validSnapshot();
    snapshot.nodes.push(member("event-entry", 0, { project_id: "project-other", flow_id: "flow-other" }));

    expect(validateStoryFlowSnapshot(snapshot).map((entry) => entry.code)).toEqual([
      "project_mismatch",
      "flow_mismatch",
      "duplicate_membership_id",
      "duplicate_membership",
      "duplicate_presentation_order"
    ]);
  });

  it("reports malformed transitions and sibling ordering", () => {
    const snapshot = validSnapshot();
    snapshot.transitions = [
      transition("self", "event-entry", "event-entry", 0),
      transition("conditioned-default", "event-entry", "scene-dock", 1, { is_default: true, condition: "flag" }),
      transition("empty-branch", "event-entry", "event-departure", 2, { kind: "branch" }),
      transition("second-default", "event-entry", "event-departure", 1, { is_default: true })
    ];

    expect(validateStoryFlowSnapshot(snapshot).map((entry) => entry.code)).toEqual([
      "self_transition",
      "conditioned_default",
      "branch_without_condition",
      "duplicate_priority",
      "multiple_defaults"
    ]);
  });

  it("reports transition owner, duplicate id, and dangling endpoints", () => {
    const snapshot = validSnapshot();
    snapshot.transitions = [
      transition("same", "event-entry", "scene-dock", 0, { project_id: "project-other", flow_id: "flow-other" }),
      transition("same", "dialogue-warning", "missing", 0)
    ];

    expect(validateStoryFlowSnapshot(snapshot).map((entry) => entry.code)).toEqual([
      "project_mismatch",
      "flow_mismatch",
      "duplicate_transition_id",
      "invalid_endpoint"
    ]);
  });

  it("requires Scene boundaries to use unique flow-member canonical children", () => {
    const snapshot = validSnapshot();
    snapshot.scene_boundaries = [
      boundary({ exit_node_ids: ["event-departure", "event-departure"] }),
      boundary({ id: "boundary-copy", entry_node_id: "event-entry" })
    ];

    expect(validateStoryFlowSnapshot(snapshot).map((entry) => entry.code)).toEqual([
      "duplicate_exit",
      "duplicate_boundary",
      "invalid_scene_child"
    ]);
  });

  it("requires a composition child projection for every Scene boundary", () => {
    const snapshot = validSnapshot();
    snapshot.scene_children = {};

    expect(validateStoryFlowSnapshot(snapshot).map((entry) => entry.code)).toEqual(["missing_scene_projection"]);
  });
});

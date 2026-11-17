import { describe, expect, it } from "vitest";
import type { StoryFlowSnapshot } from "./contracts";
import {
  addMembershipLocally,
  continueExistingLocally,
  continueNewLocally,
  nextTransitionPriority,
  removeTransitionLocally,
  removeSceneBoundaryLocally,
  reorderOutgoingTransitions,
  setSceneBoundaryLocally,
  setEntryLocally
} from "./authoring";

const now = "2026-07-24T10:00:00Z";

function snapshot(): StoryFlowSnapshot {
  return {
    snapshot_version: 1,
    flow: {
      flow_version: 1, id: "flow", project_id: "project", name: "Main", description: "", kind: "main",
      status: "active", entry_node_id: "source", metadata: {}, created_at: now, updated_at: now
    },
    nodes: [
      { flow_node_version: 1, id: "member-source", project_id: "project", flow_id: "flow", node_id: "source", presentation_order: 0, metadata: {}, created_at: now, updated_at: now },
      { flow_node_version: 1, id: "member-a", project_id: "project", flow_id: "flow", node_id: "a", presentation_order: 1, metadata: {}, created_at: now, updated_at: now },
      { flow_node_version: 1, id: "member-b", project_id: "project", flow_id: "flow", node_id: "b", presentation_order: 2, metadata: {}, created_at: now, updated_at: now }
    ],
    transitions: [
      { transition_version: 1, id: "first", project_id: "project", flow_id: "flow", source_node_id: "source", target_node_id: "a", kind: "branch", label: "A", condition: "a", priority: 0, is_default: false, metadata: {}, created_at: now, updated_at: now },
      { transition_version: 1, id: "second", project_id: "project", flow_id: "flow", source_node_id: "source", target_node_id: "b", kind: "branch", label: "B", condition: "", priority: 1, is_default: true, metadata: {}, created_at: now, updated_at: now }
    ],
    scene_boundaries: [],
    scene_children: {}
  };
}

describe("Story Flow authoring fallback", () => {
  it("creates existing and new continuations as complete aggregate updates", () => {
    const ids = ["membership", "transition", "node", "new-membership", "new-transition"];
    const createId = () => ids.shift()!;
    const existing = continueExistingLocally(snapshot(), "a", "outside", {
      kind: "next", label: "", condition: "", priority: 0, is_default: false
    }, createId);
    const created = continueNewLocally(existing, "outside", {
      kind: "Event", title: "Gate opens", summary: "The guard opens the gate.", tags: []
    }, {
      kind: "next", label: "Enter", condition: "", priority: 0, is_default: false
    }, { x: 500, y: 120 }, createId);

    expect(existing.nodes.at(-1)).toMatchObject({ node_id: "outside", presentation_order: 3 });
    expect(existing.transitions.at(-1)).toMatchObject({ source_node_id: "a", target_node_id: "outside" });
    expect(created.node).toMatchObject({ id: "node-local-node", position: { x: 500, y: 120 } });
    expect(created.snapshot.transitions.at(-1)).toMatchObject({ source_node_id: "outside", target_node_id: "node-local-node" });
  });

  it("atomically adds a missing outcome source and target in the local fallback", () => {
    const value = { ...snapshot(), nodes: [], transitions: [], flow: { ...snapshot().flow, entry_node_id: null } };
    const ids = ["source-member", "target-member", "transition"];
    const result = continueExistingLocally(value, "dialogue", "event", {
      kind: "branch",
      label: "Open the gate",
      condition: "guard_agrees",
      priority: 0,
      is_default: false,
      metadata: { semantic_edge_id: "edge-outcome", dialogue_element_id: "line-agree" }
    }, () => ids.shift()!);

    expect(result.nodes.map((item) => item.node_id)).toEqual(["dialogue", "event"]);
    expect(result.flow.entry_node_id).toBe("dialogue");
    expect(result.transitions[0]).toMatchObject({
      source_node_id: "dialogue",
      target_node_id: "event",
      metadata: { semantic_edge_id: "edge-outcome", dialogue_element_id: "line-agree" }
    });

    const retargeted = continueExistingLocally(result, "dialogue", "other-event", {
      kind: "optional",
      label: "Use another gate",
      condition: "",
      priority: 0,
      is_default: false,
      metadata: { semantic_edge_id: "edge-outcome", dialogue_element_id: "line-agree" }
    }, () => "retarget");
    expect(retargeted.transitions).toHaveLength(1);
    expect(retargeted.transitions[0]).toMatchObject({
      id: result.transitions[0]?.id,
      target_node_id: "other-event",
      kind: "optional"
    });
  });

  it("sets and removes Scene boundaries without changing placements or transitions", () => {
    const value = {
      ...snapshot(),
      nodes: [
        ...snapshot().nodes,
        { ...snapshot().nodes[0]!, id: "member-scene", node_id: "scene", presentation_order: 3 },
        { ...snapshot().nodes[0]!, id: "member-entry", node_id: "entry", presentation_order: 4 },
        { ...snapshot().nodes[0]!, id: "member-exit", node_id: "exit", presentation_order: 5 }
      ]
    };
    const configured = setSceneBoundaryLocally(value, "scene", "entry", ["exit"], ["entry", "exit"], () => "boundary");

    expect(configured.scene_boundaries[0]).toMatchObject({
      id: "boundary-local-boundary",
      scene_node_id: "scene",
      entry_node_id: "entry",
      exit_node_ids: ["exit"]
    });
    expect(configured.transitions).toBe(value.transitions);
    expect(removeSceneBoundaryLocally(configured, "scene").scene_boundaries).toEqual([]);
  });

  it("rejects Scene boundary references outside canonical flow children", () => {
    expect(() => setSceneBoundaryLocally(snapshot(), "source", "a", ["outside"], ["a", "outside"]))
      .toThrow("must belong to the selected Story Flow");
    expect(() => setSceneBoundaryLocally(snapshot(), "source", "a", ["b"], ["a"]))
      .toThrow("must be canonical Scene children");
  });

  it("reorders, removes, and replaces entry without changing record identities", () => {
    const reordered = reorderOutgoingTransitions(snapshot(), "source", ["second", "first"]);
    expect(reordered.transitions.map(({ id, priority }) => [id, priority])).toEqual([["first", 1], ["second", 0]]);
    expect(removeTransitionLocally(reordered, "first").nodes).toEqual(snapshot().nodes);
    expect(setEntryLocally(snapshot(), "b").flow.entry_node_id).toBe("b");
    expect(() => setEntryLocally(snapshot(), "missing")).toThrow("must be a flow member");
  });

  it("chooses the first unused priority and rejects incomplete reorder commands", () => {
    expect(nextTransitionPriority(snapshot(), "source")).toBe(2);
    const withCall = {
      ...snapshot(),
      invocations: [{
        invocation_version: 1 as const,
        id: "call",
        project_id: "project",
        source_flow_id: "flow",
        source_node_id: "a",
        target_flow_id: "side",
        label: "",
        condition: "",
        priority: 0,
        is_default: false,
        created_at: now,
        updated_at: now
      }]
    };
    expect(nextTransitionPriority(withCall, "a")).toBe(1);
    expect(() => reorderOutgoingTransitions(snapshot(), "source", ["first"])).toThrow("every outgoing transition");
  });

  it("makes the first local membership the flow entry", () => {
    const empty = { ...snapshot(), nodes: [], transitions: [], flow: { ...snapshot().flow, entry_node_id: null } };
    const added = addMembershipLocally(empty, "first", () => "membership");

    expect(added.nodes[0]).toMatchObject({ id: "membership-local-membership", node_id: "first" });
    expect(added.flow.entry_node_id).toBe("first");
    expect(addMembershipLocally(added, "first")).toBe(added);
  });
});

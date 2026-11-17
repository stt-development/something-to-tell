import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import type { StoryFlowSnapshot } from "../story-flow/contracts";
import type { NarrativeNodeData } from "../types";
import { highlightCanonTargets, resolveCanonOwner } from "./navigation";

const nodes = [
  {
    id: "dialogue",
    data: {
      canonicalNodeId: "dialogue",
      dialogueDocument: {
        dialogue_version: 1,
        entry_element_id: "line",
        participants: [],
        elements: [{ id: "line", kind: "line", speaker_node_id: "hero", text: "Hello", next_element_id: null }]
      }
    }
  },
  {
    id: "quest",
    data: {
      canonicalNodeId: "quest",
      questDocument: {
        quest_version: 1,
        objective: "Reach the gate",
        quest_giver_node_id: null,
        entry_stage_id: "stage",
        prerequisite_node_ids: [],
        reward_node_ids: [],
        stages: [{ id: "stage", title: "Gate", description: "", branches: [{ id: "branch", label: "Open", condition: "", target_stage_id: null }] }]
      }
    }
  },
  { id: "linked", data: { canonicalNodeId: "hero", placementId: "placement" } }
] as Array<Node<NarrativeNodeData>>;

const flow = {
  flow: { id: "main" },
  nodes: [],
  transitions: [{ id: "transition" }],
  invocations: [{ id: "invocation" }],
  exits: [{ id: "exit" }],
  bindings: []
} as unknown as StoryFlowSnapshot;

const narrativeState = {
  project_id: "project",
  initial_states: [{ id: "initial", flow_id: "main" }],
  effects: [],
  bindings: [{ id: "binding", effect_id: "effect", owner: { owner_version: 1, owner_kind: "flow_transition", owner_id: "transition" } }],
  integrity: { project_id: "project", facts: [] }
} as never;

describe("Canon owner navigation", () => {
  it("resolves graph, Flow, and placement identities", () => {
    expect(resolveCanonOwner({ owner_type: "edge", owner_id: "edge", context_type: null, context_id: null }, nodes, [flow], null)).toMatchObject({ canvasEdgeId: "edge", surface: "graph" });
    expect(resolveCanonOwner({ owner_type: "flow_transition", owner_id: "transition", context_type: null, context_id: null }, nodes, [flow], null)).toMatchObject({ canvasEdgeId: "story-flow:transition", flowId: "main", surface: "flow" });
    expect(resolveCanonOwner({ owner_type: "placement", owner_id: "placement", context_type: null, context_id: null }, nodes, [flow], null)).toMatchObject({ nodeId: "hero", surface: "graph" });
  });

  it("finds nested Dialogue and Quest owners without relying on context depth", () => {
    expect(resolveCanonOwner({ owner_type: "dialogue_element", owner_id: "line", context_type: "node", context_id: "dialogue" }, nodes, [flow], null)).toMatchObject({ nodeId: "dialogue", surface: "dialogue" });
    expect(resolveCanonOwner({ owner_type: "quest_branch", owner_id: "branch", context_type: "quest_stage", context_id: "stage" }, nodes, [flow], null)).toMatchObject({ nodeId: "quest", surface: "quest" });
  });

  it("maps generated effects back to their bound temporal owner", () => {
    expect(resolveCanonOwner({ owner_type: "effect", owner_id: "effect", context_type: null, context_id: null }, nodes, [flow], narrativeState)).toMatchObject({
      surface: "temporal",
      temporalOwner: { owner_kind: "flow_transition", owner_id: "transition" }
    });
  });

  it("resolves exact Flow exits, bindings, boundaries, and initial state", () => {
    const caller = {
      flow: { id: "caller", entry_node_id: "dialogue" },
      nodes: [],
      transitions: [],
      invocations: [{ id: "call", source_node_id: "dialogue", target_flow_id: "callee" }],
      exits: [],
      bindings: [{ id: "binding", invocation_id: "call", exit_id: "exit", target_node_id: "quest" }],
      scene_boundaries: []
    } as unknown as StoryFlowSnapshot;
    const callee = {
      flow: { id: "callee", entry_node_id: "quest" },
      nodes: [],
      transitions: [],
      invocations: [],
      exits: [{ id: "exit", source_node_id: "quest" }],
      bindings: [],
      scene_boundaries: [{ id: "boundary", scene_node_id: "dialogue" }]
    } as unknown as StoryFlowSnapshot;

    expect(resolveCanonOwner({ owner_type: "flow_exit", owner_id: "exit", context_type: null, context_id: null }, nodes, [caller, callee], null)).toMatchObject({ found: true, flowId: "callee", sourceNodeId: "quest", surface: "flow" });
    expect(resolveCanonOwner({ owner_type: "flow_exit_binding", owner_id: "binding", context_type: null, context_id: null }, nodes, [caller, callee], null)).toMatchObject({ found: true, flowId: "caller", sourceNodeId: "dialogue", surface: "flow" });
    expect(resolveCanonOwner({ owner_type: "scene_boundary", owner_id: "boundary", context_type: null, context_id: null }, nodes, [caller, callee], null)).toMatchObject({ found: true, flowId: "callee", sourceNodeId: "dialogue", surface: "flow" });
    expect(resolveCanonOwner({ owner_type: "initial_state", owner_id: "initial", context_type: null, context_id: null }, nodes, [flow], narrativeState)).toMatchObject({ found: true, flowId: "main", surface: "temporal" });
  });

  it("reports deleted exact owners while retaining their parent context", () => {
    expect(resolveCanonOwner({ owner_type: "dialogue_option", owner_id: "deleted", context_type: "node", context_id: "dialogue" }, nodes, [flow], null)).toMatchObject({ found: false, nodeId: "dialogue", surface: "dialogue" });
    expect(resolveCanonOwner({ owner_type: "edge", owner_id: "deleted-edge", context_type: null, context_id: null }, nodes, [flow], null, [])).toMatchObject({ found: false, canvasEdgeId: "deleted-edge" });
  });

  it("highlights every selected target without adding canvas labels", () => {
    const projection = highlightCanonTargets(nodes, [{ id: "edge", source: "dialogue", target: "quest", data: { label: "leads" } }], {
      id: "issue",
      project_id: "project",
      title: "Conflict",
      description: "",
      severity: "critical",
      status: "resolved",
      repair: {
        capability_version: 1,
        kind: "none",
        action: "none",
        available: false,
        unavailable_reason: "canon.repair.unavailable.issue_inactive",
        source_checksum: "b".repeat(64)
      },
      metadata: {
        issue_version: 1,
        origin: "canon_rule",
        rule_id: "rule",
        rule_version: 1,
        fingerprint: "a".repeat(64),
        category: "test",
        message_key: "message",
        message_parameters: {},
        recommendation_key: null,
        recommendation_parameters: {},
        targets: [
          { owner_type: "node", owner_id: "dialogue", context_type: null, context_id: null },
          { owner_type: "edge", owner_id: "edge", context_type: null, context_id: null }
        ],
        evidence: [],
        agent_explanation: null,
        agent_recommendation: null,
        saved_revision: 1,
        source_checksum: "b".repeat(64),
        first_seen_at: "2026-08-21T10:00:00Z",
        last_seen_at: "2026-08-21T10:00:00Z",
        resolved_at: "2026-08-21T10:00:00Z",
        resolution_reason: "candidate_absent"
      }
    }, "Conflict preview");

    expect(projection.nodes.find((node) => node.id === "dialogue")?.data).toMatchObject({
      canonTarget: true,
      canonIssuePreview: "Conflict preview",
      canonIssueStatus: "resolved"
    });
    expect(projection.edges[0]).toMatchObject({
      data: { canonTarget: true, canonIssueSeverity: "critical" },
      style: { stroke: "#dc2626", strokeDasharray: "7 5", strokeWidth: 5 }
    });
  });
});

import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import type { NarrativeEdgeData, NarrativeNodeData } from "../types";
import { projectSessionToGraphSnapshot } from "../runtime/apiClient";
import { projectFixture } from "../testFixtures/projectFixtures";
import type { StoryFlowSnapshot } from "./contracts";
import { projectStoryDocument } from "./storyDocument";

const now = "2026-07-24T10:00:00Z";
const nodes = ["entry", "left", "right", "ending", "orphan"].map((id) => ({
  id,
  position: { x: 0, y: 0 },
  data: { kind: "Event", label: id, title: id, summary: `${id} text`, tags: [] }
})) satisfies Node<NarrativeNodeData>[];

function snapshot(): StoryFlowSnapshot {
  const flowId = "flow";
  return {
    snapshot_version: 1,
    flow: { flow_version: 1, id: flowId, project_id: "project", name: "Story", description: "", kind: "main", status: "active", entry_node_id: "entry", metadata: {}, created_at: now, updated_at: now },
    nodes: nodes.map((node, index) => ({ flow_node_version: 1, id: `member-${node.id}`, project_id: "project", flow_id: flowId, node_id: node.id, presentation_order: index, metadata: {}, created_at: now, updated_at: now })),
    transitions: [
      transition("a", "entry", "left", "branch", 0),
      transition("b", "entry", "right", "branch", 1),
      transition("c", "left", "ending", "next", 0),
      transition("d", "right", "ending", "next", 0),
      transition("e", "ending", "entry", "return", 0)
    ],
    scene_boundaries: [],
    scene_children: {}
  };
}

function transition(id: string, source: string, target: string, kind: "branch" | "next" | "return", priority: number) {
  return { transition_version: 1 as const, id, project_id: "project", flow_id: "flow", source_node_id: source, target_node_id: target, kind, label: id, condition: kind === "branch" ? `${id}_condition` : "", priority, is_default: false, metadata: {}, created_at: now, updated_at: now };
}

describe("projectStoryDocument", () => {
  it("renders ordered branches, rejoin and cycle references, and unreachable members", () => {
    const result = projectStoryDocument(nodes, [], snapshot());

    expect(result.sections.map((section) => [section.node.id, section.depth, section.reference])).toEqual([
      ["entry", 0, null],
      ["left", 1, null],
      ["ending", 1, null],
      ["entry", 2, "cycle"],
      ["right", 1, null],
      ["ending", 1, "rejoin"]
    ]);
    expect(result.unreachable.map((node) => node.id)).toEqual(["orphan"]);
  });

  it("keeps semantic relationships as context without adding them to reading order", () => {
    const edges: Edge<NarrativeEdgeData>[] = [{
      id: "semantic",
      source: "entry",
      target: "orphan",
      data: { label: "mentions clue", relationshipType: "mentions" }
    }];

    const result = projectStoryDocument(nodes, edges, snapshot());
    expect(result.sections[0]?.semanticContext).toEqual([{
      counterpartId: "orphan",
      counterpartTitle: "orphan",
      direction: "outgoing",
      label: "mentions clue",
      relationshipType: "mentions"
    }]);
    expect(result.sections.filter((section) => section.node.id === "orphan")).toHaveLength(0);
  });

  it("returns members diagnostically when a flow has no entry", () => {
    const value = snapshot();
    value.flow.entry_node_id = null;
    expect(projectStoryDocument(nodes, [], value)).toMatchObject({ sections: [], unreachable: nodes });
  });

  it("expands an explicit Scene boundary entry as document structure", () => {
    const value = snapshot();
    value.flow.entry_node_id = "entry";
    value.transitions = [];
    value.scene_boundaries = [{
      boundary_version: 1,
      id: "boundary",
      project_id: "project",
      flow_id: "flow",
      scene_node_id: "entry",
      entry_node_id: "left",
      exit_node_ids: ["left"],
      metadata: {},
      created_at: now,
      updated_at: now
    }];

    const result = projectStoryDocument(nodes, [], value);
    expect(result.sections.map((section) => [section.node.id, section.depth, section.boundarySceneId])).toEqual([
      ["entry", 0, null],
      ["left", 1, "entry"]
    ]);
  });

  it("preserves all ten nested branch levels for non-indenting presentation markers", () => {
    const deepNodes = Array.from({ length: 11 }, (_, index) => ({
      id: `depth-${index}`,
      position: { x: 0, y: 0 },
      data: {
        kind: "Event" as const,
        label: `Depth ${index}`,
        title: `Depth ${index}`,
        summary: `Story content at branch depth ${index}`,
        tags: []
      }
    })) satisfies Node<NarrativeNodeData>[];
    const value = snapshot();
    value.flow.entry_node_id = deepNodes[0]!.id;
    value.nodes = deepNodes.map((node, index) => ({
      flow_node_version: 1,
      id: `member-${node.id}`,
      project_id: "project",
      flow_id: "flow",
      node_id: node.id,
      presentation_order: index,
      metadata: {},
      created_at: now,
      updated_at: now
    }));
    value.transitions = deepNodes.slice(1).map((node, index) =>
      transition(`deep-${index}`, deepNodes[index]!.id, node.id, "branch", 0)
    );

    const result = projectStoryDocument(deepNodes, [], value);

    expect(result.sections.map((section) => section.depth)).toEqual(
      Array.from({ length: 11 }, (_, index) => index)
    );
    expect(result.sections.at(-1)?.node.id).toBe("depth-10");
  });

  it("expands Aurora calls with breadcrumbs, named exits, and mapped returns", () => {
    const fixture = projectFixture("aurora");
    const graph = projectSessionToGraphSnapshot(fixture.response);
    const main = fixture.storyFlows.find((flow) => flow.flow.id === "flow-main-story")!;

    const result = projectStoryDocument(graph.nodes, graph.edges, main, fixture.storyFlows);
    const call = result.entries.find((entry) => entry.kind === "call");
    const flowExit = result.entries.find((entry) => entry.kind === "exit");

    expect(call).toMatchObject({
      breadcrumbs: [{ flowId: "flow-main-story" }, { flowId: "flow-smuggler-route" }],
      cycle: false,
      invocation: { id: "flow-invocation-inspection-smuggler-route" },
      targetFlow: { flow: { id: "flow-smuggler-route" } }
    });
    expect(flowExit).toMatchObject({
      binding: { target_node_id: "node-route-consequence" },
      flowExit: { key: "success", label: "Patrol evaded" },
      targetNode: { id: "node-route-consequence" }
    });
    expect(result.sections.some((section) =>
      section.flowId === "flow-smuggler-route"
      && section.callPath.includes("flow-invocation-inspection-smuggler-route")
    )).toBe(true);
  });

  it("renders an unmapped exit as a draft and expands one reused flow at every call site", () => {
    const fixture = projectFixture("aurora");
    const graph = projectSessionToGraphSnapshot(fixture.response);
    const main = structuredClone(fixture.storyFlows.find((flow) => flow.flow.id === "flow-main-story")!);
    const original = main.invocations!.find((invocation) => invocation.id === "flow-invocation-inspection-smuggler-route")!;
    main.invocations = [
      original,
      { ...original, id: "flow-invocation-inspection-smuggler-route-duplicate", source_node_id: "node-dock-dialogue", priority: 2 }
    ];
    main.bindings = [];

    const result = projectStoryDocument(graph.nodes, graph.edges, main, [main, ...fixture.storyFlows.filter((flow) => flow.flow.id !== main.flow.id)]);
    const calls = result.entries.filter((entry) => entry.kind === "call");
    const sideEntries = result.sections.filter((section) => section.flowId === "flow-smuggler-route" && !section.reference);
    const exits = result.entries.filter((entry) => entry.kind === "exit");

    expect(calls).toHaveLength(2);
    expect(new Set(sideEntries.map((section) => section.callPath.join("/"))).size).toBe(2);
    expect(sideEntries.filter((section) => section.node.id === "node-smuggler-route").every((section) => section.node === graph.nodes.find((node) => node.id === "node-smuggler-route"))).toBe(true);
    expect(exits.every((entry) => entry.kind === "exit" && entry.binding === null && entry.targetNode === null)).toBe(true);
  });

  it("keeps ten nested calls in one reference-based projection column", () => {
    const nestedNodes = Array.from({ length: 11 }, (_, index) => ({
      id: `call-node-${index}`,
      position: { x: 0, y: 0 },
      data: { kind: "Event" as const, label: `Call ${index}`, title: `Call ${index}`, summary: "", tags: [] }
    })) satisfies Node<NarrativeNodeData>[];
    const nestedFlows = nestedNodes.map((node, index): StoryFlowSnapshot => ({
      snapshot_version: 1,
      flow: { flow_version: 1, id: `nested-flow-${index}`, project_id: "project", name: `Nested ${index}`, description: "", kind: index ? "side" : "main", status: "active", entry_node_id: node.id, metadata: {}, created_at: now, updated_at: now },
      nodes: [{ flow_node_version: 1, id: `nested-member-${index}`, project_id: "project", flow_id: `nested-flow-${index}`, node_id: node.id, presentation_order: 0, metadata: {}, created_at: now, updated_at: now }],
      transitions: [],
      scene_boundaries: [],
      scene_children: {},
      invocations: index < 10 ? [{ invocation_version: 1, id: `nested-call-${index}`, project_id: "project", source_flow_id: `nested-flow-${index}`, source_node_id: node.id, target_flow_id: `nested-flow-${index + 1}`, label: `Continue ${index}`, condition: "", priority: 0, is_default: true, created_at: now, updated_at: now }] : [],
      exits: [],
      bindings: []
    }));

    const result = projectStoryDocument(nestedNodes, [], nestedFlows[0]!, nestedFlows);

    expect(result.entries.filter((entry) => entry.kind === "call")).toHaveLength(10);
    expect(result.sections.at(-1)?.callPath).toHaveLength(10);
    expect(result.sections.map((section) => section.node)).toEqual(nestedNodes);
  });
});

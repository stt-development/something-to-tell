import { type Edge, type Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { projectFixture } from "../testFixtures/projectFixtures";
import type { NarrativeEdgeData, NarrativeNodeData } from "../types";
import {
  analyzeStoryFlow,
  defaultWorkspacePreference,
  emptyProjectStoryDraft,
  flowRouteArcPath,
  localStoryFlowIntegrity,
  projectGraphForWorkspace,
  shiftedFlowLabelPosition
} from "./workspace";

const PROJECT_AURORA_STORY_FLOWS = projectFixture("aurora").storyFlows;

const nodes: Node<NarrativeNodeData>[] = [
  { ...node("node-opening", "Scene", { x: 100, y: 80 }), data: { ...node("node-opening", "Scene", { x: 100, y: 80 }).data, isFrame: true } },
  { ...node("node-dock-dialogue", "Dialogue", { x: 24, y: 58 }), parentId: "node-opening" },
  node("node-inspection", "Event", { x: 700, y: 80 }),
  node("node-route-consequence", "Consequence", { x: 1000, y: 80 }),
  node("node-mara-runs-blockade", "Event", { x: 700, y: 320 }),
  node("node-sealed-ledger", "Item", { x: 1000, y: 320 }),
  node("node-smuggler-route", "Quest", { x: 1200, y: 520 }),
  node("worldbuilding", "Lore", { x: 40, y: 500 })
];
const relationshipEdges: Edge<NarrativeEdgeData>[] = [
  { id: "relationship", source: "worldbuilding", target: "node-opening", data: { label: "mentions", relationshipType: "mentions" } }
];

describe("Story Flow workspace projection", () => {
  it("keeps Graph and Story projections immutable and distinct", () => {
    const relationships = projectGraphForWorkspace(nodes, relationshipEdges, "relationships", null);
    const story = projectGraphForWorkspace(nodes, relationshipEdges, "story", null);

    expect(relationships).toEqual({ nodes, edges: relationshipEdges });
    expect(story).toEqual({ nodes: [], edges: [] });
    expect(relationshipEdges).toHaveLength(1);
  });

  it("shows only canonical flow members and dedicated patterned transitions", () => {
    const projection = projectGraphForWorkspace(nodes, relationshipEdges, "flow", PROJECT_AURORA_STORY_FLOWS[0]!, PROJECT_AURORA_STORY_FLOWS);
    const nestedDialogue = projection.nodes.find((candidate) => candidate.id === "node-dock-dialogue");

    expect(projection.nodes.map((candidate) => candidate.id)).not.toContain("worldbuilding");
    expect(nestedDialogue?.parentId).toBeUndefined();
    expect(nestedDialogue?.position).toEqual({ x: 430, y: 0 });
    expect(projection.edges.find((edge) => edge.data?.label === "Present the ledger")).toMatchObject({
      type: "storyFlow",
      data: { flowTransition: { kind: "branch", condition: "items.node-sealed-ledger.holder.node_id == \"node-hero\"" } },
      style: { strokeDasharray: "9 5" }
    });
  });

  it("overlays selected flow order on the complete Graph projection", () => {
    const projection = projectGraphForWorkspace(nodes, relationshipEdges, "relationships", PROJECT_AURORA_STORY_FLOWS[0]!);

    expect(projection.nodes).toEqual(nodes);
    expect(projection.edges[0]).toBe(relationshipEdges[0]);
    expect(projection.edges).toHaveLength(relationshipEdges.length + PROJECT_AURORA_STORY_FLOWS[0]!.transitions.length);
    expect(projection.edges.find((edge) => edge.data?.label === "Begin inspection")).toMatchObject({
      type: "storyFlow",
      data: { flowTransition: { kind: "next" } }
    });
  });

  it("moves Flow labels along a shared semantic route without mutating either edge", () => {
    const semantic: Edge<NarrativeEdgeData> = {
      id: "shared-semantic",
      source: "node-opening",
      target: "node-dock-dialogue",
      data: { label: "contains", relationshipType: "contains" }
    };
    const projection = projectGraphForWorkspace(
      nodes,
      [semantic],
      "relationships",
      PROJECT_AURORA_STORY_FLOWS[0]!
    );
    const route = projection.edges.find((edge) =>
      edge.source === semantic.source
      && edge.target === semantic.target
      && edge.data?.flowTransition
    );

    expect(Math.abs(route?.data?.flowRouteLabelLane ?? 0)).toBe(1);
    expect(projection.edges[0]).toBe(semantic);
    expect(semantic.data).not.toHaveProperty("flowRouteLabelLane");
    expect(shiftedFlowLabelPosition(100, 50, 0, 0, 200, 0, 1)).toEqual({
      x: 160,
      y: 50
    });
    expect(shiftedFlowLabelPosition(100, 50, 0, 0, 100, 0, 1)).toEqual({
      x: 130,
      y: 50
    });
  });

  it("assigns unique longitudinal lanes to several Flow routes sharing one edge", () => {
    const value = structuredClone(PROJECT_AURORA_STORY_FLOWS[0]!);
    const original = value.transitions.find((transition) =>
      transition.source_node_id === "node-opening"
      && transition.target_node_id === "node-dock-dialogue"
    )!;
    value.transitions.push(
      { ...original, id: `${original.id}-parallel-a` },
      { ...original, id: `${original.id}-parallel-b` }
    );
    const projection = projectGraphForWorkspace(
      nodes,
      [{
        id: "shared-semantic",
        source: original.source_node_id,
        target: original.target_node_id,
        data: { label: "contains", relationshipType: "contains" }
      }],
      "relationships",
      value
    );
    const lanes = projection.edges
      .filter((edge) => edge.data?.flowTransition?.transitionId.startsWith(original.id))
      .map((edge) => edge.data?.flowRouteLabelLane);

    expect(new Set(lanes).size).toBe(3);
    expect(lanes).not.toContain(0);
    expect(lanes.every((lane) => Math.abs(lane ?? 0) <= 1)).toBe(true);
  });

  it("separates reciprocal Aurora route labels in Graph and Flow", () => {
    const smuggler = PROJECT_AURORA_STORY_FLOWS.find((flow) => flow.flow.id === "flow-smuggler-route")!;
    const flowProjection = projectGraphForWorkspace(nodes, relationshipEdges, "flow", smuggler, PROJECT_AURORA_STORY_FLOWS);
    const questX = flowProjection.nodes.find((node) => node.id === "node-smuggler-route")!.position.x;
    const blockadeX = flowProjection.nodes.find((node) => node.id === "node-mara-runs-blockade")!.position.x;
    const outcomeX = flowProjection.nodes.find((node) => node.id === "node-route-consequence")!.position.x;

    expect(blockadeX - questX).toBe(600);
    expect(outcomeX - blockadeX).toBe(430);

    for (const mode of ["relationships", "flow"] as const) {
      const projection = projectGraphForWorkspace(nodes, relationshipEdges, mode, smuggler, PROJECT_AURORA_STORY_FLOWS);
      const circle = projection.edges.find((edge) => edge.data?.label === "Circle back past the patrol")!;
      const take = projection.edges.find((edge) => edge.data?.label === "Take the covert route")!;

      expect(circle).toMatchObject({
        sourceHandle: "top",
        targetHandle: "top",
        data: { flowRouteArc: true, flowRouteLabelLane: 0 }
      });
      expect(take).toMatchObject({
        sourceHandle: "right",
        targetHandle: "left",
        data: { flowRouteArc: false }
      });
    }
  });

  it("raises a cycle route and places its label near the arc apex", () => {
    const [path, labelX, labelY] = flowRouteArcPath(0, 100, 600, 100);

    expect(path).toMatch(/^M0,100 C0,-\d+ 600,-\d+ 600,100$/);
    expect(labelX).toBe(300);
    expect(labelY).toBeLessThan(-40);
  });

  it("renders Aurora calls as navigable non-semantic routes with callee context", () => {
    const projection = projectGraphForWorkspace(
      nodes,
      relationshipEdges,
      "flow",
      PROJECT_AURORA_STORY_FLOWS[0]!,
      PROJECT_AURORA_STORY_FLOWS
    );
    const call = projection.edges.find((edge) => edge.id === "flow-invocation:flow-invocation-inspection-smuggler-route");

    expect(call).toMatchObject({
      id: "flow-invocation:flow-invocation-inspection-smuggler-route",
      source: "node-inspection",
      target: "node-smuggler-route",
      reconnectable: false,
      data: { flowInvocation: { targetFlowId: "flow-smuggler-route", invalid: false } },
      style: { stroke: "#b45309", strokeDasharray: "10 5" }
    });
    expect(projection.nodes.find((node) => node.id === "node-smuggler-route")?.data.callContext)
      .toBe("Smuggler Route");
    expect(projection.nodes.find((node) => node.id === "node-smuggler-route")?.position.y)
      .toBeGreaterThan(Math.max(...projection.nodes.filter((node) => !node.data.callContext).map((node) => node.position.y)));
    expect(call?.sourceHandle).toBe("bottom");
    expect(call?.targetHandle).toBe("left");
    expect(relationshipEdges).toHaveLength(1);
  });

  it("uses a configured Scene entry for reachability without drawing a duplicate arrow", () => {
    const value = structuredClone(PROJECT_AURORA_STORY_FLOWS[0]!);
    value.transitions = value.transitions.filter((transition) => transition.id !== "flow-transition-opening-dialogue");
    const projection = projectGraphForWorkspace(nodes, relationshipEdges, "flow", value);
    const analysis = analyzeStoryFlow(value);

    expect(projection.edges.filter((edge) =>
      edge.source === "node-opening" && edge.target === "node-dock-dialogue"
    )).toHaveLength(1);
    expect(projection.edges.find((edge) => edge.data?.sceneBoundary)).toMatchObject({
      label: "Scene entry",
      data: { sceneBoundary: { exitNodeIds: ["node-dock-dialogue"] } }
    });
    expect(analysis.roles.get("node-dock-dialogue")?.unreachable).toBe(false);
  });

  it("compacts container members and lays parallel branches out by traversal depth", () => {
    const projection = projectGraphForWorkspace(nodes, relationshipEdges, "flow", PROJECT_AURORA_STORY_FLOWS[0]!, PROJECT_AURORA_STORY_FLOWS);
    const opening = projection.nodes.find((candidate) => candidate.id === "node-opening");
    const inspection = projection.nodes.find((candidate) => candidate.id === "node-inspection");
    const blockade = projection.nodes.find((candidate) => candidate.id === "node-mara-runs-blockade");
    const consequence = projection.nodes.find((candidate) => candidate.id === "node-route-consequence");

    expect(opening).toMatchObject({
      height: 132,
      position: { x: 0, y: 0 },
      width: 210,
      data: { presentationState: "collapsed" }
    });
    expect(inspection?.position).toEqual({ x: 860, y: 0 });
    expect(blockade?.position.x).toBeGreaterThan(consequence?.position.x ?? 0);
    expect(blockade?.data.callContext).toBe("Blockade Outcome");
    expect(consequence?.position.x).toBeGreaterThan(inspection?.position.x ?? 0);
    expect((blockade?.position.y ?? 0) - (inspection?.position.y ?? 0)).toBeGreaterThan(180);
    expect(projection.edges.filter((edge) => edge.data?.flowTransition).every((edge) => edge.reconnectable)).toBe(true);
    const dialogueRoutes = projection.edges.filter((edge) => edge.source === "node-dock-dialogue");
    expect(new Set(dialogueRoutes.map((edge) => edge.data?.flowRouteLabelOffset)).size).toBe(dialogueRoutes.length);
    expect(dialogueRoutes.every((edge) =>
      Math.abs(edge.data?.flowRouteLabelOffset ?? 0) <= 10
    )).toBe(true);
    expect(dialogueRoutes.every((edge) =>
      edge.sourceHandle === (edge.data?.flowInvocation ? "bottom" : "right") && edge.targetHandle === "left"
    )).toBe(true);
  });

  it("derives entry, branches, endings, and unreachable facts", () => {
    const analysis = analyzeStoryFlow(PROJECT_AURORA_STORY_FLOWS[0]!);

    expect(analysis.roles.get("node-opening")).toMatchObject({ entry: true });
    expect(analysis.roles.get("node-dock-dialogue")).toMatchObject({ branch: true });
    expect(analysis.roles.get("node-sealed-ledger")).toMatchObject({ ending: true, unreachable: true });
    expect(analysis.facts.some((fact) => fact.code === "unreachable_member")).toBe(true);
    expect(localStoryFlowIntegrity(PROJECT_AURORA_STORY_FLOWS[0]!)?.facts).toContainEqual(
      expect.objectContaining({
        code: "unreachable_member",
        flow_id: "flow-main-story",
        node_id: "node-sealed-ledger"
      })
    );
  });

  it("defaults each project to relationships and its first active flow", () => {
    expect(defaultWorkspacePreference(PROJECT_AURORA_STORY_FLOWS)).toEqual({
      mode: "relationships",
      activeFlowId: "flow-main-story"
    });
  });

  it("provides stable Scene and Event starter fixtures without choosing Scene for the author", () => {
    expect(emptyProjectStoryDraft("Scene")).toMatchObject({
      kind: "Scene",
      title: "Opening Scene",
      size: { width: 520, height: 360 }
    });
    expect(emptyProjectStoryDraft("Event")).toMatchObject({
      kind: "Event",
      title: "Opening Event",
      size: { width: 260, height: 156 }
    });
  });
});

function node(id: string, kind: NarrativeNodeData["kind"], position: { x: number; y: number }): Node<NarrativeNodeData> {
  return {
    id,
    type: "narrative",
    position,
    width: 260,
    height: 156,
    data: { kind, label: id, title: id, summary: "", tags: [] }
  };
}

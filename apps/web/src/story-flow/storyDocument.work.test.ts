import type { Edge, Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import type { NarrativeEdgeData, NarrativeNodeData } from "../types";
import type { StoryFlowSnapshot } from "./contracts";
import { projectStoryDocument } from "./storyDocument";

const now = "2026-11-03T00:00:00Z";

function longStory(count: number) {
  const reads = { membership: 0, transition: 0, edge: 0 };
  const nodes: Node<NarrativeNodeData>[] = Array.from({ length: count }, (_, i) => ({
    id: `node-${i}`, position: { x: 0, y: 0 },
    data: { kind: "Event", label: `Beat ${i}`, title: `Beat ${i}`, summary: `Complete text ${i}`, tags: [] }
  }));
  const snapshot: StoryFlowSnapshot = {
    snapshot_version: 1,
    flow: { flow_version: 1, id: "main", project_id: "project", name: "Long story", description: "", kind: "main", status: "active", entry_node_id: "node-0", metadata: {}, created_at: now, updated_at: now },
    nodes: nodes.map((node, i) => ({
      flow_node_version: 1, id: `member-${i}`, project_id: "project", flow_id: "main",
      get node_id() { reads.membership++; return node.id; },
      presentation_order: i, metadata: {}, created_at: now, updated_at: now
    })),
    transitions: nodes.slice(1).map((node, i) => ({
      transition_version: 1, id: `transition-${i}`, project_id: "project", flow_id: "main",
      get source_node_id() { reads.transition++; return "node-0"; },
      target_node_id: node.id, kind: "branch", label: `Branch ${i}`, condition: "", priority: i,
      is_default: false, metadata: {}, created_at: now, updated_at: now
    })),
    scene_boundaries: [], scene_children: {}
  };
  const edges: Edge<NarrativeEdgeData>[] = nodes.slice(1).map((node, i) => ({
    id: `semantic-${i}`,
    get source() { reads.edge++; return "node-0"; },
    target: node.id, data: { relationshipType: "mentions", label: `Context ${i}` }
  }));
  return { nodes, snapshot, edges, reads };
}

describe("Story projection input work", () => {
  it("reads each long-flow input a bounded number of times without dropping beats or context", () => {
    const { nodes, snapshot, edges, reads } = longStory(1000);
    const result = projectStoryDocument(nodes, edges, snapshot);
    expect(result.sections.map((section) => section.node)).toEqual(nodes);
    expect(result.entries).toHaveLength(1000);
    expect(result.sections[0]!.semanticContext).toHaveLength(999);
    expect(result.sections.at(-1)!.semanticContext).toHaveLength(1);
    expect(result.sections.at(-1)!.node.data.summary).toBe("Complete text 999");
    expect(reads).toEqual({ membership: 3000, transition: 999, edge: 5994 });
  });

  it("retains semantic duplicates and one self-edge, ignores Flow overlays and refreshes replacement inputs", () => {
    const { nodes, snapshot, edges } = longStory(3);
    const self: Edge<NarrativeEdgeData> = { id: "self", source: "node-0", target: "node-0", data: { relationshipType: "mentions", label: "Self" } };
    const overlay: Edge<NarrativeEdgeData> = { ...edges[0]!, id: "overlay", data: {
      ...edges[0]!.data!, flowTransition: { flowId: "main", transitionId: "overlay", kind: "next", priority: 0, isDefault: false, condition: "" }
    } };
    const inputs = Object.freeze([...edges, edges[0]!, self, overlay]);
    const first = projectStoryDocument(nodes, inputs as Edge<NarrativeEdgeData>[], snapshot);
    expect(first.sections[0]!.semanticContext.map((context) => context.label)).toEqual(["Self", "Context 0", "Context 0", "Context 1"]);
    const changed = nodes.map((node) => ({ ...node, data: { ...node.data, title: `${node.data.title} changed` } }));
    const next = projectStoryDocument(changed, [], { ...snapshot, transitions: [...snapshot.transitions].reverse().map((transition, i) => ({ ...transition, priority: i })) });
    expect(next.sections.map((section) => section.node.id)).toEqual(["node-0", "node-2", "node-1"]);
    expect(next.sections[0]!.semanticContext).toEqual([]);
    expect(next.sections[1]!.node.data.title).toBe("Beat 2 changed");
    expect(snapshot.transitions[0]!.target_node_id).toBe("node-1");
  });
});

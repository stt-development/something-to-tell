import { afterEach, expect, it, vi } from "vitest";
import { projectSessionToGraphSnapshot } from "../runtime/projections";
import { projectFixture } from "../testFixtures/projectFixtures";
import type { FlowTransition, StoryFlowSnapshot } from "./contracts";
import * as incoming from "./incomingTransitions";
import { projectGraphForWorkspace } from "./workspace";

const fixture = projectFixture("aurora");
const graph = projectSessionToGraphSnapshot(fixture.response);
const template = fixture.storyFlows[0]!;
afterEach(() => vi.restoreAllMocks());
const project = (snapshot: StoryFlowSnapshot, nodes = graph.nodes) =>
  projectGraphForWorkspace(nodes, graph.edges, "flow", snapshot, fixture.storyFlows);

/** Unoptimized query oracle: restore exactly the removed raw target filter for every score. */
function unbatched(snapshot: StoryFlowSnapshot, nodes = graph.nodes) {
  const spy = vi.spyOn(incoming, "buildIncomingTransitionLookup").mockImplementation((transitions) => {
    const lookup = new Map<string, readonly FlowTransition[]>();
    vi.spyOn(lookup, "get").mockImplementation((id) => transitions.filter((item) => item.target_node_id === id));
    return lookup;
  });
  try { return project(snapshot, nodes); } finally { spy.mockRestore(); }
}

for (const snapshot of fixture.storyFlows) {
  it(`matches unbatched complete Aurora projection for ${snapshot.flow.id}, including portals and return corridors`, () => {
    const before = JSON.stringify(snapshot);
    expect(project(snapshot)).toEqual(unbatched(snapshot));
    expect(JSON.stringify(snapshot)).toBe(before);
  });
}

function layered() {
  const ids = ["root", "unused", "v", "p", "q", "y", "x", "s", "t"];
  const source = graph.nodes.find((item) => item.data.kind === "Event")!;
  const nodes = ids.map((id) => ({ ...source, id, parentId: undefined, data: { ...source.data, canonicalNodeId: undefined } }));
  const pairs = [["root", "p"], ["root", "q"], ["p", "x"], ["q", "y"], ["q", "x"], ["q", "x"],
    ["y", "s"], ["x", "t"], ["missing", "y"], ["t", "p"], ["x", "x"]];
  const snapshot: StoryFlowSnapshot = { ...template, flow: { ...template.flow, entry_node_id: "root" },
    nodes: ids.map((id, index) => ({ ...template.nodes[0]!, node_id: id, presentation_order: index })),
    transitions: pairs.map(([sourceId, targetId], index) => ({ ...template.transitions[0]!, id: `layout-${index}`,
      source_node_id: sourceId!, target_node_id: targetId! })),
    scene_boundaries: [{ ...template.scene_boundaries[0]!, id: "virtual-entry", scene_node_id: "root", entry_node_id: "v", exit_node_ids: [] }],
    invocations: [], bindings: [], exits: [] };
  return { nodes, snapshot };
}

it("uses current rows at each depth, duplicate parent weights and explicit-only boundary scoring", () => {
  const { nodes, snapshot } = layered();
  const before = JSON.stringify({ nodes, snapshot });
  const result = project(snapshot, nodes);
  expect(result).toEqual(unbatched(snapshot, nodes));
  const rows = Object.fromEntries(result.nodes.map((item) => [item.id, item.position.y]));
  expect(rows).toEqual({ root: 0, unused: 280, v: 560, p: 0, q: 280, y: 280, x: 0, s: 280, t: 0 });
  expect(result.nodes.find((item) => item.id === "x")!.position.x).toBe(1030);
  expect(JSON.stringify({ nodes, snapshot })).toBe(before);
});

it.each(["endpoint", "order", "entry", "remove"])("rebuilds for current %s input rather than retaining old layout queries", (change) => {
  const { nodes, snapshot } = layered();
  const before = project(snapshot, nodes);
  const changed = structuredClone(snapshot);
  if (change === "endpoint") changed.transitions[2]!.target_node_id = "s";
  if (change === "order") {
    changed.nodes = changed.nodes.map((item, index) => ({ ...item, presentation_order: changed.nodes.length - index }));
    changed.transitions.reverse();
  }
  if (change === "entry") changed.flow = { ...changed.flow, id: "replacement-flow", project_id: "replacement-project", entry_node_id: "q" };
  if (change === "remove") changed.transitions = changed.transitions.filter((item) => item.target_node_id !== "x");
  expect(project(changed, nodes)).toEqual(unbatched(changed, nodes));
  expect(project(snapshot, nodes)).toEqual(before);
});

it.each(["empty", "singleton", "chain", "disconnected", "Graph", "Story"])("builds no incoming lookup for %s without a scoring comparison", (kind) => {
  const { nodes, snapshot } = layered();
  const batch = vi.spyOn(incoming, "buildIncomingTransitionLookup");
  const simple: StoryFlowSnapshot = { ...snapshot, nodes: snapshot.nodes.slice(0, kind === "empty" ? 0 : kind === "singleton" ? 1 : 2),
    transitions: kind === "chain" ? [{ ...snapshot.transitions[0]!, source_node_id: "root", target_node_id: "unused" }] : [],
    scene_boundaries: [] };
  projectGraphForWorkspace(nodes, [], kind === "Graph" ? "relationships" : kind === "Story" ? "story" : "flow", simple);
  expect(batch).not.toHaveBeenCalled();
});

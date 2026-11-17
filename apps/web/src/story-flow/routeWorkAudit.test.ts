import type { Edge } from "@xyflow/react";
import { afterEach, expect, it, vi } from "vitest";
import { projectSessionToGraphSnapshot } from "../runtime/projections";
import { projectFixture } from "../testFixtures/projectFixtures";
import type { NarrativeEdgeData } from "../types";
import { projectGraphForWorkspace } from "./workspace";
import * as incoming from "./incomingTransitions";

afterEach(() => vi.restoreAllMocks());

it.each([20, 80])("bounds incoming construction and scoring queries for %s ordered Flow siblings", (count) => {
  const fixture = projectFixture("aurora");
  const template = fixture.storyFlows[0]!;
  const source = projectSessionToGraphSnapshot(fixture.response).nodes.find((item) => item.data.kind === "Event")!;
  const nodes = Array.from({ length: count + 1 }, (_, index) => ({ ...source, id: `row-${index}`, parentId: undefined,
    data: { ...source.data, canonicalNodeId: undefined } }));
  let building = false, targets = 0, queries = 0, querySources = 0;
  const original = incoming.buildIncomingTransitionLookup;
  const batch = vi.spyOn(incoming, "buildIncomingTransitionLookup").mockImplementation((values) => {
    building = true;
    let grouped: ReturnType<typeof original>;
    try { grouped = original(values); } finally { building = false; }
    const get = grouped.get.bind(grouped);
    vi.spyOn(grouped, "get").mockImplementation((id) => {
      queries++;
      // Count actual source-field reads when scoring consumes the selected incoming records.
      return get(id)?.map((item) => new Proxy(item, { get(target, key, receiver) {
        if (key === "source_node_id") querySources++;
        return Reflect.get(target, key, receiver);
      } }));
    });
    return grouped;
  });
  const transitions = Array.from({ length: count }, (_, index) => new Proxy({ ...template.transitions[0]!,
    id: `route-${index}`, source_node_id: "row-0", target_node_id: `row-${index + 1}` }, { get(target, key, receiver) {
      if (building && key === "target_node_id") targets++;
      return Reflect.get(target, key, receiver);
    } }));
  let filters = 0, visits = 0;
  // Delegate native filtering; only raw transition predicates are counted, not CPU or Map work.
  const measured = new Proxy(transitions, { get(target, key, receiver) {
    if (key !== "filter") return Reflect.get(target, key, receiver);
    return (...args: Parameters<typeof transitions.filter>) => {
      filters++;
      return target.filter((...values) => { visits++; return args[0](...values); }, args[1]);
    };
  } });
  const snapshot = { ...template, flow: { ...template.flow, entry_node_id: "row-0" },
    nodes: nodes.map((item, index) => ({ ...template.nodes[0]!, node_id: item.id, presentation_order: index })),
    transitions: measured, scene_boundaries: [], invocations: [], bindings: [], exits: [] };
  const projected = projectGraphForWorkspace(nodes, [], "flow", snapshot);
  expect(batch).toHaveBeenCalledOnce();
  expect({ targets, queries, querySources }).toEqual({ targets: count, queries: 2 * (count - 1), querySources: 2 * (count - 1) });
  // Only the unchanged final edge-visibility filter still scans raw transition predicates.
  expect(filters).toBe(1);
  expect(visits).toBe(transitions.length);
  expect(projected.nodes.map((item) => item.position)).toEqual([
    { x: 0, y: 0 }, ...Array.from({ length: count }, (_, index) => ({ x: 430, y: index * 280 }))
  ]);
  expect(projected.edges.map((edge) => edge.data?.flowTransition?.transitionId)).toEqual(transitions.map((item) => item.id));
  expect(nodes.every((item) => item.position === source.position)).toBe(true);
});

it.each([20, 80])("counts label-corridor source reads even for %s unchanged relationship-only routes", (count) => {
  let sources = 0, targets = 0, data = 0;
  const raw: Edge<NarrativeEdgeData>[] = Array.from({ length: count }, (_, index) => ({
    id: `semantic-${index}`, source: `source-${index}`, target: `target-${index}`, data: { label: "mentions", relationshipType: "mentions" }
  }));
  const edges = raw.map((item) => new Proxy(item, { get(target, key, receiver) {
    if (key === "source") sources++;
    if (key === "target") targets++;
    if (key === "data") data++;
    return Reflect.get(target, key, receiver);
  } }));
  const projected = projectGraphForWorkspace([], edges, "relationships", null);
  expect({ sources, targets, data }).toEqual({ sources: count * 2, targets: count, data: count * 6 });
  expect(projected.edges.every((edge, index) => edge === edges[index])).toBe(true);
  expect(projected.edges).not.toBe(edges);
});

it.each(["relationships", "flow"] as const)("keeps mixed lanes, reciprocal returns, loops and distant routes deterministic in %s", (mode) => {
  const fixture = projectFixture("aurora");
  const graph = projectSessionToGraphSnapshot(fixture.response);
  const flow = fixture.storyFlows.find((item) => item.flow.id === "flow-smuggler-route")!;
  const route = flow.transitions[0]!;
  const snapshot = { ...flow, transitions: [...flow.transitions,
    { ...route, id: "audit-parallel" }, { ...route, id: "audit-loop", target_node_id: route.source_node_id }] };
  const relation: Edge<NarrativeEdgeData> = { id: "audit-semantic", source: route.source_node_id, target: route.target_node_id,
    data: { label: "coexists", relationshipType: "mentions" } };
  const before = projectGraphForWorkspace(graph.nodes, [relation], mode, snapshot, fixture.storyFlows);
  const changed = graph.nodes.map((item) => ({ ...item, selected: true, width: (item.width ?? 200) + 30,
    position: { x: item.position.x + 17, y: item.position.y + 9 }, data: { ...item.data, summary: "Current Text" } }));
  const after = projectGraphForWorkspace(changed, [relation], mode, snapshot, fixture.storyFlows);
  expect(after.edges).toEqual(before.edges);
  expect(after.edges.map((edge) => edge.id)).toEqual(before.edges.map((edge) => edge.id));
  const loop = after.edges.find((edge) => edge.id === "story-flow:audit-loop")!;
  expect(loop.source).toBe(loop.target);
  expect(after.edges.find((edge) => edge.data?.label === "Circle back past the patrol")).toMatchObject({
    sourceHandle: "top", targetHandle: "top", data: { flowRouteArc: true, flowRouteLabelLane: 0 }
  });
  if (mode === "relationships") {
    expect(after.edges[0]).toBe(relation);
    expect(after.nodes).toBe(changed);
  } else expect(after.nodes.map((item) => item.position)).toEqual(before.nodes.map((item) => item.position));
});

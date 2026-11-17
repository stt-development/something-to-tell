import type { Edge, Node } from "@xyflow/react";
import { expect, it } from "vitest";
import { enforceFrameMinimums } from "../../composition/layout";
import { projectSessionToGraphSnapshot } from "../../runtime/projections";
import { projectGraphForWorkspace } from "../../story-flow/workspace";
import { projectFixture } from "../../testFixtures/projectFixtures";
import type { NarrativeEdgeData, NarrativeNodeData } from "../../types";
import { applyIssueOverlays, filterGraphForView, nodePresentationMetrics, projectFrameWorkspace } from "./graphProjection";

type Work = Record<string, { calls: number; visits: number }>;
/** Count source-array predicate visits only, delegating native behavior/thisArg unchanged. */
function counted<T>(source: T[]) {
  const work: Work = {};
  const observed = new Set(["map", "filter", "find", "some", "flatMap"]);
  const values = new Proxy(source, {
    get(target, key, receiver) {
      const original = Reflect.get(target, key, receiver);
      if (typeof key !== "string" || !observed.has(key)) return original;
      return (...args: unknown[]) => {
        const row = work[key] ??= { calls: 0, visits: 0 };
        row.calls++;
        return Reflect.apply(original, receiver, [function(this: unknown, ...values: unknown[]) {
          row.visits++;
          return Reflect.apply(args[0] as (...values: unknown[]) => unknown, this, values);
        }, ...args.slice(1)]);
      };
    }
  });
  return { values, work };
}
const node = (id: string, kind: NarrativeNodeData["kind"], parentId?: string): Node<NarrativeNodeData> => ({
  id, parentId, position: { x: 10, y: 20 }, data: { kind, title: id, label: id, summary: "", tags: [] }
});
function nested(count: number) {
  const scene = { ...node("scene", "Scene"), position: { x: 100, y: 200 }, data: { ...node("scene", "Scene").data, isFrame: true } };
  const location = { ...node("location", "Location", "scene"), position: { x: 20, y: 30 }, data: { ...node("location", "Location").data, isFrame: true } };
  const children = Array.from({ length: count }, (_, index) => ({ ...node(`leaf-${index}`, "Character", "location"), position: { x: index, y: index } }));
  return [scene, location, ...children];
}

it.each([20, 80])("counts full lookup construction separately for %s filtered orphan placements", (size) => {
  const source = nested(size);
  const positions = source.map((item) => item.position);
  const nodes = counted(source);
  const edges = counted(Array.from({ length: size - 1 }, (_, index) => ({ source: `leaf-${index}`, target: `leaf-${index + 1}` })));
  const projected = filterGraphForView(nodes.values, edges.values, { kinds: ["Character"], query: "" });
  expect(nodes.work).toEqual({ filter: { calls: 1, visits: size + 2 }, map: { calls: 1, visits: size + 2 } });
  expect(edges.work).toEqual({ filter: { calls: 1, visits: size - 1 } });
  expect(projected.nodes).toHaveLength(size);
  for (const [index, item] of projected.nodes.entries()) {
    expect(item.parentId).toBeUndefined();
    expect(item.position).toEqual({ x: 120 + index, y: 230 + index });
    expect(item.data).toBe(source[index + 2]!.data);
    expect(source[index + 2]!.parentId).toBe("location");
    expect(source[index + 2]!.position).toBe(positions[index + 2]);
  }
  expect(projected.edges).toEqual(edges.values);
});

it("builds no position lookup when parents remain visible, and one for a single query match", () => {
  const source = nested(20);
  source[2]!.data = { ...source[2]!.data, title: "Unique match" };
  const all = counted(source);
  const visible = filterGraphForView(all.values, [], { kinds: ["Scene", "Location", "Character"], query: "" });
  expect(all.work).toEqual({ filter: { calls: 1, visits: 22 } });
  expect(visible.nodes.every((item, index) => item === source[index])).toBe(true);
  const one = counted(source);
  expect(filterGraphForView(one.values, [], { kinds: ["Character"], query: "unique match" }).nodes).toHaveLength(1);
  expect(one.work).toEqual({ filter: { calls: 1, visits: 22 }, map: { calls: 1, visits: 22 } });
});

it("keeps linked visual ancestry, missing parents and cycles explicit in filtered geometry", () => {
  const source = nested(1);
  const linked = { ...node("linked", "Character", "scene"), data: { ...source[2]!.data, canonicalNodeId: "leaf-0", isLinkedInstance: true } };
  const missing = node("missing", "Character", "absent");
  const cycle = node("cycle", "Character", "cycle-frame");
  const frame = { ...node("cycle-frame", "Location", "cycle"), data: { ...node("cycle-frame", "Location").data, isFrame: true } };
  const nodes = counted([...source, linked, missing, cycle, frame]);
  const projected = filterGraphForView(nodes.values, [], { kinds: ["Character"], query: "" });
  expect(nodes.work.map).toEqual({ calls: 1, visits: 7 });
  expect(projected.nodes.map((item) => [item.id, item.position])).toEqual([
    ["leaf-0", { x: 120, y: 230 }], ["linked", { x: 110, y: 220 }],
    ["missing", { x: 10, y: 20 }], ["cycle", { x: 20, y: 40 }]
  ]);
  expect(linked.parentId).toBe("scene");
});

it("separates frame map construction from visibility scans and focused-root geometry", () => {
  const source = nested(20);
  const nodes = counted(source);
  const edges = counted([{ source: "scene", target: "location" }, { source: "location", target: "leaf-0" }]);
  const projected = projectFrameWorkspace(nodes.values, edges.values, "location");
  expect(nodes.work).toEqual({ map: { calls: 1, visits: 22 }, filter: { calls: 2, visits: 44 } });
  expect(edges.work).toEqual({ filter: { calls: 1, visits: 2 } });
  expect(projected.nodes).toHaveLength(21);
  expect(projected.nodes[0]).toMatchObject({ id: "location", parentId: undefined, position: { x: 0, y: 0 } });
  expect(source[1]!.parentId).toBe("scene");
  expect(projected.edges).toEqual([{ source: "location", target: "leaf-0" }]);
});

it("keeps raw frame clamping and numeric topology scans separate from projection construction", () => {
  const source = nested(20);
  const layout = counted(source);
  const clamped = enforceFrameMinimums(layout.values);
  // The batch's source-field/query work is counted at its actual construction boundary.
  expect(layout.work).toEqual({ map: { calls: 1, visits: 22 } });
  expect(clamped.filter((item, index) => item !== source[index])).toHaveLength(2);
  const nodes = counted(source);
  const edges = counted([{ id: "out", source: "leaf-0", target: "leaf-1" }, { id: "in", source: "leaf-1", target: "leaf-0" }]);
  for (const item of source) nodePresentationMetrics(nodes.values, edges.values, item);
  expect(nodes.work).toEqual({ filter: { calls: 22, visits: 484 } });
  expect(edges.work).toEqual({ filter: { calls: 44, visits: 88 } });
});

it("counts Graph versus Flow source queries without conflating Flow route geometry work", () => {
  const fixture = projectFixture("aurora");
  const graph = projectSessionToGraphSnapshot(fixture.response);
  const nodes = counted(graph.nodes);
  const flows = counted(fixture.storyFlows);
  const snapshot = fixture.storyFlows.find((item) => item.flow.id === "flow-main-story")!;
  const projected = projectGraphForWorkspace(nodes.values, graph.edges, "flow", snapshot, flows.values);
  expect({ nodes: nodes.work, flows: flows.work, output: projected.nodes.length }).toMatchInlineSnapshot(`
    {
      "flows": {
        "find": {
          "calls": 4,
          "visits": 10,
        },
      },
      "nodes": {
        "filter": {
          "calls": 1,
          "visits": 18,
        },
        "find": {
          "calls": 2,
          "visits": 25,
        },
      },
      "output": 7,
    }
  `);
  expect(projected.nodes.every((item) => !item.parentId)).toBe(true);
  expect(projected.nodes.some((item) => item.data.callContext)).toBe(true);
  const raw = counted(graph.nodes);
  const graphFlows = counted(fixture.storyFlows);
  const relationships = projectGraphForWorkspace(raw.values, graph.edges, "relationships", snapshot, graphFlows.values);
  expect(raw.work).toEqual({ map: { calls: 1, visits: 18 } });
  expect(graphFlows.work).toEqual({ find: { calls: 2, visits: 5 } });
  expect(relationships.nodes).toBe(raw.values);
});

it("records diagnostic overlay wrapper/data churn independently of source predicate work", () => {
  const source = [node("hero", "Character"), node("quest", "Quest")];
  const nodes = counted(source);
  const edges: Edge<NarrativeEdgeData>[] = [{ id: "edge", source: "hero", target: "quest", data: { label: "leads" } }];
  const projected = applyIssueOverlays(nodes.values, edges, []);
  expect(nodes.work).toEqual({ map: { calls: 1, visits: 2 } });
  expect(projected.nodes.every((item, index) => item !== source[index] && item.data !== source[index]!.data)).toBe(true);
  expect(projected.nodes.map((item) => item.data.issueCount)).toEqual([0, 0]);
});

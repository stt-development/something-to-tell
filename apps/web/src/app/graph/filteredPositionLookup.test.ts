import type { Node } from "@xyflow/react";
import { afterEach, expect, it, vi } from "vitest";
import * as layout from "../../composition/layout";
import type { NarrativeNodeData } from "../../types";
import { filterGraphForView } from "./graphProjection";

type VisualNode = Node<NarrativeNodeData>;
const node = (id: string, kind: NarrativeNodeData["kind"], parentId?: string): VisualNode => ({
  id, parentId, position: { x: 10, y: 20 }, data: { kind, title: id, label: id, summary: "", tags: [] }
});
const filter = { kinds: ["Character"] as NarrativeNodeData["kind"][], query: "" };
function nested(count: number) {
  return [node("scene", "Scene"), node("location", "Location", "scene"),
    ...Array.from({ length: count }, (_, index) => node(`child-${index}`, "Character", "location"))];
}

/** Count actual key reads during lookup construction and delegated resolver queries. */
function observeConstruction() {
  let building = false;
  let entries = 0;
  const queries: { calls: number }[] = [];
  const original = layout.createAbsoluteNodePositionResolver;
  const build = vi.spyOn(layout, "createAbsoluteNodePositionResolver").mockImplementation((nodes) => {
    const resolve = (() => {
      building = true;
      try { return original(nodes); } finally { building = false; }
    })();
    const query = { calls: 0 };
    queries.push(query);
    return (node) => { query.calls++; return resolve(node); };
  });
  const wrap = (nodes: VisualNode[]) => nodes.map((node) => new Proxy(node, {
    get(target, key, receiver) {
      if (building && key === "id") entries++;
      return Reflect.get(target, key, receiver);
    }
  }));
  return { build, queries, wrap, entries: () => entries };
}
afterEach(() => vi.restoreAllMocks());

it.each([20, 80])("builds one N-entry lookup and performs K queries for %s orphan children", (size) => {
  const work = observeConstruction();
  const source = nested(size);
  const positions = source.map((item) => item.position);
  const input = work.wrap(source);
  const projected = filterGraphForView(input, [], filter);
  expect(work.build).toHaveBeenCalledTimes(1);
  expect(work.build).toHaveBeenCalledWith(input);
  expect(work.entries()).toBe(size + 2);
  expect(work.queries).toEqual([{ calls: size }]);
  expect(projected.nodes.every((item) => !item.parentId && item.position.x === 30 && item.position.y === 60)).toBe(true);
  expect(source.map((item) => item.position)).toEqual(positions);
  expect(source.every((item, index) => item.position === positions[index])).toBe(true);
});

it("does not build for visible parents, no matches or empty input; builds once for one match", () => {
  const work = observeConstruction();
  const input = work.wrap(nested(20));
  const visible = filterGraphForView(input, [], { kinds: ["Scene", "Location", "Character"], query: "" });
  expect(visible.nodes.every((item, index) => item === input[index])).toBe(true);
  expect(filterGraphForView(input, [], { ...filter, query: "not present" }).nodes).toEqual([]);
  expect(filterGraphForView([], [], filter).nodes).toEqual([]);
  expect(work.build).not.toHaveBeenCalled();
  expect(work.entries()).toBe(0);
  const one = filterGraphForView(input, [], { ...filter, query: "child-19" });
  expect(one.nodes).toHaveLength(1);
  expect(work.entries()).toBe(22);
  expect(work.queries).toEqual([{ calls: 1 }]);
});

it("rebuilds per invocation and reads current moved, reparented and replacement inputs", () => {
  const work = observeConstruction();
  const source = nested(2);
  const input = work.wrap(source);
  filterGraphForView(input, [], filter);
  filterGraphForView(input, [], filter);
  const moved = source.map((item) => item.id === "scene" ? { ...item, position: { x: 100, y: 200 } } : item);
  expect(filterGraphForView(work.wrap(moved), [], filter).nodes[0]!.position).toEqual({ x: 120, y: 240 });
  const reparented = moved.map((item) => item.id === "child-0" ? { ...item, parentId: "scene" } : item);
  expect(filterGraphForView(work.wrap(reparented), [], filter).nodes[0]!.position).toEqual({ x: 110, y: 220 });
  const replacement = source.map((item) => ({ ...item, position: { x: 1, y: 2 } }));
  expect(filterGraphForView(work.wrap(replacement), [], filter).nodes[0]!.position).toEqual({ x: 3, y: 6 });
  expect(work.build).toHaveBeenCalledTimes(5);
  expect(work.entries()).toBe(20);
  expect(work.queries).toEqual(Array.from({ length: 5 }, () => ({ calls: 2 })));
});

it("keeps linked visual ancestry, filtered edge endpoints, order and input data references", () => {
  const work = observeConstruction();
  const source = [node("scene", "Scene"), { ...node("other", "Scene"), position: { x: -50, y: -60 } },
    node("primary", "Character", "scene"), { ...node("linked", "Character", "other"),
      data: { ...node("primary", "Character").data, canonicalNodeId: "primary", isLinkedInstance: true } }];
  const visible = { source: "primary", target: "linked" };
  const hidden = { source: "scene", target: "primary" };
  const projected = filterGraphForView(work.wrap(source), [visible, hidden], filter);
  expect(projected.nodes.map((item) => [item.id, item.position])).toEqual([
    ["primary", { x: 20, y: 40 }], ["linked", { x: -40, y: -40 }]
  ]);
  expect(projected.nodes[0]!.data).toBe(source[2]!.data);
  expect(projected.nodes[1]!.data).toBe(source[3]!.data);
  expect(projected.edges).toEqual([visible]);
  expect(projected.edges[0]).toBe(visible);
  expect(source[2]!.parentId).toBe("scene");
  expect(source[3]!.parentId).toBe("other");
  expect(work.entries()).toBe(4);
  expect(work.queries).toEqual([{ calls: 2 }]);
});

it("preserves missing-parent, self/indirect cycles and duplicate visual-id last-match rules", () => {
  const nodes = [node("root", "Scene"), { ...node("root", "Scene"), position: { x: 100, y: 200 } },
    node("leaf", "Character", "root"), node("missing", "Character", "absent"),
    node("self", "Character", "self"), node("cycle", "Character", "cycle-frame"), node("cycle-frame", "Location", "cycle")];
  const resolve = layout.createAbsoluteNodePositionResolver(nodes);
  expect(resolve(nodes[2]!)).toEqual({ x: 110, y: 220 });
  expect(resolve(nodes[3]!)).toEqual({ x: 10, y: 20 });
  expect(resolve(nodes[4]!)).toEqual({ x: 10, y: 20 });
  expect(resolve(nodes[5]!)).toEqual({ x: 20, y: 40 });
  for (const item of nodes) {
    expect(resolve(item)).toEqual(layout.absoluteNodePosition(nodes, item));
    expect(resolve(item)).not.toBe(item.position);
  }
});

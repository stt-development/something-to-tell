import type { Node } from "@xyflow/react";
import { expect, it } from "vitest";
import { projectNodeDomVisibility } from "./nodeDomProjection";

const node = (id: string, extra: Partial<Node> = {}): Node => ({ id, position: { x: 0, y: 0 },
  width: 260, height: 156, measured: { width: 260, height: 156 }, data: { text: "Author text" }, ...extra });

it("keeps disabled, unknown and empty projections referentially exact", () => {
  const nodes = [node("a")];
  expect(projectNodeDomVisibility(nodes, new Set(["a"]), false)).toBe(nodes);
  expect(projectNodeDomVisibility(nodes, new Set(), true)).toBe(nodes);
  expect(projectNodeDomVisibility(nodes, new Set(["absent"]), true)).toBe(nodes);
});

it("preserves complete order, geometry, data and measured endpoints without mutation", () => {
  const nodes = [node("near"), node("far"), node("authored-hidden", { hidden: true })];
  const before = structuredClone(nodes);
  const output = projectNodeDomVisibility(nodes, new Set(["far", "authored-hidden"]), true);
  expect(output).toHaveLength(nodes.length);
  expect(output[0]).toBe(nodes[0]); expect(output[2]).toBe(nodes[2]);
  expect(output[1]).toEqual({ ...nodes[1], hidden: true });
  expect(output[1]!.data).toBe(nodes[1]!.data);
  expect(output[1]!.measured).toBe(nodes[1]!.measured);
  expect(nodes).toEqual(before);
  expect(projectNodeDomVisibility(nodes, new Set(), false)).toBe(nodes);
});

it.each([{ measured: undefined }, { measured: { width: 100, height: 156 } },
  { width: undefined }, { height: NaN }, { width: 0 }, { height: -1 }])("retains unmeasured or changed geometry: %j", extra => {
  const nodes = [node("uncertain", extra)];
  expect(projectNodeDomVisibility(nodes, new Set(["uncertain"]), true)).toBe(nodes);
});

it.each(["selected", "dragging", "resizing"] as const)("protects %s owners and all ancestors", flag => {
  const nodes = [node("root"), node("parent", { parentId: "root" }), node("child", { parentId: "parent", [flag]: true })];
  expect(projectNodeDomVisibility(nodes, new Set(nodes.map(n => n.id)), true)).toBe(nodes);
});

it("does not cap selection, merge linked identities or accept ambiguous ownership", () => {
  const nodes = Array.from({ length: 1000 }, (_, i) => node(`placement-${i}`, { selected: true, data: { canonicalNodeId: "same" } }));
  expect(projectNodeDomVisibility(nodes, new Set(nodes.map(n => n.id)), true)).toBe(nodes);
  const duplicate = [node("a"), node("a")];
  expect(projectNodeDomVisibility(duplicate, new Set(["a"]), true)).toBe(duplicate);
  const orphan = [node("a", { parentId: "absent" })];
  expect(projectNodeDomVisibility(orphan, new Set(["a"]), true)).toBe(orphan);
  const cycle = [node("a", { parentId: "b" }), node("b", { parentId: "a" })];
  expect(projectNodeDomVisibility(cycle, new Set(["a", "b"]), true)).toBe(cycle);
});

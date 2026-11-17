import type { Edge, Node } from "@xyflow/react";
import { afterEach, expect, it, vi } from "vitest";
import type { NarrativeEdgeData, NarrativeNodeData } from "../../types";
import { nodePresentationMetrics } from "./graphProjection";
import { buildNodeTopologyMetrics } from "./nodeTopologyMetrics";

const node = (id: string, canonicalNodeId?: string): Node<NarrativeNodeData> => ({
  id, position: { x: 0, y: 0 }, data: { kind: "Character", title: id, label: id, summary: "", tags: [], canonicalNodeId }
});
const edge = (id: string, source: string, target: string): Edge<NarrativeEdgeData> => ({ id, source, target });
const zero = () => ({ incoming: 0, outgoing: 0, instances: 0 });
afterEach(() => vi.restoreAllMocks());

it("matches the single-owner helper for linked/hidden placements, exact endpoints and dangling owners", () => {
  const nodes = [node("primary"), { ...node("linked", "primary"), hidden: true }, node("other"),
    node("empty", ""), node("__proto__"), node("missing-placement", "missing-canonical")];
  const edges = [
    { ...edge("hidden", "other", "primary"), hidden: true, data: { label: "Member", relationshipType: "member_of" as const, canvasVisibility: "hidden" as const } },
    edge("parallel", "other", "primary"), edge("loop", "primary", "primary"),
    edge("visual-only", "linked", "other"), edge("empty", "", "empty"),
    edge("dangling", "absent", "missing-canonical"), edge("special", "__proto__", "absent")
  ];
  const batch = buildNodeTopologyMetrics(nodes, edges);
  for (const item of [...nodes, node("absent"), node("never-seen")]) {
    expect(batch.get(item.data.canonicalNodeId ?? item.id) ?? zero()).toEqual(nodePresentationMetrics(nodes, edges, item));
  }
  expect(batch.get("primary")).toEqual({ incoming: 3, outgoing: 1, instances: 2 });
  expect(batch.get("linked")).toEqual({ incoming: 0, outgoing: 1, instances: 0 });
  expect(batch.get("")).toEqual({ incoming: 0, outgoing: 1, instances: 1 });
});

it.each([20, 80])("reads %s raw node owners and every edge endpoint once, independently of query count", (size) => {
  const nodes = Array.from({ length: size }, (_, index) => node(`node-${index}`));
  const edges = Array.from({ length: size - 1 }, (_, index) => edge(`edge-${index}`, `node-${index}`, `node-${index + 1}`));
  let owners = 0, sources = 0, targets = 0;
  // Actual input-field reads count construction work regardless of array method choice.
  const rawNodes = nodes.map((item) => new Proxy(item, { get(target, key, receiver) {
    if (key === "data") owners++;
    return Reflect.get(target, key, receiver);
  } }));
  const rawEdges = edges.map((item) => new Proxy(item, { get(target, key, receiver) {
    if (key === "source") sources++;
    if (key === "target") targets++;
    return Reflect.get(target, key, receiver);
  } }));
  const batch = buildNodeTopologyMetrics(rawNodes, rawEdges);
  const queries = vi.spyOn(batch, "get");
  for (const item of nodes) expect(batch.get(item.id)).toEqual(nodePresentationMetrics(nodes, edges, item));
  for (const item of nodes) expect(batch.get(item.id)).toBeDefined();
  expect(queries).toHaveBeenCalledTimes(size * 2);
  expect({ owners, sources, targets }).toEqual({ owners: size, sources: size - 1, targets: size - 1 });
});

it("uses fresh invocation-local counts and leaves frozen source records and previous results untouched", () => {
  const a = Object.freeze(node("a"));
  const b = Object.freeze(node("b"));
  const nodes = Object.freeze([a, b]);
  const before = buildNodeTopologyMetrics(nodes, []);
  const added = buildNodeTopologyMetrics(nodes, Object.freeze([Object.freeze(edge("edge", "a", "b"))]));
  expect(before.get("a")).toEqual({ incoming: 0, outgoing: 0, instances: 1 });
  expect(added.get("a")).toEqual({ incoming: 0, outgoing: 1, instances: 1 });
  expect(added.get("b")).toEqual({ incoming: 1, outgoing: 0, instances: 1 });
  const restored = buildNodeTopologyMetrics(nodes, []);
  expect(restored.get("a")).toEqual(before.get("a"));
  expect(restored.get("a")).not.toBe(before.get("a"));
  expect(buildNodeTopologyMetrics([], []).size).toBe(0);
});

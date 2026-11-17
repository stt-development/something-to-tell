import type { Edge, Node } from "@xyflow/react";
import { renderHook } from "@testing-library/react";
import { StrictMode, Suspense } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { NarrativeEdgeData, NarrativeNodeData } from "../../types";
import * as presentation from "../graph/nodeTopologyMetrics";
import { useNodePresentationMetrics, type NodeMetricInputs } from "./useNodePresentationMetrics";

afterEach(() => vi.restoreAllMocks());
const node = (id: string, canonicalNodeId?: string): Node<NarrativeNodeData> => ({ id, position: { x: 0, y: 0 },
  data: { kind: "Character", title: id, label: id, summary: "Text", tags: [], canonicalNodeId } });
const edge = (id: string, source: string, target: string): Edge<NarrativeEdgeData> => ({ id, source, target });
function inputs(rawNodes: Node<NarrativeNodeData>[], rawEdges: Edge<NarrativeEdgeData>[] = [], nodes = rawNodes, projectId = "project-a"): NodeMetricInputs {
  return { projectId, rawNodes, rawEdges, nodes };
}
const observe = (initialProps: NodeMetricInputs) => renderHook(useNodePresentationMetrics, { initialProps });

it("includes hidden semantic edges, parallel edges, self loops and all raw placements", () => {
  const primary = node("primary");
  const linked = { ...node("linked", "primary"), hidden: true };
  const hidden = { ...edge("semantic", "other", "primary"), hidden: true, data: { label: "Member", relationshipType: "member_of" as const } };
  const view = observe(inputs([primary, linked, node("other")], [hidden, edge("parallel", "other", "primary"), edge("loop", "primary", "primary")], [primary]));
  expect(view.result.current.get("primary")).toEqual({ incoming: 3, outgoing: 1, instances: 2 });
  expect([...view.result.current.keys()]).toEqual(["primary"]);
});

it("shares one metric result across linked placements with one raw batch", () => {
  const context = inputs([node("primary"), node("linked", "primary")]);
  const helper = vi.spyOn(presentation, "buildNodeTopologyMetrics");
  const view = observe(context);
  const before = view.result.current.get("primary");
  expect(view.result.current.get("linked")).toBe(before);
  expect(helper).toHaveBeenCalledOnce();
  helper.mockClear();
  const selected = { ...context.rawNodes[1]!, selected: true };
  view.rerender({ ...context, nodes: [selected] });
  expect(view.result.current.get("linked")).toBe(before);
  expect(helper).not.toHaveBeenCalled();
});

it("retains equal numbers after raw geometry, labels, kind, order and edge metadata changes", () => {
  const context = inputs([node("primary"), node("other")], [edge("edge", "primary", "other")]);
  const helper = vi.spyOn(presentation, "buildNodeTopologyMetrics");
  const view = observe(context);
  const before = view.result.current;
  helper.mockClear();
  const raw = context.rawNodes.map((item) => ({ ...item, position: { x: 90, y: 30 },
    data: { ...item.data, kind: "Item" as const, title: "Renamed", summary: "Edited" } })).reverse();
  view.rerender(inputs(raw, [{ ...context.rawEdges[0]!, hidden: true, label: "Changed" }]));
  for (const id of ["primary", "other"]) expect(view.result.current.get(id)).toBe(before.get(id));
  expect(helper).toHaveBeenCalledOnce();
});

it("updates affected owners on add, reconnect and delete while retaining unaffected values", () => {
  const raw = [node("a"), node("b"), node("c"), node("unrelated")];
  const view = observe(inputs(raw));
  const before = view.result.current;
  view.rerender(inputs(raw, [edge("edge", "a", "b")]));
  expect(view.result.current.get("a")!.outgoing).toBe(1);
  expect(view.result.current.get("b")!.incoming).toBe(1);
  expect(view.result.current.get("unrelated")).toBe(before.get("unrelated"));
  const a = view.result.current.get("a");
  view.rerender(inputs(raw, [edge("edge", "a", "c")]));
  expect(view.result.current.get("a")).toBe(a);
  expect(view.result.current.get("b")!.incoming).toBe(0);
  expect(view.result.current.get("c")!.incoming).toBe(1);
  view.rerender(inputs(raw));
  expect(view.result.current.get("a")!.outgoing).toBe(0);
  expect(view.result.current.get("c")!.incoming).toBe(0);
});

it("updates instance counts after linked placement add/remove or canonical remapping", () => {
  const primary = node("primary");
  const other = node("other");
  const view = observe(inputs([primary, other]));
  view.rerender(inputs([primary, other, node("linked", "primary")], [], [primary, other]));
  expect(view.result.current.get("primary")!.instances).toBe(2);
  view.rerender(inputs([primary, other, node("linked", "other")], [], [primary, other]));
  expect(view.result.current.get("primary")!.instances).toBe(1);
  expect(view.result.current.get("other")!.instances).toBe(2);
  view.rerender(inputs([primary, other]));
  expect(view.result.current.get("other")!.instances).toBe(1);
});

it("preserves exact canonical endpoints and nullish rather than truthy canonical fallback", () => {
  const primary = node("primary");
  const linked = node("linked", "primary");
  const empty = node("empty", "");
  const view = observe(inputs([primary, linked, empty], [edge("visual", "linked", "primary"), edge("empty", "", "empty")]));
  expect(view.result.current.get("linked")).toEqual({ incoming: 1, outgoing: 0, instances: 2 });
  expect(view.result.current.get("empty")).toEqual({ incoming: 0, outgoing: 1, instances: 1 });
});

it.each(["projection", "canonical", "project"])("retires %s scope without preserving historical owner metrics", (change) => {
  const original = inputs([node("node")]);
  const view = observe(original);
  const before = view.result.current.get("node");
  view.rerender(change === "projection" ? { ...original, nodes: [] }
    : change === "canonical" ? inputs([node("node", "other")])
    : { ...original, projectId: "project-b" });
  expect(view.result.current.get("node")).not.toBe(before);
  view.rerender(original);
  expect(view.result.current.get("node")).not.toBe(before);
});

it("bounds retained canonical owners to the current projection", () => {
  const raw = Array.from({ length: 20 }, (_, index) => node(`node:${index}`));
  const helper = vi.spyOn(presentation, "buildNodeTopologyMetrics");
  const view = observe(inputs(raw, [], []));
  for (const item of raw) {
    view.rerender(inputs(raw, [], [item]));
    expect([...view.result.current.keys()]).toEqual([item.id]);
  }
  view.rerender(inputs(raw, [], []));
  expect(view.result.current.size).toBe(0);
  view.rerender(inputs(raw, [], [raw[0]!]));
  expect(helper).toHaveBeenCalledTimes(21);
});

it.each(["edges", "placements", "projection", "project"])("does not publish speculative %s or prune committed owners during Suspense", (change) => {
  const original = inputs([node("a"), node("b")]);
  const next = change === "edges" ? { ...original, rawEdges: [edge("edge", "a", "b")] }
    : change === "placements" ? { ...original, rawNodes: [...original.rawNodes, node("linked", "a")] }
    : change === "projection" ? { ...original, nodes: [] } : { ...original, projectId: "project-b" };
  const pending = new Promise<void>(() => {});
  const helper = vi.spyOn(presentation, "buildNodeTopologyMetrics");
  const view = renderHook(({ context, suspend }) => {
    const values = useNodePresentationMetrics(context);
    if (suspend) throw pending;
    return values;
  }, { initialProps: { context: original, suspend: false }, wrapper: ({ children }) => <Suspense fallback={null}>{children}</Suspense> });
  const before = view.result.current.get("a");
  view.rerender({ context: next, suspend: true });
  // React may retry speculative work; only committed scope may affect reuse.
  helper.mockClear();
  view.rerender({ context: { ...original, nodes: [...original.nodes] }, suspend: false });
  expect(view.result.current.get("a")).toBe(before);
  expect(helper).not.toHaveBeenCalled();
  view.rerender({ context: next, suspend: false });
  expect(view.result.current.get("a")).not.toBe(before);
});

it("supports Strict Mode replay and releases the registry on real unmount", () => {
  const context = inputs([node("node")]);
  const view = renderHook(useNodePresentationMetrics, { initialProps: context, wrapper: StrictMode });
  const before = view.result.current.get("node");
  view.rerender({ ...context, nodes: [...context.nodes] });
  expect(view.result.current.get("node")).toBe(before);
  view.unmount();
  const fresh = observe(context);
  expect(fresh.result.current.get("node")).toEqual(before);
  expect(fresh.result.current.get("node")).not.toBe(before);
});

it("constructs once and queries once per fresh canonical owner, not per linked placement", () => {
  const raw = [node("a"), node("linked", "a"), node("b")];
  const original = presentation.buildNodeTopologyMetrics;
  const queries: { count: number }[] = [];
  const build = vi.spyOn(presentation, "buildNodeTopologyMetrics").mockImplementation((nodes, edges) => {
    const batch = original(nodes, edges);
    const get = batch.get.bind(batch);
    const query = { count: 0 };
    queries.push(query);
    vi.spyOn(batch, "get").mockImplementation((id) => { query.count++; return get(id); });
    return batch;
  });
  const context = inputs(raw, [edge("edge", "a", "b")]);
  const view = observe(context);
  expect(build).toHaveBeenCalledOnce();
  expect(queries).toEqual([{ count: 2 }]);
  const before = view.result.current.get("a");
  view.rerender({ ...context, nodes: [...raw] });
  expect(build).toHaveBeenCalledOnce();
  expect(queries).toEqual([{ count: 2 }]);
  expect(view.result.current.get("a")).toBe(before);
  view.rerender({ ...context, rawNodes: [...raw] });
  expect(build).toHaveBeenCalledTimes(2);
  expect(queries).toEqual([{ count: 2 }, { count: 2 }]);
  expect(view.result.current.get("a")).toBe(before);
});

it("skips empty/cached projections and builds lazily for newly visible owners or absent raw owners", () => {
  const a = node("a");
  const b = node("b");
  const context = inputs([a, b], [], []);
  const build = vi.spyOn(presentation, "buildNodeTopologyMetrics");
  const view = observe(context);
  expect(build).not.toHaveBeenCalled();
  view.rerender({ ...context, nodes: [a] });
  const before = view.result.current.get("a");
  expect(build).toHaveBeenCalledOnce();
  view.rerender({ ...context, nodes: [a, b] });
  expect(build).toHaveBeenCalledTimes(2);
  expect(view.result.current.get("a")).toBe(before);
  view.rerender({ ...context, nodes: [a, b, node("absent")] });
  expect(build).toHaveBeenCalledTimes(3);
  expect(view.result.current.get("absent")).toEqual({ incoming: 0, outgoing: 0, instances: 0 });
  view.rerender({ ...context, nodes: [a, b, node("absent")] });
  expect(build).toHaveBeenCalledTimes(3);
});

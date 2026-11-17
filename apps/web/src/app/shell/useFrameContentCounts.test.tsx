import type { Node } from "@xyflow/react";
import { renderHook } from "@testing-library/react";
import { StrictMode, Suspense } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { NarrativeNodeData } from "../../types";
import * as frameCounts from "../graph/frameContentCounts";
import * as membership from "../graph/frameMembershipSignatures";
import { useFrameContentCounts, type FrameCountInputs } from "./useFrameContentCounts";

afterEach(() => vi.restoreAllMocks());
function node(id: string, kind: NarrativeNodeData["kind"], parentId?: string): Node<NarrativeNodeData> {
  return { id, parentId, position: { x: 0, y: 0 }, data: {
    kind, title: id, label: id, summary: "Text", tags: [], isFrame: kind === "Scene" || kind === "Location"
  } };
}
function inputs(rawNodes: Node<NarrativeNodeData>[], nodes: FrameCountInputs["nodes"] = rawNodes, projectId = "project-a"): FrameCountInputs {
  return { projectId, rawNodes, nodes };
}
const observe = (initialProps: FrameCountInputs) => renderHook(useFrameContentCounts, { initialProps });

it.each([2, 20])("bounds initial and changed-member count preparation independently of cached signatures for %s frames", (count) => {
  const original = frameCounts.buildFrameCountInputs;
  let parents = 0, queries = 0;
  const batch = vi.spyOn(frameCounts, "buildFrameCountInputs").mockImplementation((nodes) => {
    const grouped = original(nodes);
    const get = grouped.get.bind(grouped);
    vi.spyOn(grouped, "get").mockImplementation((id) => { queries++; return get(id); });
    return grouped;
  });
  const watched = (item: Node<NarrativeNodeData>) => new Proxy(item, { get(target, key, receiver) {
    // Actual raw parent reads include both independent invocation-local groupings.
    if (key === "parentId") parents++;
    return Reflect.get(target, key, receiver);
  } });
  const raw = Array.from({ length: count }, (_, index) => [node(`frame-${index}`, "Scene"),
    node(`child-${index}`, "Character", `frame-${index}`), node(`item-${index}`, "Item", `frame-${index}`)]).flat().map(watched);
  const formatter = vi.spyOn(frameCounts, "countFrameChildren");
  const view = observe(inputs(raw));
  const before = view.result.current;
  expect(batch).toHaveBeenCalledOnce();
  expect(queries).toBe(count);
  expect(formatter).toHaveBeenCalledTimes(count);
  expect(formatter.mock.calls.every(([children]) => children.length === 2)).toBe(true);
  expect(parents).toBe(2 * raw.length);
  expect(before.get("frame-0")).toEqual({ total: 2, tooltip: "1 character, 1 item" });
  parents = 0;
  queries = 0;
  batch.mockClear();
  formatter.mockClear();
  const changed = raw.map((item) => item.id === "child-0" ? watched({ ...item, data: { ...item.data, kind: "Lore" } }) : item);
  parents = 0;
  view.rerender(inputs(changed));
  expect(batch).toHaveBeenCalledOnce();
  expect(queries).toBe(1);
  expect(formatter).toHaveBeenCalledOnce();
  expect(formatter.mock.calls[0]![0]).toHaveLength(2);
  expect(parents).toBe(2 * raw.length);
  expect(view.result.current.get("frame-0")).toEqual({ total: 2, tooltip: "1 lore, 1 item" });
  expect(view.result.current.get("frame-0")).not.toBe(before.get("frame-0"));
  for (let index = 1; index < count; index++) expect(view.result.current.get(`frame-${index}`)).toBe(before.get(`frame-${index}`));
  parents = 0;
  queries = 0;
  batch.mockClear();
  formatter.mockClear();
  view.rerender(inputs([...changed]));
  expect(parents).toBe(raw.length);
  expect(queries).toBe(0);
  expect(batch).not.toHaveBeenCalled();
  expect(formatter).not.toHaveBeenCalled();
});

it.each([2, 20])("measures cached signature preparation independently from formatting for %s frames", (count) => {
  let parents = 0;
  const raw = Array.from({ length: count }, (_, index) => [node(`frame-${index}`, "Scene"),
    node(`child-${index}-a`, "Character", `frame-${index}`), node(`child-${index}-b`, "Item", `frame-${index}`)]).flat()
    .map((item) => new Proxy(item, { get(target, key, receiver) {
      if (key === "parentId") parents++;
      return Reflect.get(target, key, receiver);
    } }));
  const formatter = vi.spyOn(frameCounts, "countFrameChildren");
  const context = inputs(raw);
  const view = observe(context);
  const before = view.result.current;
  parents = 0;
  formatter.mockClear();
  view.rerender({ ...context, rawNodes: [...raw], nodes: [...context.nodes] });
  expect(parents).toBe(raw.length);
  expect(formatter).not.toHaveBeenCalled();
  for (const [id, value] of view.result.current) expect(value).toBe(before.get(id));
});

it("keeps the existing direct-placement formatter, kind order and empty-frame value", () => {
  const scene = node("scene", "Scene");
  const location = node("location", "Location", "scene");
  const raw = [scene, location, node("empty", "Location"), node("child-a", "Character", "scene"),
    node("child-b", "Character", "scene"), node("nested", "Event", "location")];
  const view = observe(inputs(raw));
  expect([...view.result.current.keys()]).toEqual(["scene", "location", "empty"]);
  expect(view.result.current.get("scene")).toEqual({ total: 3, tooltip: "2 characters, 1 location" });
  expect(view.result.current.get("location")).toEqual({ total: 1, tooltip: "1 event" });
  expect(view.result.current.get("empty")).toEqual({ total: 0, tooltip: "No placements" });
});

it("retains counts across selection, titles, Text, geometry and raw/projected order changes", () => {
  const raw = [node("scene", "Scene"), node("child", "Character", "scene")];
  const helper = vi.spyOn(frameCounts, "countFrameChildren");
  const view = observe(inputs(raw));
  const before = view.result.current.get("scene");
  helper.mockClear();
  const next = raw.map((item) => ({ ...item, selected: true, position: { x: 100, y: 200 }, width: 500,
    data: { ...item.data, title: "Renamed", summary: "Edited Text", tags: ["tag"] } })).reverse();
  view.rerender(inputs(next));
  expect(view.result.current.get("scene")).toBe(before);
  expect(helper).not.toHaveBeenCalled();
});

it("counts hidden/filtered raw children even when the projection contains only a collapsed frame", () => {
  const scene = node("scene", "Scene");
  const child = { ...node("child", "Character", "scene"), hidden: true };
  const raw = [scene, child];
  const view = observe(inputs(raw));
  const before = view.result.current.get("scene");
  const collapsed = { ...scene, data: { ...scene.data, presentationState: "collapsed" as const } };
  view.rerender(inputs(raw, [collapsed]));
  expect(view.result.current.get("scene")).toBe(before);
  expect(before!.total).toBe(1);
});

it("updates child kind tooltips without changing totals and detects same-kind membership replacement", () => {
  const scene = node("scene", "Scene");
  const view = observe(inputs([scene, node("child", "Character", "scene")]));
  view.rerender(inputs([scene, node("child", "Item", "scene")]));
  const before = view.result.current.get("scene");
  expect(before).toEqual({ total: 1, tooltip: "1 item" });
  view.rerender(inputs([scene, node("replacement", "Item", "scene")]));
  expect(view.result.current.get("scene")).toEqual(before);
  expect(view.result.current.get("scene")).not.toBe(before);
});

it("counts linked placements separately and moves counts between visual frames without canonical merging", () => {
  const primary = node("primary", "Location");
  const linked = { ...node("linked", "Location"), data: { ...primary.data, canonicalNodeId: "primary" } };
  const child = node("child", "Character", "primary");
  const alias = { ...node("alias", "Character", "linked"), data: { ...child.data, canonicalNodeId: "child" } };
  const view = observe(inputs([primary, linked, child, alias]));
  expect(view.result.current.get("primary")!.total).toBe(1);
  expect(view.result.current.get("linked")!.total).toBe(1);
  view.rerender(inputs([primary, linked, child, { ...alias, parentId: "primary" }]));
  expect(view.result.current.get("primary")!.total).toBe(2);
  expect(view.result.current.get("linked")!.total).toBe(0);
});

it("counts duplicate raw records but preserves the existing last-kind signature eligibility", () => {
  const scene = node("scene", "Scene");
  const last = node("same-id", "Item", "scene");
  const batch = vi.spyOn(frameCounts, "buildFrameCountInputs");
  const formatter = vi.spyOn(frameCounts, "countFrameChildren");
  const view = observe(inputs([scene, node("same-id", "Character", "scene"), last]));
  const before = view.result.current.get("scene");
  expect(before).toEqual({ total: 2, tooltip: "1 character, 1 item" });
  batch.mockClear();
  formatter.mockClear();
  // Removing a shadowed duplicate does not change the old last-kind signature.
  view.rerender(inputs([scene, last]));
  expect(view.result.current.get("scene")).toBe(before);
  expect(batch).not.toHaveBeenCalled();
  expect(formatter).not.toHaveBeenCalled();
  view.rerender(inputs([node("scene", "Location"), last]));
  expect(view.result.current.get("scene")).toEqual({ total: 1, tooltip: "1 item" });
  expect(batch).toHaveBeenCalledOnce();
});

it("updates nested Location counts without invalidating its Scene's direct-child counts", () => {
  const scene = node("scene", "Scene");
  const location = node("location", "Location", "scene");
  const view = observe(inputs([scene, location]));
  const before = view.result.current.get("scene");
  view.rerender(inputs([scene, location, node("grandchild", "Character", "location")]));
  expect(view.result.current.get("scene")).toBe(before);
  expect(view.result.current.get("location")!.total).toBe(1);
  view.rerender(inputs([scene, location]));
  expect(view.result.current.get("scene")).toBe(before);
  expect(view.result.current.get("location")!.total).toBe(0);
});

it.each(["removed", "non-frame", "kind", "canonical", "project"])("retires a %s frame scope instead of retaining past values", (change) => {
  const scene = node("scene", "Scene");
  const original = inputs([scene]);
  const view = observe(original);
  const before = view.result.current.get("scene");
  view.rerender(change === "removed" ? inputs([scene], [])
    : change === "non-frame" ? inputs([{ ...scene, data: { ...scene.data, isFrame: false } }])
    : change === "kind" ? inputs([node("scene", "Location")])
    : change === "canonical" ? inputs([{ ...scene, data: { ...scene.data, canonicalNodeId: "other" } }])
    : { ...original, projectId: "project-b" });
  expect(view.result.current.get("scene")).not.toBe(before);
  view.rerender(original);
  expect(view.result.current.get("scene")).not.toBe(before);
});

it("bounds entries to live projected frames, not previously visited frames", () => {
  const helper = vi.spyOn(frameCounts, "countFrameChildren");
  const view = observe(inputs([]));
  for (let index = 0; index < 20; index += 1) {
    view.rerender(inputs([node(`frame:${index}`, "Scene")]));
    expect([...view.result.current.keys()]).toEqual([`frame:${index}`]);
  }
  view.rerender(inputs([]));
  expect(view.result.current.size).toBe(0);
  view.rerender(inputs([node("frame:0", "Scene")]));
  expect(helper).toHaveBeenCalledTimes(21);
});

it.each(["children", "projection", "project"])("does not publish speculative %s or prune committed counts during Suspense", (change) => {
  const scene = node("scene", "Scene");
  const original = inputs([scene]);
  const next = change === "children" ? inputs([scene, node("child", "Character", "scene")])
    : change === "projection" ? inputs([scene], []) : { ...original, projectId: "project-b" };
  const pending = new Promise<void>(() => {});
  const helper = vi.spyOn(frameCounts, "countFrameChildren");
  const view = renderHook(({ context, suspend }) => {
    const values = useFrameContentCounts(context);
    if (suspend) throw pending;
    return values;
  }, { initialProps: { context: original, suspend: false }, wrapper: ({ children }) => <Suspense fallback={null}>{children}</Suspense> });
  const before = view.result.current.get("scene");
  view.rerender({ context: next, suspend: true });
  // React can retry speculative work; only committed membership may be retained.
  helper.mockClear();
  view.rerender({ context: { ...original, rawNodes: [...original.rawNodes] }, suspend: false });
  expect(view.result.current.get("scene")).toBe(before);
  expect(helper).not.toHaveBeenCalled();
  view.rerender({ context: next, suspend: false });
  expect(view.result.current.get("scene")).not.toBe(before);
});

it("supports Strict Mode replay and starts a fresh registry after real unmount", () => {
  const context = inputs([node("scene", "Scene")]);
  const view = renderHook(useFrameContentCounts, { initialProps: context, wrapper: StrictMode });
  const before = view.result.current.get("scene");
  view.rerender({ ...context, nodes: [...context.nodes] });
  expect(view.result.current.get("scene")).toBe(before);
  view.unmount();
  const fresh = observe(context);
  expect(fresh.result.current.get("scene")).toEqual(before);
  expect(fresh.result.current.get("scene")).not.toBe(before);
});

it("builds once and queries each projected frame, retaining cached values and independent empty-frame results", () => {
  const raw = [node("a", "Scene"), node("b", "Location"), node("empty-a", "Scene"), node("empty-b", "Scene"),
    node("child-a", "Character", "a"), node("child-b", "Item", "b")];
  const original = membership.buildFrameMembershipSignatures;
  const queries: { count: number }[] = [];
  const batch = vi.spyOn(membership, "buildFrameMembershipSignatures").mockImplementation((nodes) => {
    const grouped = original(nodes);
    const get = grouped.get.bind(grouped);
    const query = { count: 0 };
    queries.push(query);
    vi.spyOn(grouped, "get").mockImplementation((id) => { query.count++; return get(id); });
    return grouped;
  });
  const formatter = vi.spyOn(frameCounts, "countFrameChildren");
  const context = inputs(raw);
  const view = observe(context);
  const before = view.result.current;
  expect(batch).toHaveBeenCalledOnce();
  expect(queries).toEqual([{ count: 4 }]);
  expect(before.get("empty-a")).not.toBe(before.get("empty-b"));
  expect(formatter).toHaveBeenCalledTimes(4);
  formatter.mockClear();
  view.rerender({ ...context, nodes: [...raw] });
  expect(batch).toHaveBeenCalledTimes(2);
  expect(queries).toEqual([{ count: 4 }, { count: 4 }]);
  expect(formatter).not.toHaveBeenCalled();
  for (const [id, value] of view.result.current) expect(value).toBe(before.get(id));
});

it("skips signature grouping and formatting when the projection has no frames", () => {
  const raw = [node("scene", "Scene"), node("child", "Character", "scene")];
  const batch = vi.spyOn(membership, "buildFrameMembershipSignatures");
  const countInputs = vi.spyOn(frameCounts, "buildFrameCountInputs");
  const formatter = vi.spyOn(frameCounts, "countFrameChildren");
  const view = observe(inputs(raw, []));
  expect(view.result.current.size).toBe(0);
  view.rerender(inputs([...raw], [raw[1]!]));
  expect(view.result.current.size).toBe(0);
  expect(batch).not.toHaveBeenCalled();
  expect(countInputs).not.toHaveBeenCalled();
  expect(formatter).not.toHaveBeenCalled();
});

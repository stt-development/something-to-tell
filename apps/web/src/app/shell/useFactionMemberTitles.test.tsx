import type { Edge, Node } from "@xyflow/react";
import { renderHook } from "@testing-library/react";
import { StrictMode, Suspense } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { NarrativeEdgeData, NarrativeNodeData } from "../../types";
import * as presentation from "../graph/graphProjection";
import { useFactionMemberTitles, type FactionTitleInputs } from "./useFactionMemberTitles";

afterEach(() => vi.restoreAllMocks());
const node = (id: string, kind: NarrativeNodeData["kind"] = "Character", title = id): Node<NarrativeNodeData> => ({
  id, position: { x: 0, y: 0 }, data: { kind, title, label: title, summary: "Text", tags: [] }
});
const membership = (source: string, target = "faction", id = source): Edge<NarrativeEdgeData> => ({
  id, source, target, hidden: true, data: { label: "Member", relationshipType: "member_of" }
});
function inputs(rawNodes: Node<NarrativeNodeData>[], rawEdges: Edge<NarrativeEdgeData>[] = [], nodes: FactionTitleInputs["nodes"] = rawNodes, projectId = "project-a"): FactionTitleInputs {
  return { projectId, rawNodes, rawEdges, nodes };
}
const observe = (initialProps: FactionTitleInputs) => renderHook(useFactionMemberTitles, { initialProps });

it("uses hidden canonical memberships, excludes linked/non-Character duplicates and preserves raw Character order", () => {
  const faction = node("faction", "Faction");
  const linked = { ...node("linked", "Character", "Alias"), data: { ...node("a").data, canonicalNodeId: "a", isLinkedInstance: true } };
  const raw = [faction, node("b"), linked, node("a"), node("item", "Item")];
  const view = observe(inputs(raw, [membership("a"), membership("b"), membership("a", "faction", "duplicate"), membership("item")], [faction]));
  expect([...view.result.current.keys()]).toEqual(["faction"]);
  expect(view.result.current.get("faction")).toEqual(["b", "a"]);
});

it("retains titles without helper work when only the projection changes", () => {
  const faction = node("faction", "Faction");
  const context = inputs([faction, node("a")], [membership("a")]);
  const helper = vi.spyOn(presentation, "factionMembers");
  const view = observe(context);
  const before = view.result.current.get("faction");
  helper.mockClear();
  const selected = { ...faction, selected: true };
  view.rerender({ ...context, nodes: [selected] });
  expect(view.result.current.get("faction")).toBe(before);
  expect(helper).not.toHaveBeenCalled();
});

it("retains equal ordered titles after geometry, unrelated Text, faction title and edge metadata changes", () => {
  const context = inputs([node("faction", "Faction"), node("a")], [membership("a")]);
  const view = observe(context);
  const before = view.result.current.get("faction");
  const raw = context.rawNodes.map((item) => ({ ...item, position: { x: 50, y: 60 }, data: { ...item.data,
    title: item.data.kind === "Faction" ? "Renamed faction" : item.data.title, summary: "Edited", tags: ["tag"] } }));
  view.rerender(inputs(raw, [{ ...context.rawEdges[0]!, hidden: false, data: { label: "Changed", relationshipType: "member_of" } }]));
  expect(view.result.current.get("faction")).toBe(before);
});

it("updates current member names and raw ordering rather than caching node metadata", () => {
  const faction = node("faction", "Faction");
  const a = node("a");
  const b = node("b");
  const edges = [membership("b"), membership("a")];
  const view = observe(inputs([faction, a, b], edges));
  const before = view.result.current.get("faction");
  view.rerender(inputs([faction, b, { ...a, data: { ...a.data, title: "Renamed" } }], edges));
  expect(view.result.current.get("faction")).toEqual(["b", "Renamed"]);
  expect(view.result.current.get("faction")).not.toBe(before);
});

it("updates membership add/remove, relationship type/source/target edits and Character eligibility", () => {
  const raw = [node("faction", "Faction"), node("a"), node("b")];
  const view = observe(inputs(raw));
  expect(view.result.current.get("faction")).toEqual([]);
  view.rerender(inputs(raw, [membership("a")]));
  expect(view.result.current.get("faction")).toEqual(["a"]);
  view.rerender(inputs(raw, [membership("b")]));
  expect(view.result.current.get("faction")).toEqual(["b"]);
  view.rerender(inputs(raw, [membership("b", "other-faction")]));
  expect(view.result.current.get("faction")).toEqual([]);
  view.rerender(inputs(raw, [{ ...membership("a"), data: { label: "Appears", relationshipType: "appears_in" } }]));
  expect(view.result.current.get("faction")).toEqual([]);
  view.rerender(inputs([raw[0]!, node("a", "Item"), raw[2]!], [membership("a")]));
  expect(view.result.current.get("faction")).toEqual([]);
  view.rerender(inputs(raw, [membership("a")]));
  expect(view.result.current.get("faction")).toEqual(["a"]);
  view.rerender(inputs(raw));
  expect(view.result.current.get("faction")).toEqual([]);
});

it("preserves exact raw faction lookup and its fallback for missing visual ids", () => {
  const faction = node("faction", "Faction");
  const linked = { ...node("linked", "Faction"), data: { ...faction.data, canonicalNodeId: "faction", isLinkedInstance: true } };
  const raw = [faction, linked, node("a"), node("b")];
  const view = observe(inputs(raw, [membership("a"), membership("b", "missing")], [linked, { id: "missing", data: { kind: "Faction" } }]));
  expect(view.result.current.get("linked")).toEqual(["a"]);
  expect(view.result.current.get("missing")).toEqual(["b"]);
});

it("retains equal ordered presentation names after membership identity changes and preserves duplicate names", () => {
  const raw = [node("faction", "Faction"), node("a", "Character", "Same"), node("b", "Character", "Same")];
  const view = observe(inputs(raw, [membership("a")]));
  const before = view.result.current.get("faction");
  view.rerender(inputs(raw, [membership("b")]));
  expect(view.result.current.get("faction")).toBe(before);
  view.rerender(inputs(raw, [membership("a"), membership("b")]));
  expect(view.result.current.get("faction")).toEqual(["Same", "Same"]);
});

it.each(["projection", "type", "canonical", "project"])("retires %s scope without reviving historical lists", (change) => {
  const faction = node("faction", "Faction");
  const original = inputs([faction, node("a")], [membership("a")]);
  const view = observe(original);
  const before = view.result.current.get("faction");
  view.rerender(change === "projection" ? { ...original, nodes: [] }
    : change === "type" ? { ...original, nodes: [node("faction", "Character")] }
    : change === "canonical" ? { ...original, rawNodes: [{ ...faction, data: { ...faction.data, canonicalNodeId: "other" } }, original.rawNodes[1]!] }
    : { ...original, projectId: "project-b" });
  expect(view.result.current.get("faction")).not.toBe(before);
  view.rerender(original);
  expect(view.result.current.get("faction")).not.toBe(before);
});

it("bounds retention to live faction placements, including per-owner empty lists", () => {
  const raw = Array.from({ length: 20 }, (_, index) => node(`faction:${index}`, "Faction"));
  const helper = vi.spyOn(presentation, "factionMembers");
  const view = observe(inputs(raw, [], []));
  for (const faction of raw) {
    view.rerender(inputs(raw, [], [faction]));
    expect([...view.result.current.keys()]).toEqual([faction.id]);
  }
  view.rerender(inputs(raw, [], []));
  expect(view.result.current.size).toBe(0);
  view.rerender(inputs(raw, [], [raw[0]!]));
  expect(helper).toHaveBeenCalledTimes(21);
});

it.each(["name", "memberships", "projection", "project"])("does not publish speculative %s or prune committed lists during Suspense", (change) => {
  const original = inputs([node("faction", "Faction"), node("a")], [membership("a")]);
  const next = change === "name" ? { ...original, rawNodes: [original.rawNodes[0]!, node("a", "Character", "Renamed")] }
    : change === "memberships" ? { ...original, rawEdges: [] }
    : change === "projection" ? { ...original, nodes: [] } : { ...original, projectId: "project-b" };
  const pending = new Promise<void>(() => {});
  const helper = vi.spyOn(presentation, "factionMembers");
  const view = renderHook(({ context, suspend }) => {
    const values = useFactionMemberTitles(context);
    if (suspend) throw pending;
    return values;
  }, { initialProps: { context: original, suspend: false }, wrapper: ({ children }) => <Suspense fallback={null}>{children}</Suspense> });
  const before = view.result.current.get("faction");
  view.rerender({ context: next, suspend: true });
  // Speculative retry counts are not contractual; only committed titles may survive.
  helper.mockClear();
  view.rerender({ context: { ...original, nodes: [...original.nodes] }, suspend: false });
  expect(view.result.current.get("faction")).toBe(before);
  expect(helper).not.toHaveBeenCalled();
  view.rerender({ context: next, suspend: false });
  expect(view.result.current.get("faction")).not.toBe(before);
});

it("supports Strict Mode replay and releases retained titles on real unmount", () => {
  const context = inputs([node("faction", "Faction"), node("a")], [membership("a")]);
  const view = renderHook(useFactionMemberTitles, { initialProps: context, wrapper: StrictMode });
  const before = view.result.current.get("faction");
  view.rerender({ ...context, nodes: [...context.nodes] });
  expect(view.result.current.get("faction")).toBe(before);
  view.unmount();
  const fresh = observe(context);
  expect(fresh.result.current.get("faction")).toEqual(before);
  expect(fresh.result.current.get("faction")).not.toBe(before);
});

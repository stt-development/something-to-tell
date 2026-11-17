import type { Node } from "@xyflow/react";
import { afterEach, expect, it, vi } from "vitest";
import type { NarrativeNodeData } from "../../types";
import { NODE_KINDS } from "../workspaceShared";
import { buildFrameCountInputs, countFrameChildren } from "./frameContentCounts";
import { frameContentCounts } from "./graphProjection";

const node = (id: string, kind: NarrativeNodeData["kind"], parentId?: string): Node<NarrativeNodeData> => ({
  id, parentId, position: { x: 0, y: 0 }, data: { kind, title: id, label: id, summary: "", tags: [] }
});
afterEach(() => vi.restoreAllMocks());

/** Pre-extraction oracle keeps parity independent of the newly shared formatter. */
function original(nodes: readonly Node<NarrativeNodeData>[], frameId: string) {
  const children = nodes.filter((item) => item.parentId === frameId);
  const counts = new Map<NarrativeNodeData["kind"], number>();
  for (const child of children) counts.set(child.data.kind, (counts.get(child.data.kind) ?? 0) + 1);
  return { total: children.length, tooltip: NODE_KINDS.flatMap((kind) => counts.has(kind)
    ? [`${counts.get(kind)} ${kind.toLocaleLowerCase()}${counts.get(kind) === 1 ? "" : "s"}`] : []).join(", ") || "No placements" };
}

it("matches the original facade for exact direct, hidden, linked, duplicate and defensive parent inputs", () => {
  const raw = [node("scene", "Scene"), node("location", "Location", "scene"), node("nested", "Event", "location"),
    { ...node("hidden", "Character", "scene"), hidden: true }, node("duplicate", "Character", "scene"), node("duplicate", "Item", "scene"),
    { ...node("alias", "Item", "linked"), data: { ...node("alias", "Item").data, canonicalNodeId: "duplicate", isLinkedInstance: true } },
    node("empty-parent", "Lore", ""), node("self", "Location", "self"), node("missing-parent", "Quest", "missing")];
  const grouped = buildFrameCountInputs(raw);
  for (const id of ["scene", "location", "linked", "", "self", "missing", "empty"]) {
    expect(countFrameChildren(grouped.get(id) ?? [])).toEqual(original(raw, id));
    expect(frameContentCounts(raw, id)).toEqual(original(raw, id));
  }
  expect(countFrameChildren(grouped.get("scene")!)).toEqual({ total: 4, tooltip: "2 characters, 1 location, 1 item" });
  expect(grouped.get("scene")![2]).toBe(raw[4]);
  expect(grouped.get("scene")![3]).toBe(raw[5]);
});

it("preserves kind order, singular/plural and fresh empty values independently of raw order", () => {
  const raw = [...NODE_KINDS].reverse().flatMap((kind) => [node(kind, kind, "frame"), node(kind, kind, "frame")]);
  expect(countFrameChildren(raw)).toEqual(original(raw, "frame"));
  for (const kind of NODE_KINDS) expect(countFrameChildren([node(kind, kind)])).toEqual({ total: 1, tooltip: `1 ${kind.toLocaleLowerCase()}` });
  expect(countFrameChildren([])).toEqual({ total: 0, tooltip: "No placements" });
  expect(countFrameChildren([])).not.toBe(countFrameChildren([]));
});

it.each([20, 80])("groups %s direct children with one source-parent read each and no query rescan", (count) => {
  let parents = 0, data = 0;
  const raw = [node("a", "Scene"), node("b", "Location"),
    ...Array.from({ length: count }, (_, index) => node(`child-${index}`, "Character", index % 2 ? "a" : "b"))];
  const source = raw.map((item) => new Proxy(item, { get(target, key, receiver) {
    if (key === "parentId") parents++;
    if (key === "data") data++;
    return Reflect.get(target, key, receiver);
  } }));
  const grouped = buildFrameCountInputs(source);
  const get = vi.spyOn(grouped, "get");
  for (let index = 0; index < count; index++) expect(grouped.get(index % 2 ? "a" : "b")).toHaveLength(count / 2);
  expect(get).toHaveBeenCalledTimes(count);
  expect({ parents, data }).toEqual({ parents: count + 2, data: 0 });
  expect(countFrameChildren(grouped.get("a")!)).toEqual({ total: count / 2, tooltip: `${count / 2} characters` });
  expect(parents).toBe(count + 2);
});

it("uses only current frozen inputs without mutating records or old groups", () => {
  const child = Object.freeze(node("child", "Character", "a"));
  const raw = Object.freeze([child]);
  const before = buildFrameCountInputs(raw);
  const next = buildFrameCountInputs([Object.freeze({ ...child, parentId: "b", data: { ...child.data, kind: "Item" as const } })]);
  expect(next.has("a")).toBe(false);
  expect(countFrameChildren(next.get("b")!)).toEqual({ total: 1, tooltip: "1 item" });
  expect(countFrameChildren(before.get("a")!)).toEqual({ total: 1, tooltip: "1 character" });
  expect(buildFrameCountInputs(raw).get("a")).not.toBe(before.get("a"));
  expect(buildFrameCountInputs([]).size).toBe(0);
});

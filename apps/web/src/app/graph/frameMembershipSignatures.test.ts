import type { Node } from "@xyflow/react";
import { afterEach, expect, it, vi } from "vitest";
import type { NarrativeNodeData } from "../../types";
import { buildFrameMembershipSignatures } from "./frameMembershipSignatures";

const node = (id: string, kind: NarrativeNodeData["kind"], parentId?: string): Node<NarrativeNodeData> => ({
  id, parentId, position: { x: 0, y: 0 }, data: { kind, title: id, label: id, summary: "", tags: [] }
});
afterEach(() => vi.restoreAllMocks());

it("matches per-frame maps for hidden/linked/direct children, exact ids and duplicate last values", () => {
  const raw = [node("scene", "Scene"), node("location", "Location", "scene"),
    { ...node("linked-frame", "Location"), data: { ...node("linked-frame", "Location").data, canonicalNodeId: "scene" } },
    { ...node("hidden", "Character", "scene"), hidden: true },
    { ...node("alias", "Character", "linked-frame"), data: { ...node("alias", "Character").data, canonicalNodeId: "hidden", isLinkedInstance: true } },
    node("grandchild", "Item", "location"), node("duplicate", "Character", "scene"), node("duplicate", "Item", "scene"),
    node("empty-parent", "Event", ""), node("missing-parent", "Lore", "missing"), node("self", "Location", "self")];
  const grouped = buildFrameMembershipSignatures(raw);
  for (const id of ["scene", "location", "linked-frame", "", "missing", "self", "empty"]) {
    expect(grouped.get(id) ?? new Map()).toEqual(new Map(raw.filter((child) => child.parentId === id).map((child) => [child.id, child.data.kind])));
  }
  expect([...grouped.get("scene")!.keys()]).toEqual(["location", "hidden", "duplicate"]);
  expect(grouped.get("scene")!.get("duplicate")).toBe("Item");
  expect(grouped.get("scene")!.has("grandchild")).toBe(false);
  expect(grouped.get("linked-frame")!.has("alias")).toBe(true);
});

it.each([20, 80])("reads each source parent once when grouping %s attached children, without query rescans", (count) => {
  const source = [node("a", "Scene"), node("b", "Location"),
    ...Array.from({ length: count }, (_, index) => node(`child-${index}`, "Character", index % 2 ? "a" : "b"))];
  let parents = 0, ids = 0, kinds = 0;
  // Actual source-field reads, not the name of an array method used by the builder.
  const input = source.map((item) => new Proxy(item, { get(target, key, receiver) {
    if (key === "parentId") parents++;
    if (key === "id") ids++;
    if (key === "data") kinds++;
    return Reflect.get(target, key, receiver);
  } }));
  const grouped = buildFrameMembershipSignatures(input);
  const query = vi.spyOn(grouped, "get");
  for (let index = 0; index < count; index++) {
    expect(grouped.get(index % 2 ? "a" : "b")!.size).toBe(count / 2);
  }
  expect(query).toHaveBeenCalledTimes(count);
  expect({ parents, ids, kinds }).toEqual({ parents: count + 2, ids: count, kinds: count });
});

it("uses only current invocation inputs and leaves frozen raw records and old signatures untouched", () => {
  const frame = Object.freeze(node("frame", "Scene"));
  const child = Object.freeze(node("child", "Character", "frame"));
  const raw = Object.freeze([frame, child]);
  const before = buildFrameMembershipSignatures(raw);
  const changed = buildFrameMembershipSignatures([frame, { ...child, parentId: "other", data: { ...child.data, kind: "Item" } }]);
  expect(changed.has("frame")).toBe(false);
  expect(changed.get("other")!.get("child")).toBe("Item");
  expect(before.get("frame")!.get("child")).toBe("Character");
  const restored = buildFrameMembershipSignatures(raw);
  expect(restored.get("frame")).toEqual(before.get("frame"));
  expect(restored.get("frame")).not.toBe(before.get("frame"));
  expect(buildFrameMembershipSignatures([]).size).toBe(0);
});

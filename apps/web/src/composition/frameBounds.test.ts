import type { Node } from "@xyflow/react";
import { afterEach, expect, it, vi } from "vitest";
import type { NarrativeNodeData } from "../types";
import * as bounds from "./frameBounds";
import { enforceFrameMinimums, fitFrameToContent, FRAME_MIN_SIZE, FRAME_PADDING } from "./layout";

type VisualNode = Node<NarrativeNodeData>;
const node = (id: string, parentId?: string): VisualNode => ({
  id, parentId, position: { x: 10, y: 20 }, data: { kind: "Character", title: id, label: id, summary: "", tags: [] }
});
const frame = (id: string, parentId?: string): VisualNode => ({ ...node(id, parentId),
  data: { ...node(id).data, kind: parentId === undefined ? "Scene" : "Location", isFrame: true }
});
afterEach(() => vi.restoreAllMocks());

/** Test-only pre-batch oracle; production size policy stays in composition layout. */
function legacyClamp(nodes: readonly VisualNode[]): VisualNode[] {
  return nodes.map((item) => {
    if (!item.data.isFrame || item.data.presentationState === "collapsed") return item;
    const children = nodes.filter((child) => child.parentId === item.id);
    const right = Math.max(0, ...children.map((child) => child.position.x + (child.width ?? 260)));
    const bottom = Math.max(0, ...children.map((child) => child.position.y + (child.height ?? 156)));
    return { ...item, width: Math.max(item.width ?? FRAME_MIN_SIZE.width, FRAME_MIN_SIZE.width, right + FRAME_PADDING),
      height: Math.max(item.height ?? FRAME_MIN_SIZE.height, FRAME_MIN_SIZE.height, bottom + FRAME_PADDING) };
  });
}

it.each([2, 20])("constructs child bounds once for %s expanded frames and queries each frame once", (count) => {
  const source = Array.from({ length: count }, (_, index) => [frame(`frame-${index}`),
    node(`child-${index}-a`, `frame-${index}`), node(`child-${index}-b`, `frame-${index}`)]).flat();
  const original = bounds.buildFrameChildBounds;
  let building = false, parents = 0, children = 0, widths = 0, heights = 0, queries = 0;
  const build = vi.spyOn(bounds, "buildFrameChildBounds").mockImplementation((nodes) => {
    building = true;
    let result: ReturnType<typeof original>;
    try { result = original(nodes); } finally { building = false; }
    const get = result.get.bind(result);
    vi.spyOn(result, "get").mockImplementation((id) => { queries++; return get(id); });
    return result;
  });
  const input = source.map((item) => new Proxy(item, { get(target, key, receiver) {
    if (building) {
      if (key === "parentId") parents++;
      if (key === "position") children++;
      if (key === "width") widths++;
      if (key === "height") heights++;
    }
    return Reflect.get(target, key, receiver);
  } }));
  expect(enforceFrameMinimums(input)).toEqual(legacyClamp(source));
  expect(build).toHaveBeenCalledTimes(1);
  expect(build).toHaveBeenCalledWith(input);
  expect({ parents, children, widths, heights, queries }).toEqual({
    parents: count * 3, children: count * 2, widths: count * 2, heights: count * 2, queries: count
  });
});

it("does not construct a batch for empty, non-frame or collapsed-only input", () => {
  const build = vi.spyOn(bounds, "buildFrameChildBounds");
  const collapsed = { ...frame("collapsed"), data: { ...frame("collapsed").data, presentationState: "collapsed" as const } };
  for (const source of [[], [node("root")], [collapsed, node("child", "collapsed")]]) {
    const result = enforceFrameMinimums(source);
    expect(result).not.toBe(source);
    expect(result.every((item, index) => item === source[index])).toBe(true);
  }
  expect(build).not.toHaveBeenCalled();
});

it("preserves nested original-input dimensions, output order and wrapper/reference behavior", () => {
  const source = [
    { ...node("child", "inner"), position: { x: 800, y: 600 }, width: 300, height: 200 },
    { ...frame("inner", "outer"), width: 1, height: 1 },
    { ...frame("outer"), width: 100, height: 100 }
  ];
  const result = enforceFrameMinimums(source);
  expect(result).toEqual(legacyClamp(source));
  expect(result.map((item) => item.id)).toEqual(source.map((item) => item.id));
  expect(result[1]).toMatchObject({ width: 1124, height: 824 });
  expect(result[2]).toMatchObject({ width: 320, height: 220 });
  expect(result[0]).toBe(source[0]);
  for (const index of [1, 2]) {
    expect(result[index]).not.toBe(source[index]);
    expect(result[index]!.position).toBe(source[index]!.position);
    expect(result[index]!.data).toBe(source[index]!.data);
  }
  expect(source[1]!.width).toBe(1);
  expect(enforceFrameMinimums(result)).toEqual(legacyClamp(result));
});

it("includes hidden and linked children by visual parent while respecting zero/default sizes and negative bounds", () => {
  const source = [frame("a"), frame("b"), frame("empty"),
    { ...node("hidden", "a"), hidden: true, position: { x: 500, y: 400 }, width: 0, height: 0 },
    { ...node("linked", "b"), position: { x: 900, y: 700 },
      data: { ...node("linked").data, canonicalNodeId: "hidden", isLinkedInstance: true } },
    { ...node("negative", "a"), position: { x: -1000, y: -1000 } },
    { ...node("measured", "a"), width: 0, height: 0, measured: { width: 9000, height: 9000 } },
    { ...node("uncontained"), position: { x: 9000, y: 9000 } }];
  expect(enforceFrameMinimums(source)).toEqual(legacyClamp(source));
  const batch = bounds.buildFrameChildBounds(source);
  expect(batch.get("a")).toEqual({ right: 500, bottom: 400 });
  expect(batch.get("b")).toEqual({ right: 1160, bottom: 856 });
  expect(batch.has("empty")).toBe(false);
});

it("uses current parents/sizes per invocation without retaining previous bounds or mutating frozen input", () => {
  const source = [Object.freeze(frame("a")), Object.freeze(frame("b")), Object.freeze(node("child", "a"))];
  const first = enforceFrameMinimums(Object.freeze(source));
  const changed = source.map((item) => item.id === "child" ? { ...item, parentId: "b", width: 1000, height: 900 } : item);
  const second = enforceFrameMinimums(changed);
  expect(second).toEqual(legacyClamp(changed));
  expect(second[1]).toMatchObject({ width: 1034, height: 944 });
  expect(enforceFrameMinimums(source)).toEqual(first);
  expect(bounds.buildFrameChildBounds(source).get("a")).not.toBe(bounds.buildFrameChildBounds(source).get("a"));
});

it("keeps clamp no-shrink behavior and explicit fit shrinking through the same size rules", () => {
  const source = [{ ...frame("frame"), width: 2000, height: 2000 }, node("child", "frame"), frame("other")];
  expect(enforceFrameMinimums(source)[0]).toMatchObject({ width: 2000, height: 2000 });
  const batch = vi.spyOn(bounds, "buildFrameChildBounds");
  const children = vi.spyOn(bounds, "frameBoundsForChildren");
  const fitted = fitFrameToContent(source, "frame");
  expect(fitted[0]).toMatchObject({ width: 320, height: 220 });
  expect(fitted[1]).toBe(source[1]);
  expect(fitted[2]).toBe(source[2]);
  expect(children).toHaveBeenCalledTimes(1);
  expect(batch).not.toHaveBeenCalled();
});

it("preserves exact empty ids, duplicate frame ids, missing parents and non-finite arithmetic", () => {
  const source = [frame(""), frame("duplicate"), { ...frame("duplicate"), width: 1000 }, frame("nan"),
    { ...node("empty-parent", ""), position: { x: 700, y: 600 } },
    node("missing", "absent"), node("duplicate-child", "duplicate"),
    { ...node("nan-child", "nan"), width: Number.NaN, height: Number.POSITIVE_INFINITY }];
  const result = enforceFrameMinimums(source);
  expect(result).toEqual(legacyClamp(source));
  expect(result[0]).toMatchObject({ width: 984, height: 780 });
  expect(result[3]!.width).toBeNaN();
  expect(result[3]!.height).toBe(Number.POSITIVE_INFINITY);
});

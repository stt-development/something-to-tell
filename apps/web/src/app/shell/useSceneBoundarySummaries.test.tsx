import { renderHook } from "@testing-library/react";
import { StrictMode, Suspense } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useSceneBoundarySummaries, type SceneBoundaryInputs } from "./useSceneBoundarySummaries";

afterEach(() => vi.restoreAllMocks());
const node = (id: string, title = id, canonicalNodeId?: string) => ({ id, data: { title, canonicalNodeId } });
const boundary = (scene_node_id = "scene", entry_node_id = "entry", exit_node_ids = ["exit"]) => ({ scene_node_id, entry_node_id, exit_node_ids });
function inputs(rawNodes: SceneBoundaryInputs["rawNodes"] = [node("entry", "Opening")], nodes: SceneBoundaryInputs["nodes"] = [node("scene")], boundaries = [boundary()], flowId = "flow-a", projectId = "project-a"): SceneBoundaryInputs {
  return { projectId, rawNodes, nodes, activeStoryFlow: { flow: { id: flowId }, scene_boundaries: boundaries } };
}
const observe = (initialProps: SceneBoundaryInputs) => renderHook(useSceneBoundarySummaries, { initialProps });

it("resolves current entry titles and exit counts, omitting nodes without an active boundary", () => {
  const view = observe(inputs([node("entry", "Opening")], [node("scene"), node("other")]));
  expect([...view.result.current.keys()]).toEqual(["scene"]);
  expect(view.result.current.get("scene")).toEqual({ entry: "Opening", exits: 1 });
});

it("shares canonical summaries across linked placements and retains them if only the primary projection disappears", () => {
  const context = inputs(undefined, [node("scene"), node("linked", "Alias", "scene")]);
  const view = observe(context);
  const before = view.result.current.get("scene");
  expect(view.result.current.get("linked")).toBe(before);
  view.rerender({ ...context, nodes: [context.nodes[1]!] });
  expect(view.result.current.get("linked")).toBe(before);
});

it("retains equal values across view/geometry/label changes and replacement boundary records", () => {
  const context = inputs();
  const view = observe(context);
  const before = view.result.current.get("scene");
  const projected = { ...node("scene", "Renamed"), selected: true, position: { x: 40, y: 80 } };
  const replacement = inputs([node("unrelated", "Edited Text"), ...context.rawNodes], [projected]);
  view.rerender(replacement);
  expect(view.result.current.get("scene")).toBe(before);
});

it("updates entry and exit count, but retains presentation when routing ids change to equal displayed values", () => {
  const raw = [node("entry", "Opening"), node("other", "Other"), node("same", "Other")];
  const view = observe(inputs(raw));
  view.rerender(inputs(raw, undefined, [boundary("scene", "other", ["a", "b"])]));
  const before = view.result.current.get("scene");
  expect(before).toEqual({ entry: "Other", exits: 2 });
  view.rerender(inputs(raw, undefined, [boundary("scene", "same", ["c", "d"])]));
  expect(view.result.current.get("scene")).toBe(before);
  view.rerender(inputs(raw, undefined, [boundary("scene", "same", [])]));
  expect(view.result.current.get("scene")).toEqual({ entry: "Other", exits: 0 });
});

it("refreshes entry renames, missing-id fallback, reappearance and empty authored titles", () => {
  const view = observe(inputs());
  view.rerender(inputs([node("entry", "Renamed")]));
  expect(view.result.current.get("scene")!.entry).toBe("Renamed");
  view.rerender(inputs([]));
  expect(view.result.current.get("scene")!.entry).toBe("entry");
  view.rerender(inputs([node("entry", "Restored")]));
  expect(view.result.current.get("scene")!.entry).toBe("Restored");
  view.rerender(inputs([node("entry", "")]));
  expect(view.result.current.get("scene")!.entry).toBe("");
});

it("preserves first boundary/raw canonical match, duplicate exit length and nullish id fallback", () => {
  const raw = [node("linked-entry", "Linked first", "entry"), node("entry", "Primary"), node("empty-entry", "Empty", "")];
  const view = observe(inputs(raw, [node("scene"), node("empty-scene", "Scene", "")], [
    boundary("scene", "entry", ["same", "same"]), boundary("scene", "ignored", []), boundary("", "", [])
  ]));
  expect(view.result.current.get("scene")).toEqual({ entry: "Linked first", exits: 2 });
  expect(view.result.current.get("empty-scene")).toEqual({ entry: "Empty", exits: 0 });
});

it("preserves boundary-only presentation on membership/kind changes rather than adding integrity rules", () => {
  const original = inputs();
  const view = observe(original);
  const before = view.result.current.get("scene");
  const nonScene = { ...node("scene"), data: { ...node("scene").data, kind: "Event" } };
  const flow = { ...original.activeStoryFlow!, nodes: [], scene_children: {} };
  view.rerender({ ...original, nodes: [nonScene], activeStoryFlow: flow });
  expect(view.result.current.get("scene")).toBe(before);
});

it.each(["boundary", "projection", "canonical", "flow", "no flow", "project"])("retires %s scope without reviving historical summaries", (change) => {
  const original = inputs();
  const view = observe(original);
  const before = view.result.current.get("scene");
  const next = change === "boundary" ? { ...original, activeStoryFlow: { ...original.activeStoryFlow!, scene_boundaries: [] } }
    : change === "projection" ? { ...original, nodes: [] }
    : change === "canonical" ? { ...original, nodes: [node("scene", "Remapped", "other")] }
    : change === "flow" ? inputs(undefined, undefined, undefined, "flow-b")
    : change === "no flow" ? { ...original, activeStoryFlow: null } : { ...original, projectId: "project-b" };
  view.rerender(next);
  expect(view.result.current.get("scene")).not.toBe(before);
  view.rerender(original);
  expect(view.result.current.get("scene")).not.toBe(before);
});

it("bounds retained owners to current projected canonical nodes, not all boundaries visited", () => {
  const boundaries = Array.from({ length: 20 }, (_, index) => boundary(`scene:${index}`));
  const context = inputs(undefined, [node("scene:0")], boundaries);
  const view = observe(context);
  const before = view.result.current.get("scene:0");
  for (let index = 1; index < 20; index += 1) {
    view.rerender({ ...context, nodes: [node(`scene:${index}`)] });
    expect([...view.result.current.keys()]).toEqual([`scene:${index}`]);
  }
  view.rerender({ ...context, nodes: [] });
  expect(view.result.current.size).toBe(0);
  view.rerender(context);
  expect(view.result.current.get("scene:0")).not.toBe(before);
});

it.each(["name", "boundary", "flow", "project", "projection"])("does not publish speculative %s or prune committed summaries during Suspense", (change) => {
  const original = inputs();
  const next = change === "name" ? { ...original, rawNodes: [node("entry", "Renamed")] }
    : change === "boundary" ? inputs(undefined, undefined, [boundary("scene", "missing", [])])
    : change === "flow" ? inputs(undefined, undefined, undefined, "flow-b")
    : change === "project" ? { ...original, projectId: "project-b" } : { ...original, nodes: [] };
  const pending = new Promise<void>(() => {});
  const view = renderHook(({ context, suspend }) => {
    const values = useSceneBoundarySummaries(context);
    if (suspend) throw pending;
    return values;
  }, { initialProps: { context: original, suspend: false }, wrapper: ({ children }) => <Suspense fallback={null}>{children}</Suspense> });
  const before = view.result.current.get("scene");
  view.rerender({ context: next, suspend: true });
  // Abandoned snapshots cannot replace names, prune owners or switch the committed Flow.
  view.rerender({ context: { ...original, nodes: [...original.nodes] }, suspend: false });
  expect(view.result.current.get("scene")).toBe(before);
  view.rerender({ context: next, suspend: false });
  expect(view.result.current.get("scene")).not.toBe(before);
});

it("supports Strict Mode replay and releases summaries on real unmount", () => {
  const context = inputs();
  const view = renderHook(useSceneBoundarySummaries, { initialProps: context, wrapper: StrictMode });
  const before = view.result.current.get("scene");
  view.rerender({ ...context, nodes: [...context.nodes] });
  expect(view.result.current.get("scene")).toBe(before);
  view.unmount();
  const fresh = observe(context);
  expect(fresh.result.current.get("scene")).toEqual(before);
  expect(fresh.result.current.get("scene")).not.toBe(before);
});

import { renderHook } from "@testing-library/react";
import { StrictMode, Suspense } from "react";
import { expect, it } from "vitest";
import { useFlowExitLists, type FlowExitListInputs } from "./useFlowExitLists";

const node = (id: string, canonicalNodeId = id) => ({ id, data: { canonicalNodeId } });
function inputs(): FlowExitListInputs {
  return { projectId: "project-a", nodes: [node("source"), node("linked", "source"), node("empty"), node("other-empty")],
    activeStoryFlow: { flow: { id: "flow-a" }, exits: [
      { id: "exit-a", source_node_id: "source", key: "success", label: "Depart" },
      { id: "exit-b", source_node_id: "source", key: "failure", label: "" },
      { id: "hidden", source_node_id: "hidden-source", key: "hidden", label: "Hidden" }
    ] } };
}
const observe = (initialProps: FlowExitListInputs) => renderHook(useFlowExitLists, { initialProps });

it("preserves source order, shares canonical lists and keeps empty lists local to each live source", () => {
  const view = observe(inputs());
  const rows = view.result.current.get("source")!;
  expect(rows).toEqual([{ id: "exit-a", key: "success", label: "Depart" }, { id: "exit-b", key: "failure", label: "" }]);
  expect(view.result.current.get("linked")).toBe(rows);
  expect(view.result.current.get("empty")).toEqual([]);
  expect(view.result.current.get("empty")).not.toBe(view.result.current.get("other-empty"));
  expect(view.result.current.has("hidden-source")).toBe(false);
});

it("retains rows/lists through equal snapshot replacement and unrelated metadata/geometry changes", () => {
  const context = inputs();
  const view = observe(context);
  const before = view.result.current;
  const next = { ...context, nodes: context.nodes.map((item) => ({ ...item, selected: true, position: { x: 30, y: 90 } })).reverse(),
    activeStoryFlow: { ...context.activeStoryFlow!, exits: context.activeStoryFlow!.exits!.map((exit) => ({ ...exit, metadata: { changed: true } })) } };
  view.rerender(next);
  for (const [id, list] of before) expect(view.result.current.get(id)).toBe(list);
});

it("updates id/key/label independently without mutating prior rows or replacing unaffected rows", () => {
  const context = inputs();
  const exits = context.activeStoryFlow!.exits!;
  const view = observe(context);
  const before = view.result.current.get("source")!;
  view.rerender({ ...context, activeStoryFlow: { ...context.activeStoryFlow!, exits: [{ ...exits[0]!, key: "renamed" }, exits[1]!] } });
  const keyed = view.result.current.get("source")!;
  expect(keyed[0]!.key).toBe("renamed");
  expect(keyed[0]).not.toBe(before[0]);
  expect(keyed[1]).toBe(before[1]);
  expect(before[0]!.key).toBe("success");
  view.rerender({ ...context, activeStoryFlow: { ...context.activeStoryFlow!, exits: [{ ...exits[0]!, label: "Reviewed" }, exits[1]!] } });
  const labelled = view.result.current.get("source")!;
  expect(labelled[0]!.label).toBe("Reviewed");
  expect(labelled[1]).toBe(before[1]);
  expect(before[0]!.label).toBe("Depart");
  view.rerender({ ...context, activeStoryFlow: { ...context.activeStoryFlow!, exits: [{ ...exits[0]!, id: "replacement" }, exits[1]!] } });
  expect(view.result.current.get("source")![0]!.id).toBe("replacement");
  expect(view.result.current.get("source")![0]).not.toBe(before[0]);
});

it("retains rows across reorder, moves exits between sources and prunes removed/recreated exits", () => {
  const context = inputs();
  const exits = context.activeStoryFlow!.exits!;
  const view = observe(context);
  const before = view.result.current.get("source")!;
  view.rerender({ ...context, activeStoryFlow: { ...context.activeStoryFlow!, exits: [exits[1]!, exits[0]!] } });
  expect(view.result.current.get("source")).not.toBe(before);
  expect(view.result.current.get("source")![0]).toBe(before[1]);
  expect(view.result.current.get("source")![1]).toBe(before[0]);
  view.rerender({ ...context, activeStoryFlow: { ...context.activeStoryFlow!, exits: [{ ...exits[0]!, source_node_id: "empty" }] } });
  expect(view.result.current.get("source")).toEqual([]);
  expect(view.result.current.get("empty")![0]!.id).toBe("exit-a");
  view.rerender(context);
  expect(view.result.current.get("source")![0]).not.toBe(before[0]);
});

it("treats absent and empty exit arrays as equal presentation without normalizing raw keys or labels", () => {
  const context = inputs();
  const view = observe({ ...context, activeStoryFlow: { flow: { id: "flow-a" } } });
  const before = view.result.current.get("source");
  view.rerender({ ...context, activeStoryFlow: { ...context.activeStoryFlow!, exits: [] } });
  expect(view.result.current.get("source")).toBe(before);
  view.rerender({ ...context, activeStoryFlow: { ...context.activeStoryFlow!, exits: [{ id: "raw", source_node_id: "source", key: "", label: " " }] } });
  expect(view.result.current.get("source")).toEqual([{ id: "raw", key: "", label: " " }]);
});

it("uses nullish canonical fallback and does not confuse visual and canonical source ids", () => {
  const context = inputs();
  const view = observe({ ...context, nodes: [node("alias", ""), node("other-alias", "source")],
    activeStoryFlow: { flow: { id: "flow-a" }, exits: [
      { id: "empty-canonical", source_node_id: "", key: "empty", label: "" },
      { id: "visual", source_node_id: "other-alias", key: "visual", label: "Not canonical" }
    ] } });
  expect(view.result.current.get("alias")![0]!.id).toBe("empty-canonical");
  expect(view.result.current.get("other-alias")).toEqual([]);
});

it.each(["source", "canonical", "flow", "project", "no flow"])("retires %s scope rather than keeping historical row/list references", (change) => {
  const context = inputs();
  const view = observe(context);
  const before = view.result.current.get("source");
  view.rerender(change === "source" ? { ...context, nodes: [] }
    : change === "canonical" ? { ...context, nodes: [node("source", "other")] }
    : change === "flow" ? { ...context, activeStoryFlow: { ...context.activeStoryFlow!, flow: { id: "flow-b" } } }
    : change === "project" ? { ...context, projectId: "project-b" } : { ...context, activeStoryFlow: null });
  expect(view.result.current.get("source")).not.toBe(before);
  view.rerender(context);
  expect(view.result.current.get("source")).not.toBe(before);
});

it("keeps no-Flow empty lists stable and bounds retained entries to live canonical sources", () => {
  const context = { ...inputs(), activeStoryFlow: null };
  const view = observe(context);
  const before = view.result.current.get("empty");
  view.rerender({ ...context, nodes: [node("empty")] });
  expect(view.result.current.get("empty")).toBe(before);
  for (let index = 0; index < 20; index += 1) {
    view.rerender({ ...context, nodes: [node(`source:${index}`)] });
    expect([...view.result.current.keys()]).toEqual([`source:${index}`]);
  }
  view.rerender({ ...context, nodes: [] });
  expect(view.result.current.size).toBe(0);
  view.rerender({ ...context, nodes: [node("empty")] });
  expect(view.result.current.get("empty")).not.toBe(before);
});

it.each(["label", "key", "projection", "flow", "project"])("does not publish speculative %s or prune committed lists during Suspense", (change) => {
  const context = inputs();
  const next = change === "label" || change === "key" ? { ...context, activeStoryFlow: { ...context.activeStoryFlow!, exits: context.activeStoryFlow!.exits!.map((exit) => ({ ...exit, [change]: "Changed" })) } }
    : change === "projection" ? { ...context, nodes: [] }
    : change === "flow" ? { ...context, activeStoryFlow: { ...context.activeStoryFlow!, flow: { id: "flow-b" } } } : { ...context, projectId: "project-b" };
  const pending = new Promise<void>(() => {});
  const view = renderHook(({ context, suspend }) => {
    const lists = useFlowExitLists(context);
    if (suspend) throw pending;
    return lists;
  }, { initialProps: { context, suspend: false }, wrapper: ({ children }) => <Suspense fallback={null}>{children}</Suspense> });
  const before = view.result.current.get("source");
  view.rerender({ context: next, suspend: true });
  // Only committed labels/keys/scope may replace current presentation rows.
  view.rerender({ context: { ...context, nodes: [...context.nodes] }, suspend: false });
  expect(view.result.current.get("source")).toBe(before);
  view.rerender({ context: next, suspend: false });
  expect(view.result.current.get("source")).not.toBe(before);
});

it("supports Strict Mode replay and releases retained rows on real unmount", () => {
  const context = inputs();
  const view = renderHook(useFlowExitLists, { initialProps: context, wrapper: StrictMode });
  const before = view.result.current.get("source");
  view.rerender({ ...context, nodes: [...context.nodes] });
  expect(view.result.current.get("source")).toBe(before);
  view.unmount();
  const fresh = observe(context);
  expect(fresh.result.current.get("source")).toEqual(before);
  expect(fresh.result.current.get("source")).not.toBe(before);
});

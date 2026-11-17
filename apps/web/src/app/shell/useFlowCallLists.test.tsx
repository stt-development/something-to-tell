import { act, renderHook } from "@testing-library/react";
import { StrictMode, Suspense } from "react";
import { expect, it, vi } from "vitest";
import { useFlowCallLists, type FlowCallListInputs } from "./useFlowCallLists";

const node = (id: string, canonicalNodeId = id) => ({ id, data: { canonicalNodeId } });
function inputs(): FlowCallListInputs {
  return { projectId: "project-a", nodes: [node("source"), node("linked", "source"), node("empty"), node("other-empty")],
    activeStoryFlow: { flow: { id: "flow-a" }, invocations: [
      { id: "call-a", source_node_id: "source", target_flow_id: "target", label: "" },
      { id: "call-b", source_node_id: "source", target_flow_id: "missing", label: "Explicit" },
      { id: "hidden", source_node_id: "hidden-source", target_flow_id: "target", label: "Hidden" }
    ] }, projectStoryFlows: [{ flow: { id: "target", name: "Target name" } }],
    openActions: new Map([["call-a", vi.fn()], ["call-b", vi.fn()], ["hidden", vi.fn()]]) };
}
const observe = (initialProps: FlowCallListInputs) => renderHook(useFlowCallLists, { initialProps });

it("preserves source call order, shares canonical lists and scopes empty lists per live source", () => {
  const context = inputs();
  const view = observe(context);
  const rows = view.result.current.get("source")!;
  expect(rows.map(({ id, label }) => ({ id, label }))).toEqual([{ id: "call-a", label: "Target name" }, { id: "call-b", label: "Explicit" }]);
  expect(view.result.current.get("linked")).toBe(rows);
  expect(view.result.current.get("empty")).toEqual([]);
  expect(view.result.current.get("empty")).not.toBe(view.result.current.get("other-empty"));
  expect(view.result.current.has("hidden-source")).toBe(false);
  expect(context.openActions.get("call-a")).not.toHaveBeenCalled();
  act(() => rows[0]!.onOpen());
  expect(context.openActions.get("call-a")).toHaveBeenCalledOnce();
});

it("retains rows, lists and empty lists across unrelated metadata and equal input replacement", () => {
  const context = inputs();
  const view = observe(context);
  const before = view.result.current;
  const next = { ...context, nodes: context.nodes.map((item) => ({ ...item, selected: true, position: { x: 50, y: 80 } })).reverse(),
    activeStoryFlow: { ...context.activeStoryFlow!, invocations: context.activeStoryFlow!.invocations!.map((call) => ({ ...call, updated_at: "new" })) },
    projectStoryFlows: context.projectStoryFlows.map((flow) => ({ flow: { ...flow.flow } })), openActions: new Map(context.openActions) };
  view.rerender(next);
  for (const [id, list] of before) expect(view.result.current.get(id)).toBe(list);
});

it("updates fallback target names and explicit labels without mutating retained rows or replacing unaffected rows", () => {
  const context = inputs();
  const view = observe(context);
  const before = view.result.current.get("source")!;
  view.rerender({ ...context, projectStoryFlows: [{ flow: { id: "target", name: "Renamed" } }] });
  const renamed = view.result.current.get("source")!;
  expect(renamed[0]!.label).toBe("Renamed");
  expect(renamed[0]).not.toBe(before[0]);
  expect(renamed[1]).toBe(before[1]);
  expect(before[0]!.label).toBe("Target name");
  expect(renamed[0]!.onOpen).toBe(before[0]!.onOpen);
  view.rerender({ ...context, activeStoryFlow: { ...context.activeStoryFlow!, invocations: context.activeStoryFlow!.invocations!.map((call) => call.id === "call-a" ? { ...call, label: "Authored" } : call) } });
  expect(view.result.current.get("source")![0]!.label).toBe("Authored");
});

it("preserves truthy whitespace labels and first name/id fallback including target removal and restoration", () => {
  const context = inputs();
  const flow = { ...context.activeStoryFlow!, invocations: [context.activeStoryFlow!.invocations![0]!, { ...context.activeStoryFlow!.invocations![1]!, label: " " }] };
  const view = observe({ ...context, activeStoryFlow: flow, projectStoryFlows: [] });
  expect(view.result.current.get("source")!.map((row) => row.label)).toEqual(["target", " "]);
  view.rerender({ ...context, activeStoryFlow: flow, projectStoryFlows: [{ flow: { id: "target", name: "First" } }, { flow: { id: "target", name: "Second" } }] });
  expect(view.result.current.get("source")![0]!.label).toBe("First");
  view.rerender({ ...context, activeStoryFlow: flow, projectStoryFlows: [{ flow: { id: "target", name: "" } }] });
  expect(view.result.current.get("source")![0]!.label).toBe("target");
});

it("replaces rows when the current open action changes, not when hidden target data has equal presentation", () => {
  const context = inputs();
  const view = observe(context);
  const before = view.result.current.get("source")!;
  const replacement = vi.fn();
  const next = { ...context, openActions: new Map(context.openActions).set("call-b", replacement) };
  view.rerender(next);
  const changed = view.result.current.get("source")!;
  expect(changed[0]).toBe(before[0]);
  expect(changed[1]).not.toBe(before[1]);
  act(() => changed[1]!.onOpen());
  expect(replacement).toHaveBeenCalledOnce();
  expect(context.openActions.get("call-b")).not.toHaveBeenCalled();
  view.rerender({ ...next, activeStoryFlow: { ...context.activeStoryFlow!, invocations: context.activeStoryFlow!.invocations!.map((call) => call.id === "call-b" ? { ...call, target_flow_id: "other-target" } : call) } });
  expect(view.result.current.get("source")).toBe(changed);
});

it("retains rows across reordering, moves calls between sources and prunes removed/recreated calls", () => {
  const context = inputs();
  const calls = context.activeStoryFlow!.invocations!;
  const view = observe(context);
  const before = view.result.current.get("source")!;
  view.rerender({ ...context, activeStoryFlow: { ...context.activeStoryFlow!, invocations: [calls[1]!, calls[0]!] } });
  expect(view.result.current.get("source")).toEqual([before[1], before[0]]);
  expect(view.result.current.get("source")![1]).toBe(before[0]);
  view.rerender({ ...context, activeStoryFlow: { ...context.activeStoryFlow!, invocations: [{ ...calls[0]!, source_node_id: "empty" }] } });
  expect(view.result.current.get("source")).toEqual([]);
  expect(view.result.current.get("empty")![0]!.id).toBe("call-a");
  view.rerender(context);
  expect(view.result.current.get("source")![0]).not.toBe(before[0]);
});

it.each(["source", "canonical", "flow", "project", "no flow"])("retires %s scope instead of keeping historical row/list references", (change) => {
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

it("keeps current empty lists stable without a Flow and bounds retention to live sources", () => {
  const context = { ...inputs(), activeStoryFlow: null };
  const view = observe(context);
  const before = view.result.current.get("empty");
  view.rerender({ ...context, nodes: [node("empty")] });
  expect(view.result.current.get("empty")).toBe(before);
  for (let index = 0; index < 20; index += 1) {
    view.rerender({ ...context, nodes: [node(`source:${index}`)] });
    expect([...view.result.current.keys()]).toEqual([`source:${index}`]);
  }
  view.rerender({ ...context, nodes: [node("empty")] });
  expect(view.result.current.get("empty")).not.toBe(before);
});

it.each(["label", "action", "projection", "flow", "project"])("does not publish speculative %s or prune committed lists during Suspense", (change) => {
  const context = inputs();
  const next = change === "label" ? { ...context, projectStoryFlows: [{ flow: { id: "target", name: "Renamed" } }] }
    : change === "action" ? { ...context, openActions: new Map(context.openActions).set("call-a", vi.fn()) }
    : change === "projection" ? { ...context, nodes: [] }
    : change === "flow" ? { ...context, activeStoryFlow: { ...context.activeStoryFlow!, flow: { id: "flow-b" } } } : { ...context, projectId: "project-b" };
  const pending = new Promise<void>(() => {});
  const view = renderHook(({ context, suspend }) => {
    const lists = useFlowCallLists(context);
    if (suspend) throw pending;
    return lists;
  }, { initialProps: { context, suspend: false }, wrapper: ({ children }) => <Suspense fallback={null}>{children}</Suspense> });
  const before = view.result.current.get("source");
  view.rerender({ context: next, suspend: true });
  // Only committed label/action/scope inputs may replace current rows.
  view.rerender({ context: { ...context, nodes: [...context.nodes] }, suspend: false });
  expect(view.result.current.get("source")).toBe(before);
  view.rerender({ context: next, suspend: false });
  expect(view.result.current.get("source")).not.toBe(before);
});

it("supports Strict Mode replay and releases retained rows on real unmount", () => {
  const context = inputs();
  const view = renderHook(useFlowCallLists, { initialProps: context, wrapper: StrictMode });
  const before = view.result.current.get("source");
  view.rerender({ ...context, nodes: [...context.nodes] });
  expect(view.result.current.get("source")).toBe(before);
  view.unmount();
  const fresh = observe(context);
  expect(fresh.result.current.get("source")).toEqual(before);
  expect(fresh.result.current.get("source")).not.toBe(before);
});

import { renderHook } from "@testing-library/react";
import { StrictMode, Suspense } from "react";
import { expect, it } from "vitest";
import type { NodeDataAssemblyInputs } from "./useNodeDataAssembly";
import { useNodeWrapperAssembly } from "./useNodeWrapperAssembly";

function inputs(): NodeDataAssemblyInputs {
  return { projectId: "project-a", flowId: "flow-a", workspaceMode: "relationships", nodes: [{
    id: "primary", position: { x: 10, y: 20 }, style: { opacity: 1 },
    data: { kind: "Character", title: "Hero", label: "Hero", summary: "Text", tags: [] }
  }] };
}
const fresh = (context: NodeDataAssemblyInputs) => ({ ...context, nodes: context.nodes.map((node) => ({ ...node })) });
const observe = (initialProps: NodeDataAssemblyInputs) => renderHook(useNodeWrapperAssembly, { initialProps });

it("retains the committed array when new candidates resolve to the same ordered wrapper references", () => {
  const context = inputs();
  const view = observe(context);
  const before = view.result.current;
  const candidate = fresh(context);
  view.rerender(candidate);
  expect(view.result.current).toBe(before);
  expect(view.result.current[0]).toBe(before[0]);
  expect(candidate.nodes[0]).not.toBe(before[0]);
  const currentArray = view.result.current;
  view.rerender(candidate);
  expect(view.result.current).toBe(currentArray);
  expect(view.result.current[0]).toBe(before[0]);
});

it.each(["data", "position", "style", "measured", "selected", "resizing", "parentId", "width", "height"])("forwards a changed %s input without mutating the previous wrapper", (field) => {
  const context = inputs();
  const original = context.nodes[0]!;
  const changes = { data: { ...original.data }, position: { ...original.position }, style: { ...original.style },
    measured: { width: 240, height: 160 }, selected: true, resizing: true, parentId: "frame", width: 240, height: 160 };
  const candidate = { ...original, [field]: changes[field as keyof typeof changes] };
  const view = observe(context);
  const before = view.result.current;
  view.rerender({ ...context, nodes: [candidate] });
  expect(view.result.current).not.toBe(before);
  expect(view.result.current[0]).toBe(candidate);
  expect(original).toBe(context.nodes[0]);
  expect(original.position).toEqual({ x: 10, y: 20 });
  expect(original).not.toHaveProperty("selected");
});

it("compares key presence including unknown undefined, symbol and non-enumerable fields", () => {
  const context = inputs();
  const original = context.nodes[0]!;
  const symbol = Symbol("extension");
  const source = Object.defineProperty({ ...original, [symbol]: "old", extension: undefined }, "hidden", { value: 1 });
  const view = observe({ ...context, nodes: [source] });
  const equal = Object.defineProperty({ ...source }, "hidden", { value: 1 });
  view.rerender({ ...context, nodes: [equal] });
  expect(view.result.current[0]).toBe(source);
  const changed = Object.defineProperty({ ...equal, [symbol]: "new" }, "hidden", { value: 1 });
  view.rerender({ ...context, nodes: [changed] });
  expect(view.result.current[0]).toBe(changed);
  const hidden = Object.defineProperty({ ...changed }, "hidden", { value: 2 });
  view.rerender({ ...context, nodes: [hidden] });
  expect(view.result.current[0]).toBe(hidden);
  view.rerender({ ...context, nodes: [original] });
  expect(view.result.current[0]).toBe(original);
  const added = { ...original, extension: undefined };
  view.rerender({ ...context, nodes: [added] });
  expect(view.result.current[0]).toBe(added);
  view.rerender({ ...context, nodes: [{ ...original }] });
  expect(view.result.current[0]).not.toBe(added);
});

it("retains independent linked wrappers in the current order, forwarding only changed placement geometry", () => {
  const context = inputs();
  const primary = context.nodes[0]!;
  const linked = { ...primary, id: "linked", parentId: "frame", data: { ...primary.data, canonicalNodeId: "primary", placementId: "linked" } };
  const view = observe({ ...context, nodes: [primary, linked] });
  const before = view.result.current;
  view.rerender({ ...context, nodes: [{ ...linked }, { ...primary }] });
  expect(view.result.current).not.toBe(before);
  expect(view.result.current).toEqual([linked, primary]);
  expect(view.result.current[0]).toBe(before[1]);
  expect(view.result.current[1]).toBe(before[0]);
  const reordered = view.result.current;
  view.rerender({ ...context, nodes: [{ ...linked }, { ...primary }] });
  expect(view.result.current).toBe(reordered);
  const moved = { ...linked, position: { x: 90, y: 70 } };
  view.rerender({ ...context, nodes: [moved, { ...primary }] });
  expect(view.result.current).not.toBe(reordered);
  expect(view.result.current[0]).toBe(moved);
  expect(view.result.current[1]).toBe(primary);
});

it.each(["project", "flow", "no flow", "workspace"])("does not retain old wrappers after %s scope replacement", (scope) => {
  const context = inputs();
  const view = observe(context);
  const candidate = fresh(context);
  const next: NodeDataAssemblyInputs = scope === "project" ? { ...candidate, projectId: "project-b" }
    : scope === "flow" ? { ...candidate, flowId: "flow-b" }
    : scope === "no flow" ? { ...candidate, flowId: null } : { ...candidate, workspaceMode: "flow" };
  view.rerender(next);
  expect(view.result.current[0]).toBe(candidate.nodes[0]);
  const restored = fresh(context);
  view.rerender(restored);
  expect(view.result.current[0]).toBe(restored.nodes[0]);
});

it("prunes removed visual ids and never revives historical wrappers on recreation", () => {
  const context = inputs();
  const view = observe(context);
  for (let index = 0; index < 20; index += 1) {
    view.rerender({ ...context, nodes: [{ ...context.nodes[0]!, id: `placement:${index}` }] });
    expect(view.result.current.map((node) => node.id)).toEqual([`placement:${index}`]);
  }
  view.rerender({ ...context, nodes: [] });
  expect(view.result.current).toEqual([]);
  const recreated = fresh(context);
  view.rerender(recreated);
  expect(view.result.current[0]).toBe(recreated.nodes[0]);
});

it.each(["geometry", "removed", "project", "flow", "workspace", "order"])("does not publish or prune speculative %s during Suspense", (change) => {
  const base = inputs();
  const context: NodeDataAssemblyInputs = { ...base, nodes: [...base.nodes, { ...base.nodes[0]!, id: "linked" }] };
  const candidate = fresh(context);
  const next: NodeDataAssemblyInputs = change === "geometry" ? { ...candidate,
    nodes: candidate.nodes.map((node, index) => index === 0 ? { ...node, position: { x: 90, y: 70 } } : node) }
    : change === "removed" ? { ...candidate, nodes: [] }
    : change === "order" ? { ...candidate, nodes: [...candidate.nodes].reverse() }
    : change === "project" ? { ...candidate, projectId: "project-b" }
    : change === "flow" ? { ...candidate, flowId: "flow-b" } : { ...candidate, workspaceMode: "flow" };
  const pending = new Promise<void>(() => {});
  const view = renderHook(({ context, suspend }) => {
    const nodes = useNodeWrapperAssembly(context);
    if (suspend) throw pending;
    return nodes;
  }, { initialProps: { context, suspend: false }, wrapper: ({ children }) => <Suspense fallback={null}>{children}</Suspense> });
  const before = view.result.current;
  view.rerender({ context: next, suspend: true });
  view.rerender({ context: fresh(context), suspend: false });
  expect(view.result.current).toBe(before);
  view.rerender({ context: next, suspend: false });
  expect(view.result.current).not.toBe(before);
});

it.each([false, true])("handles Strict Mode replay and real remounts with empty=%s", (empty) => {
  const context = empty ? { ...inputs(), nodes: [] } : inputs();
  const view = renderHook(useNodeWrapperAssembly, { initialProps: context, wrapper: StrictMode });
  const before = view.result.current;
  view.rerender(fresh(context));
  expect(view.result.current).toBe(before);
  view.unmount();
  const candidate = fresh(context);
  const remounted = observe(candidate).result.current;
  expect(remounted).not.toBe(before);
  expect(remounted).toEqual(candidate.nodes);
  if (!empty) expect(remounted[0]).toBe(candidate.nodes[0]);
});

it.each(["project", "flow", "no flow", "workspace"])("replaces the array on %s changes even with identical node references", (scope) => {
  const context = inputs();
  const view = observe(context);
  const before = view.result.current;
  const next: NodeDataAssemblyInputs = scope === "project" ? { ...context, projectId: "project-b" }
    : scope === "flow" ? { ...context, flowId: "flow-b" }
    : scope === "no flow" ? { ...context, flowId: null } : { ...context, workspaceMode: "flow" };
  view.rerender(next);
  const replaced = view.result.current;
  expect(replaced).not.toBe(before);
  expect(replaced[0]).toBe(before[0]);
  view.rerender(context);
  expect(view.result.current).not.toBe(replaced);
  expect(view.result.current).not.toBe(before);
});

it("retains only the latest same-scope empty array, not empties from other scopes", () => {
  const context = { ...inputs(), nodes: [] };
  const view = observe(context);
  const before = view.result.current;
  view.rerender({ ...context, nodes: [] });
  expect(view.result.current).toBe(before);
  view.rerender({ ...context, flowId: "flow-b", nodes: [] });
  const replaced = view.result.current;
  expect(replaced).not.toBe(before);
  view.rerender(context);
  expect(view.result.current).not.toBe(replaced);
  expect(view.result.current).not.toBe(before);
});

it("forwards additions/removals and does not resurrect an array after deletion/recreation", () => {
  const context = inputs();
  const view = observe(context);
  const before = view.result.current;
  const second = { ...context.nodes[0]!, id: "second" };
  view.rerender({ ...context, nodes: [...context.nodes, second] });
  const added = view.result.current;
  expect(added).not.toBe(before);
  expect(added[0]).toBe(before[0]);
  expect(added[1]).toBe(second);
  view.rerender({ ...context, nodes: [] });
  expect(view.result.current).not.toBe(added);
  const empty = view.result.current;
  view.rerender(context);
  expect(view.result.current).not.toBe(empty);
  expect(view.result.current).not.toBe(before);
  expect(view.result.current[0]).toBe(context.nodes[0]);
});

it("does not revive a historical array when the original node reference returns", () => {
  const context = inputs();
  const view = observe(context);
  const before = view.result.current;
  view.rerender({ ...context, nodes: [{ ...context.nodes[0]!, selected: true }] });
  expect(view.result.current).not.toBe(before);
  view.rerender(context);
  expect(view.result.current[0]).toBe(before[0]);
  expect(view.result.current).not.toBe(before);
  const restored = view.result.current;
  view.rerender(fresh(context));
  expect(view.result.current).toBe(restored);
});

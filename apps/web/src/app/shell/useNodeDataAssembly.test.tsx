import type { Node } from "@xyflow/react";
import { renderHook } from "@testing-library/react";
import { StrictMode, Suspense } from "react";
import { expect, it, vi } from "vitest";
import type { NarrativeNodeRenderData } from "../workspaceShared";
import { useNodeDataAssembly, type NodeDataAssemblyInputs } from "./useNodeDataAssembly";

function inputs(): NodeDataAssemblyInputs {
  const data: NarrativeNodeRenderData = { kind: "Character", title: "Hero", label: "Hero", summary: "Text", tags: ["actor"], onResizeStart: vi.fn() };
  return { projectId: "project-a", flowId: "flow-a", workspaceMode: "relationships",
    nodes: [{ id: "primary", position: { x: 0, y: 0 }, data }] };
}
const observe = (initialProps: NodeDataAssemblyInputs) => renderHook(useNodeDataAssembly, { initialProps });
const withData = (context: NodeDataAssemblyInputs, data: NarrativeNodeRenderData): NodeDataAssemblyInputs => ({ ...context, nodes: [{ ...context.nodes[0]!, data }] });
const fresh = (context: NodeDataAssemblyInputs) => ({ ...context, nodes: context.nodes.map((node) => ({ ...node, data: { ...node.data } })) });

it("retains complete equal data despite own-field ordering, never mutating current candidates", () => {
  const context = inputs();
  const view = observe(context);
  const before = view.result.current.get("primary");
  const candidate = Object.fromEntries(Object.entries(context.nodes[0]!.data).reverse()) as NarrativeNodeRenderData;
  view.rerender(withData(context, candidate));
  expect(view.result.current.get("primary")).toBe(before);
  expect(candidate).not.toBe(before);
  expect(context.nodes[0]!.data).toBe(before);
});

it("forwards changed authored fields, type, diagnostic text and current interaction flags", () => {
  const context = inputs();
  const view = observe(context);
  const candidate: NarrativeNodeRenderData = { ...context.nodes[0]!.data, kind: "Event", title: "Changed", summary: "Edited Text",
    issuePreview: "Current diagnostic", isConnectionSource: true, flowMembership: true };
  view.rerender(withData(context, candidate));
  expect(view.result.current.get("primary")).toBe(candidate);
  expect(context.nodes[0]!.data.summary).toBe("Text");
});

it("does not deep-compare equal-valued nested inputs or omit replaced callbacks", () => {
  const context = inputs();
  const view = observe(context);
  const source = context.nodes[0]!.data;
  const nested = { ...source, tags: [...source.tags], auditExtension: { value: 1 } };
  view.rerender(withData(context, nested));
  expect(view.result.current.get("primary")).toBe(nested);
  const equalNested = { ...nested, auditExtension: { value: 1 } };
  view.rerender(withData(context, equalNested));
  expect(view.result.current.get("primary")).toBe(equalNested);
  const callback = { ...equalNested, onResizeStart: vi.fn() };
  view.rerender(withData(context, callback));
  expect(view.result.current.get("primary")).toBe(callback);
});

it("distinguishes absent fields from explicit undefined and never revives historical payloads", () => {
  const context = inputs();
  const view = observe(context);
  const source = context.nodes[0]!.data;
  const added = { ...source, auditOptional: undefined };
  view.rerender(withData(context, added));
  expect(view.result.current.get("primary")).toBe(added);
  const removed = { ...source };
  view.rerender(withData(context, removed));
  expect(view.result.current.get("primary")).toBe(removed);
  expect(view.result.current.get("primary")).not.toBe(source);
});

it("includes symbol and non-enumerable own fields without relying on serialized values", () => {
  const context = inputs();
  const symbol = Symbol("extension");
  const source = Object.defineProperty({ ...context.nodes[0]!.data, [symbol]: "old" }, "hidden", { value: "old" });
  const view = observe(withData(context, source));
  const equal = Object.defineProperty({ ...source }, "hidden", { value: "old" });
  view.rerender(withData(context, equal));
  expect(view.result.current.get("primary")).toBe(source);
  const changed = Object.defineProperty({ ...source, [symbol]: "changed" }, "hidden", { value: "old" });
  view.rerender(withData(context, changed));
  expect(view.result.current.get("primary")).toBe(changed);
  const hidden = Object.defineProperty({ ...changed }, "hidden", { value: "changed" });
  view.rerender(withData(context, hidden));
  expect(view.result.current.get("primary")).toBe(hidden);
});

it("keeps linked placements independent and ignores outer selection/geometry/style for data reuse", () => {
  const context = inputs();
  const source = context.nodes[0]!;
  const linked: Node<NarrativeNodeRenderData> = { ...source, id: "linked", data: { ...source.data, canonicalNodeId: "primary", placementId: "linked" } };
  const view = observe({ ...context, nodes: [source, linked] });
  const before = view.result.current;
  const primary = { ...source, selected: true, parentId: "frame", position: { x: 90, y: 80 }, style: { opacity: 0.5 }, data: { ...source.data } };
  view.rerender({ ...context, nodes: [linked, primary] });
  expect(view.result.current.get("primary")).toBe(before.get("primary"));
  expect(view.result.current.get("linked")).toBe(linked.data);
  expect(primary.position).toEqual({ x: 90, y: 80 });
  expect(primary.selected).toBe(true);
});

it.each(["project", "flow", "no flow", "workspace"])("forwards fresh candidates after %s replacement rather than retaining old scope data", (scope) => {
  const context = inputs();
  const view = observe(context);
  const before = view.result.current.get("primary");
  const candidate = fresh(context);
  const next: NodeDataAssemblyInputs = scope === "project" ? { ...candidate, projectId: "project-b" }
    : scope === "flow" ? { ...candidate, flowId: "flow-b" }
    : scope === "no flow" ? { ...candidate, flowId: null } : { ...candidate, workspaceMode: "flow" };
  view.rerender(next);
  expect(view.result.current.get("primary")).toBe(candidate.nodes[0]!.data);
  expect(view.result.current.get("primary")).not.toBe(before);
  const restored = fresh(context);
  view.rerender(restored);
  expect(view.result.current.get("primary")).toBe(restored.nodes[0]!.data);
});

it("bounds retained data to live visual placements and forwards fresh recreated ids", () => {
  const context = inputs();
  const view = observe(context);
  const before = view.result.current.get("primary");
  for (let index = 0; index < 20; index += 1) {
    view.rerender({ ...context, nodes: [{ ...context.nodes[0]!, id: `placement:${index}`, data: { ...context.nodes[0]!.data } }] });
    expect([...view.result.current.keys()]).toEqual([`placement:${index}`]);
  }
  view.rerender({ ...context, nodes: [] });
  expect(view.result.current.size).toBe(0);
  const recreated = fresh(context);
  view.rerender(recreated);
  expect(view.result.current.get("primary")).toBe(recreated.nodes[0]!.data);
  expect(view.result.current.get("primary")).not.toBe(before);
});

it.each(["payload", "removed", "project", "flow", "workspace"])("does not publish speculative %s or prune committed data during Suspense", (change) => {
  const context = inputs();
  const candidate = fresh(context);
  const next: NodeDataAssemblyInputs = change === "payload" ? withData(candidate, { ...candidate.nodes[0]!.data, summary: "Speculative" })
    : change === "removed" ? { ...candidate, nodes: [] }
    : change === "project" ? { ...candidate, projectId: "project-b" }
    : change === "flow" ? { ...candidate, flowId: "flow-b" } : { ...candidate, workspaceMode: "flow" };
  const pending = new Promise<void>(() => {});
  const view = renderHook(({ context, suspend }) => {
    const data = useNodeDataAssembly(context);
    if (suspend) throw pending;
    return data;
  }, { initialProps: { context, suspend: false }, wrapper: ({ children }) => <Suspense fallback={null}>{children}</Suspense> });
  const before = view.result.current.get("primary");
  view.rerender({ context: next, suspend: true });
  // A fresh equal committed candidate must still find the previous live payload.
  view.rerender({ context: fresh(context), suspend: false });
  expect(view.result.current.get("primary")).toBe(before);
  view.rerender({ context: next, suspend: false });
  expect(view.result.current.get("primary")).not.toBe(before);
});

it("supports Strict Mode replay and starts fresh on real unmount/remount", () => {
  const context = inputs();
  const view = renderHook(useNodeDataAssembly, { initialProps: context, wrapper: StrictMode });
  const before = view.result.current.get("primary");
  view.rerender(fresh(context));
  expect(view.result.current.get("primary")).toBe(before);
  view.unmount();
  const candidate = fresh(context);
  const remounted = observe(candidate);
  expect(remounted.result.current.get("primary")).toBe(candidate.nodes[0]!.data);
});

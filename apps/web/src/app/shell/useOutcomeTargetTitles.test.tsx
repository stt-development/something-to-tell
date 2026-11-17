import { renderHook } from "@testing-library/react";
import { StrictMode, Suspense } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useOutcomeTargetTitles, type OutcomeTitleInputs } from "./useOutcomeTargetTitles";

afterEach(() => vi.restoreAllMocks());
const target = (id: string, title = id, canonicalNodeId?: string) => ({ id, data: { title, canonicalNodeId } });
const outcome = (id: string, targetNodeIds?: string[], canonicalNodeId = id) => ({
  id, data: { kind: "Consequence", canonicalNodeId, outcome: targetNodeIds ? { targetNodeIds } : undefined }
});
function inputs(rawNodes: OutcomeTitleInputs["rawNodes"], nodes: OutcomeTitleInputs["nodes"], projectId = "project-a"): OutcomeTitleInputs {
  return { projectId, rawNodes, nodes };
}
const observe = (initialProps: OutcomeTitleInputs) => renderHook(useOutcomeTargetTitles, { initialProps });

it("preserves ordered duplicate targets, missing-id fallback and empty authored titles", () => {
  const view = observe(inputs([target("a", "Alpha"), target("b", "")], [outcome("outcome", ["a", "missing", "b", "a"])]));
  expect(view.result.current.get("outcome")).toEqual(["Alpha", "missing", "", "Alpha"]);
});

it("handles legacy/empty outcomes and excludes other kinds without a shared global empty list", () => {
  const view = observe(inputs([], [outcome("legacy"), outcome("empty", []), { id: "other", data: { kind: "Event" } }]));
  expect([...view.result.current.keys()]).toEqual(["legacy", "empty"]);
  expect(view.result.current.get("legacy")).toEqual([]);
  expect(view.result.current.get("empty")).toEqual([]);
  expect(view.result.current.get("legacy")).not.toBe(view.result.current.get("empty"));
});

it("avoids target lookups for unchanged immutable raw nodes and target ids across projection refreshes", () => {
  const raw = [target("a", "Alpha")];
  const source = outcome("outcome", ["a"]);
  const lookup = vi.spyOn(raw, "find");
  const view = observe(inputs(raw, [source]));
  const before = view.result.current.get(source.id);
  lookup.mockClear();
  const moved = { ...source, selected: true, position: { x: 40, y: 90 }, data: { ...source.data, title: "Renamed", summary: "Edited Text" } };
  view.rerender(inputs(raw, [moved]));
  expect(view.result.current.get(source.id)).toBe(before);
  expect(lookup).not.toHaveBeenCalled();
});

it("retains equal ordered names after unrelated raw metadata edits and equal target-id replacement", () => {
  const raw = [target("a", "Alpha"), target("unrelated")];
  const view = observe(inputs(raw, [outcome("outcome", ["a"])]));
  const before = view.result.current.get("outcome");
  const updated = raw.map((item) => ({ ...item, position: { x: 30, y: 80 }, data: { ...item.data,
    title: item.id === "unrelated" ? "Changed" : item.data.title, summary: "New Text" } }));
  view.rerender(inputs(updated, [outcome("outcome", ["a"])]));
  expect(view.result.current.get("outcome")).toBe(before);
});

it("refreshes target add/remove/reorder with the same raw graph", () => {
  const raw = [target("a", "Alpha"), target("b", "Beta")];
  const view = observe(inputs(raw, [outcome("outcome", ["a"])]));
  view.rerender(inputs(raw, [outcome("outcome", ["b", "a"])]));
  expect(view.result.current.get("outcome")).toEqual(["Beta", "Alpha"]);
  view.rerender(inputs(raw, [outcome("outcome", ["a", "b"])]));
  expect(view.result.current.get("outcome")).toEqual(["Alpha", "Beta"]);
  view.rerender(inputs(raw, [outcome("outcome", [])]));
  expect(view.result.current.get("outcome")).toEqual([]);
});

it("refreshes target rename, disappearance and reappearance even with unchanged target ids", () => {
  const nodes = [outcome("outcome", ["a"])];
  const view = observe(inputs([target("a", "Alpha")], nodes));
  view.rerender(inputs([target("a", "Renamed")], nodes));
  expect(view.result.current.get("outcome")).toEqual(["Renamed"]);
  view.rerender(inputs([], nodes));
  expect(view.result.current.get("outcome")).toEqual(["a"]);
  view.rerender(inputs([target("a", "Restored")], nodes));
  expect(view.result.current.get("outcome")).toEqual(["Restored"]);
});

it("keeps first raw canonical match semantics, including linked-first order and nullish fallback", () => {
  const primary = target("a", "Primary");
  const linked = target("linked", "Linked first", "a");
  const empty = target("empty-placement", "Empty canonical", "");
  const nodes = [outcome("outcome", ["a", "linked", ""])];
  const view = observe(inputs([linked, primary, empty], nodes));
  expect(view.result.current.get("outcome")).toEqual(["Linked first", "linked", "Empty canonical"]);
  view.rerender(inputs([primary, linked, empty], nodes));
  expect(view.result.current.get("outcome")).toEqual(["Primary", "linked", "Empty canonical"]);
});

it("keeps placement-specific target arrays independent and retains equal names after identity changes", () => {
  const raw = [target("a", "Same"), target("b", "Same"), target("c", "Other")];
  const view = observe(inputs(raw, [outcome("primary", ["a"]), outcome("linked", ["c"], "primary")]));
  const before = view.result.current.get("primary");
  expect(view.result.current.get("linked")).toEqual(["Other"]);
  view.rerender(inputs(raw, [outcome("primary", ["b"]), outcome("linked", ["c"], "primary")]));
  expect(view.result.current.get("primary")).toBe(before);
  expect(view.result.current.get("linked")).toEqual(["Other"]);
});

it.each(["projection", "type", "canonical", "project"])("retires %s scope without retaining historical lists", (change) => {
  const original = inputs([target("a")], [outcome("outcome", ["a"])]);
  const view = observe(original);
  const before = view.result.current.get("outcome");
  view.rerender(change === "projection" ? { ...original, nodes: [] }
    : change === "type" ? { ...original, nodes: [{ id: "outcome", data: { kind: "Event" } }] }
    : change === "canonical" ? { ...original, nodes: [outcome("outcome", ["a"], "other")] }
    : { ...original, projectId: "project-b" });
  expect(view.result.current.get("outcome")).not.toBe(before);
  view.rerender(original);
  expect(view.result.current.get("outcome")).not.toBe(before);
});

it("bounds retained lists to current live placements rather than visited outcomes", () => {
  const raw = [target("a")];
  const view = observe(inputs(raw, [outcome("outcome:0", ["a"])]));
  const before = view.result.current.get("outcome:0");
  for (let index = 1; index < 20; index += 1) {
    view.rerender(inputs(raw, [outcome(`outcome:${index}`, ["a"])]));
    expect([...view.result.current.keys()]).toEqual([`outcome:${index}`]);
  }
  view.rerender(inputs(raw, []));
  expect(view.result.current.size).toBe(0);
  view.rerender(inputs(raw, [outcome("outcome:0", ["a"])]));
  expect(view.result.current.get("outcome:0")).not.toBe(before);
});

it.each(["name", "targets", "projection", "project"])("does not publish speculative %s or prune committed lists during Suspense", (change) => {
  const original = inputs([target("a", "Alpha")], [outcome("outcome", ["a"])]);
  const next = change === "name" ? { ...original, rawNodes: [target("a", "Renamed")] }
    : change === "targets" ? { ...original, nodes: [outcome("outcome", ["missing"])] }
    : change === "projection" ? { ...original, nodes: [] } : { ...original, projectId: "project-b" };
  const pending = new Promise<void>(() => {});
  const view = renderHook(({ context, suspend }) => {
    const values = useOutcomeTargetTitles(context);
    if (suspend) throw pending;
    return values;
  }, { initialProps: { context: original, suspend: false }, wrapper: ({ children }) => <Suspense fallback={null}>{children}</Suspense> });
  const before = view.result.current.get("outcome");
  view.rerender({ context: next, suspend: true });
  // Abandoned names/ids must not replace the committed result or its input references.
  view.rerender({ context: { ...original, nodes: [...original.nodes] }, suspend: false });
  expect(view.result.current.get("outcome")).toBe(before);
  view.rerender({ context: next, suspend: false });
  expect(view.result.current.get("outcome")).not.toBe(before);
});

it("supports Strict Mode replay and releases the registry on real unmount", () => {
  const context = inputs([target("a")], [outcome("outcome", ["a"])]);
  const view = renderHook(useOutcomeTargetTitles, { initialProps: context, wrapper: StrictMode });
  const before = view.result.current.get("outcome");
  view.rerender({ ...context, nodes: [...context.nodes] });
  expect(view.result.current.get("outcome")).toBe(before);
  view.unmount();
  const fresh = observe(context);
  expect(fresh.result.current.get("outcome")).toEqual(before);
  expect(fresh.result.current.get("outcome")).not.toBe(before);
});

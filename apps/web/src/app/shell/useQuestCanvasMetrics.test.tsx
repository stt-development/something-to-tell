import { renderHook } from "@testing-library/react";
import { StrictMode, Suspense } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createQuestDocument, type QuestDocument } from "../../quest/contracts";
import * as presentation from "../../quest/presentation";
import { useQuestCanvasMetrics, type QuestMetricInputs } from "./useQuestCanvasMetrics";

afterEach(() => vi.restoreAllMocks());
const quest = (id: string, document?: QuestDocument, canonicalNodeId = id) => ({
  id, data: { kind: "Quest", canonicalNodeId, questDocument: document }
});
const inputs = (nodes: QuestMetricInputs["nodes"], projectId = "project-a"): QuestMetricInputs => ({ projectId, nodes });
const document = () => createQuestDocument("Route", "Reach the harbor");
const observe = (initialProps: QuestMetricInputs) => renderHook(useQuestCanvasMetrics, { initialProps });

it("derives all counts and handles legacy documents without including other node kinds", () => {
  const source = document();
  source.prerequisite_node_ids = ["key"];
  source.reward_node_ids = ["reward", "coin"];
  source.stages[0]!.branches = [{ id: "branch", label: "Continue", condition: "", target_stage_id: null }];
  const helper = vi.spyOn(presentation, "questCanvasMetrics");
  const view = observe(inputs([quest("quest", source), quest("legacy"), { id: "hero", data: { kind: "Character" } }]));
  expect([...view.result.current.keys()]).toEqual(["quest", "legacy"]);
  expect(view.result.current.get("quest")).toEqual({ branches: 1, prerequisites: 1, rewards: 2, stages: 1 });
  expect(view.result.current.get("legacy")).toEqual({ branches: 0, prerequisites: 0, rewards: 0, stages: 0 });
  expect(helper).toHaveBeenCalledTimes(2);
});

it("retains document-derived values across placement, label, selection and order changes", () => {
  const source = document();
  const original = quest("quest", source);
  const helper = vi.spyOn(presentation, "questCanvasMetrics");
  const view = observe(inputs([original, quest("legacy")]));
  const before = view.result.current;
  helper.mockClear();
  const moved = { ...original, selected: true, position: { x: 90, y: 30 }, data: { ...original.data, title: "Renamed", summary: "Edited Text" } };
  view.rerender(inputs([quest("legacy"), moved]));
  expect(view.result.current.get("quest")).toBe(before.get("quest"));
  expect(view.result.current.get("legacy")).toBe(before.get("legacy"));
  expect(helper).not.toHaveBeenCalled();
});

it("shares canonical metrics across linked placements, even after removing the primary", () => {
  const source = document();
  const helper = vi.spyOn(presentation, "questCanvasMetrics");
  const linked = quest("linked", source, "primary");
  const view = observe(inputs([quest("primary", source), linked]));
  const retained = view.result.current.get("primary");
  expect(view.result.current.get("linked")).toBe(retained);
  expect(helper).toHaveBeenCalledOnce();
  view.rerender(inputs([linked]));
  expect(view.result.current.get("linked")).toBe(retained);
  expect(helper).toHaveBeenCalledOnce();
});

it("does not mix distinct live documents belonging to the same canonical owner", () => {
  const first = document();
  const second = { ...document(), reward_node_ids: ["reward"] };
  const helper = vi.spyOn(presentation, "questCanvasMetrics");
  const view = observe(inputs([quest("primary", first), quest("linked", second, "primary")]));
  const before = view.result.current;
  expect(before.get("primary")!.rewards).toBe(0);
  expect(before.get("linked")!.rewards).toBe(1);
  helper.mockClear();
  view.rerender(inputs([quest("linked", second, "primary"), quest("primary", first)]));
  expect(view.result.current.get("primary")).toBe(before.get("primary"));
  expect(view.result.current.get("linked")).toBe(before.get("linked"));
  expect(helper).not.toHaveBeenCalled();
});

it("recomputes immutable edits and prunes historical document versions, even equal-valued ones", () => {
  const first = document();
  const helper = vi.spyOn(presentation, "questCanvasMetrics");
  const view = observe(inputs([quest("quest", first)]));
  const before = view.result.current.get("quest");
  view.rerender(inputs([quest("quest", { ...first })]));
  expect(view.result.current.get("quest")).toEqual(before);
  expect(view.result.current.get("quest")).not.toBe(before);
  view.rerender(inputs([quest("quest", { ...first, reward_node_ids: ["key"] })]));
  expect(view.result.current.get("quest")!.rewards).toBe(1);
  view.rerender(inputs([quest("quest", first)]));
  expect(view.result.current.get("quest")).not.toBe(before);
  expect(helper).toHaveBeenCalledTimes(4);
});

it.each(["removed", "type", "canonical", "project"])("retires values after %s replacement rather than keeping a history", (change) => {
  const source = document();
  const original = inputs([quest("quest", source)]);
  const view = observe(original);
  const before = view.result.current.get("quest");
  const next = change === "removed" ? inputs([])
    : change === "type" ? inputs([{ id: "quest", data: { kind: "Character", questDocument: source } }])
    : change === "canonical" ? inputs([quest("quest", source, "other")])
    : inputs(original.nodes, "project-b");
  view.rerender(next);
  expect(view.result.current.get("quest")).not.toBe(before);
  view.rerender(original);
  expect(view.result.current.get("quest")).not.toBe(before);
});

it("bounds output and retained work to live owners rather than previously visited projections", () => {
  const source = document();
  const helper = vi.spyOn(presentation, "questCanvasMetrics");
  const view = observe(inputs([]));
  for (let index = 0; index < 20; index += 1) {
    view.rerender(inputs([quest(`quest:${index}`, source)]));
    expect([...view.result.current.keys()]).toEqual([`quest:${index}`]);
  }
  expect(helper).toHaveBeenCalledTimes(20);
  view.rerender(inputs([]));
  expect(view.result.current.size).toBe(0);
  view.rerender(inputs([quest("quest:0", source)]));
  expect(helper).toHaveBeenCalledTimes(21);
});

it("does not publish speculative documents or prune committed values during suspension", () => {
  const original = inputs([quest("quest", document())]);
  const next = inputs([quest("quest", { ...document(), reward_node_ids: ["key"] })]);
  const pending = new Promise<void>(() => {});
  const helper = vi.spyOn(presentation, "questCanvasMetrics");
  const view = renderHook(({ context, suspend }) => {
    const values = useQuestCanvasMetrics(context);
    if (suspend) throw pending;
    return values;
  }, { initialProps: { context: original, suspend: false }, wrapper: ({ children }) => <Suspense fallback={null}>{children}</Suspense> });
  const before = view.result.current.get("quest");
  view.rerender({ context: next, suspend: true });
  // React may retry speculative work; only committed identity is contractual.
  helper.mockClear();
  view.rerender({ context: { ...original, nodes: [...original.nodes] }, suspend: false });
  expect(view.result.current.get("quest")).toBe(before);
  expect(helper).not.toHaveBeenCalled();
  view.rerender({ context: next, suspend: false });
  expect(view.result.current.get("quest")!.rewards).toBe(1);
  expect(helper).toHaveBeenCalledOnce();
});

it("supports Strict Mode replay and starts a fresh registry after unmount", () => {
  const context = inputs([quest("quest", document())]);
  const view = renderHook(useQuestCanvasMetrics, { initialProps: context, wrapper: StrictMode });
  const before = view.result.current.get("quest");
  view.rerender({ ...context, nodes: [...context.nodes] });
  expect(view.result.current.get("quest")).toBe(before);
  view.unmount();
  const fresh = observe(context);
  expect(fresh.result.current.get("quest")).toEqual(before);
  expect(fresh.result.current.get("quest")).not.toBe(before);
});

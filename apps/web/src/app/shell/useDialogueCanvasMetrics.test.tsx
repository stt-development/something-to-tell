import { renderHook } from "@testing-library/react";
import { StrictMode, Suspense } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { DialogueDocument } from "../../dialogue/contracts";
import * as presentation from "../../dialogue/presentation";
import { useDialogueCanvasMetrics, type DialogueMetricInputs } from "./useDialogueCanvasMetrics";

afterEach(() => vi.restoreAllMocks());
const document = (): DialogueDocument => ({
  dialogue_version: 1, entry_element_id: "line", participants: ["hero"], elements: [
    { id: "line", kind: "line", speaker_node_id: "hero", text: "Choose", next_element_id: "choice" },
    { id: "choice", kind: "choice", prompt: "Route?", options: [
      { id: "stay", text: "Stay", condition: "", next_element_id: null },
      { id: "leave", text: "Leave", condition: "", next_element_id: null }
    ] },
    { id: "ending", kind: "line", speaker_node_id: "hero", text: "Goodbye", next_element_id: null }
  ]
});
const dialogue = (id: string, source?: DialogueDocument, canonicalNodeId = id) => ({
  id, data: { kind: "Dialogue", canonicalNodeId, dialogueDocument: source }
});
function inputs(nodes: DialogueMetricInputs["nodes"], origins: [string, string[]][] = [], projectId = "project-a"): DialogueMetricInputs {
  return { projectId, nodes, externalOrigins: new Map(origins) };
}
const observe = (initialProps: DialogueMetricInputs) => renderHook(useDialogueCanvasMetrics, { initialProps });

it("counts lines, choices, participants and terminal options/lines, including legacy documents", () => {
  const helper = vi.spyOn(presentation, "dialogueCanvasMetrics");
  const view = observe(inputs([dialogue("dialogue", document()), dialogue("legacy"), { id: "other", data: { kind: "Quest" } }], [["dialogue", ["leave", "ending"]]]));
  expect([...view.result.current.keys()]).toEqual(["dialogue", "legacy"]);
  expect(view.result.current.get("dialogue")).toEqual({ choices: 1, endings: 1, lines: 2, participants: 1 });
  expect(view.result.current.get("legacy")).toEqual({ choices: 0, endings: 0, lines: 0, participants: 0 });
  expect(helper).toHaveBeenCalledTimes(2);
});

it("retains metrics through placement/label changes and equal reordered or duplicated origin ids", () => {
  const original = dialogue("dialogue", document());
  const helper = vi.spyOn(presentation, "dialogueCanvasMetrics");
  const view = observe(inputs([original], [["dialogue", ["leave", "ending"]]]));
  const before = view.result.current.get("dialogue");
  const moved = { ...original, selected: true, position: { x: 10, y: 20 }, data: { ...original.data, title: "Renamed", summary: "New text" } };
  helper.mockClear();
  view.rerender(inputs([moved], [["unrelated", ["stay"]], ["dialogue", ["ending", "leave", "leave"]]]));
  expect(view.result.current.get("dialogue")).toBe(before);
  expect(helper).not.toHaveBeenCalled();
});

it("updates endings on external-origin addition, removal and reassignment with the same document", () => {
  const nodes = [dialogue("dialogue", document())];
  const view = observe(inputs(nodes));
  expect(view.result.current.get("dialogue")!.endings).toBe(3);
  view.rerender(inputs(nodes, [["dialogue", ["leave", "ending"]]]));
  expect(view.result.current.get("dialogue")!.endings).toBe(1);
  view.rerender(inputs(nodes, [["dialogue", ["stay"]]]));
  expect(view.result.current.get("dialogue")!.endings).toBe(2);
  view.rerender(inputs(nodes, [["other-source", ["stay"]]]));
  expect(view.result.current.get("dialogue")!.endings).toBe(3);
});

it("keeps exact visual source lookup for linked placements rather than falling back to canonical ids", () => {
  const source = document();
  const nodes = [dialogue("primary", source), dialogue("linked", source, "primary")];
  const view = observe(inputs(nodes, [["primary", ["leave", "ending"]]]));
  const primary = view.result.current.get("primary");
  expect(primary!.endings).toBe(1);
  expect(view.result.current.get("linked")!.endings).toBe(3);
  view.rerender(inputs(nodes, [["primary", ["leave", "ending"]], ["linked", ["stay"]]]));
  expect(view.result.current.get("primary")).toBe(primary);
  expect(view.result.current.get("linked")!.endings).toBe(2);
});

it("recomputes immutable documents, including equal-valued replacements, without retaining history", () => {
  const source = document();
  const helper = vi.spyOn(presentation, "dialogueCanvasMetrics");
  const view = observe(inputs([dialogue("dialogue", source)]));
  const before = view.result.current.get("dialogue");
  view.rerender(inputs([dialogue("dialogue", { ...source })]));
  expect(view.result.current.get("dialogue")).toEqual(before);
  expect(view.result.current.get("dialogue")).not.toBe(before);
  view.rerender(inputs([dialogue("dialogue", { ...source, participants: ["hero", "guard"], elements: [] })]));
  expect(view.result.current.get("dialogue")).toEqual({ choices: 0, endings: 0, lines: 0, participants: 2 });
  view.rerender(inputs([dialogue("dialogue", source)]));
  expect(view.result.current.get("dialogue")).not.toBe(before);
  expect(helper).toHaveBeenCalledTimes(4);
});

it.each(["removed", "type", "canonical", "project"])("prunes values after %s replacement even with reused documents and ids", (change) => {
  const source = document();
  const original = inputs([dialogue("dialogue", source)]);
  const view = observe(original);
  const before = view.result.current.get("dialogue");
  view.rerender(change === "removed" ? inputs([])
    : change === "type" ? inputs([{ id: "dialogue", data: { kind: "Character", dialogueDocument: source } }])
    : change === "canonical" ? inputs([dialogue("dialogue", source, "other")])
    : { ...original, projectId: "project-b" });
  expect(view.result.current.get("dialogue")).not.toBe(before);
  view.rerender(original);
  expect(view.result.current.get("dialogue")).not.toBe(before);
});

it("bounds retained entries to live placements and does not accumulate visited origins", () => {
  const source = document();
  const helper = vi.spyOn(presentation, "dialogueCanvasMetrics");
  const view = observe(inputs([]));
  for (let index = 0; index < 20; index += 1) {
    view.rerender(inputs([dialogue(`placement:${index}`, source)], [[`placement:${index}`, ["leave"]]]));
    expect([...view.result.current.keys()]).toEqual([`placement:${index}`]);
  }
  view.rerender(inputs([]));
  expect(view.result.current.size).toBe(0);
  view.rerender(inputs([dialogue("placement:0", source)], [["placement:0", ["leave"]]]));
  expect(helper).toHaveBeenCalledTimes(21);
});

it.each(["origins", "document", "project"])("does not publish speculative %s or prune committed metrics during Suspense", (change) => {
  const original = inputs([dialogue("dialogue", document())]);
  const next = change === "origins" ? { ...original, externalOrigins: new Map([["dialogue", ["leave"]]]) }
    : change === "document" ? inputs([dialogue("dialogue", { ...document(), elements: [] })])
    : { ...original, projectId: "project-b" };
  const pending = new Promise<void>(() => {});
  const helper = vi.spyOn(presentation, "dialogueCanvasMetrics");
  const view = renderHook(({ context, suspend }) => {
    const values = useDialogueCanvasMetrics(context);
    if (suspend) throw pending;
    return values;
  }, { initialProps: { context: original, suspend: false }, wrapper: ({ children }) => <Suspense fallback={null}>{children}</Suspense> });
  const before = view.result.current.get("dialogue");
  view.rerender({ context: next, suspend: true });
  // Speculative retry count is not contractual; only committed inputs may be retained.
  helper.mockClear();
  view.rerender({ context: { ...original, nodes: [...original.nodes] }, suspend: false });
  expect(view.result.current.get("dialogue")).toBe(before);
  expect(helper).not.toHaveBeenCalled();
  view.rerender({ context: next, suspend: false });
  expect(view.result.current.get("dialogue")).not.toBe(before);
  expect(helper).toHaveBeenCalledOnce();
});

it("supports Strict Mode replay and releases the registry on real unmount", () => {
  const context = inputs([dialogue("dialogue", document())]);
  const view = renderHook(useDialogueCanvasMetrics, { initialProps: context, wrapper: StrictMode });
  const before = view.result.current.get("dialogue");
  view.rerender({ ...context, nodes: [...context.nodes] });
  expect(view.result.current.get("dialogue")).toBe(before);
  view.unmount();
  const fresh = observe(context);
  expect(fresh.result.current.get("dialogue")).toEqual(before);
  expect(fresh.result.current.get("dialogue")).not.toBe(before);
});

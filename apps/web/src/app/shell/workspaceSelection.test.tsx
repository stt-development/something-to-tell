import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import type { NarrativeEffectOwnerRef } from "@something-to-tell/contracts/narrative-state";
import { useWorkspaceState } from "./useWorkspaceState";

const options = { activeProjectId: "test", initialStoryFlowsByProject: {} };

it("retains equal canvas sets, but preserves order, kinds and batched functional updates", () => {
  const { result } = renderHook(() => useWorkspaceState(options));
  const set = result.current.setCanvasSelection;
  act(() => set({ nodeIds: ["a", "b"], edgeIds: ["e"] }));
  const selected = result.current.canvasSelection;
  act(() => set({ nodeIds: ["a", "b"], edgeIds: ["e"] }));
  expect(result.current.canvasSelection).toBe(selected);
  act(() => set((current) => ({ nodeIds: [...current.nodeIds], edgeIds: [...current.edgeIds] })));
  expect(result.current.canvasSelection).toBe(selected);
  act(() => set({ nodeIds: ["b", "a"], edgeIds: ["e"] }));
  expect(result.current.canvasSelection.nodeIds).toEqual(["b", "a"]);
  expect(result.current.canvasSelection).not.toBe(selected);
  act(() => {
    set({ nodeIds: ["same"], edgeIds: [] });
    set((current) => ({ nodeIds: [], edgeIds: [...current.nodeIds] }));
    set((current) => ({ ...current, edgeIds: [...current.edgeIds, "next"] }));
  });
  expect(result.current.canvasSelection).toEqual({ nodeIds: [], edgeIds: ["same", "next"] });
  const edges = result.current.canvasSelection;
  act(() => set({ nodeIds: [], edgeIds: ["next", "same"] }));
  expect(result.current.canvasSelection.edgeIds).toEqual(["next", "same"]);
  expect(result.current.canvasSelection).not.toBe(edges);
  act(() => set({ nodeIds: [], edgeIds: [] }));
  const empty = result.current.canvasSelection;
  act(() => set({ nodeIds: [], edgeIds: [] }));
  expect(result.current.canvasSelection).toBe(empty);
  expect(result.current.setCanvasSelection).toBe(set);
});

it("compares all temporal owner identity fields and preserves queued transitions", () => {
  const { result } = renderHook(() => useWorkspaceState(options));
  const set = result.current.setSelectedTemporalOwner;
  const owner: NarrativeEffectOwnerRef = {
    owner_version: 1, owner_kind: "dialogue_element", owner_id: "line", context_node_id: "dialogue"
  };
  act(() => set(owner));
  act(() => set({ ...owner }));
  expect(result.current.selectedTemporalOwner).toBe(owner);
  act(() => set((current) => current ? { ...current } : null));
  expect(result.current.selectedTemporalOwner).toBe(owner);
  for (const next of [
    { ...owner, context_node_id: "other-dialogue" },
    { ...owner, owner_id: "other-line" },
    { ...owner, owner_kind: "dialogue_option" },
    { owner_version: 1, owner_kind: "node_entry", owner_id: "line" }
  ] satisfies NarrativeEffectOwnerRef[]) {
    act(() => set(next));
    expect(result.current.selectedTemporalOwner).toBe(next);
  }
  act(() => { set(owner); set(null); });
  expect(result.current.selectedTemporalOwner).toBeNull();
  act(() => set(owner));
  act(() => {
    set(null);
    set((current) => { expect(current).toBeNull(); return owner; });
  });
  expect(result.current.selectedTemporalOwner).toBe(owner);
  expect(result.current.setSelectedTemporalOwner).toBe(set);
});

import { beforeEach, expect, it, vi } from "vitest";
import { loadProjectFixturesForTests } from "../testFixtures/projectFixtures";
import type { Selection } from "../types";
import { useGraphStore } from "./graphStore";

beforeEach(() => {
  useGraphStore.setState(useGraphStore.getInitialState(), true);
  loadProjectFixturesForTests();
});

it.each(["node", "edge", "project"] as const)("does not publish an equal %s selection", (type) => {
  const selection: Selection = { type, id: "same-id" };
  useGraphStore.getState().selectItem(selection);
  const state = useGraphStore.getState();
  const listener = vi.fn();
  const unsubscribe = useGraphStore.subscribe(listener);
  try {
    state.selectItem({ ...selection });
    expect(useGraphStore.getState()).toBe(state);
    expect(useGraphStore.getState().selection).toBe(selection);
    expect(listener).not.toHaveBeenCalled();
  } finally { unsubscribe(); }
});

it("publishes type/id changes and clears once without touching authored state", () => {
  const before = useGraphStore.getState();
  const listener = vi.fn();
  const unsubscribe = useGraphStore.subscribe(listener);
  try {
    for (const selection of [
      { type: "node", id: "shared-id" }, { type: "edge", id: "shared-id" },
      { type: "project", id: "shared-id" }, { type: "node", id: "other-id" }, null
    ] satisfies (Selection | null)[]) {
      before.selectItem(selection);
      expect(useGraphStore.getState().selection).toEqual(selection);
    }
    expect(listener).toHaveBeenCalledTimes(5);
    const cleared = useGraphStore.getState();
    before.selectItem(null);
    expect(listener).toHaveBeenCalledTimes(5);
    expect(useGraphStore.getState()).toBe(cleared);
    expect(cleared.graphs).toBe(before.graphs);
    expect(cleared.activeProjectSession).toBe(before.activeProjectSession);
  } finally { unsubscribe(); }
});

it("keeps linked placement identities distinct from the canonical node", () => {
  const { selectItem } = useGraphStore.getState();
  selectItem({ type: "node", id: "node-dockmaster" });
  const canonical = useGraphStore.getState();
  selectItem({ type: "node", id: "placement:seed-ilya-opening" });
  expect(useGraphStore.getState()).not.toBe(canonical);
  expect(useGraphStore.getState().selection?.id).toBe("placement:seed-ilya-opening");
});

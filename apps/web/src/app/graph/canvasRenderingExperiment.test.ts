import { describe, expect, it, vi } from "vitest";
import { createGraphCardExperiment, createCanvasExperimentPreference, GRAPH_CARD_EXPERIMENT_KEY, NODE_DETAIL_EXPERIMENT_KEY, MINIMAP_EXPERIMENT_KEY } from "./canvasRenderingExperiment";

it("keeps Graph and detail keys, values and subscriptions independent", () => {
  const values = new Map<string, string>();
  const read = () => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } });
  const graph = createGraphCardExperiment(read), detail = createCanvasExperimentPreference(NODE_DETAIL_EXPERIMENT_KEY, read), listener = vi.fn();
  graph.subscribe(listener); detail.setEnabled(true);
  expect(graph.getSnapshot()).toBeNull(); expect(listener).not.toHaveBeenCalled();
  graph.setEnabled(false); expect(detail.getSnapshot()).toBe(true);
  expect([...values.keys()].sort()).toEqual([GRAPH_CARD_EXPERIMENT_KEY, NODE_DETAIL_EXPERIMENT_KEY].sort());
});

describe.each([
  { name: "Graph cards", key: GRAPH_CARD_EXPERIMENT_KEY, create: createGraphCardExperiment },
  { name: "MiniMap", key: MINIMAP_EXPERIMENT_KEY, create: (read: Parameters<typeof createGraphCardExperiment>[0]) => createCanvasExperimentPreference(MINIMAP_EXPERIMENT_KEY, read) },
  { name: "node detail", key: NODE_DETAIL_EXPERIMENT_KEY, create: (read: Parameters<typeof createGraphCardExperiment>[0]) => createCanvasExperimentPreference(NODE_DETAIL_EXPERIMENT_KEY, read) }
])("device-local $name preference contract", ({ key, create }) => {
  it.each([null, "1", "invalid"])("inherits the approved default for %s", (value) => {
    expect(create(() => ({ getItem: () => value, setItem: vi.fn() })).getSnapshot()).toBeNull();
  });

  it.each([["true", true], ["false", false]] as const)("preserves an existing literal %s choice", (stored, choice) => {
    expect(create(() => ({ getItem: () => stored, setItem: vi.fn() })).getSnapshot()).toBe(choice);
  });

  it("persists explicit opt-in and rollback across preference lifetimes", () => {
    const storage = new Map<string, string>();
    const adapter = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } };
    const preference = create(() => adapter);
    preference.setEnabled(true);
    expect(storage.get(key)).toBe("true");
    const reloaded = create(() => adapter);
    expect(reloaded.getSnapshot()).toBe(true);
    reloaded.setEnabled(false);
    expect(create(() => adapter).getSnapshot()).toBe(false);
  });

  it("publishes only real changes and removes subscriptions", () => {
    const preference = create(() => undefined), listener = vi.fn();
    const unsubscribe = preference.subscribe(listener);
    preference.setEnabled(false);
    preference.setEnabled(false);
    preference.setEnabled(true);
    preference.setEnabled(true);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe(); preference.setEnabled(false);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(preference.getSnapshot()).toBe(false);
  });

  it("records explicit Off even when an unset preference currently resolves to Off", () => {
    const write = vi.fn();
    const preference = create(() => ({ getItem: () => null, setItem: write }));
    expect(preference.getSnapshot()).toBeNull();
    preference.setEnabled(false);
    expect(write).toHaveBeenCalledWith(key, "false");
    expect(preference.getSnapshot() ?? true).toBe(false);
  });

  it("supports in-memory enable and rollback when storage access or writes throw", () => {
    for (const read of [() => { throw Error("blocked"); }, () => ({ getItem: () => "true", setItem: () => { throw Error("quota"); } })]) {
      const preference = create(read);
      preference.setEnabled(true); expect(preference.getSnapshot()).toBe(true);
      preference.setEnabled(false); expect(preference.getSnapshot()).toBe(false);
    }
  });
});

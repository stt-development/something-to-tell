import { expect, it, vi } from "vitest";
import { createNodePresentationStore } from "./nodePresentationStore";
import { queryViewportEligibility } from "./viewportEligibility";
import type { CommittedEligibilityInputs } from "./viewportEligibilityScheduler";
import * as detailQuery from "./nodeDetailEligibility";

const input = (zoom = 1): CommittedEligibilityInputs => ({
  scope: { projectId: "project", workspaceMode: "relationships", flowId: null, focusedFrameId: null }, resetKey: 1,
  placements: Array.from({ length: 5 }, (_, index) => ({ id: `visual-${index}`, parentId: index ? `visual-${index - 1}` : undefined,
    worldBounds: { x: index * 10, y: index * 10, width: 260, height: 156 } })),
  viewport: { x: 0, y: 0, width: 1440, height: 900, zoom }, protectedIds: new Set()
});
function fixture(value = input()) {
  const store = createNodePresentationStore(); store.configure({ spatialEnabled: true, detailEnabled: true });
  const publish = (current: CommittedEligibilityInputs) => { store.commit(current); store.publish(queryViewportEligibility(current)); };
  publish(value);
  return { store, publish, row: store.reader.getPresentation };
}

it("publishes stable narrow detail snapshots only after the latest frame evaluation", () => {
  const initial = input(), { store, row, publish } = fixture(initial), listener = vi.fn();
  const full = row("visual-0"), unsubscribe = store.reader.subscribe("visual-0", listener);
  publish(initial); expect(row("visual-0")).toBe(full); expect(listener).not.toHaveBeenCalled();
  const compact = { ...initial, viewport: { ...initial.viewport, zoom: 0.3 } };
  store.commit(compact); expect(row("visual-0")).toBe(full);
  store.publish(queryViewportEligibility(compact)); expect(row("visual-0").mode).toBe("compact"); expect(listener).toHaveBeenCalledOnce();
  const before = row("visual-0"); publish({ ...compact, viewport: { ...compact.viewport, x: 5 } });
  expect(row("visual-0")).toBe(before); expect(listener).toHaveBeenCalledOnce();
  unsubscribe(); publish(initial); expect(listener).toHaveBeenCalledOnce();
});

it("does not repeat depth/count work during pan-only frame evaluations", () => {
  const query = vi.spyOn(detailQuery, "queryNodeDetailEligibility"), initial = input(), { publish, store } = fixture(initial);
  try {
    expect(query).toHaveBeenCalledOnce();
    for (let x = 0; x < 10; x++) publish({ ...initial, viewport: { ...initial.viewport, x } });
    expect(query).toHaveBeenCalledOnce();
    publish({ ...initial, viewport: { ...initial.viewport, zoom: 0.3 } }); expect(query).toHaveBeenCalledTimes(2);
    store.commit(null); expect(store.reader.getPresentation("visual-0").mode).toBe("full");
  } finally { query.mockRestore(); }
});

it("keeps detail independent of spatial shells and permits immediate separate rollback", () => {
  const value = { ...input(0.3), placements: [{ id: "far", worldBounds: { x: 100000, y: 0, width: 260, height: 156 } }] };
  const { store, publish, row } = fixture(value); expect(row("far").mode).toBe("shell");
  store.configure({ spatialEnabled: false, detailEnabled: true }); publish(value); expect(row("far").mode).toBe("compact");
  store.configure({ spatialEnabled: false, detailEnabled: false }); expect(row("far").mode).toBe("full");
  store.configure({ spatialEnabled: true, detailEnabled: false }); publish(value); expect(row("far").mode).toBe("shell");
});

it("reveals an arbitrary-depth visual path without changing inputs, selection, dimensions or authored collapse", () => {
  const initial = input(0.1), before = JSON.stringify(initial), { store, row } = fixture(initial);
  expect(row("visual-4").mode).toBe("folded"); expect(row("visual-0").foldedDescendants).toBe(2);
  store.reveal("visual-4");
  expect(Array.from({ length: 5 }, (_, index) => row(`visual-${index}`).mode)).toEqual(["full", "full", "full", "full", "full"]);
  expect(row("visual-0").foldedDescendants).toBe(0); expect(JSON.stringify(initial)).toBe(before);
  store.reveal("absent"); expect(row("absent").mode).toBe("full");
});

it.each(["project", "workspace", "flow", "frame", "document"])("clears revealed paths and zoom deadbands on %s replacement", (kind) => {
  const initial = input(), { store, row, publish } = fixture(initial); store.reveal("visual-4");
  const next = { ...initial, scope: { ...initial.scope, projectId: kind === "project" ? "other" : initial.scope.projectId,
    workspaceMode: kind === "workspace" ? "flow" as const : initial.scope.workspaceMode,
    flowId: kind === "flow" ? "flow" : null, focusedFrameId: kind === "frame" ? "frame" : null },
    resetKey: kind === "document" ? 2 : initial.resetKey, viewport: { ...initial.viewport, zoom: 0.6 } };
  store.commit(next); expect(row("visual-4").mode).toBe("full");
  store.publish(queryViewportEligibility(next)); expect(row("visual-0").mode).toBe("compact"); expect(row("visual-4").mode).toBe("folded");
  publish(next); expect(row("visual-4").mode).toBe("folded");
});

it("immediately protects changed geometry and interaction controls, then retires removed/re-added reveals", () => {
  const initial = input(0.1), { store, row, publish } = fixture(initial);
  const protectedValue = { ...initial, protectedIds: new Set(["visual-0", "visual-1", "visual-2", "visual-3", "visual-4"]) };
  store.commit(protectedValue); expect(row("visual-4").mode).toBe("full");
  publish(protectedValue); expect(row("visual-4").mode).toBe("full");
  publish(initial); expect(row("visual-4").mode).toBe("folded");
  store.reveal("visual-4"); publish({ ...initial, placements: initial.placements.slice(0, 4) });
  publish(initial); expect(row("visual-4").mode).toBe("folded");
  const moved = { ...initial, placements: initial.placements.map((row) => ({ ...row, worldBounds: { ...row.worldBounds!, x: 500 } })) };
  store.commit(moved); expect(row("visual-4").mode).toBe("full");
  store.publish(queryViewportEligibility(moved)); expect(row("visual-4").mode).toBe("folded");
  store.commit(null); store.publish(queryViewportEligibility(moved)); expect(row("visual-4").mode).toBe("full");
});

it("keeps invalid camera, unknown geometry and malformed ancestry full", () => {
  for (const value of [input(NaN), { ...input(), viewport: { ...input().viewport, width: 0 } },
    { ...input(), placements: [{ id: "unknown", worldBounds: null }] },
    { ...input(), placements: [{ id: "orphan", parentId: "missing", worldBounds: { x: 0, y: 0, width: 100, height: 100 } }] }]) {
    const { row } = fixture(value); expect(row(value.placements[0]!.id).mode).toBe("full");
  }
});

it("rebuilds reveal ancestry from current visual parents instead of retaining an old container path", () => {
  const initial = input(0.1), { store, row, publish } = fixture(initial); store.reveal("visual-4");
  const next = { ...initial, placements: [...initial.placements.map((item) => item.id === "visual-4" ? { ...item, parentId: "other" } : item),
    { id: "other", worldBounds: { x: 0, y: 0, width: 320, height: 220 } }] };
  store.commit(next); expect(row("other").mode).toBe("full");
  publish(next); expect(row("visual-4").mode).toBe("full"); expect(row("other").mode).toBe("full");
  expect(row("visual-0").mode).toBe("overview"); expect(row("visual-3").mode).toBe("folded");
});

it("does not turn explicit detail reveal into an offscreen spatial protection cache", () => {
  const initial = input(), { store, row, publish } = fixture(initial); store.reveal("visual-4");
  expect(row("visual-4").mode).toBe("full");
  publish({ ...initial, viewport: { ...initial.viewport, x: -100000 } }); expect(row("visual-4").mode).toBe("shell");
  publish(initial); expect(row("visual-4").mode).toBe("full");
});

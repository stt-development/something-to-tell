import { expect, it, vi } from "vitest";
import { createNodePresentationStore } from "./nodePresentationStore";
import { queryViewportEligibility } from "./viewportEligibility";
import type { CommittedEligibilityInputs } from "./viewportEligibilityScheduler";

const input = (): CommittedEligibilityInputs => ({ scope: { projectId: "owned", workspaceMode: "relationships", flowId: null, focusedFrameId: null },
  resetKey: "doc", viewport: { x: 0, y: 0, width: 1000, height: 800, zoom: 1 }, protectedIds: new Set(),
  placements: [{ id: "near", worldBounds: { x: 0, y: 0, width: 260, height: 156 } },
    { id: "far", worldBounds: { x: 10000, y: 0, width: 260, height: 156 } }] });

it("derives stable DOM eligibility from the one existing mask and clears on release", () => {
  const store = createNodePresentationStore(), notify = vi.fn(), current = input();
  const stop = store.reader.subscribeDom(notify);
  expect(store.reader.getDomHiddenIds().size).toBe(0);
  store.commit(current); store.publish(queryViewportEligibility(current));
  const snapshot = store.reader.getDomHiddenIds();
  expect([...snapshot]).toEqual(["far"]);
  expect(notify).toHaveBeenCalledOnce();
  store.publish(queryViewportEligibility(current));
  expect(store.reader.getDomHiddenIds()).toBe(snapshot);
  expect(notify).toHaveBeenCalledOnce();
  store.commit({ ...current, protectedIds: new Set(["far"]) });
  expect(store.reader.getDomHiddenIds().size).toBe(0);
  stop(); store.commit(null);
  expect(store.reader.getDomHiddenIds().size).toBe(0);
});

it("falls back full for geometry, scope, unknown viewport and disabled spatial presentation", () => {
  const store = createNodePresentationStore(), current = input();
  store.reader.subscribeDom(() => {});
  store.commit(current); store.publish(queryViewportEligibility(current));
  expect(store.reader.getDomHiddenIds().size).toBe(1);
  store.commit({ ...current, viewport: { ...current.viewport, width: 0 } });
  expect(store.reader.getDomHiddenIds().size).toBe(0);
  store.commit(current); store.publish(queryViewportEligibility(current));
  store.configure({ spatialEnabled: false, detailEnabled: true });
  expect(store.reader.getDomHiddenIds().size).toBe(0);
  store.configure({ spatialEnabled: true, detailEnabled: false });
  store.commit({ ...current, resetKey: "other" });
  expect(store.reader.getDomHiddenIds().size).toBe(0);
  store.commit({ ...current, placements: [{ id: "far", worldBounds: null }] });
  store.publish(queryViewportEligibility({ ...current, placements: [{ id: "far", worldBounds: null }] }));
  expect(store.reader.getDomHiddenIds().size).toBe(0);
});

it.each([{ zoom: NaN }, { x: Infinity }, { zoom: 11 }])("clears a previous mask immediately for invalid camera: %j", invalid => {
  const store = createNodePresentationStore(), current = input();
  store.reader.subscribeDom(() => {});
  store.commit(current); store.publish(queryViewportEligibility(current));
  expect(store.reader.getDomHiddenIds().size).toBe(1);
  store.commit({ ...current, viewport: { ...current.viewport, ...invalid } });
  expect(store.reader.getDomHiddenIds().size).toBe(0);
});

import { describe, expect, it, vi } from "vitest";
import { createViewportEligibilityScheduler, type CommittedEligibilityInputs, type EligibilityFrameClock } from "./viewportEligibilityScheduler";
import type { ViewportEligibility, ViewportPlacement, ViewportScope } from "./viewportEligibility";

const scope: ViewportScope = { projectId: "project", workspaceMode: "relationships", flowId: null, focusedFrameId: null };
const node = (id: string, x = 0, parentId?: string): ViewportPlacement => ({ id, parentId,
  worldBounds: { x, y: 0, width: 10, height: 10 } });
const input = (extra: Partial<CommittedEligibilityInputs> = {}): CommittedEligibilityInputs => ({
  scope, resetKey: "document-1", placements: [node("a")],
  viewport: { x: 0, y: 0, width: 100, height: 100, zoom: 1 }, ...extra
});

/** Deliberately retains canceled callbacks to exercise hostile late delivery. */
function clock() {
  let serial = 0;
  const callbacks = new Map<number, () => void>();
  const active = new Set<number>();
  const frames: EligibilityFrameClock = {
    request: vi.fn((callback) => { const id = serial++; callbacks.set(id, callback); active.add(id); return id; }),
    cancel: vi.fn((id) => { active.delete(id); })
  };
  return { frames, active,
    fire(id: number) { active.delete(id); callbacks.get(id)?.(); },
    flush() { for (const id of [...active]) { active.delete(id); callbacks.get(id)?.(); } }
  };
}

function setup() {
  const ticks = clock();
  const changes = vi.fn<(value: ViewportEligibility | null) => void>();
  return { ticks, changes, scheduler: createViewportEligibilityScheduler(changes, ticks.frames) };
}

describe("viewport eligibility frame scheduler", () => {
  it("settles changed geometry even when membership publication is suppressed", () => {
    const ticks = clock(), changes = vi.fn(), evaluated = vi.fn();
    const scheduler = createViewportEligibilityScheduler(changes, ticks.frames, evaluated);
    scheduler.update(input({ placements: [node("far", 10000)] })); ticks.flush();
    scheduler.update(input({ placements: [node("far", 20000)] })); ticks.flush();
    expect(changes).toHaveBeenCalledTimes(1);
    expect(evaluated).toHaveBeenCalledTimes(2);
    expect(evaluated.mock.lastCall?.[0]).toBe(scheduler.getSnapshot());
    scheduler.update(input()); scheduler.dispose(); ticks.fire(2);
    expect(evaluated).toHaveBeenCalledTimes(2);
  });

  it("does not settle a result replaced synchronously by its change listener", () => {
    const ticks = clock(), evaluated = vi.fn();
    const scheduler = createViewportEligibilityScheduler((value) => {
      if (value?.scope.projectId === "project") scheduler.update(input({ scope: { ...scope, projectId: "replacement" } }));
    }, ticks.frames, evaluated);
    scheduler.update(input()); ticks.flush();
    expect(evaluated).not.toHaveBeenCalled();
    ticks.flush();
    expect(evaluated).toHaveBeenCalledTimes(1);
    expect(evaluated.mock.lastCall?.[0].scope.projectId).toBe("replacement");
  });
  it("coalesces many updates and queries only the latest committed geometry/camera/protection", () => {
    const { scheduler, ticks, changes } = setup();
    let reads = 0;
    const obsolete = { get id() { reads++; return "obsolete"; }, worldBounds: node("unused").worldBounds };
    scheduler.update(input({ placements: [obsolete] }));
    for (let index = 0; index < 100; index++) scheduler.update(input({ viewport: { ...input().viewport, x: index } }));
    scheduler.update(input({ placements: [node("near"), node("protected", 10000), node("far", 20000)],
      viewport: { ...input().viewport, x: -10000 }, protectedIds: new Set(["near"]) }));
    expect(ticks.frames.request).toHaveBeenCalledTimes(1);
    expect(changes).not.toHaveBeenCalled();
    ticks.flush();
    expect(reads).toBe(0);
    expect(scheduler.getSnapshot()?.eligibleIds).toEqual(new Set(["near", "protected"]));
    expect(changes).toHaveBeenCalledTimes(1);
    ticks.fire(0);
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("retains 360px fringe membership and releases without a visited-node history", () => {
    const { scheduler, ticks, changes } = setup();
    scheduler.update(input({ placements: [node("a", 330)] })); ticks.flush();
    const first = scheduler.getSnapshot();
    scheduler.update(input({ placements: [node("a", 450)] })); ticks.flush();
    expect(scheduler.getSnapshot()).toBe(first);
    expect(changes).toHaveBeenCalledTimes(1);
    scheduler.update(input({ placements: [node("a", 461)] })); ticks.flush();
    expect(scheduler.getSnapshot()?.eligibleIds.size).toBe(0);
    scheduler.update(input({ placements: [node("a", 450)] })); ticks.flush();
    expect(scheduler.getSnapshot()?.eligibleIds.size).toBe(0);
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it("compares membership rather than Set order and suppresses equal publications", () => {
    const { scheduler, ticks, changes } = setup();
    scheduler.update(input({ placements: [node("a"), node("b")] })); ticks.flush();
    const first = scheduler.getSnapshot();
    scheduler.update(input({ placements: [node("b"), node("a")] })); ticks.flush();
    expect(scheduler.getSnapshot()).toBe(first);
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it.each([
    { projectId: "other" }, { workspaceMode: "flow" as const },
    { flowId: "other" }, { focusedFrameId: "frame" }
  ])("retires membership and pending work when scope changes: %o", (replacement) => {
    const { scheduler, ticks, changes } = setup();
    scheduler.update(input({ placements: [node("a", 330)] })); ticks.flush();
    scheduler.update(input({ placements: [node("a", 450)] }));
    scheduler.update(input({ scope: { ...scope, ...replacement }, placements: [node("a", 450)] }));
    expect(scheduler.getSnapshot()).toBeNull();
    expect(changes.mock.lastCall?.[0]).toBeNull();
    ticks.fire(1);
    expect(scheduler.getSnapshot()).toBeNull();
    ticks.flush();
    expect(scheduler.getSnapshot()?.eligibleIds.size).toBe(0);
    expect(scheduler.getSnapshot()?.scope).toEqual({ ...scope, ...replacement });
    expect(ticks.frames.cancel).toHaveBeenCalledWith(1);
  });

  it("resets retention for same-scope document replacement and never revives an earlier scope", () => {
    const { scheduler, ticks } = setup();
    scheduler.update(input({ placements: [node("a", 330)] })); ticks.flush();
    scheduler.update(input({ placements: [node("a", 450)], resetKey: {} }));
    expect(scheduler.getSnapshot()).toBeNull(); ticks.flush();
    expect(scheduler.getSnapshot()?.eligibleIds.size).toBe(0);
    scheduler.update(input({ scope: { ...scope, projectId: "B" } }));
    scheduler.update(input({ placements: [node("a", 450)] })); ticks.flush();
    expect(scheduler.getSnapshot()?.eligibleIds.size).toBe(0);
  });

  it("uses reset-key identity, not a key object's shape", () => {
    const { scheduler, ticks } = setup();
    const resetKey = {};
    scheduler.update(input({ placements: [node("a", 330)], resetKey })); ticks.flush();
    scheduler.update(input({ placements: [node("a", 450)], resetKey })); ticks.flush();
    expect(scheduler.getSnapshot()?.eligibleIds.has("a")).toBe(true);
    scheduler.update(input({ placements: [node("a", 450)], resetKey: {} })); ticks.flush();
    expect(scheduler.getSnapshot()?.eligibleIds.size).toBe(0);
  });

  it("prunes removed ids, uses current parents and releases ended protection", () => {
    const { scheduler, ticks } = setup();
    scheduler.update(input({ placements: [node("removed"), node("old-parent", 10000), node("child", 10000, "old-parent")],
      protectedIds: new Set(["child"]) })); ticks.flush();
    expect(scheduler.getSnapshot()?.eligibleIds).toEqual(new Set(["removed", "child", "old-parent"]));
    scheduler.update(input({ placements: [node("new-parent", 10000), node("child", 10000, "new-parent")],
      protectedIds: new Set(["child", "removed"]) })); ticks.flush();
    expect(scheduler.getSnapshot()?.eligibleIds).toEqual(new Set(["child", "new-parent"]));
    scheduler.update(input({ placements: [node("new-parent", 10000), node("child", 10000, "new-parent")] })); ticks.flush();
    expect(scheduler.getSnapshot()?.eligibleIds.size).toBe(0);
  });

  it("publishes fallback changes even when the eligible ids stay equal", () => {
    const { scheduler, ticks, changes } = setup();
    scheduler.update(input()); ticks.flush();
    scheduler.update(input({ placements: [{ id: "a" }] })); ticks.flush();
    expect(scheduler.getSnapshot()?.fallback).toBe("geometry");
    scheduler.update(input({ viewport: { ...input().viewport, width: 0 } })); ticks.flush();
    expect(scheduler.getSnapshot()?.fallback).toBe("viewport");
    scheduler.update(input()); ticks.flush();
    expect(scheduler.getSnapshot()?.fallback).toBe("none");
    expect(changes).toHaveBeenCalledTimes(4);
  });

  it("null input clears retention, cancels frame zero and permits a fresh activation", () => {
    const { scheduler, ticks, changes } = setup();
    scheduler.update(input()); scheduler.update(null);
    expect(ticks.frames.cancel).toHaveBeenCalledWith(0);
    ticks.fire(0);
    expect(changes).not.toHaveBeenCalled();
    scheduler.update(input({ placements: [node("a", 330)] })); ticks.flush();
    scheduler.update(null); scheduler.update(null);
    expect(changes.mock.calls.map(([value]) => value === null)).toEqual([false, true]);
    scheduler.update(input({ placements: [node("a", 450)] })); ticks.flush();
    expect(scheduler.getSnapshot()?.eligibleIds.size).toBe(0);
  });

  it("disposal is terminal, releases the snapshot and ignores canceled callbacks", () => {
    const { scheduler, ticks, changes } = setup();
    scheduler.update(input()); ticks.flush();
    scheduler.update(input()); scheduler.dispose(); scheduler.dispose();
    expect(scheduler.getSnapshot()).toBeNull();
    scheduler.update(input()); scheduler.update(null); ticks.fire(1); ticks.flush();
    expect(ticks.frames.request).toHaveBeenCalledTimes(2);
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("honors a synchronous disposal during reset publication", () => {
    const { scheduler, ticks, changes } = setup();
    scheduler.update(input()); ticks.flush();
    changes.mockImplementation((value) => { if (!value) scheduler.dispose(); });
    scheduler.update(input({ resetKey: "replacement" })); ticks.flush();
    expect(scheduler.getSnapshot()).toBeNull();
    expect(ticks.frames.request).toHaveBeenCalledTimes(1);
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it("does not overwrite a reentrant scope replacement during reset publication", () => {
    const { scheduler, ticks, changes } = setup();
    scheduler.update(input()); ticks.flush();
    const replacement = input({ scope: { ...scope, projectId: "C" }, placements: [node("c")] });
    changes.mockImplementation((value) => { if (!value) scheduler.update(replacement); });
    scheduler.update(input({ scope: { ...scope, projectId: "B" }, placements: [node("b")] }));
    ticks.flush();
    expect(scheduler.getSnapshot()?.scope.projectId).toBe("C");
    expect(scheduler.getSnapshot()?.eligibleIds).toEqual(new Set(["c"]));
    expect(ticks.frames.request).toHaveBeenCalledTimes(2);
  });
});

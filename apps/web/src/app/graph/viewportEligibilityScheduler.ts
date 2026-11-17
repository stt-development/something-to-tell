import { queryViewportEligibility, sameViewportScope,
  type ViewportEligibility, type ViewportEligibilityInputs } from "./viewportEligibility";

export interface EligibilityFrameClock {
  request(callback: () => void): number;
  cancel(id: number): void;
}

export interface CommittedEligibilityInputs extends Omit<ViewportEligibilityInputs, "previous"> {
  /** Stable document lifetime identity; replace after authoritative reload. */
  readonly resetKey: unknown;
}

export interface ViewportEligibilityScheduler {
  /** Submit immutable inputs only after the owning UI render has committed. */
  update(inputs: CommittedEligibilityInputs | null): void;
  getSnapshot(): ViewportEligibility | null;
  /** Terminal teardown: no notifications or work after disposal. */
  dispose(): void;
}

const browserFrames: EligibilityFrameClock = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (id) => cancelAnimationFrame(id)
};

function equalEligibility(a: ViewportEligibility | null, b: ViewportEligibility | null): boolean {
  if (a === b) return true;
  if (!a || !b || !sameViewportScope(a.scope, b.scope) || a.fallback !== b.fallback
    || a.eligibleIds.size !== b.eligibleIds.size) return false;
  for (const id of a.eligibleIds) if (!b.eligibleIds.has(id)) return false;
  return true;
}

/** View-only scheduling, not a graph owner. One instance belongs to one mounted workspace. */
export function createViewportEligibilityScheduler(
  onChange: (snapshot: ViewportEligibility | null) => void,
  frames: EligibilityFrameClock = browserFrames,
  /** Lets a geometry adapter settle changed inputs even when membership is equal. */
  onEvaluated?: (snapshot: ViewportEligibility) => void
): ViewportEligibilityScheduler {
  let latest: CommittedEligibilityInputs | null = null;
  let snapshot: ViewportEligibility | null = null;
  let pending: { id: number | null } | null = null;
  let disposed = false;

  function cancelPending() {
    const ticket = pending;
    pending = null;
    if (ticket?.id != null) frames.cancel(ticket.id);
  }

  function publish(next: ViewportEligibility | null) {
    if (equalEligibility(snapshot, next)) return;
    snapshot = next;
    onChange(next);
  }

  function update(inputs: CommittedEligibilityInputs | null) {
    if (disposed) return;
    if (!inputs) {
      latest = null;
      cancelPending();
      publish(null);
      return;
    }
    const reset = !latest || !sameViewportScope(latest.scope, inputs.scope)
      || !Object.is(latest.resetKey, inputs.resetKey);
    // Copy scalar camera/scope metadata, retaining only the latest immutable
    // geometry/protection references until replacement, suspension or teardown.
    const committed: CommittedEligibilityInputs = {
      scope: { projectId: inputs.scope.projectId, workspaceMode: inputs.scope.workspaceMode,
        flowId: inputs.scope.flowId, focusedFrameId: inputs.scope.focusedFrameId },
      viewport: { x: inputs.viewport.x, y: inputs.viewport.y, width: inputs.viewport.width,
        height: inputs.viewport.height, zoom: inputs.viewport.zoom },
      placements: inputs.placements, protectedIds: inputs.protectedIds, resetKey: inputs.resetKey
    };
    latest = committed;
    if (reset) {
      cancelPending();
      publish(null);
    }
    // Publication may synchronously suspend, replace or dispose this controller.
    if (disposed || latest !== committed || pending) return;
    const ticket: { id: number | null } = { id: null };
    pending = ticket;
    ticket.id = frames.request(() => {
      // Cancellation alone cannot guarantee a callback already queued by a host
      // will not run. A retired ticket must never publish another scope's mask.
      if (disposed || pending !== ticket || !latest) return;
      pending = null;
      const inputs = latest;
      publish(queryViewportEligibility({ ...inputs, previous: snapshot }));
      if (!disposed && latest === inputs && snapshot) onEvaluated?.(snapshot);
    });
  }

  return {
    update,
    getSnapshot: () => snapshot,
    dispose() {
      disposed = true;
      latest = null;
      cancelPending();
      snapshot = null;
    }
  };
}

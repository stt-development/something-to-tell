import type { RemoteStorageHeadV1 } from "@something-to-tell/contracts/remote-storage";
import type { RemoteSessionObservation } from "../../runtime/remoteChannel";

/** Read-only presentation owner. It cannot advance a command guard or install data. */
export function createRemoteRecoveryMonitor(sessionId: string, head: RemoteStorageHeadV1, scopeCurrent: () => boolean) {
  let mounted = true;
  let snapshot: RemoteSessionObservation = Object.freeze({ sessionId, head: Object.freeze({ ...head }),
    blocked: head.state !== "ready", errorCode: null, unresolvedCommandId: null });
  const listeners = new Set<() => void>();
  const current = () => mounted && scopeCurrent();
  return {
    sessionId, projectId: head.project_id, generation: head.storage_generation,
    current,
    setMounted: (value: boolean) => { mounted = value; },
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    observe: (value: RemoteSessionObservation) => {
      if (!current() || value.sessionId !== sessionId || value.head.project_id !== head.project_id
          || value.head.storage_generation !== head.storage_generation) return;
      snapshot = Object.freeze({ ...value, head: Object.freeze({ ...value.head }) });
      listeners.forEach(listener => listener());
    }
  };
}
export type RemoteRecoveryMonitor = ReturnType<typeof createRemoteRecoveryMonitor>;

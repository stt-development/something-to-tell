import { useSyncExternalStore } from "react";

export const GRAPH_CARD_EXPERIMENT_KEY = "stt.canvas.graph_card_experiment.v1";
export const NODE_DETAIL_EXPERIMENT_KEY = "stt.canvas.node_detail_experiment.v1";
export const MINIMAP_EXPERIMENT_KEY = "stt.canvas.minimap_experiment.v1";
type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

/** Owns one device preference, never project state, history or runtime writes. */
export function createCanvasExperimentPreference(key: string, readStorage: () => PreferenceStorage | undefined) {
  let initialized = false;
  let enabled: boolean | null = null;
  const listeners = new Set<() => void>();
  const getSnapshot = () => {
    if (!initialized) {
      initialized = true;
      try {
        const stored = readStorage()?.getItem(key);
        enabled = stored === "true" ? true : stored === "false" ? false : null;
      } catch { /* Restricted storage inherits the approved default. */ }
    }
    return enabled;
  };
  return {
    getSnapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setEnabled(next: boolean) {
      if (getSnapshot() === next) return;
      enabled = next;
      try { readStorage()?.setItem(key, String(next)); }
      catch { /* A failed write must not prevent immediate in-memory rollback. */ }
      for (const listener of [...listeners]) listener();
    }
  };
}

export const createGraphCardExperiment = (readStorage: () => PreferenceStorage | undefined) => createCanvasExperimentPreference(GRAPH_CARD_EXPERIMENT_KEY, readStorage);
const preference = createGraphCardExperiment(() => globalThis.localStorage);
const detailPreference = createCanvasExperimentPreference(NODE_DETAIL_EXPERIMENT_KEY, () => globalThis.localStorage);
const minimapPreference = createCanvasExperimentPreference(MINIMAP_EXPERIMENT_KEY, () => globalThis.localStorage);
const serverDefault = () => null;
export const setGraphCardExperimentEnabled = preference.setEnabled;
export const setNodeDetailExperimentEnabled = detailPreference.setEnabled;
export const setMiniMapExperimentEnabled = minimapPreference.setEnabled;

/** Only the settings control and renderer boundary observe this flag. */
export function useGraphCardExperimentEnabled(approvedDefault = false): boolean {
  // False is an explicit rollback, not an absence of preference.
  return useSyncExternalStore(preference.subscribe, preference.getSnapshot, serverDefault) ?? approvedDefault;
}

export function useNodeDetailExperimentEnabled(approvedDefault = false): boolean {
  return useSyncExternalStore(detailPreference.subscribe, detailPreference.getSnapshot, serverDefault) ?? approvedDefault;
}

export function useMiniMapExperimentEnabled(approvedDefault = false): boolean {
  return useSyncExternalStore(minimapPreference.subscribe, minimapPreference.getSnapshot, serverDefault) ?? approvedDefault;
}

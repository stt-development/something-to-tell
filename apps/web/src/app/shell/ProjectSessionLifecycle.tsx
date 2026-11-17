import { useEffect, useLayoutEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import type { createRuntimeApiClient } from "../../runtime/apiClient";
import { useGraphStore } from "../../state/graphStore";
import { analysisBlocksAutosave } from "../analysis/sceneAnalysis";

export interface ProjectSessionLifecycleProps {
  canonSuggestionStatus: string | null;
  resolutionOperation: string | null;
  resolutionRunStatus: string | null;
  onSave: (reason: "manual" | "autosave") => Promise<boolean>;
  persistence: Pick<ReturnType<typeof createRuntimeApiClient>, "exitProjectSession">;
}

/** Owns browser scheduling/listeners, not save commands or session authority. */
export function ProjectSessionLifecycle({
  canonSuggestionStatus, resolutionOperation, resolutionRunStatus, onSave, persistence
}: ProjectSessionLifecycleProps) {
  const { sessionId, hasSession, status, revision, autosaveEnabled, autosaveInterval } = useGraphStore(useShallow((state) => ({
    sessionId: state.activeSessionId,
    hasSession: Boolean(state.activeProjectSession),
    status: state.activeProjectSession?.save_status,
    revision: state.activeProjectSession?.saved_revision,
    autosaveEnabled: state.activeAutosave?.enabled ?? false,
    autosaveInterval: state.activeAutosave?.interval_seconds
  })));
  const saveRef = useRef(onSave);
  useLayoutEffect(() => {
    // Keep committed command closures current without restarting an existing deadline.
    saveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    function handleSaveShortcut(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      void saveRef.current("manual");
    }
    window.addEventListener("keydown", handleSaveShortcut);
    return () => window.removeEventListener("keydown", handleSaveShortcut);
  }, []);

  useEffect(() => {
    if (!hasSession || status === "clean") return;
    function protectUnsavedUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", protectUnsavedUnload);
    return () => window.removeEventListener("beforeunload", protectUnsavedUnload);
  }, [hasSession, status]);

  useEffect(() => {
    if (!sessionId || !hasSession || revision === undefined) return;
    function releaseSessionOnPageExit(event: PageTransitionEvent) {
      if (event.persisted) return;
      void persistence.exitProjectSession(sessionId!, { expected_revision: revision! }).catch(() => undefined);
    }
    window.addEventListener("pagehide", releaseSessionOnPageExit);
    return () => window.removeEventListener("pagehide", releaseSessionOnPageExit);
  }, [hasSession, persistence, revision, sessionId]);

  useEffect(() => {
    if (!autosaveEnabled || autosaveInterval === undefined || status !== "dirty" || !sessionId
      || analysisBlocksAutosave(canonSuggestionStatus, resolutionOperation, resolutionRunStatus)) return;
    // Save changes concurrency tokens: pending provider proposals keep their old guard.
    const timer = window.setTimeout(() => void saveRef.current("autosave"), autosaveInterval * 1000);
    return () => window.clearTimeout(timer);
  }, [autosaveEnabled, autosaveInterval, status, revision, sessionId,
    canonSuggestionStatus, resolutionOperation, resolutionRunStatus, persistence]);

  return null;
}

import type { ProjectSessionState } from "@something-to-tell/contracts/project-session";
import { useCallback, useLayoutEffect, useRef } from "react";
import { RuntimeApiError, type createRuntimeApiClient } from "../../runtime/apiClient";
import { useGraphStore } from "../../state/graphStore";

export type ProjectSavePersistence = Pick<ReturnType<typeof createRuntimeApiClient>, "saveProjectSession" | "inspectProjectSession">;
export type ProjectSaveReason = "manual" | "autosave" | "close";

/** Owns one workspace's in-flight save; canonical state remains in Zustand/runtime. */
export function useProjectSave(sessionId: string | null, persistence: ProjectSavePersistence, onSaved: () => void) {
  const inFlight = useRef<{ sessionId: string; promise: Promise<boolean> } | null>(null);
  const savedCallback = useRef(onSaved);
  const mounted = useRef(true);
  useLayoutEffect(() => {
    savedCallback.current = onSaved;
  }, [onSaved]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  return useCallback((reason: ProjectSaveReason): Promise<boolean> => {
    const state = useGraphStore.getState();
    const session = state.activeProjectSession;
    if (!mounted.current) return Promise.resolve(false);
    if (!state.activeSessionId || !session) return Promise.resolve(true);
    // A retained callback cannot send a new session through an old bound client.
    if (state.activeSessionId !== sessionId || session.session_id !== sessionId) return Promise.resolve(false);
    if (inFlight.current?.sessionId === sessionId) return inFlight.current.promise;
    if (session.save_status === "saving") return Promise.resolve(false);
    if (session.save_status === "clean") return Promise.resolve(true);
    const id = state.activeSessionId;
    const isCurrent = (candidate = session) => {
      const current = useGraphStore.getState();
      return mounted.current && candidate.project_id === session.project_id && candidate.project_path === session.project_path
        && current.activeSessionId === candidate.session_id
        && current.activeProjectSession?.session_id === candidate.session_id
        && current.activeProjectSession.project_id === session.project_id
        && current.activeProjectSession.project_path === session.project_path;
    };
    const accept = (saved: ProjectSessionState) => {
      if (!isCurrent(saved)) {
        if (isCurrent()) throw new Error("Project save response does not match the active session");
        return false;
      }
      state.setProjectSessionState(saved);
      savedCallback.current();
      return true;
    };
    const operation = (async () => {
      state.setProjectSessionState({ ...session, save_status: "saving", save_error: null });
      try {
        const saved = await persistence.saveProjectSession(id, { expected_revision: session.saved_revision, reason });
        return accept(saved.session);
      } catch (failure) {
        let error = failure;
        if (!isCurrent()) return false;
        const code = error instanceof RuntimeApiError ? error.code
          : error && typeof error === "object" && "code" in error ? String(error.code) : null;
        if (code === "project_save_revision_stale") {
          try {
            const current = await persistence.inspectProjectSession(id);
            if (!isCurrent(current.session)) {
              if (isCurrent()) throw new Error("Project save response does not match the active session");
              return false;
            }
            if (current.session.save_status === "clean") return accept(current.session);
            // Keep the observed revision even if the single guarded retry fails.
            state.setProjectSessionState({ ...current.session, save_status: "saving", save_error: null });
            const retried = await persistence.saveProjectSession(id, {
              expected_revision: current.session.saved_revision, reason
            });
            return accept(retried.session);
          } catch (retryError) {
            error = retryError;
          }
        }
        if (isCurrent()) {
          const latest = useGraphStore.getState().activeProjectSession!;
          state.setProjectSessionState({ ...latest, save_status: "error",
            save_error: error instanceof Error ? error.message : "Project save failed" });
        }
        return false;
      }
    })();
    inFlight.current = { sessionId: id, promise: operation };
    const clear = () => {
      if (inFlight.current?.promise === operation) inFlight.current = null;
    };
    void operation.then(clear, clear);
    return operation;
  }, [persistence, sessionId]);
}

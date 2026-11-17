import { AlertTriangle, LoaderCircle, RotateCcw } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { localizeRuntimeError, tr } from "../../localization/i18n";
import { createRuntimeApiClient } from "../../runtime/apiClient";
import { useGraphStore } from "../../state/graphStore";
import { closeAcquiredSession, type ProjectEntryReleaseError } from "./projectSessionEntry";
import type { ReconnectReleaseScope } from "./projectSessionEntry";
import { createRemoteStorageClient } from "../../runtime/remoteClient";
import { createRuntimeTransport, RuntimeApiError } from "../../runtime/transport";

const ReleaseReporter = createContext<(error: ProjectEntryReleaseError) => void>(() => {});
export const useProjectEntryReleaseReporter = () => useContext(ReleaseReporter);
interface ReleaseNotice { sessionId: string; projectName: string; reason: string; reconnectScope?: ReconnectReleaseScope }

/** Lives above Start/workspace replacement; retains ownership metadata, not acquired documents. */
export function ProjectEntryReleaseProvider({ children }: { children: ReactNode }) {
  useTranslation();
  const activeId = useGraphStore((state) => state.activeSessionId);
  const client = useMemo(() => createRuntimeApiClient(), []);
  const [notices, setNotices] = useState<ReleaseNotice[]>([]);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const inFlight = useRef(new Set<string>());
  const report = useCallback((error: ProjectEntryReleaseError) => {
    const notice = { sessionId: error.sessionId, projectName: error.projectName, reason: localizeRuntimeError(error.releaseError), reconnectScope: error.reconnectScope };
    setNotices((current) => [...current.filter((item) => item.sessionId !== notice.sessionId), notice]);
  }, []);

  async function retry(notice: ReleaseNotice) {
    const id = notice.sessionId;
    // Read at dispatch time too: an old notice can outlive adoption by another entry.
    if (inFlight.current.has(id) || useGraphStore.getState().activeSessionId === id) return;
    inFlight.current.add(id);
    setPending(new Set(inFlight.current));
    try {
      if (notice.reconnectScope) {
        const scope = notice.reconnectScope;
        const recovery = createRemoteStorageClient(createRuntimeTransport({ projectSessionId: scope.sourceSessionId }));
        const wire = { protocol_version: 1 as const, project_id: scope.projectId,
          storage_generation: scope.generation, attempt_id: scope.attemptId };
        const found = await recovery.inspectRemoteReconnect(scope.sourceSessionId, wire);
        // A candidate installed by another path must not be closed by an old notice.
        if (!found.result_session_id || useGraphStore.getState().activeSessionId !== found.result_session_id) {
          const released = await recovery.abandonRemoteReconnect(scope.sourceSessionId,
            { ...wire, confirmation: "leave_remote_working_data_unchanged" });
          if (!["released", "failed"].includes(released.status)) throw new RuntimeApiError("remote_commit_unknown", "remote_commit_unknown", 503);
        }
      } else await closeAcquiredSession(client.closeProjectSession, id);
      // A later failure for the same id must not be erased by an older completion.
      setNotices((current) => current.filter((item) => item !== notice));
    } catch (error) {
      setNotices((current) => current.map((item) => item === notice ? { ...item, reason: localizeRuntimeError(error) } : item));
    } finally {
      inFlight.current.delete(id);
      setPending(new Set(inFlight.current));
    }
  }

  return <ReleaseReporter.Provider value={report}>
    {children}
    {notices.length ? <aside aria-label={tr("projects.releaseNotice")} className="fixed bottom-4 right-4 z-[10000] max-h-[40vh] w-96 max-w-[calc(100vw-2rem)] space-y-2 overflow-auto">
      {notices.map((notice) => {
        const busy = pending.has(notice.sessionId), adopted = activeId === notice.sessionId;
        return <section role="alert" className="rounded border border-amber-300 bg-white p-3 text-sm text-slate-900 shadow-lg" key={notice.sessionId}>
          <strong className="flex items-center gap-2"><AlertTriangle aria-hidden="true" size={16} />{tr("projects.releaseNotice")}</strong>
          <p className="my-2 break-words">{tr("projects.unusedSessionCloseFailed", { name: notice.projectName, reason: notice.reason })}</p>
          {adopted ? <p>{tr("projects.releaseAdopted")}</p> : null}
          <button className="flex items-center gap-2 rounded border border-slate-300 px-3 py-1.5 disabled:opacity-50" disabled={busy || adopted} onClick={() => void retry(notice)} type="button">
            {busy ? <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={15} /> : <RotateCcw aria-hidden="true" size={15} />}
            {tr(busy ? "projects.releasePending" : "projects.releaseRetry")}
          </button>
        </section>;
      })}
    </aside> : null}
  </ReleaseReporter.Provider>;
}

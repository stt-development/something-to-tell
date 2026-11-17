import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useGraphStore } from "../../state/graphStore";
import { useWorkspaceDialogCommands } from "../shell/WorkspaceDialog";
import { RemoteRecoveryContext, RemoteRecoveryAttemptActive } from "./RemoteRecoveryContext";
import { createRemoteRecoveryMonitor, type RemoteRecoveryMonitor } from "./remoteRecoveryMonitor";
import { useRemoteRecoveryActions } from "./useRemoteRecoveryActions";
import { RemoteRecoverySurface } from "./RemoteRecoverySurface";

/** Session identity, not each observation/revision, controls the canvas wrapper. */
export function RemoteRecoveryProvider({ children }: { children: ReactNode }) {
  const key = useGraphStore(state => {
    const session = state.activeProjectSession;
    return session?.remote_storage && state.activeSessionId === session.session_id
      ? `${session.session_id}/${session.project_id}/${session.remote_storage.storage_generation}` : "";
  });
  const monitor = useMemo(() => {
    const session = useGraphStore.getState().activeProjectSession;
    if (!key || !session?.remote_storage) return null;
    return createRemoteRecoveryMonitor(session.session_id, session.remote_storage, () => {
      const current = useGraphStore.getState();
      return current.activeSessionId === session.session_id && current.activeProjectId === session.project_id
        && current.activeProjectSession?.remote_storage?.storage_generation === session.remote_storage!.storage_generation;
    });
  }, [key]);
  return monitor ? <ScopedRecovery key={key} monitor={monitor}>{children}</ScopedRecovery> : <>{children}</>;
}

function ScopedRecovery({ children, monitor }: { children: ReactNode; monitor: RemoteRecoveryMonitor }) {
  const [open, setOpen] = useState(false);
  const { setDialog } = useWorkspaceDialogCommands();
  const installed = useCallback(() => { setDialog(null); setOpen(false); }, [setDialog]);
  const actions = useRemoteRecoveryActions(monitor, installed);
  const show = useCallback(() => setOpen(true), []);
  const context = useMemo(() => ({ monitor, open: show }), [monitor, show]);
  return <RemoteRecoveryContext.Provider value={context}>
    <RemoteRecoveryAttemptActive.Provider value={actions.hasAttempt || actions.operation === "begin"}>{children}</RemoteRecoveryAttemptActive.Provider>
    {open ? <RemoteRecoverySurface monitor={monitor} actions={actions} onClose={() => setOpen(false)} /> : null}
  </RemoteRecoveryContext.Provider>;
}

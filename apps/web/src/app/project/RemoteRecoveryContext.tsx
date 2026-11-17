import { createContext, useContext, useSyncExternalStore } from "react";
import { Database } from "lucide-react";
import { tr } from "../../localization/i18n";
import type { RemoteRecoveryMonitor } from "./remoteRecoveryMonitor";

export const RemoteRecoveryContext = createContext<{ monitor: RemoteRecoveryMonitor | null; open: () => void }>({ monitor: null, open: () => {} });
export const SuppressRemoteRecoveryLauncher = createContext(false);
export const RemoteRecoveryAttemptActive = createContext(false);
export const useRemoteRecovery = () => useContext(RemoteRecoveryContext);

/** Only this small consumer and the recovery window subscribe, not the canvas. */
function Launcher({ monitor, open, active }: { monitor: RemoteRecoveryMonitor; open: () => void; active: boolean }) {
  const state = useSyncExternalStore(monitor.subscribe, monitor.getSnapshot);
  return <span className="tooltip-wrapper" data-tooltip={tr("remoteRecovery.open")}>
    <button type="button" className={`icon-button relative ${active || state.blocked || state.errorCode ? "text-amber-700" : ""}`}
      aria-label={tr("remoteRecovery.open")} onClick={open}>
      <Database size={18} aria-hidden="true" />
      {active || state.blocked || state.errorCode ? <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" /> : null}
    </button>
  </span>;
}
export function RemoteRecoveryLauncher() {
  const { monitor, open } = useRemoteRecovery();
  const suppressed = useContext(SuppressRemoteRecoveryLauncher);
  const active = useContext(RemoteRecoveryAttemptActive);
  return monitor && !suppressed ? <Launcher monitor={monitor} open={open} active={active} /> : null;
}

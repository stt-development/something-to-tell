import { useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { Download, LogOut, RefreshCw, Search, Unplug, LoaderCircle } from "lucide-react";
import { localizeRuntimeError, tr } from "../../localization/i18n";
import { DialogShell } from "../shared/DialogShell";
import { SuppressRemoteRecoveryLauncher } from "./RemoteRecoveryContext";
import type { RemoteRecoveryMonitor } from "./remoteRecoveryMonitor";
import type { useRemoteRecoveryActions } from "./useRemoteRecoveryActions";

export function RemoteRecoverySurface({ monitor, actions, onClose }: {
  monitor: RemoteRecoveryMonitor; actions: ReturnType<typeof useRemoteRecoveryActions>; onClose: () => void;
}) {
  const observed = useSyncExternalStore(monitor.subscribe, monitor.getSnapshot);
  const [reloadConsent, setReloadConsent] = useState(false);
  const [releaseConsent, setReleaseConsent] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const busy = Boolean(actions.operation);
  const mutating = ["begin", "install", "close", "abandon"].includes(actions.operation ?? "");
  const pending = observed.unresolvedCommandId;
  const resolved = !pending || (actions.command?.command_id === pending && actions.command.status !== "unknown");
  const head = actions.head ?? observed.head;
  const button = "inline-flex min-h-9 items-center justify-center gap-2 rounded border border-slate-300 bg-white px-3 py-2 text-sm font-semibold disabled:opacity-50";
  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    event.stopPropagation();
    if ((event.ctrlKey || event.metaKey) && ["s", "z", "y"].includes(event.key.toLowerCase())) event.preventDefault();
    if (event.key === "Escape") { event.preventDefault(); if (!mutating) onClose(); }
    if (event.key === "Tab") {
      const controls = [...root.current!.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), [tabindex='0']")];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }
  return <SuppressRemoteRecoveryLauncher.Provider value={true}>
    <div ref={root} role="dialog" aria-modal="true" aria-label={tr("remoteRecovery.title")} className="fixed inset-0 z-[20000]" onKeyDown={keyboard}>
      <DialogShell onClose={onClose} title={tr("remoteRecovery.title")} closeDisabled={mutating}>
        <div className="space-y-4 text-sm text-slate-700">
          <p>{tr("remoteRecovery.layers")}</p>
          <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-4 gap-y-2 border-y border-slate-200 py-3">
            <dt>{tr("remoteRecovery.state")}</dt><dd className="break-words">{tr(`remoteRecovery.state.${head.state}`)}</dd>
            <dt>{tr("remoteRecovery.working")}</dt><dd className="break-all font-mono">{head.authoring_revision}</dd>
            <dt>{tr("remoteRecovery.saved")}</dt><dd className="break-all font-mono">{head.saved_authoring_revision} / {head.saved_revision}</dd>
          </dl>
          {observed.errorCode ? <p role="status" className="text-amber-800">{localizeRuntimeError({ code: observed.errorCode })}</p> : null}
          <div className="flex flex-wrap gap-2">
            <button autoFocus type="button" className={button} disabled={busy || actions.hasAttempt} onClick={() => void actions.inspect()}><Search size={16} />{tr("remoteRecovery.inspect")}</button>
            {pending ? <button type="button" className={button} disabled={busy || actions.hasAttempt} onClick={() => void actions.resolve()}><Search size={16} />{tr("remoteRecovery.resolve")}</button> : null}
          </div>
          {pending ? <p className="break-all">{tr("remoteRecovery.pending", { id: pending })} {actions.command ? tr(`remoteRecovery.command.${actions.command.status}`) : tr("remoteRecovery.command.unknown")}</p> : null}
          <label className="flex items-start gap-2"><input type="checkbox" checked={reloadConsent} disabled={busy} onChange={event => setReloadConsent(event.target.checked)} />
            <span>{tr("remoteRecovery.reloadConsent")}</span></label>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={button} disabled={busy || actions.hasAttempt || !reloadConsent || !resolved} onClick={() => void actions.begin()}><RefreshCw size={16} />{tr("remoteRecovery.reconnect")}</button>
            {actions.hasAttempt ? <>
              <button type="button" className={button} disabled={busy} onClick={() => void actions.lookup()}><Search size={16} />{tr("remoteRecovery.lookup")}</button>
              <button type="button" className={button} disabled={busy || actions.outcome?.status !== "ready" || !reloadConsent} onClick={() => void actions.install()}><Download size={16} />{tr("remoteRecovery.install")}</button>
              <button type="button" className={button} disabled={busy} onClick={() => void actions.cancelAttempt()}><Unplug size={16} />{tr("remoteRecovery.abandon")}</button>
            </> : null}
          </div>
          {actions.outcome ? <p role="status">{tr(`remoteRecovery.attempt.${actions.outcome.status}`)}</p> : actions.hasAttempt ? <p role="status">{tr("remoteRecovery.attempt.unknown")}</p> : null}
          {actions.outcome?.error_code ? <p role="alert" className="text-red-700">{localizeRuntimeError({ code: actions.outcome.error_code })}</p> : null}
          <div className="space-y-3 border-t border-slate-200 pt-3">
            <label className="flex items-start gap-2"><input type="checkbox" checked={releaseConsent} disabled={busy} onChange={event => setReleaseConsent(event.target.checked)} />
              <span>{tr("remoteRecovery.releaseConsent")}</span></label>
            <button type="button" className={button} disabled={busy || !releaseConsent} onClick={() => void actions.close()}><LogOut size={16} />{tr("remoteRecovery.close")}</button>
          </div>
          {busy ? <p role="status" className="flex items-center gap-2"><LoaderCircle size={16} className="animate-spin" />{tr("remoteRecovery.progress")}</p> : null}
          {actions.error ? <p role="alert" className="break-words text-red-700">{localizeRuntimeError(actions.error)}</p> : null}
        </div>
      </DialogShell>
    </div>
  </SuppressRemoteRecoveryLauncher.Provider>;
}

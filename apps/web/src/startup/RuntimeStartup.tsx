/** Entry-level readiness and terminal crash fence; project/draft state stays mounted. */
import { CircleAlert, LoaderCircle, RotateCw, LogOut } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentType } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { tr } from "../localization/i18n";
import { bundledRuntimeIsRunning, connectRuntime, type RuntimeMode } from "../runtime/runtimeBootstrap";
import { markRuntimeUnavailable } from "../runtime/runtimeConnection";
import { requestNativeProjectClose, resolveNativeClose, useNativeCloseRequests } from "../runtime/nativeClose";

type Phase = "starting" | "failed" | "ready" | "lost";
interface Props {
  loadApplication: () => Promise<{ App: ComponentType }>;
  connect?: () => Promise<RuntimeMode>;
  isRunning?: () => Promise<boolean>;
  pollInterval?: number;
}

export function RuntimeStartup({ loadApplication, connect = connectRuntime,
  isRunning = bundledRuntimeIsRunning, pollInterval = 1000 }: Props) {
  useTranslation();
  const [phase, setPhase] = useState<Phase>("starting");
  const phaseRef = useRef<Phase>("starting");
  const [Application, setApplication] = useState<ComponentType | null>(null);
  const [mode, setMode] = useState<RuntimeMode | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [closeRequest, setCloseRequest] = useState<number | null>(null);
  const [closeError, setCloseError] = useState(false);
  const [closing, setClosing] = useState(false);
  const pending = useRef<Promise<{ App: ComponentType; mode: RuntimeMode }> | null>(null);
  const lostDialog = useRef<HTMLDialogElement>(null);
  const transition = useCallback((next: Phase) => { phaseRef.current = next; setPhase(next); }, []);

  useNativeCloseRequests(async id => {
    if (phaseRef.current === "lost") setCloseError(false);
    else await requestNativeProjectClose(id);
  }, 250, setCloseRequest);

  async function resolveLostClose(approve: boolean) {
    if (closeRequest === null || closing) return;
    setClosing(true); setCloseError(false);
    try { await resolveNativeClose(closeRequest, approve); setCloseRequest(null); }
    catch { setCloseError(true); }
    finally { setClosing(false); }
  }

  useEffect(() => {
    // Register before application shortcuts mount, including Help's capture guard.
    function fenceKeys(event: KeyboardEvent) {
      if (phaseRef.current !== "lost") return;
      event.stopImmediatePropagation();
      if (!(event.target instanceof Node) || !lostDialog.current?.contains(event.target)) {
        event.preventDefault(); lostDialog.current?.focus();
      }
    }
    window.addEventListener("keydown", fenceKeys, true);
    return () => window.removeEventListener("keydown", fenceKeys, true);
  }, []);

  useEffect(() => {
    let current = true;
    // StrictMode's effect replay shares one start/import operation, not two children.
    pending.current ??= connect().then(async mode => ({ ...(await loadApplication()), mode }));
    void pending.current.then(result => {
      if (!current) return;
      setApplication(() => result.App); setMode(result.mode); transition("ready");
    }).catch(() => { if (current) transition("failed"); });
    return () => { current = false; };
  }, [attempt, connect, loadApplication, transition]);

  useEffect(() => {
    if (mode !== "bundled" || phase !== "ready") return;
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function inspect() {
      try {
        if (!(await isRunning())) throw new Error("unavailable");
        if (current) timer = setTimeout(() => void inspect(), pollInterval);
      } catch {
        if (!current) return;
        markRuntimeUnavailable(); transition("lost");
      }
    }
    timer = setTimeout(() => void inspect(), pollInterval);
    return () => { current = false; clearTimeout(timer); };
  }, [mode, phase, isRunning, pollInterval, transition]);

  useLayoutEffect(() => {
    if (phase !== "lost" || !lostDialog.current) return;
    // Native top layer covers all editor/tooltip portals, not just the app root.
    lostDialog.current.showModal();
    lostDialog.current.focus();
  }, [phase]);

  function retry() {
    if (phaseRef.current !== "failed") return;
    transition("starting"); pending.current = null; setAttempt(value => value + 1);
  }

  return <>
    {Application ? <Application /> : <main className="runtime-startup" aria-busy={phase === "starting"}>
      <section className="runtime-startup-content">
        <h1><img src="/app-icon.svg" alt="" />{tr("app.name")}</h1>
        {phase === "starting" ? <>
          <p role="status"><LoaderCircle size={17} className="runtime-loading-icon" aria-hidden="true" />{tr("runtime.starting")}</p>
          <progress aria-label={tr("runtime.starting")} />
        </> : <div role="alert">
          <p><CircleAlert size={18} aria-hidden="true" />{tr("runtime.startFailed")}</p>
          <button className="runtime-retry" type="button" onClick={retry}><RotateCw size={16} aria-hidden="true" />{tr("runtime.retry")}</button>
        </div>}
      </section>
    </main>}
    {phase === "lost" ? createPortal(<dialog ref={lostDialog} className="runtime-lost" tabIndex={-1}
      role="alertdialog" aria-modal="true" aria-labelledby="runtime-lost-title"
      onCancel={event => event.preventDefault()}>
      <section className="runtime-startup-content">
        <h1><img src="/app-icon.svg" alt="" />{tr("app.name")}</h1>
        <h2 id="runtime-lost-title"><CircleAlert size={18} aria-hidden="true" />{tr("runtime.lost")}</h2>
        <p>{tr("runtime.lostDetails")}</p>
        {closeRequest !== null ? <>
          <p>{tr("runtime.closeWithoutSave")}</p>
          {closeError ? <p role="alert">{tr("runtime.closeFailed")}</p> : null}
          <div className="flex gap-2">
            <button type="button" className="runtime-retry" disabled={closing} onClick={() => void resolveLostClose(false)}>{tr("common.cancel")}</button>
            <button type="button" className="runtime-retry" disabled={closing} onClick={() => void resolveLostClose(true)}><LogOut size={16} aria-hidden="true" />{tr("runtime.closeApplication")}</button>
          </div>
        </> : null}
      </section>
    </dialog>, document.body) : null}
  </>;
}

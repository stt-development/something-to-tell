/** Owns one transient Help overlay per visible shell, without project dependencies. */
import { BookOpen, CircleHelp, X } from "lucide-react";
import { useEffect, useRef, useState, type ComponentType, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { tr } from "../localization/i18n";
import "./help.css";

export function HelpLauncher({ link = false }: { link?: boolean }) {
  useTranslation();
  const [open, setOpen] = useState(false);
  const [Workspace, setWorkspace] = useState<ComponentType | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const launcher = useRef<HTMLButtonElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open || Workspace) return;
    let current = true;
    setFailed(false);
    void import("./HelpWorkspace").then(module => {
      if (current) setWorkspace(() => module.HelpWorkspace);
    }).catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [open, Workspace, attempt]);

  useEffect(() => {
    if (!open) return;
    // Inert is restored exactly, so existing editors/drafts stay mounted behind Help.
    const siblings = [...document.body.children].filter(node => node !== overlay.current);
    const states = siblings.map(node => [node, node.hasAttribute("inert")] as const);
    for (const [node] of states) node.setAttribute("inert", "");
    close.current?.focus();
    // Removing a selected topic can briefly leave focus on body; graph shortcuts
    // must remain blocked even before the new article receives focus.
    function guardBackgroundKeys(event: globalThis.KeyboardEvent) {
      if (event.target instanceof Node && overlay.current?.contains(event.target)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.key === "Escape") setOpen(false);
      else close.current?.focus();
    }
    window.addEventListener("keydown", guardBackgroundKeys, true);
    return () => {
      window.removeEventListener("keydown", guardBackgroundKeys, true);
      for (const [node, wasInert] of states) if (!wasInert) node.removeAttribute("inert");
      launcher.current?.focus();
    };
  }, [open]);

  function handleKeys(event: KeyboardEvent<HTMLDivElement>) {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
    if (event.key !== "Tab") return;
    const items = [...(overlay.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),[tabindex="0"]'
    ) ?? [])];
    const first = items[0], last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }

  return <>
    <span className={link ? "help-start-entry" : "tooltip-wrapper"} data-tooltip={link ? undefined : tr("help.open")}>
      <button ref={launcher} type="button" className={link ? "help-start-link" : "icon-button"}
        aria-label={tr("help.open")} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        {link ? <BookOpen size={17} aria-hidden="true" /> : <CircleHelp size={18} aria-hidden="true" />}
        {link ? tr("help.title") : null}
      </button>
    </span>
    {open ? createPortal(<div ref={overlay} className="help-backdrop" onKeyDown={handleKeys}
      onPointerDown={event => event.stopPropagation()}>
      <section className="help-dialog" role="dialog" aria-modal="true" aria-labelledby="help-dialog-title">
        <header className="help-dialog-header">
          <h2 id="help-dialog-title"><BookOpen size={18} aria-hidden="true" />{tr("help.title")}</h2>
          <button className="icon-button" ref={close} type="button" aria-label={tr("help.close")} onClick={() => setOpen(false)}><X size={18} aria-hidden="true" /></button>
        </header>
        {Workspace ? <Workspace /> : failed ? <div className="help-feedback" role="alert">
          <p>{tr("help.unavailable")}</p><button type="button" onClick={() => setAttempt(value => value + 1)}>{tr("help.retry")}</button>
        </div> : <p className="help-feedback" role="status">{tr("help.loading")}</p>}
      </section>
    </div>, document.body) : null}
  </>;
}

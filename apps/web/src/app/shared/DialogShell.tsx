import {
X
} from "lucide-react";
import { useEffect,useRef,type CSSProperties,type ReactNode } from "react";
import { CanonIssueActionsForId } from "../../canon/CanonIssueActions";
import {
localizeRuntimeText,
tr
} from "../../localization/i18n";
import {
type NarrativeIssue
} from "../../types";

import { ISSUE_COLORS } from "../workspaceShared";
import { RemoteRecoveryLauncher } from "../project/RemoteRecoveryContext";

export function DialogShell({ children, onClose, title, wide = false, hidden = false, closeDisabled = false }: { children: ReactNode; onClose: () => void; title: string; wide?: boolean; hidden?: boolean; closeDisabled?: boolean }) {
  // Capture the launcher before descendant autoFocus runs during the commit.
  const returnFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  );
  useEffect(() => {
    return () => returnFocusRef.current?.focus();
  }, []);
  return (
    <div hidden={hidden} className={`fixed inset-0 z-50 ${hidden ? "hidden" : "flex"} items-center justify-center bg-slate-950/20 p-6`}>
      <section className={`max-h-[calc(100vh-3rem)] w-full overflow-y-auto rounded-md border border-slate-200 bg-white p-5 shadow-xl ${wide ? "max-w-6xl" : "max-w-2xl"}`}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <div className="flex shrink-0 items-center gap-2"><RemoteRecoveryLauncher />
          <button aria-label={tr("common.closeDialog")} className="icon-button" disabled={closeDisabled} onClick={onClose} title={tr("common.closeDialog")} type="button">
            <X size={18} aria-hidden="true" />
          </button>
          </div>
        </div>
        {children}
      </section>
    </div>
  );
}

export function IssueDetailsList({ issues }: { issues: NarrativeIssue[] }) {
  if (issues.length === 0) {
    return null;
  }

  return (
    <section className="issue-details" aria-label={tr("authoring.issueDetails")}>
      <div className="mb-2 text-sm font-semibold text-slate-800">{tr("dialogue.issues")}</div>
      <div className="space-y-2">
        {issues.map((issue) => (
          <article className="issue-detail-row" key={issue.id} style={{ "--issue-color": ISSUE_COLORS[issue.severity] } as CSSProperties}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="issue-severity-pill">{tr(`filters.${issue.severity === "critical" ? "critical" : issue.severity}` as "filters.critical")}</span>
              <span className="rounded border border-slate-200 bg-white px-2 py-0.5 text-xs font-semibold text-slate-500">{tr(`filters.${issue.status}` as "filters.open")}</span>
            </div>
            <div className="mt-2 text-sm font-semibold text-slate-800">{localizeRuntimeText(issue.title, issue.titleParameters)}</div>
            <p className="mt-1 text-sm leading-5 text-slate-600">{localizeRuntimeText(issue.description, issue.descriptionParameters)}</p>
            <CanonIssueActionsForId issueId={issue.id} />
          </article>
        ))}
      </div>
    </section>
  );
}

export function LabeledInput({ label, onChange, value }: { label: string; onChange: (value: string) => void; value: string }) {
  return (
    <label className="block text-sm font-semibold text-slate-700">
      {label}
      <input className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" onChange={(event) => onChange(event.target.value)} value={value} />
    </label>
  );
}

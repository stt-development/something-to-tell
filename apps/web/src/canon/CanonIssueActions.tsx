import type { CanonIssueProjection, CanonIssueStatus, CanonOwnerRef } from "@something-to-tell/contracts/canon-check";
import { Ban, Bot, Check, ExternalLink, Lightbulb, RotateCcw } from "lucide-react";
import { createContext, type ReactNode, useContext } from "react";
import { localizeRuntimeText, tr } from "../localization/i18n";

export interface CanonIssueActionController {
  busy: boolean;
  error: string | null;
  issues: CanonIssueProjection[];
  notice: string | null;
  onNavigate: (owner: CanonOwnerRef, issue: CanonIssueProjection) => void;
  onRepair: (issue: CanonIssueProjection) => void;
  onReview: (issueId: string, status: "open" | "review" | "ignored") => void;
}

const CanonIssueActionContext = createContext<CanonIssueActionController | null>(null);

/** Shares the runtime-owned Issue projection with every authoring surface. */
export function CanonIssueActionProvider({ children, value }: { children: ReactNode; value: CanonIssueActionController }) {
  return <CanonIssueActionContext.Provider value={value}>{children}</CanonIssueActionContext.Provider>;
}

/** Renders actions for a durable Issue when it has a Canon projection. */
export function CanonIssueActionsForId({ issueId }: { issueId: string }) {
  const controller = useContext(CanonIssueActionContext);
  const issue = controller?.issues.find((candidate) => candidate.id === issueId);
  if (!controller || !issue) return null;
  return (
    <CanonIssueActions
      busy={controller.busy}
      issue={issue}
      onNavigate={(owner) => controller.onNavigate(owner, issue)}
      onRepair={() => controller.onRepair(issue)}
      onReview={(status) => controller.onReview(issue.id, status)}
    />
  );
}

/** Expands the selected diagnostic in place without requiring the Canon workspace. */
export function CanonIssueInlineDetail({ issue }: { issue: CanonIssueProjection }) {
  const controller = useContext(CanonIssueActionContext);
  if (!controller) return null;
  const message = localizeRuntimeText(issue.metadata.message_key, issue.metadata.message_parameters, issue.title);
  const recommendation = issue.metadata.recommendation_key
    ? localizeRuntimeText(issue.metadata.recommendation_key, issue.metadata.recommendation_parameters, issue.description)
    : tr("canon.noRecommendation");
  return (
    <div className="canon-inline-detail">
      <strong>{message}</strong>
      <p>{recommendation}</p>
      <CanonIssueActionsForId issueId={issue.id} />
      {controller.error ? <p className="canon-inline-error" role="alert">{controller.error}</p> : null}
      {controller.notice ? <p className="canon-inline-notice" role="status">{controller.notice}</p> : null}
    </div>
  );
}

/** Uses only the capability advertised by runtime; callers never infer repair support. */
export function CanonIssueActions({
  busy,
  issue,
  onNavigate,
  onRepair,
  onReview
}: {
  busy: boolean;
  issue: CanonIssueProjection;
  onNavigate: (owner: CanonOwnerRef) => void;
  onRepair: () => void;
  onReview: (status: "open" | "review" | "ignored") => void;
}) {
  const repair = issue.repair;
  const reason = repair.unavailable_reason ? localizeRuntimeText(repair.unavailable_reason) : null;
  const primaryTarget = issue.metadata.targets[0];
  const repairConfig = repair.action === "request_fix"
    ? { Icon: Lightbulb, label: tr("canon.requestSuggestion") }
    : repair.action === "explore_solutions"
      ? { Icon: Bot, label: tr("canon.exploreSolutions") }
      : repair.action === "open_source"
        ? { Icon: ExternalLink, label: tr("canon.openSource") }
        : null;

  return (
    <div aria-label={tr("canon.reviewActions")} className="canon-inline-actions">
      <span className="canon-inline-status">{canonIssueStatus(issue.status)}</span>
      {issue.status !== "review" ? <ActionButton busy={busy} Icon={Check} label={tr("canon.acknowledge")} onClick={() => onReview("review")} /> : null}
      {issue.status !== "ignored" ? <ActionButton busy={busy} Icon={Ban} label={tr("canon.ignore")} onClick={() => onReview("ignored")} /> : null}
      {issue.status !== "open" ? <ActionButton busy={busy} Icon={RotateCcw} label={tr("canon.reopen")} onClick={() => onReview("open")} /> : null}
      {repairConfig ? (
        <ActionButton
          busy={busy || !repair.available || (repair.action === "open_source" && !primaryTarget)}
          Icon={repairConfig.Icon}
          label={repairConfig.label}
          onClick={() => repair.action === "open_source" && primaryTarget ? onNavigate(primaryTarget) : onRepair()}
          tooltip={reason ?? repairConfig.label}
          impactOrigin={repair.action === "explore_solutions" ? `canon-issue:${issue.id}` : undefined}
        />
      ) : reason ? <span className="canon-repair-unavailable">{reason}</span> : null}
    </div>
  );
}

function ActionButton({ busy, Icon, impactOrigin, label, onClick, tooltip = label }: {
  busy: boolean;
  Icon: typeof Check;
  impactOrigin?: string;
  label: string;
  onClick: () => void;
  tooltip?: string;
}) {
  return (
    <span className="tooltip-wrapper tooltip-top" data-tooltip={tooltip}>
      <button data-impact-origin={impactOrigin} disabled={busy} onClick={onClick} type="button"><Icon size={14} aria-hidden="true" />{label}</button>
    </span>
  );
}

function canonIssueStatus(status: CanonIssueStatus) {
  return tr(`canon.issueStatus.${status}` as "canon.issueStatus.open");
}

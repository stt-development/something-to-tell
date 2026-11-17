import type { CanonIssueProjection, CanonOwnerRef } from "@something-to-tell/contracts/canon-check";
import { ShieldAlert } from "lucide-react";
import { localizeRuntimeText, tr } from "../localization/i18n";
import { CanonIssueInlineDetail } from "./CanonIssueActions";

export interface CanonDiagnosticFocus {
  issue: CanonIssueProjection;
  owner: CanonOwnerRef;
}

/** Matches the exact selected owner rather than every record in its parent editor. */
export function canonFocusMatches(focus: CanonDiagnosticFocus | null, ownerId: string): boolean {
  return focus?.owner.owner_id === ownerId;
}

/** Compact marker exposes full localized diagnostic detail to hover and keyboard users. */
export function CanonDiagnosticMarker({ focus }: { focus: CanonDiagnosticFocus }) {
  const message = localizeRuntimeText(
    focus.issue.metadata.message_key,
    focus.issue.metadata.message_parameters,
    focus.issue.title
  );
  const recommendation = focus.issue.metadata.recommendation_key
    ? localizeRuntimeText(
        focus.issue.metadata.recommendation_key,
        focus.issue.metadata.recommendation_parameters,
        focus.issue.description
      )
    : tr("canon.noRecommendation");
  const detail = `${message} ${recommendation}`;
  return (
    <details className="canon-owner-diagnostic-control">
      <summary aria-label={detail} className="canon-owner-diagnostic-marker tooltip-wrapper tooltip-top" data-severity={focus.issue.severity} data-tooltip={detail}>
        <span aria-label={detail} role="status" tabIndex={0}><ShieldAlert size={12} aria-hidden="true" />{tr("dialogue.canonIssue")}</span>
      </summary>
      <CanonIssueInlineDetail issue={focus.issue} />
    </details>
  );
}

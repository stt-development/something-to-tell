import type { StyleRewriteRunV1 } from "@something-to-tell/contracts/style-rewrite";
import { AlertTriangle, Check, RefreshCcw, X } from "lucide-react";
import { useState } from "react";
import { localizeRuntimeText, tr } from "../../localization/i18n";

type ReviewTab = "before" | "after" | "changes";

/** Presents provider prose and validated diff without interpreting or mutating it. */
export function StyleRecommendationReview({
  approving,
  onApprove,
  onReject,
  onRequestAgain,
  onSelectVersion,
  run,
  retryDisabled,
  versions
}: {
  approving: boolean;
  onApprove: () => void;
  onReject: () => void;
  onRequestAgain: () => void;
  onSelectVersion: (runId: string) => void;
  run: StyleRewriteRunV1;
  retryDisabled: boolean;
  versions: StyleRewriteRunV1[];
}) {
  const [tab, setTab] = useState<ReviewTab>("changes");
  const recommendation = run.recommendation;
  if (!recommendation) return null;
  const blocked = recommendation.validation_status !== "valid" || recommendation.patch === null;

  return (
    <section className="style-recommendation-review" aria-label={tr("style.reviewTitle")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold text-slate-900">{tr("style.reviewTitle")}</h4>
          <p className="text-xs text-slate-500">{run.style_profile_name}</p>
        </div>
        <label className="style-version-select">
          <span>{tr("style.version")}</span>
          <select onChange={(event) => onSelectVersion(event.target.value)} value={run.id}>
            {versions.map((version, index) => (
              <option key={version.id} value={version.id}>{tr("style.versionNumber", { count: index + 1 })} · {version.style_profile_name}</option>
            ))}
          </select>
        </label>
      </div>

      <dl className="style-review-metadata">
        <dt>{tr("style.detailsUsed")}</dt>
        <dd>{run.request.additional_instructions || tr("common.none")}</dd>
        <dt>{tr("style.explanation")}</dt>
        <dd>{recommendation.explanation}</dd>
        <dt>{tr("style.appliedTraits")}</dt>
        <dd>{recommendation.applied_traits.join(", ") || tr("common.none")}</dd>
        <dt>{tr("style.providerAndModel")}</dt>
        <dd>{recommendation.provider_disclosure.provider} · {recommendation.provider_disclosure.model_id}</dd>
        <dt>{tr("style.generatedLanguage")}</dt>
        <dd>{recommendation.provider_disclosure.content_locale === "ru" ? tr("locale.russian") : tr("locale.english")}</dd>
      </dl>

      <div className="style-review-tabs" role="tablist" aria-label={tr("style.textComparison")}>
        {(["before", "after", "changes"] as const).map((candidate) => (
          <button
            aria-selected={tab === candidate}
            className={tab === candidate ? "active" : ""}
            key={candidate}
            onClick={() => setTab(candidate)}
            role="tab"
            type="button"
          >{tr(`style.${candidate}`)}</button>
        ))}
      </div>
      <div className="style-review-text" role="tabpanel">
        {tab === "before" ? recommendation.source_text : null}
        {tab === "after" ? recommendation.rewritten_text : null}
        {tab === "changes" ? recommendation.diff.map((part, index) => (
          <span className={`style-diff-${part.kind}`} key={`${part.kind}-${index}`}>{part.text}</span>
        )) : null}
      </div>

      <FactualReview run={run} />

      <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-slate-200 pt-3">
        <button className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold" disabled={approving} onClick={onReject} type="button">
          <X size={15} aria-hidden="true" />{tr("common.reject")}
        </button>
        <button className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold disabled:opacity-50" disabled={approving || retryDisabled} onClick={onRequestAgain} type="button">
          <RefreshCcw size={15} aria-hidden="true" />{tr("style.requestAgain")}
        </button>
        <button className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={approving || blocked} onClick={onApprove} type="button">
          <Check size={15} aria-hidden="true" />{approving ? tr("style.approving") : tr("style.approve")}
        </button>
      </div>
      {blocked ? <p className="mt-2 text-right text-xs font-medium text-red-700">{tr("style.approvalBlocked")}</p> : null}
    </section>
  );
}

/** Collapses all provider and deterministic factual signals into one author check. */
function FactualReview({ run }: { run: StyleRewriteRunV1 }) {
  const recommendation = run.recommendation;
  if (!recommendation) return null;
  const missingProtected = recommendation.protected_value_results.filter((result) => !result.preserved);
  const diagnostics = recommendation.validation_diagnostics;
  const hasWarnings = recommendation.factual_risks.length > 0 || missingProtected.length > 0 || diagnostics.length > 0;
  return (
    <section className={`style-factual-review ${hasWarnings ? "warning" : "safe"}`}>
      <div className="flex items-center gap-2">
        {hasWarnings ? <AlertTriangle size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
        <h5>{hasWarnings ? tr("style.factualReviewRequired") : tr("style.noFactualRisks")}</h5>
      </div>
      {recommendation.factual_risks.length ? <ul>{recommendation.factual_risks.map((risk) => <li key={risk}>{risk}</li>)}</ul> : null}
      {missingProtected.length ? <ul>{missingProtected.map((result) => <li key={`${result.kind}-${result.value}`}>{tr("style.protectedValueChanged", { value: result.value })}</li>)}</ul> : null}
      {diagnostics.length ? <ul>{diagnostics.map((diagnostic) => (
        <li key={diagnostic.code}>{localizeRuntimeText(diagnostic.message_key, diagnostic.parameters)}</li>
      ))}</ul> : null}
    </section>
  );
}

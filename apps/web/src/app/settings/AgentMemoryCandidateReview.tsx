/** Reviewed process-local Agent Memory candidate workflow. */

import type {
  AgentMemoryAgentId,
  AgentMemoryCandidateRunV1,
  AgentMemoryLocale,
  AgentMemoryScopeV1
} from "@something-to-tell/contracts/agent-memory";
import { Bot, Check, RotateCcw, Send, X } from "lucide-react";
import { useEffect, useState } from "react";
import { localizeRuntimeError, tr } from "../../localization/i18n";
import type { RuntimeAgentMemoryPersistence } from "../../runtime/apiTypes";

interface CandidateIdentity {
  agent_id: AgentMemoryAgentId;
  content_locale: AgentMemoryLocale;
  scope: AgentMemoryScopeV1;
}

/** Keeps provider output process-local until the author accepts one exact candidate. */
export function AgentMemoryCandidateReview({
  activeSessionId,
  historyRevision,
  identity,
  onAccepted,
  onClose,
  persistence,
  projectId,
  sourceChecksum,
  supersedesId
}: {
  activeSessionId: string;
  historyRevision: number;
  identity: CandidateIdentity;
  onAccepted: () => Promise<void>;
  onClose: () => void;
  persistence: RuntimeAgentMemoryPersistence;
  projectId: string;
  sourceChecksum: string;
  supersedesId: string | null;
}) {
  const [guidance, setGuidance] = useState("");
  const [consent, setConsent] = useState(false);
  const [run, setRun] = useState<AgentMemoryCandidateRunV1 | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = run?.status === "queued" || run?.status === "running";

  useEffect(() => {
    if (!active || !run) return;
    const timer = window.setInterval(() => {
      void persistence.inspectAgentMemoryCandidate(activeSessionId, run.id)
        .then(setRun)
        .catch((caught) => setError(localizeRuntimeError(caught)));
    }, 250);
    return () => window.clearInterval(timer);
  }, [active, activeSessionId, persistence, run?.id]);

  async function start() {
    if (!guidance.trim() || !consent) return;
    await perform(async () => persistence.startAgentMemoryCandidate({
      request_version: 1,
      session_id: activeSessionId,
      project_id: projectId,
      agent_id: identity.agent_id,
      namespace: identity.agent_id,
      scope: identity.scope,
      content_locale: identity.content_locale,
      observed_source_checksum: sourceChecksum,
      expected_history_revision: historyRevision,
      guidance_request: guidance.trim(),
      content_consent: true
    }));
  }

  async function retry() {
    if (!run || !guidance.trim() || !consent) return;
    await perform(async () => persistence.retryAgentMemoryCandidate(
      activeSessionId,
      run.id,
      {
        retry_version: 1,
        observed_source_checksum: sourceChecksum,
        expected_history_revision: historyRevision,
        guidance_request: guidance.trim(),
        content_consent: true
      }
    ));
  }

  async function reject() {
    if (!run?.candidate) return;
    await perform(async () => persistence.rejectAgentMemoryCandidate(
      activeSessionId,
      run.id,
      {
        review_version: 1,
        candidate_id: run.candidate!.id,
        semantic_fingerprint: run.candidate!.semantic_fingerprint
      }
    ));
  }

  async function accept() {
    if (!run?.candidate) return;
    const candidate = run.candidate;
    setBusy(true);
    setError(null);
    try {
      const response = await persistence.acceptAgentMemoryCandidate(
        activeSessionId,
        run.id,
        {
          acceptance_version: 1,
          candidate_id: candidate.id,
          project_id: candidate.project_id,
          agent_id: candidate.agent_id,
          namespace: candidate.namespace,
          scope: candidate.scope,
          content_locale: candidate.content_locale,
          source_checksum: candidate.source_checksum,
          expected_history_revision: candidate.history_revision,
          semantic_fingerprint: candidate.semantic_fingerprint,
          supersedes_id: supersedesId
        }
      );
      setRun(response.run);
      await onAccepted();
    } catch (caught) {
      setError(localizeRuntimeError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!run) return;
    await perform(async () => persistence.cancelAgentMemoryCandidate(
      activeSessionId,
      run.id
    ));
  }

  async function perform(operation: () => Promise<AgentMemoryCandidateRunV1>) {
    setBusy(true);
    setError(null);
    try {
      setRun(await operation());
    } catch (caught) {
      setError(localizeRuntimeError(caught));
    } finally {
      setBusy(false);
    }
  }

  const retryable = run && ["completed", "failed", "cancelled", "stale", "rejected"].includes(run.status);
  return (
    <section aria-label={tr("agentMemory.candidateReview")} className="mt-3 space-y-3 border-t border-slate-200 pt-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="flex items-center gap-2 text-sm font-semibold text-slate-800"><Bot aria-hidden="true" size={16} />{tr("agentMemory.candidateReview")}</h4>
          <p className="text-xs text-slate-500">{tr("agentMemory.candidateDescription")}</p>
        </div>
        <button aria-label={tr("common.close")} className="icon-button" data-tooltip={tr("common.close")} onClick={onClose} type="button"><X aria-hidden="true" size={15} /></button>
      </div>
      <dl className="grid grid-cols-[7rem_1fr] gap-x-2 gap-y-1 text-xs">
        <dt className="font-semibold text-slate-500">{tr("agentMemory.agentLabel")}</dt>
        <dd>{tr(`agentMemory.agent.${identity.agent_id}`)}</dd>
        <dt className="font-semibold text-slate-500">{tr("agentMemory.scopeLabel")}</dt>
        <dd>{tr(`agentMemory.scope.${identity.scope.kind}`)}</dd>
        <dt className="font-semibold text-slate-500">{tr("agentMemory.locale")}</dt>
        <dd>{tr(`agentMemory.value.${identity.content_locale}`)}</dd>
      </dl>
      <label className="style-profile-field">{tr("agentMemory.guidanceRequest")}
        <textarea autoFocus className="min-h-20" disabled={active || busy} maxLength={1000} onChange={(event) => setGuidance(event.target.value)} value={guidance} />
      </label>
      <label className="flex items-start gap-2 text-xs text-slate-700">
        <input checked={consent} disabled={active || busy} onChange={(event) => setConsent(event.target.checked)} type="checkbox" />
        <span>{tr("agentMemory.candidateConsent")}</span>
      </label>
      {run ? <CandidateRunPresentation run={run} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        {!run ? <button className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={busy || !consent || !guidance.trim()} onClick={() => void start()} type="button"><Send aria-hidden="true" size={15} />{tr("agentMemory.requestCandidate")}</button> : null}
        {active ? <button className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold" disabled={busy} onClick={() => void cancel()} type="button">{tr("common.cancel")}</button> : null}
        {run?.status === "completed" ? <>
          <button className="inline-flex items-center gap-2 rounded-md bg-emerald-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={busy} onClick={() => void accept()} type="button"><Check aria-hidden="true" size={15} />{tr("common.accept")}</button>
          <button className="rounded-md border border-red-300 bg-white px-3 py-2 text-sm font-semibold text-red-700 disabled:opacity-50" disabled={busy} onClick={() => void reject()} type="button">{tr("common.reject")}</button>
        </> : null}
        {retryable ? <button className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold disabled:opacity-50" disabled={busy || !consent || !guidance.trim()} onClick={() => void retry()} type="button"><RotateCcw aria-hidden="true" size={15} />{tr("agentMemory.retryCandidate")}</button> : null}
      </div>
      {busy || active ? <p aria-live="polite" className="text-xs text-slate-500">{tr("agentMemory.candidateWorking")}</p> : null}
      {error ? <p className="text-sm text-red-700" role="alert">{error}</p> : null}
    </section>
  );
}

function CandidateRunPresentation({ run }: { run: AgentMemoryCandidateRunV1 }) {
  const candidate = run.candidate;
  return (
    <div className="space-y-2 text-sm" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <strong>{tr(`agentMemory.candidateStatus.${run.status}`)}</strong>
        <span>{run.progress}%</span>
        {run.provider_disclosure ? <span>{run.provider_disclosure.provider} · {run.provider_disclosure.model_id}</span> : null}
      </div>
      {candidate ? <div className="space-y-2 border-l-2 border-sky-300 pl-3">
        <strong className="block text-slate-800">{candidate.title}</strong>
        <p className="whitespace-pre-wrap text-slate-700">{candidate.instruction}</p>
        {candidate.rationale ? <p className="whitespace-pre-wrap text-xs text-slate-500">{candidate.rationale}</p> : null}
      </div> : null}
      {run.error_code ? <p className="text-sm text-red-700" role="alert">{localizeRuntimeError({ code: run.error_code })}</p> : null}
    </div>
  );
}

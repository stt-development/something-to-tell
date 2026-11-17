import type {
  EffectiveStyleResolutionV1,
  StyleContextRefV1
} from "@something-to-tell/contracts/style-system";
import type {
  StyleRewriteRunV1,
  StyleRewriteTargetV1
} from "@something-to-tell/contracts/style-rewrite";
import type { AgentMemoryScopeV1 } from "@something-to-tell/contracts/agent-memory";
import { Bot, LoaderCircle, Send, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { localizeRuntimeError, tr } from "../../localization/i18n";
import type { RuntimeApiClient } from "../../runtime/apiClient";
import type { RuntimeStyleRewriteApprovalResponse } from "../../runtime/apiTypes";
import { StyleRecommendationReview } from "./StyleRecommendationReview";
import {
  AgentMemoryDisclosure,
  type AgentMemoryDraftSeed
} from "../../components/AgentMemoryDisclosure";

export interface StyleRecommendationLaunch {
  actionId: string;
  label: string;
  nodeId: string;
  placementId: string | null;
  sourceText: string;
  target: StyleRewriteTargetV1;
}

export interface StyleRecommendationRuntimeContext {
  contentLocale?: "en" | "ru";
  onApproved: (response: RuntimeStyleRewriteApprovalResponse) => Promise<void> | void;
  persistence: RuntimeApiClient;
  providerConfigured: boolean;
  sessionId: string;
  onCreateMemory?: (seed: AgentMemoryDraftSeed) => void;
  onManageMemory?: () => void;
}

/** Uses the same bot action for common node Text and exact Dialogue fields. */
export function StyleRecommendationAction({
  disabled = false,
  launch,
  onLaunch
}: {
  disabled?: boolean;
  launch: StyleRecommendationLaunch;
  onLaunch: (launch: StyleRecommendationLaunch) => void;
}) {
  const tooltip = disabled ? tr("style.saveBeforeRecommendation") : tr("style.getRecommendation");
  return (
    <button
      aria-label={`${tr("style.getRecommendation")}: ${launch.label}`}
      className="style-recommendation-action"
      data-style-action-id={launch.actionId}
      data-tooltip={tooltip}
      disabled={disabled}
      onClick={() => onLaunch(launch)}
      type="button"
    >
      <Bot size={15} aria-hidden="true" />
    </button>
  );
}

/** Owns resolution, consent, dispatch, polling, and cancellation without mutating Text. */
export function StyleRecommendationRequest({
  contentLocale = "en",
  launch,
  onApproved,
  onClose,
  onCreateMemory,
  onManageMemory,
  persistence,
  providerConfigured,
  sessionId
}: {
  contentLocale?: "en" | "ru";
  launch: StyleRecommendationLaunch;
  onApproved: (response: RuntimeStyleRewriteApprovalResponse) => Promise<void> | void;
  onClose: () => void;
  onCreateMemory?: (seed: AgentMemoryDraftSeed) => void;
  onManageMemory?: () => void;
  persistence: RuntimeApiClient;
  providerConfigured: boolean;
  sessionId: string;
}) {
  const [resolution, setResolution] = useState<EffectiveStyleResolutionV1 | null>(null);
  const [context, setContext] = useState<StyleContextRefV1 | null>(null);
  const [additionalInstructions, setAdditionalInstructions] = useState("");
  const [consented, setConsented] = useState(false);
  const [run, setRun] = useState<StyleRewriteRunV1 | null>(null);
  const [versions, setVersions] = useState<StyleRewriteRunV1[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [memoryAvailable, setMemoryAvailable] = useState(false);
  const running = run?.status === "queued" || run?.status === "running";
  const selectedVersion = versions.find((version) => version.id === selectedVersionId) ?? versions.at(-1) ?? null;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void resolveInitialContext(persistence, sessionId, launch)
      .then((result) => {
        if (!active) return;
        setResolution(result.resolution);
        setContext(result.context);
      })
      .catch((caught) => active && setError(localizeRuntimeError(caught)))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [launch.actionId, launch.nodeId, launch.placementId, persistence, sessionId]);

  useEffect(() => {
    if (!run || !running) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void persistence.inspectStyleRewrite(sessionId, run.id)
        .then((next) => active && setRun(next))
        .catch((caught) => active && setError(localizeRuntimeError(caught)));
    }, 350);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [persistence, run, running, sessionId]);

  useEffect(() => {
    if (run?.status !== "completed" || !run.recommendation) return;
    setVersions((current) => current.some((version) => version.id === run.id) ? current : [...current, run]);
    setSelectedVersionId(run.id);
  }, [run]);

  async function chooseContext(sceneNodeId: string) {
    if (!sceneNodeId) return;
    setLoading(true);
    setError(null);
    const selected: StyleContextRefV1 = {
      context_version: 1,
      scene_node_id: sceneNodeId,
      placement_id: null
    };
    try {
      setResolution(await persistence.resolveEffectiveStyle(sessionId, launch.nodeId, selected));
      setContext(selected);
    } catch (caught) {
      setError(localizeRuntimeError(caught));
    } finally {
      setLoading(false);
    }
  }

  async function requestRecommendation() {
    if (!consented || !memoryAvailable || resolution?.status !== "resolved" || !launch.sourceText.trim()) return;
    setLoading(true);
    setError(null);
    try {
      // Capture checksum and history together immediately before dispatch so an
      // editor left open across another authoring command fails as stale.
      const [project, history] = await Promise.all([
        persistence.inspectProjectSession(sessionId),
        persistence.inspectProjectHistory(sessionId)
      ]);
      const started = await persistence.startStyleRewrite({
        request_version: 1,
        session_id: sessionId,
        target: launch.target,
        style_context: context ? { ...context, placement_id: context.placement_id ?? null } : null,
        observed_source_checksum: project.document.checksum,
        expected_history_revision: history.history_revision,
        additional_instructions: additionalInstructions.trim(),
        content_consent: true
      });
      setRun(started);
      setConsented(false);
    } catch (caught) {
      setError(localizeRuntimeError(caught));
    } finally {
      setLoading(false);
    }
  }

  async function cancelRecommendation() {
    if (!run || !running) return;
    setError(null);
    try {
      setRun(await persistence.cancelStyleRewrite(sessionId, run.id));
    } catch (caught) {
      setError(localizeRuntimeError(caught));
    }
  }

  async function retryRecommendation() {
    if (!selectedVersion || !consented || !memoryAvailable) return;
    setLoading(true);
    setError(null);
    try {
      const [project, history] = await Promise.all([
        persistence.inspectProjectSession(sessionId),
        persistence.inspectProjectHistory(sessionId)
      ]);
      const retried = await persistence.retryStyleRewrite(sessionId, selectedVersion.id, {
        retry_version: 1,
        observed_source_checksum: project.document.checksum,
        expected_history_revision: history.history_revision,
        additional_instructions: additionalInstructions.trim(),
        content_consent: true
      });
      setRun(retried);
      setConsented(false);
    } catch (caught) {
      setError(localizeRuntimeError(caught));
    } finally {
      setLoading(false);
    }
  }

  async function approveRecommendation() {
    const recommendation = selectedVersion?.recommendation;
    if (!selectedVersion || !recommendation || recommendation.validation_status !== "valid" || !recommendation.patch) return;
    setApproving(true);
    setError(null);
    try {
      const history = await persistence.inspectProjectHistory(sessionId);
      const response = await persistence.approveStyleRewrite(sessionId, selectedVersion.id, {
        approval_version: 1,
        recommendation_id: recommendation.id,
        source_checksum: selectedVersion.source_checksum,
        expected_history_revision: history.history_revision
      });
      await onApproved(response);
    } catch (caught) {
      setError(localizeRuntimeError(caught));
    } finally {
      setApproving(false);
    }
  }

  const unavailableReason = recommendationUnavailableReason(
    launch.sourceText,
    providerConfigured,
    resolution
  );
  return (
    <div className="style-recommendation-request" aria-label={tr("style.recommendationRequest") }>
      <header className="flex items-start justify-between gap-4 border-b border-slate-200 pb-3">
        <div>
          <div className="flex items-center gap-2">
            <Bot className="text-sky-700" size={18} aria-hidden="true" />
            <h3 className="text-base font-semibold text-slate-900">{tr("style.getRecommendation")}</h3>
          </div>
          <p className="mt-1 text-xs text-slate-500">{launch.label}</p>
        </div>
        <button className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold" disabled={running} onClick={onClose} type="button">{tr("common.close")}</button>
      </header>

      <section className="mt-3">
        <h4 className="text-xs font-semibold uppercase text-slate-500">{tr("style.sourceText")}</h4>
        <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-800">{launch.sourceText || tr("style.emptyText")}</p>
      </section>

      {resolution?.status === "context_required" ? (
        <label className="style-profile-field mt-3">
          {tr("style.chooseSceneContext")}
          <select autoFocus onChange={(event) => void chooseContext(event.target.value)} value="">
            <option value="">{tr("style.selectScene")}</option>
            {resolution.candidate_contexts.map((candidate) => <option key={candidate.scene_node_id} value={candidate.scene_node_id}>{candidate.scene_title}</option>)}
          </select>
        </label>
      ) : null}

      <dl className="mt-3 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 rounded-md border border-slate-200 p-3 text-xs">
        <dt className="font-semibold text-slate-500">{tr("style.effectiveProfile")}</dt>
        <dd className="text-slate-800">{resolution?.profile?.name ?? tr("common.none")}</dd>
        <dt className="font-semibold text-slate-500">{tr("style.sceneContext")}</dt>
        <dd className="text-slate-800">{resolution?.scene_context?.scene_title ?? tr("style.projectContext")}</dd>
      </dl>

      <AgentMemoryDisclosure
        onAvailabilityChange={setMemoryAvailable}
        onCreate={onCreateMemory}
        onManage={onManageMemory}
        persistence={persistence}
        sessionId={sessionId}
        target={{
          agentId: "style_rewriter",
          contentLocale,
          contextScope: context
            ? { scope_version: 1, kind: "scene", scene_node_id: context.scene_node_id }
            : { scope_version: 1, kind: "project" },
          scope: styleMemoryScope(launch.target, context?.scene_node_id ?? null)
        }}
      />

      <label className="style-profile-field mt-3">
        {tr("style.additionalDetails")}
        <textarea className="min-h-20" disabled={running} onChange={(event) => setAdditionalInstructions(event.target.value)} value={additionalInstructions} />
      </label>
      <div className="mt-3 rounded-md border border-sky-200 bg-sky-50 p-3 text-xs text-sky-950">
        <strong>{tr("style.contentDisclosureTitle")}</strong>
        <p className="mt-1">{tr("style.contentDisclosure")}</p>
        <label className="mt-2 flex items-start gap-2 font-semibold">
          <input checked={consented} disabled={running} onChange={(event) => setConsented(event.target.checked)} type="checkbox" />
          <span>{tr("style.contentConsent")}</span>
        </label>
      </div>

      {unavailableReason ? <p className="mt-3 text-sm font-medium text-amber-800" role="status">{unavailableReason}</p> : null}
      {error ? <p className="mt-3 text-sm font-medium text-red-700" role="alert">{error}</p> : null}
      {run && run.status !== "completed" ? <RunStatus run={run} /> : null}
      {selectedVersion ? (
        <StyleRecommendationReview
          approving={approving}
          onApprove={() => void approveRecommendation()}
          onReject={onClose}
          onRequestAgain={() => void retryRecommendation()}
          onSelectVersion={setSelectedVersionId}
          retryDisabled={loading || !consented || !memoryAvailable || running}
          run={selectedVersion}
          versions={versions}
        />
      ) : null}
      {!selectedVersion ? <div className="mt-4 flex justify-end gap-2 border-t border-slate-200 pt-3">
        {running ? (
          <button className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold" onClick={() => void cancelRecommendation()} type="button"><Square size={14} aria-hidden="true" />{tr("common.cancel")}</button>
        ) : (
          <button
            className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={loading || !consented || !memoryAvailable || Boolean(unavailableReason) || run?.status === "completed"}
            onClick={() => void requestRecommendation()}
            type="button"
          >
            {loading ? <LoaderCircle className="animate-spin" size={15} aria-hidden="true" /> : <Send size={15} aria-hidden="true" />}
            {tr("style.requestRecommendation")}
          </button>
        )}
      </div> : null}
    </div>
  );
}

/** Converts the exact Style target into the shared Agent Memory scope contract. */
export function styleMemoryScope(
  target: StyleRewriteTargetV1,
  sceneNodeId: string | null
): AgentMemoryScopeV1 {
  if (target.kind === "dialogue_field") return {
    scope_version: 1,
    kind: "dialogue_field",
    node_id: target.node_id,
    field_kind: target.field_kind,
    element_id: target.element_id,
    option_id: target.option_id
  };
  if (sceneNodeId === target.node_id) return {
    scope_version: 1,
    kind: "scene",
    scene_node_id: target.node_id
  };
  return { scope_version: 1, kind: "node", node_id: target.node_id };
}

function RunStatus({ run }: { run: StyleRewriteRunV1 }) {
  const message = run.status === "completed"
    ? tr("style.recommendationReady")
    : run.status === "cancelled"
      ? tr("style.recommendationCancelled")
      : run.status === "stale"
        ? tr("style.recommendationStale")
        : run.status === "failed"
          ? tr("style.recommendationFailed")
          : tr("style.recommendationWorking", { progress: Math.round(run.progress) });
  return <p className="mt-3 text-sm font-semibold text-slate-700" aria-live="polite">{message}</p>;
}

function recommendationUnavailableReason(
  sourceText: string,
  providerConfigured: boolean,
  resolution: EffectiveStyleResolutionV1 | null
): string | null {
  if (!sourceText.trim()) return tr("style.emptyTextReason");
  if (!providerConfigured) return tr("style.providerNotConfigured");
  if (!resolution) return null;
  if (resolution.status === "unconfigured") return tr("style.noStyleConfigured");
  if (resolution.status === "unavailable") return tr("style.styleUnavailable");
  if (resolution.status === "context_required") return tr("style.contextRequired");
  return null;
}

async function resolveInitialContext(
  persistence: RuntimeApiClient,
  sessionId: string,
  launch: StyleRecommendationLaunch
): Promise<{ context: StyleContextRefV1 | null; resolution: EffectiveStyleResolutionV1 }> {
  const unresolved = await persistence.resolveEffectiveStyle(sessionId, launch.nodeId, null);
  if (unresolved.status !== "context_required" || !launch.placementId) {
    return { context: unresolved.scene_context ? {
      context_version: 1,
      scene_node_id: unresolved.scene_context.scene_node_id,
      placement_id: launch.placementId
    } : null, resolution: unresolved };
  }
  // A concrete linked placement disambiguates shared content. Probe only the
  // resolver-declared Scene candidates and retain its validated winning context.
  for (const candidate of unresolved.candidate_contexts) {
    const context: StyleContextRefV1 = {
      context_version: 1,
      scene_node_id: candidate.scene_node_id,
      placement_id: launch.placementId
    };
    try {
      return {
        context,
        resolution: await persistence.resolveEffectiveStyle(sessionId, launch.nodeId, context)
      };
    } catch {
      // The selected placement belongs to another candidate; continue bounded probing.
    }
  }
  return { context: null, resolution: unresolved };
}

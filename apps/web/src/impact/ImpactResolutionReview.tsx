import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  FileDiff,
  LoaderCircle,
  LocateFixed,
  Minus,
  Move,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  X
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { CanonOwnerRef } from "@something-to-tell/contracts/canon-check";
import type {
  ImpactResolutionRun,
  ImpactSolutionAlternative,
  ImpactVisualChange,
  ImpactVisualMode,
  ImpactVisualSurface
} from "@something-to-tell/contracts/impact-resolution";
import type { ProjectPatch } from "@something-to-tell/contracts/project-patch";
import { localizeRuntimeText, tr } from "../localization/i18n";
import { presentImpactVisualChanges } from "./visualProjection";
import {
  AgentMemoryDisclosure,
  type AgentMemoryDisclosureTarget,
  type AgentMemoryDraftSeed
} from "../components/AgentMemoryDisclosure";
import type { RuntimeAgentMemoryPersistence } from "../runtime/apiTypes";

const SURFACES: ImpactVisualSurface[] = [
  "graph", "composition", "flow", "story", "dialogue", "quest", "temporal", "canon"
];
const MODES: ImpactVisualMode[] = ["before", "after", "changes"];

export interface ImpactResolutionReviewProps {
  error: string | null;
  findingIds: string[];
  historyRevision: number;
  initiallyExpanded?: boolean;
  operation: "starting" | "cancelling" | "approving" | "rejecting" | "editing" | null;
  providerConfigured: boolean;
  run: ImpactResolutionRun | null;
  onCancel: () => void;
  onApprove: (alternative: ImpactSolutionAlternative) => void;
  onEdit: (alternative: ImpactSolutionAlternative, patch: ProjectPatch) => void;
  onNavigate: (change: ImpactVisualChange) => void;
  onReject: (alternative: ImpactSolutionAlternative) => void;
  onRun: (findingIds: string[], includeRejected: boolean) => void;
  onVerifyCanon: () => void;
  onVerifyImpact: () => void;
  resourceLabel: (resource: CanonOwnerRef) => string;
  totalFindingCount?: number;
  verificationPending: boolean;
  memoryPersistence?: RuntimeAgentMemoryPersistence;
  memorySessionId?: string;
  memoryTarget?: AgentMemoryDisclosureTarget;
  onCreateMemory?: (seed: AgentMemoryDraftSeed) => void;
  onManageMemory?: () => void;
}

/** Presents validated agent output without applying patches or mutating authoring state. */
export function ImpactResolutionReview({
  error,
  findingIds,
  historyRevision,
  initiallyExpanded = false,
  operation,
  providerConfigured,
  run,
  onCancel,
  onApprove,
  onEdit,
  onNavigate,
  onReject,
  onRun,
  onVerifyCanon,
  onVerifyImpact,
  resourceLabel,
  totalFindingCount = findingIds.length,
  verificationPending,
  memoryPersistence,
  memorySessionId,
  memoryTarget,
  onCreateMemory,
  onManageMemory
}: ImpactResolutionReviewProps) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [consented, setConsented] = useState(false);
  const [includeRejected, setIncludeRejected] = useState(false);
  const [selectedAlternativeId, setSelectedAlternativeId] = useState<string | null>(null);
  const [mode, setMode] = useState<ImpactVisualMode>("changes");
  const [surface, setSurface] = useState<ImpactVisualSurface | "all">("all");
  const [memoryAvailable, setMemoryAvailable] = useState(!memoryPersistence);
  const busy = operation !== null || run?.status === "queued" || run?.status === "running";

  useEffect(() => {
    if (busy || run || error) setExpanded(true);
  }, [busy, error, run]);

  useEffect(() => {
    if (initiallyExpanded) setExpanded(true);
  }, [initiallyExpanded]);

  useEffect(() => {
    if (!run?.alternatives.length) {
      setSelectedAlternativeId(null);
      return;
    }
    if (!run.alternatives.some((alternative) => alternative.id === selectedAlternativeId)) {
      setSelectedAlternativeId(run.alternatives[0]!.id);
    }
  }, [run?.alternatives, selectedAlternativeId]);

  const selectedAlternative = run?.alternatives.find((alternative) => alternative.id === selectedAlternativeId) ?? null;
  const projection = selectedAlternative?.semantic_fingerprint
    ? run?.visual_projections.find((candidate) => candidate.alternative_fingerprint === selectedAlternative.semantic_fingerprint) ?? null
    : null;
  const visualChanges = useMemo(() => projection
    ? presentImpactVisualChanges(projection, mode).filter(({ change }) => surface === "all" || change.surface === surface)
    : [], [mode, projection, surface]);

  return (
    <section aria-label={tr("impactResolution.review")} className="impact-resolution-review">
      <button
        aria-expanded={expanded}
        className="impact-resolution-toggle"
        data-tooltip={tr("impactResolution.reviewTooltip")}
        onClick={() => setExpanded((current) => !current)}
        title={tr("impactResolution.reviewTooltip")}
        type="button"
      >
        {expanded ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
        <Bot size={15} aria-hidden="true" />
        <span>{tr("impactResolution.review")}</span>
        <small data-status={operation ?? run?.status ?? "idle"}>{tr(`impactResolution.status.${operation ?? run?.status ?? "idle"}` as Parameters<typeof tr>[0])}</small>
      </button>

      {expanded ? (
        <div className="impact-resolution-body">
          {findingIds.length < totalFindingCount ? (
            <div className="impact-resolution-message" data-tone="warning" role="status">
              <AlertTriangle size={15} aria-hidden="true" />
              {tr("impactResolution.boundedFindingScope", { selected: findingIds.length, total: totalFindingCount })}
            </div>
          ) : null}
          {busy ? (
            <div className="impact-resolution-progress" role="status">
              <LoaderCircle className="animate-spin" size={17} aria-hidden="true" />
              <span><strong>{tr("impactResolution.progressTitle")}</strong><small>{tr("impactResolution.progressDetail")}</small></span>
              <button disabled={operation !== null} onClick={onCancel} title={tr("common.cancel")} type="button">
                <CircleStop size={14} aria-hidden="true" />{tr("common.cancel")}
              </button>
            </div>
          ) : (
            <>
              {memoryPersistence && memorySessionId && memoryTarget ? (
                <AgentMemoryDisclosure
                  onAvailabilityChange={setMemoryAvailable}
                  onCreate={onCreateMemory}
                  onManage={onManageMemory}
                  persistence={memoryPersistence}
                  sessionId={memorySessionId}
                  target={memoryTarget}
                />
              ) : null}
              <ResolutionRunControls
                consented={consented}
                disabled={!providerConfigured || !findingIds.length || !memoryAvailable}
                onConsent={setConsented}
                includeRejected={includeRejected}
                onIncludeRejected={setIncludeRejected}
                onRun={() => onRun(findingIds, includeRejected)}
                providerConfigured={providerConfigured}
                retry={Boolean(run || error)}
              />
            </>
          )}

          {error ? <div className="impact-resolution-message" data-tone="error" role="alert"><AlertTriangle size={15} />{error}</div> : null}
          {!error && run && ["failed", "cancelled", "stale"].includes(run.status) ? (
            <div className="impact-resolution-message" data-tone={run.status} role="status">
              <AlertTriangle size={15} />{resolutionRunMessage(run)}
            </div>
          ) : null}

          {run?.explanation ? <Explanation run={run} /> : null}
          {verificationPending ? (
            <div className="impact-resolution-verification" role="status">
              <span><strong>{tr("impactResolution.verificationTitle")}</strong><small>{tr("impactResolution.verificationDetail")}</small></span>
              <button disabled={busy} onClick={onVerifyImpact} type="button"><RotateCcw size={14} aria-hidden="true" />{tr("impactResolution.verifyImpact")}</button>
              <button disabled={busy} onClick={onVerifyCanon} type="button"><RotateCcw size={14} aria-hidden="true" />{tr("impactResolution.verifyCanon")}</button>
            </div>
          ) : null}
          {run?.alternatives.length ? (
            <AlternativeReview
              mode={mode}
              historyRevision={historyRevision}
              operation={operation}
              onApprove={onApprove}
              onEdit={onEdit}
              onMode={setMode}
              onNavigate={onNavigate}
              onReject={onReject}
              onSelect={setSelectedAlternativeId}
              onSurface={setSurface}
              resourceLabel={resourceLabel}
              run={run}
              selected={selectedAlternative}
              surface={surface}
              visualChanges={visualChanges}
            />
          ) : run?.status === "completed" ? <p className="impact-resolution-empty">{tr("impactResolution.noAlternatives")}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function ResolutionRunControls({
  consented,
  disabled,
  includeRejected,
  onConsent,
  onIncludeRejected,
  onRun,
  providerConfigured,
  retry
}: {
  consented: boolean;
  disabled: boolean;
  includeRejected: boolean;
  onConsent: (value: boolean) => void;
  onIncludeRejected: (value: boolean) => void;
  onRun: () => void;
  providerConfigured: boolean;
  retry: boolean;
}) {
  return (
    <div className="impact-resolution-run-controls">
      {!providerConfigured ? <p><AlertTriangle size={14} />{tr("impactResolution.configureProvider")}</p> : null}
      <label>
        <input checked={consented} disabled={!providerConfigured} onChange={(event) => onConsent(event.target.checked)} type="checkbox" />
        <span>{tr("impactResolution.consent")}</span>
      </label>
      {retry ? (
        <label>
          <input checked={includeRejected} onChange={(event) => onIncludeRejected(event.target.checked)} type="checkbox" />
          <span>{tr("impactResolution.includeRejected")}</span>
        </label>
      ) : null}
      <button disabled={disabled || !consented} onClick={onRun} title={tr(retry ? "impactResolution.retry" : "impactResolution.explainFindings")} type="button">
        {retry ? <RotateCcw size={14} aria-hidden="true" /> : <Bot size={14} aria-hidden="true" />}
        {tr(retry ? "impactResolution.retry" : "impactResolution.explainFindings")}
      </button>
    </div>
  );
}

function Explanation({ run }: { run: ImpactResolutionRun }) {
  const explanation = run.explanation!;
  return (
    <section aria-label={tr("impactResolution.explanation")} className="impact-resolution-explanation">
      <h3>{tr("impactResolution.explanation")}</h3>
      <p>{explanation.summary}</p>
      <TextList items={explanation.why_it_matters} label={tr("impactResolution.whyItMatters")} />
      <TextList items={explanation.assumptions} label={tr("impactResolution.assumptions")} />
      <TextList items={explanation.limitations} label={tr("impactResolution.limitations")} />
    </section>
  );
}

function TextList({ items, label }: { items: string[]; label: string }) {
  if (!items.length) return null;
  return <div className="impact-resolution-text-list"><strong>{label}</strong><ul>{items.map((item, index) => <li key={`${label}-${index}`}>{item}</li>)}</ul></div>;
}

function AlternativeReview({
  historyRevision,
  mode,
  operation,
  onApprove,
  onEdit,
  onMode,
  onNavigate,
  onReject,
  onSelect,
  onSurface,
  resourceLabel,
  run,
  selected,
  surface,
  visualChanges
}: {
  historyRevision: number;
  mode: ImpactVisualMode;
  operation: ImpactResolutionReviewProps["operation"];
  onApprove: (alternative: ImpactSolutionAlternative) => void;
  onEdit: (alternative: ImpactSolutionAlternative, patch: ProjectPatch) => void;
  onMode: (mode: ImpactVisualMode) => void;
  onNavigate: (change: ImpactVisualChange) => void;
  onReject: (alternative: ImpactSolutionAlternative) => void;
  onSelect: (id: string) => void;
  onSurface: (surface: ImpactVisualSurface | "all") => void;
  resourceLabel: (resource: CanonOwnerRef) => string;
  run: ImpactResolutionRun;
  selected: ImpactSolutionAlternative | null;
  surface: ImpactVisualSurface | "all";
  visualChanges: ReturnType<typeof presentImpactVisualChanges>;
}) {
  const [editingAlternativeId, setEditingAlternativeId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  if (!selected) return null;
  const activeAlternative = selected;
  const actionable = run.status === "completed"
    && activeAlternative.validation.status === "valid"
    && activeAlternative.patch !== null
    && operation === null;

  function beginEdit() {
    if (!activeAlternative.patch) return;
    setEditingAlternativeId(activeAlternative.id);
    setDraft(JSON.stringify(activeAlternative.patch, null, 2));
    setDraftError(null);
  }

  function submitEdit() {
    try {
      const patch = JSON.parse(draft) as ProjectPatch;
      setDraftError(null);
      onEdit(activeAlternative, patch);
    } catch {
      setDraftError(tr("impactResolution.editInvalidJson"));
    }
  }
  return (
    <section aria-label={tr("impactResolution.alternatives")} className="impact-resolution-alternatives">
      <h3>{tr("impactResolution.alternatives")}</h3>
      <div aria-label={tr("impactResolution.alternatives")} className="impact-resolution-tabs" role="tablist">
        {run.alternatives.map((alternative, index) => (
          <button
            aria-selected={alternative.id === selected.id}
            key={alternative.id}
            onClick={() => onSelect(alternative.id)}
            role="tab"
            title={alternative.title}
            type="button"
          >{index + 1}. {alternative.title}<ValidationState alternative={alternative} /></button>
        ))}
      </div>
      <div className="impact-resolution-alternative-detail" role="tabpanel">
        <p>{selected.rationale}</p>
        <TextList items={selected.tradeoffs} label={tr("impactResolution.tradeoffs")} />
        <TextList items={selected.expected_outcomes} label={tr("impactResolution.expectedOutcomes")} />
        {selected.validation.diagnostics.map((diagnostic) => (
          <div className="impact-resolution-message" data-tone={diagnostic.severity} key={diagnostic.code}>
            <AlertTriangle size={14} />{localizeRuntimeText(diagnostic.message_key, diagnostic.parameters, diagnostic.code)}
          </div>
        ))}
        {!actionable ? <ReviewUnavailableReason alternative={selected} run={run} /> : null}
        {selected.comparison ? <Comparison alternative={selected} /> : null}
        <div className="impact-resolution-review-actions">
          <button data-tooltip={tr("impactResolution.approveTooltip")} disabled={!actionable} onClick={() => onApprove(selected)} title={tr("impactResolution.approveTooltip")} type="button">
            <Check size={14} aria-hidden="true" />{tr("impactResolution.approve")}
          </button>
          <button data-tooltip={tr("impactResolution.rejectTooltip")} disabled={!actionable} onClick={() => onReject(selected)} title={tr("impactResolution.rejectTooltip")} type="button">
            <X size={14} aria-hidden="true" />{tr("impactResolution.reject")}
          </button>
          <button data-tooltip={tr("impactResolution.editTooltip")} disabled={!actionable} onClick={beginEdit} title={tr("impactResolution.editTooltip")} type="button">
            <Pencil size={14} aria-hidden="true" />{tr("impactResolution.edit")}
          </button>
          <small>{tr("impactResolution.historyRevision", { revision: historyRevision })}</small>
        </div>
        {editingAlternativeId === selected.id ? (
          <div className="impact-resolution-draft-editor">
            <label htmlFor={`impact-resolution-draft-${selected.id}`}>{tr("impactResolution.patchDraft")}</label>
            <textarea id={`impact-resolution-draft-${selected.id}`} onChange={(event) => setDraft(event.target.value)} spellCheck={false} value={draft} />
            {draftError ? <p role="alert">{draftError}</p> : null}
            <div>
              <button disabled={operation !== null} onClick={submitEdit} type="button"><Save size={14} aria-hidden="true" />{tr("impactResolution.validateDraft")}</button>
              <button onClick={() => setEditingAlternativeId(null)} type="button"><X size={14} aria-hidden="true" />{tr("common.cancel")}</button>
            </div>
          </div>
        ) : null}
      </div>

      {run.status === "stale" ? (
        <div className="impact-resolution-stale-preview" role="note">
          <FileDiff size={14} aria-hidden="true" />{tr("impactResolution.stalePreviewUnavailable")}
        </div>
      ) : <>
        <div className="impact-resolution-visual-header">
          <strong><FileDiff size={14} aria-hidden="true" />{tr("impactResolution.visualPreview")}</strong>
          <div aria-label={tr("impactResolution.visualMode")} className="impact-resolution-mode">
            {MODES.map((candidate) => (
              <button aria-pressed={mode === candidate} key={candidate} onClick={() => onMode(candidate)} title={tr(`impactResolution.mode.${candidate}Tooltip` as Parameters<typeof tr>[0])} type="button">
                {tr(`impactResolution.mode.${candidate}` as Parameters<typeof tr>[0])}
              </button>
            ))}
          </div>
          <label>
            <span>{tr("impactResolution.surfaceFilter")}</span>
            <select aria-label={tr("impactResolution.surfaceFilter")} onChange={(event) => onSurface(event.target.value as ImpactVisualSurface | "all")} value={surface}>
              <option value="all">{tr("impactResolution.surface.all")}</option>
              {SURFACES.map((candidate) => <option key={candidate} value={candidate}>{tr(`impactResolution.surface.${candidate}` as Parameters<typeof tr>[0])}</option>)}
            </select>
          </label>
        </div>
        <div className="impact-resolution-visual-list">
          {visualChanges.length ? visualChanges.map((presentation) => {
            const owner = presentation.change.after_resource ?? presentation.change.before_resource;
            return (
              <div className="impact-resolution-change" data-cue={presentation.cue} key={presentation.change.id}>
                <ChangeIcon kind={presentation.change.kind} />
                <span>
                  <strong>{owner ? resourceLabel(owner) : tr("common.unknownValue")}</strong>
                  <small>{tr(`impactResolution.change.${presentation.change.kind}` as Parameters<typeof tr>[0])} · {tr(`impactResolution.surface.${presentation.change.surface}` as Parameters<typeof tr>[0])}</small>
                  {presentation.change.field_changes.length ? <code>{presentation.change.field_changes.map((field) => field.path).join(", ")}</code> : null}
                  {presentation.previewOnly ? <em>{tr("impactResolution.previewOnly")}</em> : null}
                </span>
                <button aria-label={tr("impactResolution.openSource", { name: owner ? resourceLabel(owner) : tr("common.unknownValue") })} disabled={!owner} onClick={() => onNavigate(presentation.change)} title={tr("impactResolution.openSource", { name: owner ? resourceLabel(owner) : tr("common.unknownValue") })} type="button">
                  <LocateFixed size={14} aria-hidden="true" />
                </button>
              </div>
            );
          }) : <p className="impact-resolution-empty">{tr("impactResolution.noVisualChanges")}</p>}
        </div>
      </>}
    </section>
  );
}

/** Explains why a visible provider alternative cannot mutate the project. */
function ReviewUnavailableReason({
  alternative,
  run
}: {
  alternative: ImpactSolutionAlternative;
  run: ImpactResolutionRun;
}) {
  const key = run.status === "stale"
    ? "impactResolution.actionUnavailable.stale"
    : alternative.validation.status === "explanation_only"
      ? "impactResolution.actionUnavailable.explanationOnly"
      : alternative.validation.status === "invalid"
        ? "impactResolution.actionUnavailable.invalid"
        : null;
  return key ? (
    <div className="impact-resolution-message" data-tone="warning" role="note">
      <AlertTriangle size={14} aria-hidden="true" />{tr(key)}
    </div>
  ) : null;
}

function ValidationState({ alternative }: { alternative: ImpactSolutionAlternative }) {
  return <small data-validation={alternative.validation.status}>{tr(`impactResolution.validation.${alternative.validation.status}` as Parameters<typeof tr>[0])}</small>;
}

function Comparison({ alternative }: { alternative: ImpactSolutionAlternative }) {
  const comparison = alternative.comparison!;
  const rows = [
    ["dependencies", comparison.dependencies],
    ["reachability", comparison.reachability],
    ["statePaths", comparison.state_paths],
    ["canonFacts", comparison.canon_facts]
  ] as const;
  return (
    <section aria-label={tr("impactResolution.comparison")} className="impact-resolution-comparison">
      <h4>{tr("impactResolution.comparison")}</h4>
      <div className="impact-resolution-impact-counts">
        <span><strong>{comparison.impact_before.finding_count}</strong>{tr("impactResolution.beforeFindings")}</span>
        <span><strong>{comparison.impact_after.finding_count}</strong>{tr("impactResolution.afterFindings")}</span>
        <span><strong>{comparison.affected_issue_count}</strong>{tr("impactResolution.affectedIssues")}</span>
      </div>
      <table><tbody>{rows.map(([key, value]) => <tr key={key}><th>{tr(`impactResolution.metric.${key}` as Parameters<typeof tr>[0])}</th><td>+{value.added}</td><td>−{value.removed}</td><td>±{value.changed}</td></tr>)}</tbody></table>
    </section>
  );
}

function ChangeIcon({ kind }: { kind: ImpactVisualChange["kind"] }) {
  if (kind === "add") return <Plus size={15} aria-hidden="true" />;
  if (kind === "remove") return <Minus size={15} aria-hidden="true" />;
  if (kind === "move") return <Move size={15} aria-hidden="true" />;
  return <Pencil size={15} aria-hidden="true" />;
}

function resolutionRunMessage(run: ImpactResolutionRun): string {
  const diagnostic = run.diagnostics[0];
  return diagnostic
    ? localizeRuntimeText(diagnostic.message_key, diagnostic.parameters, diagnostic.code)
    : tr(`impactResolution.statusMessage.${run.status as "failed" | "cancelled" | "stale"}`);
}

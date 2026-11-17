import {
  AlertTriangle,
  Check,
  CircleHelp,
  CircleStop,
  ExternalLink,
  LoaderCircle,
  Play,
  ScanSearch,
  ShieldCheck,
  X,
  type LucideIcon
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type {
  CanonCheckRun,
  CanonFixSuggestion,
  CanonIssueListResponse,
  CanonIssueProjection,
  CanonIssueStatus,
  CanonOwnerRef,
  CanonRunMode
} from "@something-to-tell/contracts/canon-check";
import { i18next, localizeRuntimeText, tr } from "../localization/i18n";
import { CanonIssueActions } from "./CanonIssueActions";
import { AgentMemoryDisclosure, type AgentMemoryDraftSeed } from "../components/AgentMemoryDisclosure";
import type { RuntimeAgentMemoryPersistence } from "../runtime/apiTypes";

type CanonOperation = "loading" | "running" | "cancelling" | "reviewing" | null;

export interface CanonWorkspaceProps {
  error: string | null;
  issues: CanonIssueListResponse | null;
  mode: CanonRunMode;
  notice: string | null;
  operation: CanonOperation;
  providerConfigured: boolean;
  revision: number;
  run: CanonCheckRun | null;
  selectedIssueId: string | null;
  suggestion: CanonFixSuggestion | null;
  canNavigate?: (owner: CanonOwnerRef) => boolean;
  onCancel: () => void;
  onClose: () => void;
  onModeChange: (mode: CanonRunMode) => void;
  onNavigate: (owner: CanonOwnerRef, destination: "flow" | "graph" | "source" | "story", issue?: CanonIssueProjection) => void;
  onReview: (issueId: string, status: "open" | "review" | "ignored") => void;
  onSelectIssue: (issueId: string | null) => void;
  onRun: (remoteConsent: boolean) => void;
  onRepair: (issueId: string) => void;
  onSuggestionDecision: (decision: "approved" | "rejected") => void;
  onAnalyzeSuggestion: (origin: HTMLButtonElement) => void;
  suggestionBlocked: boolean;
  memoryContentLocale?: "en" | "ru";
  memoryPersistence?: RuntimeAgentMemoryPersistence;
  memorySessionId?: string;
  onCreateMemory?: (seed: AgentMemoryDraftSeed) => void;
  onManageMemory?: () => void;
}

/** Dense non-modal review surface over durable generated canon Issues. */
export function CanonWorkspace({
  error,
  issues,
  mode,
  notice,
  operation,
  providerConfigured,
  revision,
  run,
  selectedIssueId,
  suggestion,
  canNavigate = () => true,
  onCancel,
  onClose,
  onModeChange,
  onNavigate,
  onReview,
  onSelectIssue,
  onRun,
  onRepair,
  onSuggestionDecision,
  onAnalyzeSuggestion,
  suggestionBlocked,
  memoryContentLocale = "en",
  memoryPersistence,
  memorySessionId,
  onCreateMemory,
  onManageMemory
}: CanonWorkspaceProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(selectedIssueId);
  const [severity, setSeverity] = useState("all");
  const [status, setStatus] = useState("active");
  const [category, setCategory] = useState("all");
  const [rule, setRule] = useState("all");
  const [target, setTarget] = useState("");
  const [remoteConsent, setRemoteConsent] = useState(false);
  const [memoryAvailable, setMemoryAvailable] = useState(!memoryPersistence);

  useEffect(() => closeRef.current?.focus(), []);
  const allIssues = issues?.issues ?? [];
  const categories = useMemo(
    () => [...new Set(allIssues.map((issue) => issue.metadata.category))].sort(),
    [allIssues]
  );
  const rules = useMemo(
    () => [...new Set(allIssues.map((issue) => issue.metadata.rule_id))].sort(),
    [allIssues]
  );
  const filtered = useMemo(() => allIssues.filter((issue) => {
    const statusMatches = status === "all"
      || (status === "active" && (issue.status === "open" || issue.status === "review"))
      || issue.status === status;
    const targetQuery = target.trim().toLocaleLowerCase();
    const targetMatches = !targetQuery || issue.metadata.targets.some((owner) =>
      `${owner.owner_type} ${owner.owner_id} ${owner.context_type ?? ""} ${owner.context_id ?? ""}`
        .toLocaleLowerCase()
        .includes(targetQuery)
    );
    return (severity === "all" || issue.severity === severity)
      && statusMatches
      && (category === "all" || issue.metadata.category === category)
      && (rule === "all" || issue.metadata.rule_id === rule)
      && targetMatches;
  }), [allIssues, category, rule, severity, status, target]);
  const selected = filtered.find((issue) => issue.id === selectedId) ?? filtered[0] ?? null;

  useEffect(() => setSelectedId(selectedIssueId), [selectedIssueId]);

  useEffect(() => {
    if (selected?.id !== selectedId) setSelectedId(selected?.id ?? null);
    if (selected?.id !== selectedIssueId) onSelectIssue(selected?.id ?? null);
  }, [onSelectIssue, selected?.id, selectedId, selectedIssueId]);

  function moveSelection(direction: -1 | 1) {
    if (!filtered.length) return;
    const current = Math.max(0, filtered.findIndex((issue) => issue.id === selected?.id));
    const next = Math.min(filtered.length - 1, Math.max(0, current + direction));
    selectIssue(filtered[next]!, false);
  }

  /** Explicit reveal opens the primary owner while preserving all highlights. */
  function selectIssue(issue: CanonIssueProjection, revealOwner: boolean) {
    setSelectedId(issue.id);
    onSelectIssue(issue.id);
    const primaryTarget = issue.metadata.targets[0];
    if (revealOwner && primaryTarget) onNavigate(primaryTarget, "source");
  }

  const isRunning = operation === "running"
    || run?.status === "queued"
    || run?.status === "running"
    || run?.status === "reconciling";
  const visibleRunStatus = operation === "loading"
    ? "loading"
    : operation === "running"
      ? "running"
      : operation === "cancelling"
        ? "cancelling"
        : run?.status ?? "idle";

  return (
    <aside aria-label={tr("canon.workspace")} className="canon-workspace">
      <header className="canon-workspace-header">
        <div>
          <span><ShieldCheck size={15} aria-hidden="true" />{tr("canon.workspace")}</span>
          <strong>{tr("canon.revision", { revision: run?.saved_revision ?? revision })}</strong>
        </div>
        <div className="canon-workspace-actions">
          <span className="canon-run-state" data-status={visibleRunStatus}>
            {operation === "loading"
              ? tr("canon.loading")
              : operation === "running"
                ? tr("canon.runStatus.running")
              : operation === "cancelling"
                ? tr("canon.runStatus.cancelling")
                : canonRunStatus(run)}
          </span>
          <button
            aria-label={tr("common.close")}
            className="icon-button"
            onClick={onClose}
            ref={closeRef}
            title={tr("common.close")}
            type="button"
          >
            <X size={17} aria-hidden="true" />
          </button>
        </div>
      </header>

      <section className="canon-command-bar" aria-label={tr("canon.runControls")}>
        <label>
          <span>{tr("canon.mode")}</span>
          <select onChange={(event) => onModeChange(event.target.value as CanonRunMode)} value={mode}>
            <option value="deterministic">{tr("canon.localDeterministic")}</option>
            {providerConfigured ? <option value="configured_agent">{tr("canon.configuredProvider")}</option> : null}
          </select>
        </label>
        <span className="canon-execution-disclosure">
          {mode === "deterministic" ? tr("canon.localDisclosure") : tr("canon.providerDisclosure")}
        </span>
        {operation === "running" ? (
          <button className="canon-secondary-command" disabled type="button">
            <LoaderCircle className="animate-spin" size={15} aria-hidden="true" />
            {tr("canon.runStatus.running")}
          </button>
        ) : isRunning ? (
          <button className="canon-secondary-command" disabled={operation === "cancelling"} onClick={onCancel} type="button">
            {operation === "cancelling" ? <LoaderCircle className="animate-spin" size={15} aria-hidden="true" /> : <CircleStop size={15} aria-hidden="true" />}
            {tr("common.cancel")}
          </button>
        ) : (
          <button className="canon-primary-command" disabled={operation !== null || (mode === "configured_agent" && (!remoteConsent || !memoryAvailable))} onClick={() => { onRun(remoteConsent); setRemoteConsent(false); }} type="button">
            <Play size={15} aria-hidden="true" />
            {tr("canon.run")}
          </button>
        )}
        {mode === "configured_agent" ? (
          <label className="canon-remote-consent">
            <input
              checked={remoteConsent}
              onChange={(event) => setRemoteConsent(event.target.checked)}
              type="checkbox"
            />
            <span>{tr("canon.remoteConsent")}</span>
          </label>
        ) : null}
      </section>

      {mode === "configured_agent" && memoryPersistence && memorySessionId ? (
        <AgentMemoryDisclosure
          onAvailabilityChange={setMemoryAvailable}
          onCreate={onCreateMemory}
          onManage={onManageMemory}
          persistence={memoryPersistence}
          sessionId={memorySessionId}
          target={{
            agentId: "canon_checker",
            contentLocale: memoryContentLocale,
            contextScope: { scope_version: 1, kind: "project" },
            scope: { scope_version: 1, kind: "project" }
          }}
        />
      ) : null}

      {operation === "running" ? (
        <section aria-live="polite" className="canon-running-indicator" role="status">
          <LoaderCircle className="animate-spin" size={18} aria-hidden="true" />
          <div>
            <strong>{tr(mode === "configured_agent" ? "canon.agentAnalyzing" : "canon.localAnalyzing")}</strong>
            <span>{tr(mode === "configured_agent" ? "canon.agentAnalyzingDetail" : "canon.localAnalyzingDetail")}</span>
          </div>
          <span aria-hidden="true" className="canon-running-track"><span /></span>
        </section>
      ) : null}

      <section className="canon-summary" aria-label={tr("canon.summary")}>
        <CanonMetric label={tr("canon.activeIssues")} value={issues?.active_count ?? 0} />
        <CanonMetric label={tr("canon.facts")} value={run?.summary.fact_count ?? 0} />
        <CanonMetric label={tr("canon.findings")} value={run?.summary.candidate_count ?? 0} />
        <CanonMetric label={tr("canon.resolved")} value={run?.summary.resolved_count ?? 0} />
      </section>

      <section className="canon-filters" aria-label={tr("canon.filters")}>
        <select aria-label={tr("canon.severity")} onChange={(event) => setSeverity(event.target.value)} value={severity}>
          <option value="all">{tr("canon.allSeverities")}</option>
          <option value="critical">{tr("canon.severityCritical")}</option>
          <option value="warning">{tr("canon.severityWarning")}</option>
          <option value="info">{tr("canon.severityInfo")}</option>
        </select>
        <select aria-label={tr("canon.status")} onChange={(event) => setStatus(event.target.value)} value={status}>
          <option value="active">{tr("canon.activeStatuses")}</option>
          <option value="all">{tr("canon.allStatuses")}</option>
          {(["open", "review", "ignored", "resolved"] as CanonIssueStatus[]).map((value) => (
            <option key={value} value={value}>{canonIssueStatus(value)}</option>
          ))}
        </select>
        <select aria-label={tr("canon.category")} onChange={(event) => setCategory(event.target.value)} value={category}>
          <option value="all">{tr("canon.allCategories")}</option>
          {categories.map((value) => <option key={value} value={value}>{canonCategory(value)}</option>)}
        </select>
        <select aria-label={tr("canon.rule")} onChange={(event) => setRule(event.target.value)} value={rule}>
          <option value="all">{tr("canon.allRules")}</option>
          {rules.map((value) => <option key={value} value={value}>{canonRule(value)}</option>)}
        </select>
        <input
          aria-label={tr("canon.targetFilter")}
          onChange={(event) => setTarget(event.target.value)}
          placeholder={tr("canon.targetFilter")}
          value={target}
        />
      </section>

      {error ? <p className="canon-error" role="alert">{error}</p> : null}
      {notice ? <p className="canon-notice" role="status">{notice}</p> : null}
      {run?.diagnostics.map((diagnostic) => (
        <p className="canon-error" key={diagnostic.code} role="alert">
          {localizeCanonText(diagnostic.message_key, diagnostic.parameters)}
        </p>
      ))}

      <div className="canon-review-layout">
        <div
          aria-label={tr("canon.issueList")}
          className="canon-issue-list"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              moveSelection(event.key === "ArrowDown" ? 1 : -1);
            } else if (event.key === "Enter" && selected) {
              event.preventDefault();
              selectIssue(selected, true);
            }
          }}
          role="listbox"
          tabIndex={0}
        >
          {operation === "loading" && !issues ? <CanonEmpty icon={LoaderCircle} text={tr("canon.loadingIssues")} spin /> : null}
          {!operation && run?.status === "completed" && !allIssues.length ? <CanonEmpty icon={Check} text={tr("canon.noIssues")} /> : null}
          {!operation && issues && allIssues.length > 0 && !filtered.length ? <CanonEmpty icon={CircleHelp} text={tr("canon.noFilterResults")} /> : null}
          {!operation && !run && !allIssues.length ? <CanonEmpty icon={ShieldCheck} text={tr("canon.notRunYet")} /> : null}
          {filtered.map((issue) => (
            <button
              aria-selected={issue.id === selected?.id}
              className="canon-issue-row"
              data-status={issue.status}
              key={issue.id}
              onClick={() => selectIssue(issue, false)}
              onDoubleClick={() => selectIssue(issue, true)}
              role="option"
              type="button"
            >
              <SeverityIcon severity={issue.severity} />
              <span>
                <strong>{localizeCanonText(issue.metadata.message_key, issue.metadata.message_parameters)}</strong>
                <small>{canonCategory(issue.metadata.category)} · {canonIssueStatus(issue.status)}</small>
              </span>
            </button>
          ))}
        </div>

        <section aria-label={tr("canon.issueDetails")} className="canon-issue-detail">
          {selected ? (
            <CanonIssueDetail
              busy={operation === "reviewing"}
              canNavigate={canNavigate}
              issue={selected}
              onNavigate={onNavigate}
              onReview={(status) => onReview(selected.id, status)}
              onRepair={() => onRepair(selected.id)}
              onSuggestionDecision={onSuggestionDecision}
              onAnalyzeSuggestion={onAnalyzeSuggestion}
              suggestionBlocked={suggestionBlocked}
              suggestion={suggestion?.issue_id === selected.id ? suggestion : null}
            />
          ) : <CanonEmpty icon={CircleHelp} text={tr("canon.selectIssue")} />}
        </section>
      </div>
    </aside>
  );
}

function CanonIssueDetail({
  busy,
  canNavigate,
  issue,
  onNavigate,
  onReview,
  onRepair,
  onSuggestionDecision,
  onAnalyzeSuggestion,
  suggestionBlocked,
  suggestion
}: {
  busy: boolean;
  canNavigate: (owner: CanonOwnerRef) => boolean;
  issue: CanonIssueProjection;
  onNavigate: CanonWorkspaceProps["onNavigate"];
  onReview: (status: "open" | "review" | "ignored") => void;
  onRepair: () => void;
  onSuggestionDecision: CanonWorkspaceProps["onSuggestionDecision"];
  onAnalyzeSuggestion: CanonWorkspaceProps["onAnalyzeSuggestion"];
  suggestionBlocked: boolean;
  suggestion: CanonFixSuggestion | null;
}) {
  return (
    <div className="canon-detail-content">
      <div className="canon-detail-heading">
        <SeverityIcon severity={issue.severity} />
        <div>
          <span>{canonSeverity(issue.severity)} · {canonIssueStatus(issue.status)}</span>
          <h2>{localizeCanonText(issue.metadata.message_key, issue.metadata.message_parameters)}</h2>
          <code>{canonRule(issue.metadata.rule_id)} · {issue.metadata.rule_id} v{issue.metadata.rule_version}</code>
          {issue.metadata.issue_version === 2 ? (
            <code>{issue.metadata.diagnostic.domain} / {issue.metadata.diagnostic.fact_code}</code>
          ) : null}
        </div>
      </div>
      <DetailSection title={tr("canon.explanation")}>
        <p>{localizeCanonText(issue.metadata.message_key, issue.metadata.message_parameters)}</p>
      </DetailSection>
      <DetailSection title={tr("canon.recommendation")}>
        <p>{issue.metadata.recommendation_key
          ? localizeCanonText(issue.metadata.recommendation_key, issue.metadata.recommendation_parameters)
          : tr("canon.noRecommendation")}</p>
      </DetailSection>
      {issue.metadata.agent_explanation ? (
        <DetailSection title={tr("canon.agentExplanation")}>
          <p>{issue.metadata.agent_explanation}</p>
          {issue.metadata.agent_recommendation ? <p>{issue.metadata.agent_recommendation}</p> : null}
        </DetailSection>
      ) : null}
      <DetailSection title={tr("canon.targets")}>
        <ul className="canon-owner-list">
          {issue.metadata.targets.map((target) => (
            <li key={ownerKey(target)}>
              <div>
                <strong>{humanize(target.owner_type)}</strong>
                <span>{target.owner_id}</span>
                {target.context_type ? <small>{humanize(target.context_type)} · {target.context_id}</small> : null}
              </div>
              <div className="canon-owner-actions">
                <button disabled={!canNavigate(target)} onClick={() => onNavigate(target, "source")} title={!canNavigate(target) ? tr("canon.ownerUnavailable") : undefined} type="button"><ExternalLink size={12} aria-hidden="true" />{tr("canon.openSource")}</button>
                {target.owner_type === "node" || target.owner_type === "placement" ? (
                  <>
                    <button disabled={!canNavigate(target)} onClick={() => onNavigate(target, "graph")} type="button">{tr("workspace.graph")}</button>
                    <button disabled={!canNavigate(target)} onClick={() => onNavigate(target, "story")} type="button">{tr("workspace.story")}</button>
                    <button disabled={!canNavigate(target)} onClick={() => onNavigate(target, "flow")} type="button">{tr("workspace.flow")}</button>
                  </>
                ) : null}
                {["flow_transition", "flow_invocation", "flow_exit"].includes(target.owner_type) ? (
                  <button disabled={!canNavigate(target)} onClick={() => onNavigate(target, "story")} type="button">{tr("workspace.story")}</button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </DetailSection>
      <DetailSection title={tr("canon.evidence")}>
        <ol className="canon-evidence-list">
          {issue.metadata.evidence.map((evidence, index) => (
            <li data-canon-evidence-owner={evidence.owner.owner_id} key={`${ownerKey(evidence.owner)}-${evidence.field_path ?? index}`} tabIndex={-1}>
              <strong>{humanize(evidence.owner.owner_type)} · {evidence.owner.owner_id}</strong>
              <span>{evidence.field_path ?? tr("canon.recordEvidence")}</span>
              {evidence.excerpt ? <blockquote>{evidence.excerpt}</blockquote> : null}
              <small>{localizeCanonText(evidence.message_key, evidence.message_parameters)}</small>
            </li>
          ))}
        </ol>
      </DetailSection>
      <CanonIssueActions
        busy={busy}
        issue={issue}
        onNavigate={(owner) => onNavigate(owner, "source")}
        onRepair={onRepair}
        onReview={onReview}
      />
      {suggestion ? (
        <CanonSuggestionPreview busy={busy} issue={issue} onAnalyze={onAnalyzeSuggestion} onDecision={onSuggestionDecision} suggestion={suggestion} suggestionBlocked={suggestionBlocked} />
      ) : null}
    </div>
  );
}

/** Shows every immutable forward value before a Canon fix can be decided. */
function CanonSuggestionPreview({
  busy,
  issue,
  onAnalyze,
  onDecision,
  suggestion,
  suggestionBlocked
}: {
  busy: boolean;
  issue: CanonIssueProjection;
  onAnalyze: CanonWorkspaceProps["onAnalyzeSuggestion"];
  onDecision: CanonWorkspaceProps["onSuggestionDecision"];
  suggestion: CanonFixSuggestion;
  suggestionBlocked: boolean;
}) {
  const why = suggestion.why
    ?? issue.metadata.agent_explanation
    ?? localizeCanonText(issue.metadata.message_key, issue.metadata.message_parameters);
  const how = suggestion.how
    ?? issue.metadata.agent_recommendation
    ?? (issue.metadata.recommendation_key
      ? localizeCanonText(issue.metadata.recommendation_key, issue.metadata.recommendation_parameters)
      : tr("canon.suggestion.howFallback"));
  return (
    <section aria-label={tr("canon.suggestion.preview")} className="canon-suggestion-preview">
      <header>
        <strong>{tr("canon.suggestion.preview")}</strong>
        <span>{tr("canon.suggestion.changeCount", { count: suggestion.patch.operations.length })}</span>
      </header>
      <code>{suggestion.patch.source_checksum.slice(0, 12)}</code>
      <div className="canon-suggestion-rationale">
        <section><strong>{tr("canon.suggestion.why")}</strong><p>{why}</p></section>
        <section><strong>{tr("canon.suggestion.how")}</strong><p>{how}</p></section>
      </div>
      <details className="canon-suggestion-technical">
        <summary>{tr("canon.suggestion.technicalChanges")}</summary>
        <div className="canon-suggestion-operations">
          {suggestion.patch.operations.map((operation) => {
            const collection = "collection" in operation ? operation.collection : operation.op;
            const recordId = "record_id" in operation ? operation.record_id : tr("canon.suggestion.projectLevel");
            const forward = operation.op === "put_record"
              ? operation.record
              : operation.op === "replace_manifest"
                ? operation.manifest
                : operation.op === "replace_project_metadata"
                  ? operation.value
                  : { remove: operation.record_id };
            return (
              <details key={`${operation.op}:${collection}:${recordId}`}>
                <summary><strong>{collection}</strong><span>{recordId}</span></summary>
                <pre>{JSON.stringify(forward, null, 2)}</pre>
              </details>
            );
          })}
        </div>
      </details>
      {suggestion.status === "pending" ? (
        <div className="canon-suggestion-actions">
          <button className="canon-suggestion-action" data-impact-origin={`canon-suggestion:${suggestion.id}`} disabled={busy} onClick={(event) => onAnalyze(event.currentTarget)} type="button"><ScanSearch size={14} aria-hidden="true" />{tr("impact.analyzeChange")}</button>
          <button className="canon-suggestion-action" disabled={busy} onClick={() => onDecision("rejected")} type="button">{tr("authoring.reject")}</button>
          <button className="canon-suggestion-action" disabled={busy || suggestionBlocked} title={suggestionBlocked ? tr("impact.callerBlocked") : undefined} onClick={() => onDecision("approved")} type="button">{tr("authoring.approve")}</button>
        </div>
      ) : (
        <span className={`canon-suggestion-decision canon-suggestion-${suggestion.status}`}>
          {tr(`canon.suggestion.${suggestion.status}`)}
        </span>
      )}
    </section>
  );
}

function DetailSection({ children, title }: { children: ReactNode; title: string }) {
  return <section className="canon-detail-section"><h3>{title}</h3>{children}</section>;
}

function CanonMetric({ label, value }: { label: string; value: number }) {
  return <div><strong>{value}</strong><span>{label}</span></div>;
}

function CanonEmpty({ icon: Icon, spin = false, text }: { icon: LucideIcon; spin?: boolean; text: string }) {
  return <div className="canon-empty"><Icon className={spin ? "animate-spin" : ""} size={22} aria-hidden="true" /><span>{text}</span></div>;
}

function SeverityIcon({ severity }: { severity: CanonIssueProjection["severity"] }) {
  const Icon = severity === "critical" ? CircleStop : severity === "warning" ? AlertTriangle : CircleHelp;
  return <Icon aria-label={canonSeverity(severity)} className={`canon-severity canon-severity-${severity}`} size={17} role="img" />;
}

function canonRunStatus(run: CanonCheckRun | null): string {
  return i18next.t(`canon.runStatus.${run?.status ?? "idle"}`);
}

function canonIssueStatus(status: CanonIssueStatus): string {
  return i18next.t(`canon.issueStatus.${status}`);
}

function canonSeverity(severity: CanonIssueProjection["severity"]): string {
  return i18next.t(`canon.severity.${severity}`);
}

/** Localize runtime taxonomy while retaining readable fallbacks for future values. */
function canonCategory(category: string): string {
  return localizeRuntimeText(`canon.category.${category}`, {}, humanize(category));
}

function canonRule(ruleId: string): string {
  return localizeRuntimeText(`canon.rule.${ruleId}`, {}, humanize(ruleId));
}

function localizeCanonText(key: string, parameters: Record<string, unknown>): string {
  return localizeRuntimeText(key, parameters, humanize(key.split(".").at(-1) ?? key));
}

function humanize(value: string): string {
  return value.replace(/[._-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function ownerKey(owner: { context_id: string | null; context_type: string | null; owner_id: string; owner_type: string }): string {
  return `${owner.owner_type}:${owner.owner_id}:${owner.context_type ?? ""}:${owner.context_id ?? ""}`;
}

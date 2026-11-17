import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BookOpen,
  ChevronDown,
  CircleStop,
  LoaderCircle,
  LocateFixed,
  Play,
  RotateCcw,
  ScanSearch,
  X
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  IMPACT_DOMAINS,
  IMPACT_MAX_DEPTH,
  orderImpactFindings,
  type ImpactAnalysisRun,
  type ImpactDomain,
  type ImpactFinding,
  type ImpactPropagation,
  type ImpactRequestDirection,
  type ImpactResourceRef,
  type ImpactSeed,
  type ImpactSelectionIntent
} from "@something-to-tell/contracts/impact-analysis";
import {
  IMPACT_RESOLUTION_MAX_CONTEXT_CHARACTERS,
  IMPACT_RESOLUTION_MAX_FINDINGS,
  type ImpactResolutionRun,
  type ImpactVisualChange
} from "@something-to-tell/contracts/impact-resolution";
import { localizeRuntimeText, tr } from "../localization/i18n";
import type { AgentMemoryLocale, AgentMemoryScopeV1 } from "@something-to-tell/contracts/agent-memory";
import type { RuntimeAgentMemoryPersistence } from "../runtime/apiTypes";
import type {
  AgentMemoryDisclosureTarget,
  AgentMemoryDraftSeed
} from "../components/AgentMemoryDisclosure";
import {
  ImpactResolutionReview,
  type ImpactResolutionReviewProps
} from "./ImpactResolutionReview";

export interface ImpactRunOptions {
  depth: number;
  direction: ImpactRequestDirection;
  domains: ImpactDomain[];
  intent: ImpactSelectionIntent;
}

export interface ImpactWorkspaceProps {
  error: string | null;
  operation: "starting" | "cancelling" | null;
  run: ImpactAnalysisRun | null;
  seeds: ImpactSeed[];
  onCancel: () => void;
  onClear: () => void;
  onClose: () => void;
  onNavigate: (finding: ImpactFinding) => void;
  onOpenStory: () => void;
  onReproducePlayback: (finding: ImpactFinding) => void;
  onRun: (options: ImpactRunOptions) => void;
  onReturn?: () => void;
  originLabel?: string;
  scenarioType?: "selection" | "patch";
  initialIntent?: ImpactSelectionIntent;
  resourceLabel: (resource: ImpactResourceRef) => string;
  storyFindingCount: number;
  resolutionError?: string | null;
  resolutionInitiallyExpanded?: boolean;
  resolutionHistoryRevision?: number;
  resolutionOperation?: "starting" | "cancelling" | "approving" | "rejecting" | "editing" | null;
  resolutionProviderConfigured?: boolean;
  resolutionRun?: ImpactResolutionRun | null;
  onCancelResolution?: () => void;
  onApproveResolution?: ImpactResolutionReviewProps["onApprove"];
  onEditResolution?: ImpactResolutionReviewProps["onEdit"];
  onNavigateResolution?: (change: ImpactVisualChange) => void;
  onRejectResolution?: ImpactResolutionReviewProps["onReject"];
  onRunResolution?: (findingIds: string[], includeRejected: boolean) => void;
  onVerifyCanonResolution?: () => void;
  onVerifyImpactResolution?: () => void;
  resolutionVerificationPending?: boolean;
  memoryContentLocale?: AgentMemoryLocale;
  memoryPersistence?: RuntimeAgentMemoryPersistence;
  memorySessionId?: string;
  onCreateMemory?: (seed: AgentMemoryDraftSeed) => void;
  onManageMemory?: () => void;
}

const PROPAGATIONS: ImpactPropagation[] = ["required", "conditional", "contextual"];
const IMPACT_RESOLUTION_FINDING_BUDGET = Math.floor(IMPACT_RESOLUTION_MAX_CONTEXT_CHARACTERS * 0.6);

/** Reserves provider context capacity while retaining the closest stable findings first. */
export function boundedResolutionFindingIds(findings: ImpactFinding[]): string[] {
  const selected: string[] = [];
  let characters = 2;
  for (const finding of findings.slice(0, IMPACT_RESOLUTION_MAX_FINDINGS)) {
    const json = JSON.stringify(finding);
    // Python canonical JSON escapes each non-ASCII UTF-16 unit as six characters.
    let canonicalCharacters = json.length;
    for (let index = 0; index < json.length; index += 1) {
      if (json.charCodeAt(index) > 0x7f) canonicalCharacters += 5;
    }
    const nextCharacters = characters + canonicalCharacters + (selected.length ? 1 : 0);
    if (selected.length && nextCharacters > IMPACT_RESOLUTION_FINDING_BUDGET) break;
    selected.push(finding.id);
    characters = nextCharacters;
  }
  return selected;
}

/** Maps one explicit Impact seed to memory scope without inferring canvas context. */
export function impactMemoryTarget(
  seeds: ImpactSeed[],
  contentLocale: AgentMemoryLocale
): AgentMemoryDisclosureTarget {
  const projectScope = { scope_version: 1, kind: "project" } as const;
  if (seeds.length !== 1) return {
    agentId: "impact_resolver",
    contentLocale,
    contextScope: projectScope,
    scope: projectScope
  };
  const resource = seeds[0]!.resource;
  if (resource.owner_type === "story_flow") {
    const flowScope = { scope_version: 1, kind: "story_flow", flow_id: resource.owner_id } as const;
    return { agentId: "impact_resolver", contentLocale, contextScope: flowScope, scope: flowScope };
  }
  const scope: AgentMemoryScopeV1 = resource.owner_type === "node"
    ? { scope_version: 1, kind: "node", node_id: resource.owner_id }
    : projectScope;
  const contextScope = resource.context_type === "scene" && resource.context_id
    ? { scope_version: 1, kind: "scene", scene_node_id: resource.context_id } as const
    : resource.context_type === "flow" && resource.context_id
      ? { scope_version: 1, kind: "story_flow", flow_id: resource.context_id } as const
      : projectScope;
  return { agentId: "impact_resolver", contentLocale, contextScope, scope };
}

/** Non-modal, snapshot-bound review surface for deterministic dependency impact. */
export function ImpactWorkspace({
  error,
  operation,
  run,
  seeds,
  onCancel,
  onClear,
  onClose,
  onNavigate,
  onOpenStory,
  onReproducePlayback,
  onRun,
  onReturn,
  originLabel,
  resourceLabel,
  resolutionError = null,
  resolutionInitiallyExpanded = false,
  resolutionHistoryRevision = 0,
  resolutionOperation = null,
  resolutionProviderConfigured = false,
  resolutionRun = null,
  onCancelResolution = () => undefined,
  onApproveResolution = () => undefined,
  onEditResolution = () => undefined,
  onNavigateResolution = () => undefined,
  onRejectResolution = () => undefined,
  onRunResolution = () => undefined,
  onVerifyCanonResolution = () => undefined,
  onVerifyImpactResolution = () => undefined,
  resolutionVerificationPending = false,
  memoryContentLocale = "en",
  memoryPersistence,
  memorySessionId,
  onCreateMemory,
  onManageMemory,
  scenarioType = "selection",
  initialIntent = "modify",
  storyFindingCount
}: ImpactWorkspaceProps) {
  const resolutionFindingIds = useMemo(
    () => boundedResolutionFindingIds(run?.findings ?? []),
    [run?.findings]
  );
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [intent, setIntent] = useState<ImpactSelectionIntent>(initialIntent);
  const [direction, setDirection] = useState<ImpactRequestDirection>("both");
  const [depth, setDepth] = useState(3);
  const [domains, setDomains] = useState<ImpactDomain[]>([...IMPACT_DOMAINS]);
  const [propagations, setPropagations] = useState<ImpactPropagation[]>([...PROPAGATIONS]);

  useEffect(() => closeRef.current?.focus(), []);
  useEffect(() => setIntent(initialIntent), [initialIntent, scenarioType]);

  const findings = useMemo(
    () => orderImpactFindings(run?.findings ?? []).filter((finding) => propagations.includes(finding.propagation)),
    [propagations, run?.findings]
  );
  const grouped = useMemo(() => PROPAGATIONS.map((propagation) => ({
    propagation,
    findings: findings.filter((finding) => finding.propagation === propagation)
  })), [findings]);
  const playbackFindings = useMemo(
    () => orderImpactFindings(run?.findings.filter((finding) => finding.domain === "playback") ?? []),
    [run?.findings]
  );
  const busy = operation !== null || run?.status === "queued" || run?.status === "running";

  function toggleDomain(domain: ImpactDomain) {
    setDomains((current) => current.includes(domain)
      ? current.filter((candidate) => candidate !== domain)
      : IMPACT_DOMAINS.filter((candidate) => candidate === domain || current.includes(candidate)));
  }

  function togglePropagation(propagation: ImpactPropagation) {
    setPropagations((current) => current.includes(propagation)
      ? current.filter((candidate) => candidate !== propagation)
      : PROPAGATIONS.filter((candidate) => candidate === propagation || current.includes(candidate)));
  }

  /** Arrow keys traverse result rows without requiring a mouse. */
  function moveFindingFocus(directionDelta: -1 | 1) {
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-impact-finding]") ?? [])];
    if (!rows.length) return;
    const current = rows.indexOf(document.activeElement as HTMLElement);
    rows[Math.max(0, Math.min(rows.length - 1, current + directionDelta))]?.focus();
  }

  return (
    <aside aria-label={tr("impact.workspace")} className="impact-workspace">
      <header className="impact-workspace-header">
        <div>
          <span><ScanSearch size={16} aria-hidden="true" />{tr("impact.workspace")}</span>
          <strong>{tr("impact.seedCount", { count: seeds.length })}</strong>
        </div>
        <div className="impact-workspace-actions">
          <span className="impact-run-state" data-status={operation ?? run?.status ?? "idle"}>
            {tr(`impact.status.${operation ?? run?.status ?? "idle"}` as Parameters<typeof tr>[0])}
          </span>
          <button aria-label={tr("common.close")} className="icon-button" onClick={onClose} ref={closeRef} title={tr("common.close")} type="button">
            <X size={17} aria-hidden="true" />
          </button>
        </div>
      </header>

      <section aria-label={tr("impact.selection")} className="impact-seeds">
        <span>{tr("impact.selection")}</span>
        <div>
          {scenarioType === "patch" ? <span className="impact-seed"><small>{tr("impact.patch")}</small>{originLabel}</span>
            : seeds.length ? seeds.map((seed) => (
            <span className="impact-seed" key={resourceKey(seed.resource)}>
              <small>{resourceType(seed.resource)}</small>{resourceLabel(seed.resource)}
            </span>
          )) : <span className="impact-no-seed">{tr("impact.noSelection")}</span>}
        </div>
      </section>

      <section aria-label={tr("impact.controls")} className="impact-controls">
        {scenarioType === "selection" ? (
          <ControlGroup label={tr("impact.intent")}>
            <SegmentButton active={intent === "modify"} label={tr("impact.intent.modify")} onClick={() => setIntent("modify")} />
            <SegmentButton active={intent === "delete"} label={tr("impact.intent.delete")} onClick={() => setIntent("delete")} />
          </ControlGroup>
        ) : null}
        <ControlGroup label={tr("impact.direction")}>
          <SegmentButton active={direction === "upstream"} icon={<ArrowUp size={14} />} label={tr("impact.direction.upstream")} onClick={() => setDirection("upstream")} />
          <SegmentButton active={direction === "downstream"} icon={<ArrowDown size={14} />} label={tr("impact.direction.downstream")} onClick={() => setDirection("downstream")} />
          <SegmentButton active={direction === "both"} icon={<ArrowUpDown size={14} />} label={tr("impact.direction.both")} onClick={() => setDirection("both")} />
        </ControlGroup>
        <label className="impact-depth">
          <span>{tr("impact.depth")}</span>
          <input aria-label={tr("impact.depth")} max={IMPACT_MAX_DEPTH} min={1} onChange={(event) => setDepth(Number(event.target.value))} type="number" value={depth} />
        </label>
        <fieldset className="impact-domain-fieldset">
          <legend>{tr("impact.domains")}</legend>
          <div>
            {IMPACT_DOMAINS.map((domain) => (
              <label key={domain}>
                <input checked={domains.includes(domain)} onChange={() => toggleDomain(domain)} type="checkbox" />
                <span>{tr(`impact.domain.${domain}` as Parameters<typeof tr>[0])}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="impact-command-row">
          {busy ? (
            <button className="impact-secondary-command" disabled={operation === "cancelling"} onClick={onCancel} type="button">
              {operation === "cancelling" ? <LoaderCircle className="animate-spin" size={15} /> : <CircleStop size={15} />}
              {tr("common.cancel")}
            </button>
          ) : (
            <button className="impact-primary-command" disabled={(scenarioType === "selection" && !seeds.length) || !domains.length} onClick={() => onRun({ depth, direction, domains, intent })} type="button">
              <Play size={15} aria-hidden="true" />{tr("impact.run")}
            </button>
          )}
          <span className="tooltip-wrapper" data-tooltip={tr("impact.clearTooltip")}>
            <button aria-label={tr("impact.clear")} className="icon-button" disabled={!run && !error} onClick={onClear} type="button">
              <RotateCcw size={16} aria-hidden="true" />
            </button>
          </span>
        </div>
        {onReturn ? (
          <button
            className="impact-return-command"
            disabled={busy || run?.status === "stale"}
            onClick={onReturn}
            title={run?.status === "stale" ? tr("impact.returnStale") : tr("impact.returnToReview", { name: originLabel ?? tr("impact.review") })}
            type="button"
          >
            {tr("impact.returnToReview", { name: originLabel ?? tr("impact.review") })}
          </button>
        ) : null}
      </section>

      <section aria-live="polite" className="impact-result-state">
        {busy ? (
          <div className="impact-progress" role="status">
            <LoaderCircle className="animate-spin" size={18} aria-hidden="true" />
            <div><strong>{tr(operation === "cancelling" ? "impact.cancelling" : "impact.analyzing")}</strong><span>{tr("impact.progressDetail")}</span></div>
            <span aria-hidden="true"><span /></span>
          </div>
        ) : error ? (
          <div className="impact-message" data-tone="error" role="alert"><AlertTriangle size={17} />{error}</div>
        ) : run?.status === "stale" || run?.status === "failed" || run?.status === "cancelled" ? (
          <div className="impact-message" data-tone={run.status} role="status">
            <AlertTriangle size={17} />{runMessage(run)}
          </div>
        ) : run?.summary.truncated ? (
          <div className="impact-message" data-tone="warning" role="status">
            <AlertTriangle size={17} />{tr("impact.truncated", { count: run.summary.omitted_count })}
          </div>
        ) : <span className="impact-state-placeholder" aria-hidden="true" />}
      </section>

      {run?.status === "completed" ? (
        <ImpactResolutionReview
          error={resolutionError}
          findingIds={resolutionFindingIds}
          historyRevision={resolutionHistoryRevision}
          initiallyExpanded={resolutionInitiallyExpanded}
          memoryPersistence={memoryPersistence}
          memorySessionId={memorySessionId}
          memoryTarget={impactMemoryTarget(seeds, memoryContentLocale)}
          onApprove={onApproveResolution}
          onCancel={onCancelResolution}
          onCreateMemory={onCreateMemory}
          onEdit={onEditResolution}
          onManageMemory={onManageMemory}
          onNavigate={onNavigateResolution}
          onReject={onRejectResolution}
          onRun={onRunResolution}
          onVerifyCanon={onVerifyCanonResolution}
          onVerifyImpact={onVerifyImpactResolution}
          operation={resolutionOperation}
          providerConfigured={resolutionProviderConfigured}
          resourceLabel={resourceLabel}
          run={resolutionRun}
          totalFindingCount={run.findings.length}
          verificationPending={resolutionVerificationPending}
        />
      ) : null}

      <section aria-label={tr("impact.results")} className="impact-results">
        <div className="impact-summary">
          <Metric label={tr("impact.findings")} value={run?.summary.finding_count ?? 0} />
          <Metric label={tr("impact.direct")} value={run?.summary.direct_count ?? 0} />
          <Metric label={tr("impact.transitive")} value={run?.summary.transitive_count ?? 0} />
        </div>
        {run?.status === "completed" ? (
          <div aria-label={tr("impact.projections")} className="impact-experience-projections">
            <div>
              <BookOpen size={16} aria-hidden="true" />
              <span><strong>{tr("impact.storyProjection")}</strong><small>{storyFindingCount
                ? tr("impact.storyFindingCount", { count: storyFindingCount })
                : tr("impact.storyEmpty")}</small></span>
              <button aria-label={tr("impact.openStory")} disabled={!storyFindingCount} onClick={onOpenStory} title={tr("impact.openStory")} type="button">
                <BookOpen size={14} aria-hidden="true" />
              </button>
            </div>
            <div>
              <Play size={16} aria-hidden="true" />
              <span><strong>{tr("impact.playbackProjection")}</strong><small>{playbackFindings.length
                ? tr("impact.playbackFindingCount", { count: playbackFindings.length })
                : tr("impact.playbackEmpty")}</small></span>
              <button aria-label={tr("impact.reproduce")} disabled={!playbackFindings.length} onClick={() => playbackFindings[0] && onReproducePlayback(playbackFindings[0])} title={tr("impact.reproduce")} type="button">
                <Play size={14} aria-hidden="true" />
              </button>
            </div>
          </div>
        ) : null}
        <div aria-label={tr("impact.propagationFilter")} className="impact-propagation-filter">
          {PROPAGATIONS.map((propagation) => (
            <button aria-pressed={propagations.includes(propagation)} data-propagation={propagation} key={propagation} onClick={() => togglePropagation(propagation)} type="button">
              {tr(`impact.propagation.${propagation}` as Parameters<typeof tr>[0])}
              <strong>{run?.summary.propagation[propagation] ?? 0}</strong>
            </button>
          ))}
        </div>
        <div className="impact-findings" onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            moveFindingFocus(event.key === "ArrowDown" ? 1 : -1);
          }
        }} ref={listRef}>
          {!run ? <EmptyState title={tr("impact.readyTitle")} detail={tr("impact.readyDetail")} />
            : run.status === "completed" && run.summary.finding_count === 0 ? <EmptyState title={tr("impact.emptyTitle")} detail={tr("impact.emptyDetail")} />
              : grouped.map((group) => group.findings.length ? (
                <div className="impact-finding-group" data-propagation={group.propagation} key={group.propagation}>
                  <h3>{tr(`impact.propagation.${group.propagation}` as Parameters<typeof tr>[0])}<span>{group.findings.length}</span></h3>
                  {group.findings.map((finding) => <FindingRow finding={finding} key={finding.id} onNavigate={onNavigate} resourceLabel={resourceLabel} />)}
                </div>
              ) : null)}
        </div>
      </section>
    </aside>
  );
}

function ControlGroup({ children, label }: { children: ReactNode; label: string }) {
  return <div className="impact-control-group"><span>{label}</span><div>{children}</div></div>;
}

function SegmentButton({ active, icon, label, onClick }: { active: boolean; icon?: ReactNode; label: string; onClick: () => void }) {
  return <button aria-pressed={active} onClick={onClick} title={label} type="button">{icon}{label}</button>;
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div><strong>{value}</strong><span>{label}</span></div>;
}

function EmptyState({ detail, title }: { detail: string; title: string }) {
  return <div className="impact-empty"><ScanSearch size={23} aria-hidden="true" /><strong>{title}</strong><span>{detail}</span></div>;
}

function FindingRow({ finding, onNavigate, resourceLabel }: { finding: ImpactFinding; onNavigate: (finding: ImpactFinding) => void; resourceLabel: (resource: ImpactResourceRef) => string }) {
  const playback = finding.domain === "playback";
  const actionLabel = playback
    ? tr("impact.reproduceFinding", { name: resourceLabel(finding.target) })
    : tr("impact.openSource", { name: resourceLabel(finding.target) });
  return (
    <details className="impact-finding-row">
      <summary data-impact-finding>
        <span className="impact-finding-heading">
          <span className="impact-finding-title"><strong>{resourceLabel(finding.target)}</strong><small>{resourceType(finding.target)} · {tr(`impact.domain.${finding.domain}` as Parameters<typeof tr>[0])}</small></span>
          <span className="impact-distance">{tr("impact.distance", { count: finding.distance })}</span>
          <button
            aria-label={actionLabel}
            className="impact-finding-navigate"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onNavigate(finding);
            }}
            title={actionLabel}
            type="button"
          >
            {playback ? <Play size={14} aria-hidden="true" /> : <LocateFixed size={14} aria-hidden="true" />}
          </button>
          <ChevronDown size={16} aria-hidden="true" />
        </span>
        <p>{localized(finding.message_key, finding.message_parameters)}</p>
      </summary>
      <div className="impact-finding-detail">
        <dl><dt>{tr("impact.impactType")}</dt><dd>{humanize(finding.impact_type)}</dd><dt>{tr("impact.direction")}</dt><dd>{tr(`impact.direction.${finding.direction}` as Parameters<typeof tr>[0])}</dd></dl>
        <h4>{tr("impact.paths")}</h4>
        {finding.paths.map((path, pathIndex) => (
          <div className="impact-path" key={`${finding.id}-path-${pathIndex}`}>
            <ol>{path.resources.map((resource) => <li key={resourceKey(resource)}>{resourceLabel(resource)}</li>)}</ol>
            {path.dependencies.map((dependency, dependencyIndex) => (
              <div className="impact-dependency" key={`${dependency.kind}-${dependencyIndex}`}>
                <strong>{localized(dependency.message_key, dependency.message_parameters)}</strong>
                {dependency.evidence.map((evidence, evidenceIndex) => (
                  <p key={`${evidence.field_path}-${evidenceIndex}`}>
                    {localized(evidence.message_key, evidence.message_parameters)}
                    {evidence.field_path ? <code>{evidence.field_path}</code> : null}
                    {evidence.excerpt ? <q>{evidence.excerpt}</q> : null}
                  </p>
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
    </details>
  );
}

function runMessage(run: ImpactAnalysisRun): string {
  const diagnostic = run.diagnostics[0];
  if (diagnostic) return localized(diagnostic.message_key, diagnostic.parameters);
  return tr(`impact.statusMessage.${run.status}` as Parameters<typeof tr>[0]);
}

function localized(key: string, parameters: Record<string, unknown>): string {
  return localizeRuntimeText(key, parameters, humanize(key.split(".").at(-1) ?? key));
}

function resourceType(resource: ImpactResourceRef): string {
  return humanize(resource.owner_type);
}

function resourceKey(resource: ImpactResourceRef): string {
  return `${resource.owner_type}:${resource.owner_id}:${resource.context_type ?? ""}:${resource.context_id ?? ""}`;
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

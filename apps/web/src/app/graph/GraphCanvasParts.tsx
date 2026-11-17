import {
BaseEdge,
EdgeLabelRenderer,
Panel,
getBezierPath,
getSmoothStepPath,
useViewport,
type Edge,
type EdgeProps,
type Node,
type NodeProps
} from "@xyflow/react";
import {
ArrowDown,
ArrowRight,
ArrowUp,
BookOpen,
CircleHelp,
GitBranch,
Hand,
LocateFixed,
MousePointer2,
Pencil,
RotateCcw,
Save,
Search,
Share2,
Trash2,
User,
X,
type LucideIcon
} from "lucide-react";
import { memo,useEffect,useState,type CSSProperties,type ReactNode } from "react";
import { CanonDiagnosticMarker,canonFocusMatches,type CanonDiagnosticFocus } from "../../canon/CanonDiagnosticMarker";
import { type DialogueCanvasMetrics } from "../../dialogue/presentation";
import { type ImpactHighlight } from "../../impact/navigation";
import {
tr
} from "../../localization/i18n";
import { FLOW_TRANSITION_KINDS,type FlowIntegrityFact,type FlowTransition,type StoryFlowBootstrapDraft,type StoryFlowSnapshot } from "../../story-flow/contracts";
import {
flowRouteArcPath,
shiftedFlowLabelPosition,
type WorkspaceMode
} from "../../story-flow/workspace";
import {
type NarrativeEdgeData,
type NarrativeIssue,
type NarrativeNodeData,
type NarrativeRelationshipType
} from "../../types";

import { DialogShell,LabeledInput } from "../shared/DialogShell";
import { FlowTransitionEdit,GraphFilterState,ISSUE_COLORS,ISSUE_SEVERITIES,ISSUE_STATUSES,NODE_COLORS,NODE_KINDS,NODE_META,RelationshipInspection,ToolMode,displayNodeKind,displayRelationshipType,type NarrativeNodeRenderData } from "../workspaceShared";
import { NarrativeNode } from "./NarrativeNode";
export { NarrativeNode } from "./NarrativeNode";

export function ToolRail({ leftOffset, mode, onChange }: { leftOffset: number; mode: ToolMode; onChange: (mode: ToolMode) => void }) {
  // Select and Pan own pointer semantics; Scene/Location draw frames and other kinds remain click-created cards.
  const tools: Array<{ Icon: LucideIcon; mode: ToolMode; label: string; color?: string }> = [
    { mode: "select", label: tr("tool.select"), Icon: MousePointer2 },
    { mode: "pan", label: tr("tool.pan"), Icon: Hand },
    ...NODE_KINDS.map((kind) => kind === "Scene"
      ? { mode: "scene-frame" as const, label: tr("tool.sceneFrame"), Icon: NODE_META.Scene.Icon, color: NODE_COLORS.Scene }
      : kind === "Location"
        ? { mode: "location-frame" as const, label: tr("tool.locationFrame"), Icon: NODE_META.Location.Icon, color: NODE_COLORS.Location }
        : { mode: kind, label: displayNodeKind(kind), Icon: NODE_META[kind].Icon, color: NODE_COLORS[kind] })
  ];

  return (
    <nav className="tool-rail absolute top-4 z-30 flex flex-col gap-2 rounded-md border border-slate-200 bg-white p-2 shadow-md" style={{ left: leftOffset }}>
      {tools.map((tool) => {
        const Icon = tool.Icon;
        return (
          <span className="tooltip-wrapper tooltip-right" data-tooltip={tool.label} key={tool.mode}>
            <button
              aria-label={tool.label}
              className={`tool-button ${mode === tool.mode ? "tool-button-active" : ""}`}
              onClick={() => onChange(tool.mode)}
              style={tool.color ? ({ "--tool-color": tool.color } as CSSProperties) : undefined}
              type="button"
            >
              <Icon size={18} aria-hidden="true" />
            </button>
          </span>
        );
      })}
    </nav>
  );
}

export function GraphFilterBar({
  filters,
  leftOffset,
  onChange,
  resultCount,
  totalCount
}: {
  filters: GraphFilterState;
  leftOffset: number;
  onChange: (filters: GraphFilterState) => void;
  resultCount: number;
  totalCount: number;
}) {
  const activeKinds = new Set(filters.kinds);

  function toggleKind(kind: NarrativeNodeData["kind"]) {
    const nextKinds = activeKinds.has(kind) ? filters.kinds.filter((value) => value !== kind) : [...filters.kinds, kind];
    onChange({ ...filters, kinds: nextKinds });
  }

  function toggleIssueSeverity(severity: NarrativeIssue["severity"]) {
    const nextSeverities = filters.issueSeverities.includes(severity)
      ? filters.issueSeverities.filter((value) => value !== severity)
      : [...filters.issueSeverities, severity];
    onChange({ ...filters, issueSeverities: nextSeverities });
  }

  function toggleIssueStatus(status: NarrativeIssue["status"]) {
    const nextStatuses = filters.issueStatuses.includes(status)
      ? filters.issueStatuses.filter((value) => value !== status)
      : [...filters.issueStatuses, status];
    onChange({ ...filters, issueStatuses: nextStatuses });
  }

  return (
    <section className="absolute right-4 top-4 z-30 max-w-[calc(100%-96px)] rounded-md border border-slate-200 bg-white p-2 shadow-md" style={{ left: leftOffset }}>
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 text-slate-400" size={16} aria-hidden="true" />
          <input
            aria-label={tr("filters.searchGraph")}
            className="h-9 w-full rounded-md border border-slate-300 pl-8 pr-3 text-sm text-slate-800 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
            onChange={(event) => onChange({ ...filters, query: event.target.value })}
            placeholder={tr("filters.searchGraph")}
            value={filters.query}
          />
        </label>
        <div className="flex flex-wrap items-center gap-1">
          {NODE_KINDS.map((kind) => (
            <label className="kind-filter" key={kind} style={{ "--kind-color": NODE_COLORS[kind] } as CSSProperties}>
              <input checked={activeKinds.has(kind)} onChange={() => toggleKind(kind)} type="checkbox" />
              <span>{displayNodeKind(kind)}</span>
            </label>
          ))}
        </div>
        <div className="h-8 w-px bg-slate-200" aria-hidden="true" />
        <div className="flex flex-wrap items-center gap-1">
          {ISSUE_SEVERITIES.map((severity) => (
            <label className="kind-filter" key={severity} style={{ "--kind-color": ISSUE_COLORS[severity] } as CSSProperties}>
              <input checked={filters.issueSeverities.includes(severity)} onChange={() => toggleIssueSeverity(severity)} type="checkbox" />
              <span>{tr(`filters.${severity}` as keyof typeof import("../../localization/catalogs").enCatalog)}</span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {ISSUE_STATUSES.map((status) => (
            <label className="status-filter" key={status}>
              <input checked={filters.issueStatuses.includes(status)} onChange={() => toggleIssueStatus(status)} type="checkbox" />
              <span>{tr(`filters.${status}` as keyof typeof import("../../localization/catalogs").enCatalog)}</span>
            </label>
          ))}
        </div>
        <div className="min-w-16 text-right text-xs font-semibold text-slate-500">
          {resultCount}/{totalCount}
        </div>
        <button
          className="icon-button"
          onClick={() => onChange({ issueSeverities: ISSUE_SEVERITIES, issueStatuses: ["open", "review"], kinds: NODE_KINDS, query: "" })}
          title={tr("filters.reset")}
          type="button"
        >
          <RotateCcw size={16} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

export function EmptyProjectStart({
  error,
  leftOffset,
  loading,
  onBuildWorld,
  onCreateEvent,
  onCreateScene
}: {
  error: string | null;
  leftOffset: number;
  loading: StoryFlowBootstrapDraft["kind"] | null;
  onBuildWorld: () => void;
  onCreateEvent: () => void;
  onCreateScene: () => void;
}) {
  const SceneIcon = NODE_META.Scene.Icon;
  const EventIcon = NODE_META.Event.Icon;
  return (
    <section aria-label={tr("authoring.startEmptyProject")} className="empty-project-start" style={{ left: `calc(50% + ${leftOffset}px)` }}>
      <div className="empty-project-start-heading">
        <strong>{tr("authoring.startProject")}</strong>
      </div>
      <div className="empty-project-start-actions">
        <button autoFocus disabled={Boolean(loading)} onClick={onCreateScene} type="button">
          <SceneIcon aria-hidden="true" size={19} />
          <strong>{loading === "Scene" ? tr("authoring.creatingFirstScene") : tr("authoring.createFirstScene")}</strong>
          <ArrowRight aria-hidden="true" size={16} />
        </button>
        <button disabled={Boolean(loading)} onClick={onCreateEvent} type="button">
          <EventIcon aria-hidden="true" size={19} />
          <strong>{loading === "Event" ? tr("authoring.creatingStoryEvent") : tr("authoring.createStoryEvent")}</strong>
          <ArrowRight aria-hidden="true" size={16} />
        </button>
        <button disabled={Boolean(loading)} onClick={onBuildWorld} type="button">
          <BookOpen aria-hidden="true" size={19} />
          <strong>{tr("authoring.buildWorld")}</strong>
          <ArrowRight aria-hidden="true" size={16} />
        </button>
      </div>
      {error ? <p aria-live="polite" className="empty-project-start-error">{error}</p> : null}
    </section>
  );
}

export function WorkspaceModeControl({ mode, onChange }: { mode: WorkspaceMode; onChange: (mode: WorkspaceMode) => void }) {
  const modes: Array<{ Icon: LucideIcon; label: string; mode: WorkspaceMode }> = [
    { Icon: Share2, label: tr("workspace.graph"), mode: "relationships" },
    { Icon: BookOpen, label: tr("workspace.story"), mode: "story" },
    { Icon: GitBranch, label: tr("workspace.flow"), mode: "flow" }
  ];
  return (
    <div aria-label={tr("workspace.view")} className="workspace-mode-control" role="group">
      {modes.map(({ Icon, label, mode: value }) => (
        <button
          aria-pressed={mode === value}
          className={mode === value ? "workspace-mode-active" : ""}
          key={value}
          onClick={() => onChange(value)}
          title={tr("workspace.viewNamed", { name: label })}
          type="button"
        >
          <Icon size={14} aria-hidden="true" />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

/** Original-id DOM tags expose the existing route/portal to read-only geometry observation. */
export function StoryFlowEdge({
  data,
  id,
  markerEnd,
  sourcePosition,
  sourceX,
  sourceY,
  style,
  targetPosition,
  targetX,
  targetY
}: EdgeProps<Edge<NarrativeEdgeData>>) {
  const [path, labelX, labelY] = data?.flowRouteArc
    ? flowRouteArcPath(sourceX, sourceY, targetX, targetY)
    : getSmoothStepPath({
        sourcePosition,
        sourceX,
        sourceY,
        targetPosition,
        targetX,
        targetY
      });
  const transition = data?.flowTransition;
  const invocation = data?.flowInvocation;
  const labelOffset = data?.flowRouteLabelOffset ?? 0;
  const shiftedLabel = shiftedFlowLabelPosition(
    labelX,
    labelY,
    sourceX,
    sourceY,
    targetX,
    targetY,
    data?.flowRouteLabelLane ?? 0
  );
  const label = data?.label || transition?.kind || tr("flow.callFlow");
  const accessible = invocation
    ? `${tr("flow.callFlow")}: ${label}${invocation.invalid ? `, ${tr("flow.invalidCall")}` : ""}`
    : transition
    ? `${transition.kind} Story Flow transition${transition.condition ? ` when ${transition.condition}` : ""}${transition.isDefault ? ", default" : ""}`
    : "Story Flow transition";
  return (
    <>
      <BaseEdge data-narrative-edge-route={id} data-narrative-edge-label-state="present" id={id} markerEnd={markerEnd} path={path} style={style} />
      {data?.canonTarget ? <CanonEdgeHoverPath path={path} preview={data.canonIssuePreview ?? ""} /> : null}
      {data?.impactHighlight ? <ImpactEdgeHoverPath highlight={data.impactHighlight} path={path} /> : null}
      <EdgeLabelRenderer>
        <div
          aria-label={accessible}
          data-narrative-edge-label={id}
          className={`story-flow-edge-label ${invocation ? `story-flow-invocation${invocation.invalid ? " story-flow-invocation-invalid" : ""}` : `story-flow-edge-${transition?.kind ?? "next"}`}`}
          style={{ transform: `translate(-50%, -50%) translate(${shiftedLabel.x}px, ${shiftedLabel.y + labelOffset}px)` }}
          title={accessible}
        >
          {invocation ? <ArrowRight size={12} aria-hidden="true" /> : <GitBranch size={12} aria-hidden="true" />}
          <span>{label}</span>
          {transition?.isDefault || invocation?.isDefault ? <small>{tr("common.default")}</small> : null}
          {invocation?.invalid ? <small>{tr("flow.draft")}</small> : null}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

/** Keeps semantic labels above every SVG route without changing edge ownership. */
export function RelationshipEdge({
  data,
  id,
  label,
  markerEnd,
  sourcePosition,
  sourceX,
  sourceY,
  style,
  targetPosition,
  targetX,
  targetY
}: EdgeProps<Edge<NarrativeEdgeData>>) {
  const [path, labelX, labelY] = getBezierPath({
    sourcePosition,
    sourceX,
    sourceY,
    targetPosition,
    targetX,
    targetY
  });
  const visibleLabel = typeof label === "string" || typeof label === "number"
    ? String(label)
    : data?.label;
  return (
    <>
      <BaseEdge data-narrative-edge-route={id} data-narrative-edge-label-state={visibleLabel ? "present" : "none"} id={id} markerEnd={markerEnd} path={path} style={style} />
      {data?.canonTarget ? <CanonEdgeHoverPath path={path} preview={data.canonIssuePreview ?? ""} /> : null}
      {data?.impactHighlight ? <ImpactEdgeHoverPath highlight={data.impactHighlight} path={path} /> : null}
      {visibleLabel ? (
        <EdgeLabelRenderer>
          <div
            className="relationship-edge-label"
            data-narrative-edge-label={id}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            title={visibleLabel}
          >
            {visibleLabel}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

/** Adds an accessible wide hover target without occupying an edge label lane. */
export function CanonEdgeHoverPath({ path, preview }: { path: string; preview: string }) {
  return (
    <path aria-label={preview} className="canon-edge-hover-path" d={path} fill="none" role="img" stroke="transparent" strokeWidth={16}>
      <title>{preview}</title>
    </path>
  );
}

/** Reuses the SVG route as a wide tooltip target without adding another edge label. */
export function ImpactEdgeHoverPath({ highlight, path }: { highlight: ImpactHighlight; path: string }) {
  return (
    <path aria-label={highlight.preview} className="impact-edge-hover-path" d={path} data-impact-role={highlight.role} fill="none" role="img" stroke="transparent" strokeWidth={18}>
      <title>{highlight.preview}</title>
    </path>
  );
}

export const STORY_FLOW_EDGE_TYPES = { relationship: RelationshipEdge, storyFlow: StoryFlowEdge };

const NarrativeNodeCard = memo(NarrativeNode);

/** React Flow owns interaction flags/geometry; cards consume only their presentation inputs.
 * A narrow prop bridge uses React's normal comparison, not a comparator that can
 * silently ignore a newly consumed card prop. Context and local state remain live.
 */
export function NarrativeNodeRenderer({ id, data, selected, dragging, parentId }: NodeProps<Node<NarrativeNodeRenderData, "narrative">>) {
  return <NarrativeNodeCard id={id} data={data} selected={selected} dragging={dragging} parentId={parentId} />;
}

// Registration is independent of workspace data and must survive view refreshes.
export const NARRATIVE_NODE_TYPES = { narrative: NarrativeNodeRenderer };

/** Briefly exposes the current scale while React Flow handles wheel, pinch, and button zoom. */
export function CanvasZoomControl() {
  const { zoom } = useViewport();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(true);
    const timer = window.setTimeout(() => setVisible(false), 700);
    return () => window.clearTimeout(timer);
  }, [zoom]);

  return (
    <Panel
      aria-hidden={!visible}
      className="canvas-zoom-control"
      data-visible={visible ? "true" : "false"}
      position="bottom-left"
    >
      <output>{Math.round(zoom * 100)}%</output>
    </Panel>
  );
}

export function FlowViewSummary({
  facts,
  flow,
  onClose,
  onFocusFact
}: {
  facts: FlowIntegrityFact[];
  flow: StoryFlowSnapshot | null;
  onClose: () => void;
  onFocusFact: (nodeId: string) => void;
}) {
  if (!flow) {
    return (
      <section aria-label={tr("flow.summary")} className="flow-view-summary">
        <div><strong>{tr("authoring.noFlowSelected")}</strong><FlowSummaryCloseButton onClose={onClose} /></div>
        <span>{tr("authoring.selectFlowHint")}</span>
      </section>
    );
  }
  const actionable = facts.filter((fact) => fact.level !== "info");
  const endings = facts.filter((fact) => fact.code === "ending");
  const preview = [...facts].sort((left, right) => integrityLevelOrder(left.level) - integrityLevelOrder(right.level)).slice(0, 4);
  return (
    <section aria-label={tr("flow.summary")} className="flow-view-summary">
      <div><GitBranch size={15} aria-hidden="true" /><strong>{flow.flow.name}</strong><span>{flow.flow.kind}</span><FlowSummaryCloseButton onClose={onClose} /></div>
      <span className="sr-only">{tr("authoring.integrity")}</span>
      <p>{tr("flow.summaryCounts", { endings: endings.length, facts: actionable.length, members: flow.nodes.length, transitions: flow.transitions.length })}</p>
      {preview.map((fact) => {
        const ownerId = fact.node_id ?? fact.scene_node_id ?? fact.container_node_id;
        return (
          <button
            data-level={fact.level}
            disabled={!ownerId}
            key={`${fact.code}:${fact.transition_id ?? fact.placement_id ?? fact.relationship_id ?? ownerId ?? "flow"}`}
            onClick={() => ownerId && onFocusFact(ownerId)}
            title={fact.action}
            type="button"
          >
            <CircleHelp size={13} aria-hidden="true" />
            <span><strong>{integrityFactLabel(fact.code)}</strong><small>{fact.message}</small></span>
          </button>
        );
      })}
    </section>
  );
}

/** Closes the reserved summary strip while the header toggle remains available. */
export function FlowSummaryCloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button aria-label={tr("flow.hideSummary")} className="flow-summary-close" onClick={onClose} title={tr("flow.hideSummary")} type="button">
      <X size={14} aria-hidden="true" />
    </button>
  );
}

export function integrityLevelOrder(level: FlowIntegrityFact["level"]) {
  return level === "error" ? 0 : level === "warning" ? 1 : 2;
}

export function integrityFactLabel(code: FlowIntegrityFact["code"]) {
  return code.split("_").map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`).join(" ");
}

export function FlowTransitionPanel({
  canonFocus,
  flow,
  nodes,
  onDelete,
  onEdit,
  onMove,
  transition
}: {
  canonFocus?: CanonDiagnosticFocus | null;
  flow: StoryFlowSnapshot;
  nodes: Node<NarrativeNodeData>[];
  onDelete: () => void;
  onEdit: () => void;
  onMove: (direction: -1 | 1) => void;
  transition: FlowTransition;
}) {
  const titleFor = (id: string) => nodes.find((node) => (node.data.canonicalNodeId ?? node.id) === id)?.data.title ?? id;
  const siblings = flow.transitions.filter((item) => item.source_node_id === transition.source_node_id).sort((left, right) => left.priority - right.priority);
  const index = siblings.findIndex((item) => item.id === transition.id);
  return (
    <section aria-label={tr("flow.transitionDetails")} className={`relationship-panel ${canonFocusMatches(canonFocus ?? null, transition.id) ? "canon-specialized-owner-target" : ""}`} data-canon-issue-target={canonFocusMatches(canonFocus ?? null, transition.id) || undefined} data-canon-owner-id={transition.id} tabIndex={-1}>
      {canonFocusMatches(canonFocus ?? null, transition.id) ? <CanonDiagnosticMarker focus={canonFocus!} /> : null}
      <div className="mb-3 flex items-center gap-2">
        <GitBranch className="text-teal-700" size={17} aria-hidden="true" />
        <div><strong className="block text-sm">{tr("flow.order")}</strong><span className="text-xs text-slate-500">{flow.flow.name}</span></div>
      </div>
      <div className="flow-transition-route">
        <strong>{titleFor(transition.source_node_id)}</strong>
        <ArrowRight size={14} aria-hidden="true" />
        <strong>{titleFor(transition.target_node_id)}</strong>
      </div>
      <dl className="flow-transition-details">
        <div><dt>{tr("common.kind")}</dt><dd>{tr(`flow.${transition.kind}` as keyof typeof import("../../localization/catalogs").enCatalog)}</dd></div>
        <div><dt>{tr("common.priority")}</dt><dd>{transition.priority}</dd></div>
        <div><dt>{tr("common.default")}</dt><dd>{transition.is_default ? tr("common.yes") : tr("common.none")}</dd></div>
        <div><dt>{tr("common.condition")}</dt><dd>{transition.condition || tr("common.none")}</dd></div>
        <div><dt>{tr("common.label")}</dt><dd>{transition.label || tr("common.none")}</dd></div>
      </dl>
      <div className="mt-3 flex gap-2 border-t border-slate-200 pt-3">
        <button aria-label={tr("flow.editTransition")} className="icon-button" onClick={onEdit} title={tr("flow.editTransition")} type="button"><Pencil size={15} aria-hidden="true" /></button>
        <button aria-label={tr("flow.moveEarlier")} className="icon-button" disabled={index <= 0} onClick={() => onMove(-1)} title={tr("flow.moveEarlier")} type="button"><ArrowUp size={15} aria-hidden="true" /></button>
        <button aria-label={tr("flow.moveLater")} className="icon-button" disabled={index < 0 || index >= siblings.length - 1} onClick={() => onMove(1)} title={tr("flow.moveLater")} type="button"><ArrowDown size={15} aria-hidden="true" /></button>
        <button className="ml-auto inline-flex items-center gap-1 rounded border border-red-200 px-2 py-1 text-xs font-semibold text-red-700" onClick={onDelete} type="button"><Trash2 size={13} aria-hidden="true" />{tr("common.remove")}</button>
      </div>
    </section>
  );
}

export function EditFlowTransitionDialog({
  effects,
  flow,
  nodes,
  onClose,
  onSave,
  transition
}: {
  effects?: ReactNode;
  flow: StoryFlowSnapshot;
  nodes: Node<NarrativeNodeData>[];
  onClose: () => void;
  onSave: (updates: FlowTransitionEdit) => void | Promise<void>;
  transition: FlowTransition;
}) {
  const [sourceNodeId, setSourceNodeId] = useState(transition.source_node_id);
  const [targetNodeId, setTargetNodeId] = useState(transition.target_node_id);
  const [kind, setKind] = useState(transition.kind);
  const [label, setLabel] = useState(transition.label);
  const [condition, setCondition] = useState(transition.condition);
  const [isDefault, setIsDefault] = useState(transition.is_default);
  const [validationError, setValidationError] = useState<string | null>(null);
  const titleFor = (nodeId: string) => nodes.find((node) => (node.data.canonicalNodeId ?? node.id) === nodeId)?.data.title ?? nodeId;
  const members = [...flow.nodes].sort((left, right) => left.presentation_order - right.presentation_order);

  return (
    <DialogShell onClose={onClose} title={tr("flow.editTransition")}>
      <form className="space-y-3" onSubmit={(event) => {
        event.preventDefault();
        if (sourceNodeId === targetNodeId) {
          setValidationError(tr("flow.distinctEndpoints"));
          return;
        }
        if (kind === "branch" && !isDefault && !condition.trim()) {
          setValidationError(tr("flow.branchConditionRequired"));
          return;
        }
        setValidationError(null);
        void onSave({
          condition: condition.trim(),
          is_default: isDefault,
          kind,
          label: label.trim(),
          source_node_id: sourceNodeId,
          target_node_id: targetNodeId
        });
      }}>
        <label className="block text-sm font-semibold text-slate-700">
          {tr("common.source")}
          <select className="mt-1 h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm" onChange={(event) => setSourceNodeId(event.target.value)} value={sourceNodeId}>
            {members.map((member) => <option key={member.node_id} value={member.node_id}>{titleFor(member.node_id)}</option>)}
          </select>
        </label>
        <label className="block text-sm font-semibold text-slate-700">
          {tr("common.target")}
          <select className="mt-1 h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm" onChange={(event) => setTargetNodeId(event.target.value)} value={targetNodeId}>
            {members.map((member) => <option key={member.node_id} value={member.node_id}>{titleFor(member.node_id)}</option>)}
          </select>
        </label>
        <label className="block text-sm font-semibold text-slate-700">
          {tr("flow.transitionType")}
          <select className="mt-1 h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm" onChange={(event) => setKind(event.target.value as FlowTransition["kind"])} value={kind}>
            {FLOW_TRANSITION_KINDS.map((value) => <option key={value} value={value}>{tr(`flow.${value}` as keyof typeof import("../../localization/catalogs").enCatalog)}</option>)}
          </select>
        </label>
        <LabeledInput label={tr("common.label")} onChange={setLabel} value={label} />
        <LabeledInput label={tr("common.condition")} onChange={setCondition} value={condition} />
        <label className="flex items-center gap-2 text-sm font-semibold text-slate-700">
          <input checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} type="checkbox" />
          {tr("common.default")}
        </label>
        {validationError ? <p className="text-sm font-semibold text-red-700" role="alert">{validationError}</p> : null}
        {effects}
        <button className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white" type="submit">
          <Save size={16} aria-hidden="true" />
          {tr("common.save")}
        </button>
      </form>
    </DialogShell>
  );
}



export function RelationshipPanel({
  inspection,
  onFocusNeighborhood,
  onFocusNode
}: {
  inspection: RelationshipInspection;
  onFocusNeighborhood: () => void;
  onFocusNode: (node: Node<NarrativeNodeData>) => void;
}) {
  return (
    <aside className="relationship-panel" aria-label={tr("authoring.relationshipInspection")}>
      <div className="mb-3 flex items-center gap-2 border-b border-slate-200 pb-2">
        <GitBranch className="text-slate-500" size={16} aria-hidden="true" />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-slate-800">{tr("authoring.relationships")}</div>
          <div className="truncate text-xs text-slate-500">{inspection.itemTitle}</div>
        </div>
      </div>
      {inspection.type === "node" ? (
        <div className="space-y-3">
          <button className="relationship-row" onClick={onFocusNeighborhood} type="button">
            <LocateFixed size={14} aria-hidden="true" />
            <span className="font-semibold text-slate-700">{tr("workspace.focusNeighborhood")}</span>
          </button>
          <RelationshipList direction={tr("authoring.incoming")} items={inspection.incoming} onFocusNode={onFocusNode} />
          <RelationshipList direction={tr("authoring.outgoing")} items={inspection.outgoing} onFocusNode={onFocusNode} />
        </div>
      ) : inspection.edge ? (
        <div className="space-y-3 text-xs">
          <RelationshipField label={tr("common.type")} relationshipType value={inspection.edge.type} />
          <RelationshipField label={tr("common.label")} value={inspection.edge.label || tr("common.unlabelled")} />
          {inspection.edge.dialogueElementId ? <RelationshipField label={tr("authoring.dialogueOrigin")} value={inspection.edge.dialogueElementId} /> : null}
          <RelationshipEndpoint label={tr("common.source")} node={inspection.edge.source} onFocusNode={onFocusNode} />
          <RelationshipEndpoint label={tr("common.target")} node={inspection.edge.target} onFocusNode={onFocusNode} />
        </div>
      ) : null}
    </aside>
  );
}

export function RelationshipList({
  direction,
  items,
  onFocusNode
}: {
  direction: string;
  items: Array<{ edgeId: string; label: string; node: Node<NarrativeNodeData> }>;
  onFocusNode: (node: Node<NarrativeNodeData>) => void;
}) {
  return (
    <section>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{direction}</div>
      {items.length > 0 ? (
        <div className="space-y-1">
          {items.map((item) => (
            <button className="relationship-row" key={`${direction}-${item.edgeId}`} onClick={() => onFocusNode(item.node)} type="button">
              <MousePointer2 size={14} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-left">
                <span className="font-semibold text-slate-700">{item.node.data.title}</span>
                <span className="ml-1 text-slate-500">{item.label || tr("authoring.relationshipFallback")}</span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs text-slate-500">{tr("authoring.noRelationships")}</div>
      )}
    </section>
  );
}

export function RelationshipEndpoint({
  label,
  node,
  onFocusNode
}: {
  label: string;
  node: Node<NarrativeNodeData> | null;
  onFocusNode: (node: Node<NarrativeNodeData>) => void;
}) {
  return (
    <div>
      <div className="mb-1 font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      {node ? (
        <button className="relationship-row" onClick={() => onFocusNode(node)} type="button">
          <MousePointer2 size={14} aria-hidden="true" />
          <span className="truncate text-left font-semibold text-slate-700">{node.data.title}</span>
        </button>
      ) : (
        <div className="rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-slate-500">{tr("authoring.missingNode")}</div>
      )}
    </div>
  );
}

export function RelationshipField({ label, relationshipType = false, value }: { label: string; relationshipType?: boolean; value: string }) {
  return (
    <div>
      <div className="mb-1 font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className="rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-slate-700">{relationshipType ? displayRelationshipType(value as NarrativeRelationshipType) : value}</div>
    </div>
  );
}

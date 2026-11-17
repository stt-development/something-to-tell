import { Handle, NodeResizer, Position, type Node, type NodeProps } from "@xyflow/react";
import { ArrowRight, ChevronDown, ChevronUp, CircleHelp, CircleStop, Flag, GitBranch, Layers, Link2, Maximize2, Minimize2, Plus, Share2, ShieldCheck } from "lucide-react";
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { tr } from "../../localization/i18n";
import { ISSUE_COLORS, MIN_FRAME_SIZE, NODE_COLORS, NODE_META, displayNodeKind, type NarrativeNodeRenderData } from "../workspaceShared";
import { isCompactSemanticKind } from "./graphProjection";
import { useNodeDetailPresentation } from "./CanvasNodePresentation";
import { ReducedNodeDetail } from "./ReducedNodeDetail";
import { CausalRolePreview, DialogueNodeCanvasSummary, FactionMemberPreview, FrameDescriptionControl, NodeDescriptionPreview, SemanticNodePreview, setIssueTooltipLayer } from "./GraphNodeContent";

// One node-card presentation surface; graph identity/geometry and commands stay with their owners.
export type NarrativeNodeCardProps = Pick<NodeProps<Node<NarrativeNodeRenderData, "narrative">>,
  "data" | "selected" | "id" | "dragging" | "parentId">;

export function NarrativeNode({ data, selected, id, dragging, parentId }: NarrativeNodeCardProps) {
  // Locale is a presentation input even when authored data and RF props are equal.
  useTranslation();
  const { presentation, reveal } = useNodeDetailPresentation(id);
  const [focused, setFocused] = useState(false);
  const article = useRef<HTMLElement | null>(null);
  const focusTarget = useRef<string | null | undefined>(undefined);
  // Review controls must be available on the same commit as their diagnostic,
  // before the presentation bridge publishes its updated ancestor protection.
  const fullPresentation = presentation.mode === "full" || selected || dragging || focused || data.isConnectionSource || data.isConnectionTarget
    || Boolean(data.analysisPreview || data.canonTarget || data.impactHighlight);
  useLayoutEffect(() => {
    if (!fullPresentation || focusTarget.current === undefined) return;
    const token = focusTarget.current; focusTarget.current = undefined;
    const target = [...(article.current?.querySelectorAll<HTMLElement>("[data-node-focus]") ?? [])].find((element) => element.dataset.nodeFocus === token);
    // Preserve keyboard focus across a reduced/full subtree replacement without selecting or editing.
    (target ?? article.current)?.focus();
  }, [fullPresentation]);
  const color = NODE_COLORS[data.kind];
  const NodeIcon = NODE_META[data.kind].Icon;
  const connectionClass = data.isConnectionSource ? "narrative-node-connecting-source" : data.isConnectionTarget ? "narrative-node-connecting-target" : "";
  const analysisClass = data.analysisPreview ? "narrative-node-analysis" : "";
  const canonClass = data.canonTarget
    ? `narrative-node-canon narrative-node-canon-${data.canonIssueSeverity ?? "info"} narrative-node-canon-${data.canonIssueStatus ?? "open"}`
    : "";
  const impactClass = data.impactHighlight ? `narrative-node-impact narrative-node-impact-${data.impactHighlight.role}` : "";
  const issueColor = data.issueSeverity ? ISSUE_COLORS[data.issueSeverity] : undefined;
  const isCollapsedFrame = data.isFrame && data.presentationState === "collapsed";
  const foldedPreview = presentation.foldedDescendants > 0
    ? tr("canvasDetail.foldedCount", { direct: presentation.foldedDirect, count: presentation.foldedDescendants }) : "";
  const frameCountPreview = [data.frameContentCounts?.tooltip, foldedPreview].filter(Boolean).join(". ");
  const renderedKind = data.isFrame
    ? tr(data.kind === "Scene" ? "tool.sceneFrame" : "tool.locationFrame")
    : displayNodeKind(data.kind);
  const hasNodeActions = Boolean(
    data.onAddToFlow
    || data.onContinueFlow
    || data.onCallFlow
    || data.onCreateFlowExit
    || data.onConfigureSceneBoundary
    || (data.onSetFlowEntry && !data.flowRole?.entry)
    || data.isFrame
  );

  return (
    <article
      ref={article}
      tabIndex={focused ? -1 : undefined}
      aria-label={data.title}
      data-node-presentation={fullPresentation ? "full" : presentation.mode}
      data-node-detail-depth={presentation.depth ?? undefined}
      data-node-folded-direct={presentation.foldedDirect}
      data-node-folded-descendants={presentation.foldedDescendants}
      onFocusCapture={(event) => {
        if (!fullPresentation) {
          focusTarget.current = (event.target as HTMLElement).closest<HTMLElement>("[data-node-focus]")?.dataset.nodeFocus ?? null;
          reveal();
        }
        setFocused(true);
      }}
      onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as HTMLElement | null)) setFocused(false); }}
      className={`narrative-node ${data.kind === "Dialogue" ? "narrative-node-dialogue" : ""} ${isCompactSemanticKind(data.kind) ? "narrative-node-semantic" : ""} ${data.kind === "Condition" || data.kind === "Consequence" ? "narrative-node-causal" : ""} ${data.isFrame ? "narrative-node-frame" : ""} ${isCollapsedFrame ? "narrative-node-frame-collapsed" : ""} ${data.compositionDropState ? (data.compositionDropState.valid ? "narrative-frame-drop-valid" : "narrative-frame-drop-invalid") : ""} ${connectionClass} ${analysisClass} ${canonClass} ${impactClass}`}
      data-node-frame-state={data.isFrame ? data.presentationState ?? "expanded" : undefined}
      data-node-kind={data.kind}
      data-node-linked={data.isLinkedInstance || undefined}
      data-node-nested={Boolean(parentId) || undefined}
      style={{ "--node-color": color } as CSSProperties}
    >
      <NodeResizer
        color={color}
        isVisible={Boolean(selected) && !isCollapsedFrame}
        minHeight={data.isFrame && !isCollapsedFrame ? MIN_FRAME_SIZE.height : 120}
        minWidth={data.isFrame && !isCollapsedFrame ? MIN_FRAME_SIZE.width : 220}
        onResizeEnd={data.onResizeEnd}
        onResizeStart={data.onResizeStart}
      />
      <Handle className="narrative-handle narrative-handle-top" id="top" position={Position.Top} type="source" />
      <Handle className="narrative-handle narrative-handle-right" id="right" position={Position.Right} type="source" />
      <Handle className="narrative-handle narrative-handle-bottom" id="bottom" position={Position.Bottom} type="source" />
      <Handle className="narrative-handle narrative-handle-left" id="left" position={Position.Left} type="source" />
      {!fullPresentation && presentation.mode !== "shell" ? <ReducedNodeDetail data={data} presentation={presentation}
        onReveal={data.isFrame && data.onFocusFrame ? data.onFocusFrame : reveal} /> : null}
      {fullPresentation ? <>
      {data.canonTarget ? (
        <span
          aria-label={data.canonIssuePreview}
          className="canon-node-target-indicator"
          data-preview={data.canonIssuePreview}
          onBlur={(event) => setIssueTooltipLayer(event.currentTarget, false)}
          onFocus={(event) => setIssueTooltipLayer(event.currentTarget, true)}
          onMouseEnter={(event) => setIssueTooltipLayer(event.currentTarget, true)}
          onMouseLeave={(event) => setIssueTooltipLayer(event.currentTarget, false)}
          role="img"
          tabIndex={0}
        >
          <ShieldCheck size={12} aria-hidden="true" />
        </span>
      ) : null}
      {data.impactHighlight ? (
        <span
          aria-label={data.impactHighlight.preview}
          className="impact-node-target-indicator"
          data-impact-role={data.impactHighlight.role}
          data-preview={data.impactHighlight.preview}
          onBlur={(event) => setIssueTooltipLayer(event.currentTarget, false)}
          onFocus={(event) => setIssueTooltipLayer(event.currentTarget, true)}
          onMouseEnter={(event) => setIssueTooltipLayer(event.currentTarget, true)}
          onMouseLeave={(event) => setIssueTooltipLayer(event.currentTarget, false)}
          role="img"
          tabIndex={0}
        >
          {data.impactHighlight.role === "seed" ? "S" : data.impactHighlight.role === "direct" ? "1" : "2+"}
        </span>
      ) : null}
      {data.analysisPreview || data.flowRole || data.sceneBoundarySummary || data.callContext || data.flowCalls?.length || data.flowExits?.length ? (
        <div className="node-floating-status">
          {data.analysisPreview ? (
            <button
              aria-label={tr("flow.reviewAnalysis")}
              className="analysis-badge"
              data-preview={data.analysisPreview}
              onBlur={(event) => setIssueTooltipLayer(event.currentTarget, false)}
              onClick={(event) => {
                event.stopPropagation();
                const operationIndex = data.analysisOperationIndexes?.[0];
                if (operationIndex !== undefined) data.onOpenAnalysis?.(operationIndex);
              }}
              onFocus={(event) => setIssueTooltipLayer(event.currentTarget, true)}
              onMouseEnter={(event) => setIssueTooltipLayer(event.currentTarget, true)}
              onMouseLeave={(event) => setIssueTooltipLayer(event.currentTarget, false)}
              title={tr("flow.reviewAnalysis")}
              type="button"
            >
              {tr("authoring.analysis")}
            </button>
          ) : null}
          {data.flowRole ? (
            <div className="flow-node-roles" aria-label={tr("flow.role")}>
              {data.flowRole.entry ? <span aria-label={tr("authoring.entry")} className="flow-role-entry tooltip-wrapper" data-tooltip={tr("authoring.entry")} tabIndex={0}><Flag size={11} aria-hidden="true" />{tr("authoring.entry")}</span> : null}
              {data.flowRole.branch ? <span aria-label={tr("authoring.branch")} className="tooltip-wrapper" data-tooltip={tr("authoring.branch")} tabIndex={0}><GitBranch size={11} aria-hidden="true" />{tr("authoring.branch")}</span> : null}
              {data.flowRole.ending ? <span aria-label={tr("authoring.ending")} className="tooltip-wrapper" data-tooltip={tr("authoring.ending")} tabIndex={0}><CircleStop size={11} aria-hidden="true" />{tr("authoring.ending")}</span> : null}
              {data.flowRole.unreachable ? <span aria-label={tr("authoring.unreachable")} className="flow-role-warning tooltip-wrapper" data-tooltip={tr("authoring.unreachable")} tabIndex={0}><CircleHelp size={11} aria-hidden="true" />{tr("authoring.unreachable")}</span> : null}
            </div>
          ) : null}
          {data.callContext ? (
            <div className="flow-call-context"><ArrowRight size={11} aria-hidden="true" />{tr("flow.calledEntry", { flow: data.callContext })}</div>
          ) : null}
          {data.flowCalls?.map((call) => (
            <button
              aria-label={tr("flow.editCallNamed", { name: call.label })}
              className="flow-call-status tooltip-wrapper tooltip-top"
              data-tooltip={tr("flow.editCallNamed", { name: call.label })}
              key={call.id}
              onClick={(event) => { event.stopPropagation(); call.onOpen(); }}
              type="button"
            >
              <ArrowRight size={11} aria-hidden="true" />{tr("flow.callsNamed", { flow: call.label })}
            </button>
          ))}
          {data.flowExits?.map((flowExit) => (
            <div className="flow-exit-status" key={flowExit.id}><CircleStop size={11} aria-hidden="true" />{flowExit.label || flowExit.key}</div>
          ))}
          {data.sceneBoundarySummary ? (
            <div className="scene-boundary-status" aria-label={tr("flow.sceneBoundary")}>
              <span><ArrowRight size={11} aria-hidden="true" />{tr("authoring.entryNamed", { name: data.sceneBoundarySummary.entry })}</span>
              <span><Share2 size={11} aria-hidden="true" />{tr("authoring.exitCount", { count: data.sceneBoundarySummary.exits })}</span>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="narrative-node-title" title={`${renderedKind}: ${data.title}`}>
        <NodeIcon className="narrative-node-title-icon" size={15} aria-hidden="true" />
        <span className="narrative-node-title-text">{renderedKind}: {data.title}</span>
        <div className="narrative-node-title-meta">
          {data.isFrame && ((data.frameContentCounts?.total ?? 0) > 0 || presentation.foldedDescendants > 0) ? (
            <span
              aria-label={frameCountPreview}
              className="frame-content-count tooltip-wrapper tooltip-top"
              data-node-focus="folded-count"
              data-tooltip={frameCountPreview}
              onBlur={(event) => setIssueTooltipLayer(event.currentTarget, false)}
              onFocus={(event) => setIssueTooltipLayer(event.currentTarget, true)}
              onMouseEnter={(event) => setIssueTooltipLayer(event.currentTarget, true)}
              onMouseLeave={(event) => setIssueTooltipLayer(event.currentTarget, false)}
              tabIndex={0}
            >
              {presentation.foldedDescendants > 0 ? <><Layers size={11} aria-hidden="true" />{presentation.foldedDescendants}</> : data.frameContentCounts?.total}
            </span>
          ) : null}
          {data.isLinkedInstance ? (
            <span
              aria-label={tr("authoring.linkedInstance")}
              className="linked-instance-indicator tooltip-wrapper tooltip-top"
              data-node-focus="linked"
              data-tooltip={tr("authoring.linkedInstance")}
              onBlur={(event) => setIssueTooltipLayer(event.currentTarget, false)}
              onFocus={(event) => setIssueTooltipLayer(event.currentTarget, true)}
              onMouseEnter={(event) => setIssueTooltipLayer(event.currentTarget, true)}
              onMouseLeave={(event) => setIssueTooltipLayer(event.currentTarget, false)}
              role="img"
              tabIndex={0}
            >
              <Link2 size={13} aria-hidden="true" />
            </span>
          ) : null}
          {data.issueCount ? (
            <span
              aria-label={tr("authoring.issueCount", { count: data.issueCount })}
              className="issue-badge"
              data-preview={data.issuePreview}
              onBlur={(event) => setIssueTooltipLayer(event.currentTarget, false)}
              onFocus={(event) => setIssueTooltipLayer(event.currentTarget, true)}
              onMouseEnter={(event) => setIssueTooltipLayer(event.currentTarget, true)}
              onMouseLeave={(event) => setIssueTooltipLayer(event.currentTarget, false)}
              style={{ "--issue-color": issueColor } as CSSProperties}
              tabIndex={0}
            >
              {data.issueCount}
            </span>
          ) : null}
        </div>
        {hasNodeActions ? (
          <div className="narrative-frame-actions nodrag">
            {data.onAddToFlow ? (
              <button aria-label={tr("authoring.addToFlowNamed", { flow: data.activeFlowName, name: data.title })} className="narrative-frame-action tooltip-wrapper tooltip-top" data-tooltip={tr("authoring.addToFlowNamed", { flow: data.activeFlowName, name: data.title })} onClick={(event) => { event.stopPropagation(); data.onAddToFlow?.(); }} type="button">
                <GitBranch size={14} aria-hidden="true" />
              </button>
            ) : null}
            {data.onContinueFlow ? (
              <button aria-label={tr("flow.continueFrom", { name: data.title })} className="narrative-frame-action tooltip-wrapper tooltip-top" data-tooltip={tr("flow.continueFrom", { name: data.title })} onClick={(event) => { event.stopPropagation(); data.onContinueFlow?.(); }} type="button">
                <Plus size={14} aria-hidden="true" />
              </button>
            ) : null}
            {data.onCallFlow ? (
              <button aria-label={tr("flow.callFrom", { name: data.title })} className="narrative-frame-action tooltip-wrapper tooltip-top" data-tooltip={tr("flow.callFrom", { name: data.title })} onClick={(event) => { event.stopPropagation(); data.onCallFlow?.(); }} type="button">
                <ArrowRight size={14} aria-hidden="true" />
              </button>
            ) : null}
            {data.onCreateFlowExit ? (
              <button aria-label={tr("flow.createExitFrom", { name: data.title })} className="narrative-frame-action tooltip-wrapper tooltip-top" data-tooltip={tr("flow.createExitFrom", { name: data.title })} onClick={(event) => { event.stopPropagation(); data.onCreateFlowExit?.(); }} type="button">
                <CircleStop size={14} aria-hidden="true" />
              </button>
            ) : null}
            {data.onConfigureSceneBoundary ? (
              <button aria-label={tr("flow.configureSceneNamed", { name: data.title })} className="narrative-frame-action tooltip-wrapper tooltip-top" data-tooltip={tr("flow.configureSceneNamed", { name: data.title })} onClick={(event) => { event.stopPropagation(); data.onConfigureSceneBoundary?.(); }} type="button">
                <Share2 size={14} aria-hidden="true" />
              </button>
            ) : null}
            {data.onSetFlowEntry && !data.flowRole?.entry ? (
              <button aria-label={tr("flow.setNamedEntry", { name: data.title })} className="narrative-frame-action tooltip-wrapper tooltip-top" data-tooltip={tr("flow.setNamedEntry", { name: data.title })} onClick={(event) => { event.stopPropagation(); data.onSetFlowEntry?.(); }} type="button">
                <Flag size={14} aria-hidden="true" />
              </button>
            ) : null}
            {data.isFrame ? (
              <>
                <FrameDescriptionControl summary={data.summary} title={data.title} />
                <button aria-label={tr("authoring.addLinkedNode", { name: data.title })} className="narrative-frame-action" onClick={(event) => { event.stopPropagation(); data.onAddLinked?.(); }} title={tr("authoring.addLinkedNodeAction")} type="button">
                  <Link2 size={14} aria-hidden="true" />
                </button>
                <button aria-label={tr(isCollapsedFrame ? "authoring.expandNamed" : "authoring.collapseNamed", { name: data.title })} className="narrative-frame-action" onClick={(event) => { event.stopPropagation(); data.onToggleCollapse?.(); }} title={tr(isCollapsedFrame ? "authoring.expandNamed" : "authoring.collapseNamed", { name: displayNodeKind(data.kind) })} type="button">
                  {isCollapsedFrame ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronUp size={14} aria-hidden="true" />}
                </button>
                <button aria-label={tr("authoring.fitContentNamed", { name: data.title })} className="narrative-frame-action" disabled={Boolean(isCollapsedFrame)} onClick={(event) => { event.stopPropagation(); data.onFitContent?.(); }} title={tr("authoring.fitContent")} type="button">
                  <Minimize2 size={14} aria-hidden="true" />
                </button>
                <button aria-label={tr("authoring.focusNamed", { name: data.title })} data-node-focus="open" className="narrative-frame-action" onClick={(event) => { event.stopPropagation(); data.onFocusFrame?.(); }} title={tr("authoring.openFocusedWorkspace", { kind: displayNodeKind(data.kind) })} type="button">
                  <Maximize2 size={14} aria-hidden="true" />
                </button>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      {data.compositionDropState ? <div className="composition-drop-label">{data.compositionDropState.message}</div> : null}
      <div className="narrative-node-content">
        {data.kind === "Dialogue" && data.dialogueMetrics ? (
          <DialogueNodeCanvasSummary metrics={data.dialogueMetrics} summary={data.summary} title={data.title} />
        ) : (
          <>
            {data.isFrame ? (
              <p aria-label={tr("authoring.descriptionFor", { name: data.title })} className="narrative-node-summary frame-node-description">
                {data.summary}
              </p>
            ) : <NodeDescriptionPreview className="narrative-node-summary" summary={data.summary} title={data.title} />}
            {isCompactSemanticKind(data.kind) ? <SemanticNodePreview data={data} /> : null}
            {data.kind === "Faction" ? <FactionMemberPreview members={data.factionMembers ?? []} /> : null}
            {data.kind === "Condition" || data.kind === "Consequence" ? <CausalRolePreview data={data} /> : null}
            <div className="narrative-node-tags mt-3 flex flex-wrap gap-1">
              {data.tags.map((tag) => (
                <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] text-slate-500" key={tag}>
                  {tag}
                </span>
              ))}
            </div>
          </>
        )}
      </div>
      </> : null}
    </article>
  );
}

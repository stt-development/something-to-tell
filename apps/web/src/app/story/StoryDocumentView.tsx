import type { NarrativeEffectOwnerRef } from "@something-to-tell/contracts/narrative-state";
import {
type Node
} from "@xyflow/react";
import {
ArrowRight,
BookOpen,
ChevronDown,
ChevronRight,
CircleStop,
Flag,
GitBranch,
GitCompareArrows,
LayoutPanelTop,
Maximize2,
Pencil,
RotateCcw,
ScanSearch,
Share2
} from "lucide-react";
import { useEffect,useState,type CSSProperties } from "react";
import { CanonDiagnosticMarker,canonFocusMatches,type CanonDiagnosticFocus } from "../../canon/CanonDiagnosticMarker";
import { type ImpactHighlight } from "../../impact/navigation";
import {
tr
} from "../../localization/i18n";
import { temporalEffectsForOwner,type TemporalEffectPresentation,type TemporalStateProjection,type TemporalStateValue } from "../../narrative-state/projection";
import { type FlowTransition,type StoryFlowSnapshot } from "../../story-flow/contracts";
import { type StoryDocumentCall,type StoryDocumentExit,type StoryDocumentProjection,type StoryDocumentSection } from "../../story-flow/storyDocument";
import {
type NarrativeNodeData
} from "../../types";

import { LabeledInput } from "../shared/DialogShell";
import { NODE_META,displayNodeKind,displayRelationshipType } from "../workspaceShared";

export function StoryDocumentView({
  canonFocus,
  document,
  effectProjection,
  flow,
  impactHighlights,
  leftOffset,
  nodes,
  onEditNode,
  onOpenEffectOwner,
  onOpenFlow,
  onOpenNode,
  onUpdateNode,
  onUpdateTransition
}: {
  canonFocus?: CanonDiagnosticFocus | null;
  document: StoryDocumentProjection;
  effectProjection: TemporalStateProjection;
  flow: StoryFlowSnapshot | null;
  impactHighlights: Map<string, ImpactHighlight>;
  leftOffset: number;
  nodes?: Node<NarrativeNodeData>[];
  onEditNode: (node: Node<NarrativeNodeData>) => void;
  onOpenEffectOwner: (owner: NarrativeEffectOwnerRef) => void;
  onOpenFlow: (flowId: string, nodeId?: string) => void;
  onOpenNode: (node: Node<NarrativeNodeData>, mode: "flow" | "relationships") => void;
  onUpdateNode: (node: Node<NarrativeNodeData>, title: string, summary: string) => void;
  onUpdateTransition: (transition: FlowTransition, updates: Pick<FlowTransition, "condition" | "label">) => void;
}) {
  const canonicalNodes = new Map((nodes ?? document.sections.map((section) => section.node)).map((node) => [node.data.canonicalNodeId ?? node.id, node]));
  const [collapsedCalls, setCollapsedCalls] = useState<Set<string>>(new Set());
  useEffect(() => setCollapsedCalls(new Set()), [flow?.flow.id]);
  const visibleEntries = document.entries.filter((entry) => {
    const entryPath = entry.callPath.join(">");
    return ![...collapsedCalls].some((callKey) => entryPath === callKey || entryPath.startsWith(`${callKey}>`));
  });
  return (
    <section aria-label={tr("story.document")} className="story-document-workspace" data-temporal-effect-count={effectProjection.effects.length} style={{ left: leftOffset }}>
      <div className="story-document">
        <header className="story-document-header">
          <span>{tr("story.flowKind", { kind: flow ? tr(`flow.${flow.flow.kind}` as keyof typeof import("../../localization/catalogs").enCatalog) : tr("workspace.story") })}</span>
          <h2>{flow?.flow.name ?? tr("authoring.noFlowSelected")}</h2>
          <p>{flow?.flow.description || tr("story.selectToBegin")}</p>
        </header>
        {!flow || document.sections.length === 0 ? (
          <div className="story-document-empty">
            <BookOpen size={22} aria-hidden="true" />
            <strong>{flow ? tr("story.noReadableEntry") : tr("story.noActiveFlow")}</strong>
            <p>{flow ? tr("story.addEntryHint") : tr("story.selectFlowHint")}</p>
          </div>
        ) : (
          <div aria-label={tr("story.beatsNamed", { name: flow.flow.name })} className="story-document-beats">
            {visibleEntries.map((entry) => entry.kind === "call" ? (
              <StoryDocumentCallMarker
                canonFocus={canonFocus}
                collapsed={collapsedCalls.has(storyDocumentCallKey(entry))}
                call={entry}
                effects={temporalEffectsForOwner(effectProjection, { owner_version: 1, owner_kind: "flow_invocation", owner_id: entry.invocation.id })}
                key={entry.id}
                onOpenFlow={onOpenFlow}
                onOpenEffectOwner={onOpenEffectOwner}
                onToggle={() => setCollapsedCalls((current) => {
                  // The full path keeps a reused nested call independently collapsible at each appearance.
                  const callKey = storyDocumentCallKey(entry);
                  const next = new Set(current);
                  next.has(callKey) ? next.delete(callKey) : next.add(callKey);
                  return next;
                })}
              />
            ) : entry.kind === "exit" ? (
              <StoryDocumentExitMarker canonFocus={canonFocus} effects={temporalEffectsForOwner(effectProjection, { owner_version: 1, owner_kind: "flow_exit", owner_id: entry.flowExit.id })} exit={entry} key={entry.id} onOpenEffectOwner={onOpenEffectOwner} onOpenFlow={onOpenFlow} />
            ) : (
              <StoryDocumentBeat
                canonFocus={canonFocus}
                canonicalNodes={canonicalNodes}
                effectProjection={effectProjection}
                impactHighlight={impactHighlights.get(entry.node.data.canonicalNodeId ?? entry.node.id)}
                key={entry.id}
                onEditNode={onEditNode}
                onOpenFlow={onOpenFlow}
                onOpenEffectOwner={onOpenEffectOwner}
                onOpenNode={onOpenNode}
                onUpdateNode={onUpdateNode}
                onUpdateTransition={onUpdateTransition}
                section={entry}
              />
            ))}
          </div>
        )}
        {document.unreachable.length > 0 ? (
          <aside aria-label={tr("story.unreachableMembers")} className="story-document-unreachable">
            <h3>{tr("authoring.unreachableMembers")}</h3>
            <p>{tr("authoring.unreachableHint")}</p>
            {document.unreachable.map((node) => (
              <button key={node.id} onClick={() => onOpenNode(node, "flow")} type="button">
                <span>{displayNodeKind(node.data.kind)}</span>
                <strong>{node.data.title}</strong>
                <ArrowRight size={14} aria-hidden="true" />
              </button>
            ))}
          </aside>
        ) : null}
      </div>
    </section>
  );
}

/** Identifies one rendered call occurrence without introducing a persisted presentation id. */
export function storyDocumentCallKey(call: StoryDocumentCall) {
  return [...call.callPath, call.invocation.id].join(">");
}

/** Marks one call site and controls session-only expansion of its referenced Flow. */
export function StoryDocumentCallMarker({ call, canonFocus, collapsed, effects, onOpenEffectOwner, onOpenFlow, onToggle }: { call: StoryDocumentCall; canonFocus?: CanonDiagnosticFocus | null; collapsed: boolean; effects: TemporalEffectPresentation[]; onOpenEffectOwner: (owner: NarrativeEffectOwnerRef) => void; onOpenFlow: (flowId: string, nodeId?: string) => void; onToggle: () => void }) {
  const targetName = call.targetFlow?.flow.name ?? call.invocation.target_flow_id;
  return (
    <section aria-label={tr("story.calledFlowNamed", { name: targetName })} className={`story-call-marker ${canonFocusMatches(canonFocus ?? null, call.invocation.id) ? "canon-specialized-owner-target" : ""}`} data-call-id={call.invocation.id} data-canon-issue-target={canonFocusMatches(canonFocus ?? null, call.invocation.id) || undefined} data-canon-owner-id={call.invocation.id} tabIndex={-1}>
      {canonFocusMatches(canonFocus ?? null, call.invocation.id) ? <CanonDiagnosticMarker focus={canonFocus!} /> : null}
      <div className="story-call-heading">
        <button aria-expanded={!collapsed} aria-label={tr(collapsed ? "story.expandCalledFlow" : "story.collapseCalledFlow", { name: targetName })} onClick={onToggle} type="button">
          {collapsed ? <ChevronRight size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
        </button>
        <GitBranch size={16} aria-hidden="true" />
        <div><span>{tr("story.callsFrom", { name: call.sourceNode.data.title })}</span><strong>{call.invocation.label || targetName}</strong></div>
        {call.targetFlow ? <button className="story-source-link" onClick={() => onOpenFlow(call.targetFlow!.flow.id, call.targetFlow!.flow.entry_node_id ?? undefined)} type="button">{tr("story.openFlowNamed", { name: targetName })}<ArrowRight size={14} aria-hidden="true" /></button> : null}
      </div>
      <StoryBreadcrumbs breadcrumbs={call.breadcrumbs} onOpenFlow={onOpenFlow} />
      <StoryTemporalEffects effects={effects} onOpenOwner={onOpenEffectOwner} />
      {call.cycle ? <p className="story-call-warning">{tr("story.callCycle")}</p> : !call.targetFlow?.flow.entry_node_id ? <p className="story-call-warning">{tr("story.calledFlowMissingEntry")}</p> : null}
    </section>
  );
}

/** Presents a named callee result and its immediate caller continuation. */
export function StoryDocumentExitMarker({ canonFocus, effects, exit, onOpenEffectOwner, onOpenFlow }: { canonFocus?: CanonDiagnosticFocus | null; effects: TemporalEffectPresentation[]; exit: StoryDocumentExit; onOpenEffectOwner: (owner: NarrativeEffectOwnerRef) => void; onOpenFlow: (flowId: string, nodeId?: string) => void }) {
  const owner = exit.breadcrumbs.at(-1);
  const caller = exit.breadcrumbs.at(-2);
  return (
    <section aria-label={tr("story.namedExit", { name: exit.flowExit.label || exit.flowExit.key })} className={`story-exit-marker ${exit.binding ? "story-exit-mapped" : "story-exit-draft"} ${canonFocusMatches(canonFocus ?? null, exit.flowExit.id) ? "canon-specialized-owner-target" : ""}`} data-canon-issue-target={canonFocusMatches(canonFocus ?? null, exit.flowExit.id) || undefined} data-canon-owner-id={exit.flowExit.id} tabIndex={-1}>
      {canonFocusMatches(canonFocus ?? null, exit.flowExit.id) ? <CanonDiagnosticMarker focus={canonFocus!} /> : null}
      <CircleStop size={16} aria-hidden="true" />
      <div>
        <span>{tr("story.exitKey", { key: exit.flowExit.key })}</span>
        <strong>{exit.flowExit.label || exit.flowExit.key}</strong>
        <small>{exit.targetNode ? tr("story.returnsTo", { name: exit.targetNode.data.title }) : tr("story.unmappedExit")}</small>
      </div>
      <div className="story-exit-effects"><StoryTemporalEffects effects={effects} onOpenOwner={onOpenEffectOwner} /></div>
      {owner ? <button aria-label={tr("story.openExitSource")} onClick={() => onOpenFlow(owner.flowId, exit.flowExit.source_node_id)} type="button"><GitBranch size={14} aria-hidden="true" />{tr("story.exitSource")}</button> : null}
      {caller && exit.targetNode ? <button aria-label={tr("story.openReturnTarget")} onClick={() => onOpenFlow(caller.flowId, exit.targetNode!.id)} type="button"><RotateCcw size={14} aria-hidden="true" />{tr("story.returnTarget")}</button> : null}
    </section>
  );
}

/** Keeps nested call context readable without indenting the document column. */
export function StoryBreadcrumbs({ breadcrumbs, onOpenFlow }: { breadcrumbs: StoryDocumentCall["breadcrumbs"]; onOpenFlow: (flowId: string, nodeId?: string) => void }) {
  return (
    <nav aria-label={tr("story.flowBreadcrumbs")} className="story-flow-breadcrumbs">
      {breadcrumbs.map((breadcrumb, index) => (
        <span key={`${breadcrumb.flowId}:${index}`}>
          {index > 0 ? <ChevronRight size={12} aria-hidden="true" /> : null}
          <button onClick={() => onOpenFlow(breadcrumb.flowId)} type="button">{breadcrumb.name}</button>
        </span>
      ))}
    </nav>
  );
}

export function StoryDocumentBeat({
  canonFocus,
  canonicalNodes,
  effectProjection,
  impactHighlight,
  onEditNode,
  onOpenEffectOwner,
  onOpenFlow,
  onOpenNode,
  onUpdateNode,
  onUpdateTransition,
  section
}: {
  canonFocus?: CanonDiagnosticFocus | null;
  canonicalNodes: Map<string, Node<NarrativeNodeData>>;
  effectProjection: TemporalStateProjection;
  impactHighlight?: ImpactHighlight;
  onEditNode: (node: Node<NarrativeNodeData>) => void;
  onOpenEffectOwner: (owner: NarrativeEffectOwnerRef) => void;
  onOpenFlow: (flowId: string, nodeId?: string) => void;
  onOpenNode: (node: Node<NarrativeNodeData>, mode: "flow" | "relationships") => void;
  onUpdateNode: (node: Node<NarrativeNodeData>, title: string, summary: string) => void;
  onUpdateTransition: (transition: FlowTransition, updates: Pick<FlowTransition, "condition" | "label">) => void;
  section: StoryDocumentSection;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(section.node.data.title);
  const [summary, setSummary] = useState(section.node.data.summary);
  const [editingTransition, setEditingTransition] = useState(false);
  const [transitionLabel, setTransitionLabel] = useState(section.via?.label ?? "");
  const [condition, setCondition] = useState(section.via?.condition ?? "");
  const meta = NODE_META[section.node.data.kind];
  const Icon = meta.Icon;
  const canonicalNodeId = section.node.data.canonicalNodeId ?? section.node.id;
  const transitionEffects = temporalEffectsForOwner(effectProjection, section.via ? { owner_version: 1, owner_kind: "flow_transition", owner_id: section.via.id } : null);
  const nodeEffects = temporalEffectsForOwner(effectProjection, { owner_version: 1, owner_kind: "node_entry", owner_id: canonicalNodeId });
  // Depth is semantic context only; the document column stays geometrically flat.
  const depthMarker = section.depth > 0 ? (
    <span
      aria-label={tr("story.branchDepth", { depth: section.depth })}
      className="story-depth-marker"
    >
      {section.depth}
    </span>
  ) : null;

  return (
    <article
      aria-label={`${displayNodeKind(section.node.data.kind)}: ${section.node.data.title}`}
      className={`story-document-beat ${section.reference ? "story-document-reference" : ""} ${canonFocusMatches(canonFocus ?? null, canonicalNodeId) ? "canon-specialized-owner-target" : ""}`}
      data-canon-issue-target={canonFocusMatches(canonFocus ?? null, canonicalNodeId) || undefined}
      data-canon-owner-id={canonicalNodeId}
      data-story-depth={section.depth}
      data-story-node-id={section.node.data.canonicalNodeId ?? section.node.id}
      style={{ "--story-color": meta.color } as CSSProperties}
      tabIndex={-1}
    >
      {canonFocusMatches(canonFocus ?? null, canonicalNodeId) ? <CanonDiagnosticMarker focus={canonFocus!} /> : null}
      {impactHighlight ? (
        <span aria-label={impactHighlight.preview} className="story-impact-marker" data-impact-role={impactHighlight.role} data-preview={impactHighlight.preview} tabIndex={0}>
          <ScanSearch size={12} aria-hidden="true" />
          {tr(`impact.highlight.${impactHighlight.role}`)}
        </span>
      ) : null}
      {section.via ? (
        <div className={`story-route-label ${canonFocusMatches(canonFocus ?? null, section.via.id) ? "canon-specialized-owner-target" : ""}`} data-canon-issue-target={canonFocusMatches(canonFocus ?? null, section.via.id) || undefined} data-canon-owner-id={section.via.id} tabIndex={-1}>
          {canonFocusMatches(canonFocus ?? null, section.via.id) ? <CanonDiagnosticMarker focus={canonFocus!} /> : null}
          <GitBranch size={13} aria-hidden="true" />
          {depthMarker}
          <strong>{section.via.label || section.via.kind.replace(/_/g, " ")}</strong>
          <span>{tr(`flow.${section.via.kind}` as keyof typeof import("../../localization/catalogs").enCatalog)}{section.via.is_default ? ` · ${tr("story.default")}` : ""}</span>
          {section.via.condition ? <code>{section.via.condition}</code> : null}
          {!section.reference ? (
            <button aria-label={tr("flow.editTransitionTo", { name: section.node.data.title })} onClick={() => setEditingTransition((value) => !value)} title={tr("flow.editTransitionText")} type="button">
              <Pencil size={13} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : section.returnFrom ? (
        <div className="story-route-label"><RotateCcw size={13} aria-hidden="true" />{depthMarker}<strong>{tr("story.returnedVia", { name: section.returnFrom.exitLabel })}</strong></div>
      ) : section.boundarySceneId ? (
        <div className="story-route-label"><LayoutPanelTop size={13} aria-hidden="true" />{depthMarker}<strong>{tr("workspace.composition")}</strong></div>
      ) : <div className="story-route-entry"><Flag size={13} aria-hidden="true" /> {tr("authoring.entry")}</div>}
      {editingTransition && section.via ? (
        <form className="story-transition-inline" onSubmit={(event) => {
          event.preventDefault();
          onUpdateTransition(section.via!, { label: transitionLabel.trim(), condition: condition.trim() });
          setEditingTransition(false);
        }}>
          <LabeledInput label={tr("flow.transitionLabel")} onChange={setTransitionLabel} value={transitionLabel} />
          <LabeledInput label={tr("common.condition")} onChange={setCondition} value={condition} />
          <button className="story-inline-save" type="submit">{tr("authoring.saveTransition")}</button>
        </form>
      ) : null}
      <StoryTemporalEffects effects={transitionEffects} onOpenOwner={onOpenEffectOwner} />
      {section.reference ? (
        <button className="story-reference-link" onClick={() => onOpenFlow(section.flowId, section.node.id)} type="button">
          <RotateCcw size={15} aria-hidden="true" />
          {tr(section.reference === "cycle" ? "story.returnTo" : "story.rejoinAt")} <strong>{section.node.data.title}</strong>
        </button>
      ) : (
        <>
          <div className="story-beat-heading">
            <div className="story-beat-kind"><Icon size={15} aria-hidden="true" />{displayNodeKind(section.node.data.kind)}</div>
            <div className="story-beat-actions">
              <button aria-label={tr("authoring.editNodeNamedInline", { name: section.node.data.title })} onClick={() => setEditing((value) => !value)} title={tr("authoring.editText")} type="button"><Pencil size={14} aria-hidden="true" /></button>
              <button aria-label={tr("authoring.openNodeEditor", { name: section.node.data.title })} onClick={() => onEditNode(section.node)} title={tr("authoring.openFullEditor")} type="button"><Maximize2 size={14} aria-hidden="true" /></button>
              <button aria-label={tr("authoring.openNodeInGraph", { name: section.node.data.title })} onClick={() => onOpenNode(section.node, "relationships")} title={tr("authoring.openInGraph")} type="button"><Share2 size={14} aria-hidden="true" /></button>
              <button aria-label={tr("authoring.openNodeInFlow", { name: section.node.data.title })} onClick={() => onOpenFlow(section.flowId, section.node.id)} title={tr("authoring.openInFlow")} type="button"><GitBranch size={14} aria-hidden="true" /></button>
            </div>
          </div>
          {editing ? (
            <form className="story-node-inline" onSubmit={(event) => {
              event.preventDefault();
              onUpdateNode(section.node, title.trim(), summary.trim());
              setEditing(false);
            }}>
              <LabeledInput label={tr("common.title")} onChange={setTitle} value={title} />
              <label>{tr("common.description")}<textarea onChange={(event) => setSummary(event.target.value)} value={summary} /></label>
              <button className="story-inline-save" disabled={!title.trim()} type="submit">{tr("authoring.saveText")}</button>
            </form>
          ) : (
            <>
              <h3>{section.node.data.title}</h3>
              <p className="story-beat-summary">{section.node.data.summary || tr("authoring.noDescription")}</p>
              <StoryTypeDetails canonicalNodes={canonicalNodes} effectProjection={effectProjection} node={section.node} onOpenEffectOwner={onOpenEffectOwner} />
            </>
          )}
          {section.semanticContext.length > 0 ? (
            <details className="story-semantic-context">
              <summary>{tr("story.semanticContext", { count: section.semanticContext.length })}</summary>
              <ul>
                {section.semanticContext.map((context, index) => (
                  <li key={`${context.counterpartId}:${context.relationshipType}:${index}`}>
                    <span>{tr(context.direction === "outgoing" ? "story.to" : "story.from")} {context.counterpartTitle}</span>
                    <strong>{displayRelationshipType(context.relationshipType)}</strong>
                    {context.label !== context.relationshipType ? <small>{context.label}</small> : null}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <StoryTemporalEffects effects={nodeEffects} onOpenOwner={onOpenEffectOwner} />
        </>
      )}
    </article>
  );
}

export function StoryTypeDetails({ canonicalNodes, effectProjection, node, onOpenEffectOwner }: { canonicalNodes: Map<string, Node<NarrativeNodeData>>; effectProjection: TemporalStateProjection; node: Node<NarrativeNodeData>; onOpenEffectOwner: (owner: NarrativeEffectOwnerRef) => void }) {
  const data = node.data;
  const contextNodeId = data.canonicalNodeId ?? node.id;
  if (data.kind === "Dialogue" && data.dialogueDocument) {
    return (
      <div className="story-dialogue-lines">
        {data.dialogueDocument.elements.map((element) => {
          const elementEffects = temporalEffectsForOwner(effectProjection, { owner_version: 1, owner_kind: "dialogue_element", owner_id: element.id, context_node_id: contextNodeId });
          return element.kind === "line" ? (
            <div className="story-specialized-step" key={element.id}><p><strong>{canonicalNodes.get(element.speaker_node_id)?.data.title ?? tr("story.unknownSpeaker")}</strong><span>{element.text}</span></p><StoryTemporalEffects effects={elementEffects} onOpenOwner={onOpenEffectOwner} /></div>
          ) : (
            <div className="story-dialogue-choice story-specialized-step" key={element.id}>
              <strong>{element.prompt}</strong>
              <StoryTemporalEffects effects={elementEffects} onOpenOwner={onOpenEffectOwner} />
              <ul>{element.options.map((option) => <li key={option.id}><span>{option.text}{option.condition ? <code>{option.condition}</code> : null}</span><StoryTemporalEffects effects={temporalEffectsForOwner(effectProjection, { owner_version: 1, owner_kind: "dialogue_option", owner_id: option.id, context_node_id: contextNodeId })} onOpenOwner={onOpenEffectOwner} /></li>)}</ul>
            </div>
          );
        })}
      </div>
    );
  }
  if (data.kind === "Quest" && data.questDocument) {
    return (
      <div className="story-quest-outline">
        <strong>{tr("story.objective")}: {data.questDocument.objective}</strong>
        <ol>{data.questDocument.stages.map((stage) => <li key={stage.id}><strong>{stage.title}</strong>{stage.description ? <span>{stage.description}</span> : null}{stage.branches.map((branch) => <div className="story-quest-branch" key={branch.id}><span>{branch.label}</span><StoryTemporalEffects effects={temporalEffectsForOwner(effectProjection, { owner_version: 1, owner_kind: "quest_branch", owner_id: branch.id, context_node_id: contextNodeId })} onOpenOwner={onOpenEffectOwner} />{branch.target_stage_id === null ? <StoryTemporalEffects effects={temporalEffectsForOwner(effectProjection, { owner_version: 1, owner_kind: "quest_outcome", owner_id: branch.id, context_node_id: contextNodeId })} onOpenOwner={onOpenEffectOwner} /> : null}</div>)}</li>)}</ol>
      </div>
    );
  }
  if (data.kind === "Condition" && data.requirement) return <p className="story-type-note"><strong>{tr("authoring.requirement")}:</strong> {data.requirement.subject} {data.requirement.predicate}</p>;
  if (data.kind === "Consequence" && data.outcome) return <p className="story-type-note"><strong>{tr("authoring.outcome")}:</strong> {data.outcome.effect}</p>;
  if (data.kind === "Character" && data.characterRole) return <p className="story-type-note"><strong>{tr("authoring.role")}:</strong> {data.characterRole}</p>;
  if (data.kind === "Item" && data.itemPurpose) return <p className="story-type-note"><strong>{tr("authoring.purpose")}:</strong> {data.itemPurpose}</p>;
  return data.tags.length ? <p className="story-type-note"><strong>{tr("authoring.tags")}:</strong> {data.tags.join(", ")}</p> : null;
}

/** Renders explicit authored changes immediately after their temporal owner. */
export function StoryTemporalEffects({ effects, onOpenOwner }: { effects: TemporalEffectPresentation[]; onOpenOwner: (owner: NarrativeEffectOwnerRef) => void }) {
  if (!effects.length) return null;
  return (
    <div aria-label={tr("narrativeState.storyChanges")} className="story-temporal-effects">
      {effects.map((effect) => <TemporalEffectSummary effect={effect} key={effect.bindingId} onOpenOwner={onOpenOwner} />)}
    </div>
  );
}

/** Keyboard-navigable Graph legend for the currently selected temporal step. */
export function TemporalStateOverlayPanel({ effects, nodes, onOpenOwner }: { effects: TemporalEffectPresentation[]; nodes: Node<NarrativeNodeData>[]; onOpenOwner: (owner: NarrativeEffectOwnerRef) => void }) {
  return (
    <aside aria-label={tr("narrativeState.temporalOverlay")} className="temporal-state-overlay-panel">
      <div className="temporal-state-overlay-heading"><GitCompareArrows size={15} aria-hidden="true" /><div><strong>{tr("narrativeState.temporalState")}</strong><span>{tr("narrativeState.selectedStep")}</span></div></div>
      <div className="temporal-state-overlay-list">
        {effects.map((effect) => <TemporalEffectSummary compact effect={effect} key={effect.bindingId} nodes={nodes} onOpenOwner={onOpenOwner} />)}
      </div>
    </aside>
  );
}

export function TemporalEffectSummary({ compact = false, effect, nodes = [], onOpenOwner }: { compact?: boolean; effect: TemporalEffectPresentation; nodes?: Node<NarrativeNodeData>[]; onOpenOwner: (owner: NarrativeEffectOwnerRef) => void }) {
  const labels = temporalChangeLabels(effect);
  return (
    <article className={`temporal-effect-summary ${compact ? "temporal-effect-summary-compact" : ""}`} data-effect-id={effect.effect.id}>
      <div className="temporal-effect-title"><strong>{effect.effect.explanation}</strong><span>{effect.subjectTitle}</span></div>
      <dl><div><dt>{labels.before}</dt><dd>{temporalValueLabel(effect.before, effect, nodes)}</dd></div><ArrowRight size={13} aria-hidden="true" /><div><dt>{labels.after}</dt><dd>{temporalValueLabel(effect.after, effect, nodes)}</dd></div></dl>
      <button className="temporal-effect-source" onClick={() => onOpenOwner(effect.owner)} type="button">{tr("narrativeState.openSource")}<ArrowRight size={13} aria-hidden="true" /></button>
    </article>
  );
}

export function temporalChangeLabels(effect: TemporalEffectPresentation): { after: string; before: string } {
  return effect.effect.operation === "transfer_item"
    ? { before: tr("narrativeState.previousHolder"), after: tr("narrativeState.currentHolder") }
    : { before: tr("narrativeState.before"), after: tr("narrativeState.after") };
}

export function temporalValueLabel(value: TemporalStateValue, effect: TemporalEffectPresentation, nodes: Node<NarrativeNodeData>[]): string {
  if (value.kind === "boolean") return tr(value.value ? "narrativeState.enabled" : "narrativeState.disabled");
  if (value.kind === "quest_status") return value.value ? tr(({ inactive: "narrativeState.quest.inactive", active: "narrativeState.quest.active", completed: "narrativeState.quest.completed", failed: "narrativeState.quest.failed" } as const)[value.value]) : tr("narrativeState.notSpecified");
  if (value.kind === "dialogue_choice") return value.value ?? tr("narrativeState.notRecorded");
  const holder = value.holder;
  if (holder.kind === "character" || holder.kind === "location" || holder.kind === "faction") return nodes.find((node) => (node.data.canonicalNodeId ?? node.id) === holder.node_id)?.data.title ?? effect.affectedNodeTitles[holder.node_id] ?? holder.node_id;
  return tr(({ player: "narrativeState.player", party: "narrativeState.party", unowned: "narrativeState.unowned" } as const)[holder.kind]);
}

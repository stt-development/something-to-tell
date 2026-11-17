import {
type Node
} from "@xyflow/react";
import {
Archive,
ArrowRight,
CircleStop,
Flag,
GitBranch,
Pencil,
Plus,
ScanSearch,
ShieldCheck,
Trash2
} from "lucide-react";
import { type CSSProperties,type DragEvent as ReactDragEvent,useMemo } from "react";
import { allowsComposition } from "../../composition/contracts";
import { locationPlacementWouldCycle } from "../../composition/layout";
import {
tr
} from "../../localization/i18n";
import { type StoryFlowSnapshot } from "../../story-flow/contracts";
import {
type NarrativeNodeData
} from "../../types";

import { DialogShell } from "../shared/DialogShell";
import { NODE_COLORS,NODE_CONTEXT_MENU_HEIGHT,NODE_KINDS,NODE_META,displayNodeKind } from "../workspaceShared";
import { projectTreeEntries } from "./projectTreeEntries";
import { ProjectNavigationList } from "./ProjectNavigationList";

export { projectTreeEntries } from "./projectTreeEntries";

const navigationItemKey = (item: { id: string }) => item.id;
const flowItemKey = (item: StoryFlowSnapshot) => item.flow.id;
const treeItemKey = (entry: { node: { id: string } }) => entry.node.id;

export function CurrentProjectPanel({
  activeFlowId,
  flows = [],
  nodes,
  onArchiveFlow,
  onCallFlow,
  onContinueFlow,
  onCreateFlowExit,
  onCreateFlow,
  onDeleteFlow,
  onDragNode,
  onFocusNode,
  onRenameFlow,
  onReviewProgression,
  onSelectFlow,
  onSetFlowEntry,
  project
}: {
  activeFlowId?: string | null;
  flows?: StoryFlowSnapshot[];
  nodes: Array<{ data: NarrativeNodeData; height?: number | null; id: string; parentId?: string; position: { x: number; y: number }; width?: number | null }>;
  onArchiveFlow?: (flow: StoryFlowSnapshot) => void;
  onCallFlow?: (nodeId: string) => void;
  onContinueFlow?: (nodeId: string) => void;
  onCreateFlowExit?: (nodeId: string) => void;
  onCreateFlow?: () => void;
  onDeleteFlow?: (flow: StoryFlowSnapshot) => void;
  onDragNode?: (canonicalNodeId: string, event: ReactDragEvent<HTMLButtonElement>) => void;
  onFocusNode: (node: { data: NarrativeNodeData; height?: number | null; id: string; parentId?: string; position: { x: number; y: number }; width?: number | null }) => void;
  onRenameFlow?: (flowId: string) => void;
  onReviewProgression?: () => void;
  onSelectFlow?: (flowId: string) => void;
  onSetFlowEntry?: (nodeId: string) => void;
  project: { description: string; name: string; path: string; updatedAt: string };
}) {
  // The rail describes only the active project; switching remains explicit through dialogs.
  const treeEntries = useMemo(() => projectTreeEntries(nodes), [nodes]);
  const activeFlow = flows.find((snapshot) => snapshot.flow.id === activeFlowId);
  const canonicalById = useMemo(() => new Map(nodes.map((node) => [node.data.canonicalNodeId ?? node.id, node])), [nodes]);
  const activeMembers = useMemo(() => [...(activeFlow?.nodes ?? [])]
    .sort((left, right) => left.presentation_order - right.presentation_order)
    .filter((membership) => canonicalById.has(membership.node_id)), [activeFlow, canonicalById]);
  return (
    <section className="rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="text-sm font-semibold text-slate-800">{project.name}</div>
      <div className="mt-2 text-xs text-slate-500">{tr("projects.updated", { date: project.updatedAt })}</div>
      <div className="mt-1 truncate text-xs text-slate-600">{project.path}</div>
      <p className="mt-3 text-xs leading-5 text-slate-600">{project.description}</p>
      <div className="mt-4 border-t border-slate-200 pt-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-xs font-semibold text-slate-500">{tr("authoring.storyFlows")}</div>
          <div className="flex gap-1">
            {onReviewProgression ? (
              <button aria-label={tr("flow.reviewMigrations")} className="project-flow-action" onClick={onReviewProgression} title={tr("flow.reviewMigrations")} type="button">
                <ShieldCheck size={14} aria-hidden="true" />
              </button>
            ) : null}
            {onCreateFlow ? (
              <button aria-label={tr("flow.create")} className="project-flow-action" onClick={onCreateFlow} title={tr("flow.create")} type="button">
                <Plus size={14} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </div>
        <div>
          <ProjectNavigationList items={flows} itemKey={flowItemKey} label={tr("authoring.storyFlows")} rowHeight={46} renderItem={(snapshot) => (
            <div className={`project-flow-row ${snapshot.flow.id === activeFlowId ? "project-flow-row-active" : ""}`} key={snapshot.flow.id}>
              <button
                aria-label={tr("flow.openNamed", { name: snapshot.flow.name })}
                className="project-flow-select"
                onClick={() => onSelectFlow?.(snapshot.flow.id)}
                type="button"
              >
                <GitBranch size={14} aria-hidden="true" />
                <span><strong>{snapshot.flow.name}</strong><small>{tr(`flow.${snapshot.flow.kind}` as keyof typeof import("../../localization/catalogs").enCatalog)} · {tr("workspace.members", { count: snapshot.nodes.length })}</small></span>
              </button>
              <div className="project-flow-actions">
                <button aria-label={tr("flow.renameNamed", { name: snapshot.flow.name })} onClick={() => onRenameFlow?.(snapshot.flow.id)} title={tr("flow.rename")} type="button"><Pencil size={13} aria-hidden="true" /></button>
                <button aria-label={tr("flow.archiveNamed", { name: snapshot.flow.name })} onClick={() => onArchiveFlow?.(snapshot)} title={tr("flow.archiveNamed", { name: snapshot.flow.name })} type="button"><Archive size={13} aria-hidden="true" /></button>
                <button aria-label={tr("flow.deleteNamed", { name: snapshot.flow.name })} onClick={() => onDeleteFlow?.(snapshot)} title={tr("flow.previewDeletion")} type="button"><Trash2 size={13} aria-hidden="true" /></button>
              </div>
            </div>
          )} />
          {flows.length === 0 ? <div className="text-xs text-slate-500">{tr("authoring.noStoryFlows")}</div> : null}
        </div>
        {activeFlow ? (
          <div className="mt-3 grid gap-1 border-t border-slate-200 pt-2">
            <ProjectNavigationList items={activeMembers} itemKey={navigationItemKey} label={tr("flow.membersNamed", { name: activeFlow.flow.name })} rowHeight={32} renderItem={(membership) => {
              const node = canonicalById.get(membership.node_id);
              if (!node) return null;
              const isEntry = activeFlow.flow.entry_node_id === membership.node_id;
              return (
                <div className="project-flow-member" key={membership.id}>
                  <button className="project-flow-member-title" onClick={() => onFocusNode(node)} title={node.data.title} type="button">
                    {isEntry ? `${tr("authoring.entry")}: ` : ""}{node.data.title}
                  </button>
                  <button aria-label={tr("flow.continueFrom", { name: node.data.title })} className="tooltip-wrapper tooltip-top" data-tooltip={tr("flow.continueFrom", { name: node.data.title })} onClick={() => onContinueFlow?.(membership.node_id)} type="button"><Plus size={12} aria-hidden="true" /></button>
                  <button aria-label={tr("flow.callFrom", { name: node.data.title })} className="tooltip-wrapper tooltip-top" data-tooltip={tr("flow.callFrom", { name: node.data.title })} onClick={() => onCallFlow?.(membership.node_id)} type="button"><ArrowRight size={12} aria-hidden="true" /></button>
                  <button aria-label={tr("flow.createExitFrom", { name: node.data.title })} className="tooltip-wrapper tooltip-top" data-tooltip={tr("flow.createExitFrom", { name: node.data.title })} onClick={() => onCreateFlowExit?.(membership.node_id)} type="button"><CircleStop size={12} aria-hidden="true" /></button>
                  {!isEntry ? <button aria-label={tr("flow.setNamedEntry", { name: node.data.title })} className="tooltip-wrapper tooltip-top" data-tooltip={tr("flow.setNamedEntry", { name: node.data.title })} onClick={() => onSetFlowEntry?.(membership.node_id)} type="button"><Flag size={12} aria-hidden="true" /></button> : null}
                </div>
              );
            }} />
          </div>
        ) : null}
      </div>
      <div className="mt-4 border-t border-slate-200 pt-3">
        <div className="text-xs font-semibold text-slate-500">{tr("workspace.graph")}</div>
        {treeEntries.length > 0 ? (
          <ProjectNavigationList items={treeEntries} itemKey={treeItemKey} label={tr("workspace.graph")} className="grid" rowHeight={24} renderItem={({ depth, node }) => (
            <div className="project-tree-row" data-depth={depth} data-node-id={node.id} key={node.id} style={{ "--tree-depth": depth } as CSSProperties}>
              <span aria-hidden="true" className="project-tree-branch" />
              <button className="block min-w-0 flex-1 cursor-grab truncate rounded px-1 py-0.5 text-left text-xs text-slate-600 hover:bg-white hover:text-slate-900" draggable onClick={() => onFocusNode(node)} onDragStart={(event) => onDragNode?.(node.data.canonicalNodeId ?? node.id, event)} type="button">
                {displayNodeKind(node.data.kind)}: {node.data.title}
              </button>
            </div>
          )} />
        ) : (
          <div className="mt-1 text-xs text-slate-500">{tr("authoring.noNodes")}</div>
        )}
      </div>
    </section>
  );
}

export function FrameAddDialog({
  frame,
  nodes,
  onClose,
  onPick
}: {
  frame: Node<NarrativeNodeData>;
  nodes: Node<NarrativeNodeData>[];
  onClose: () => void;
  onPick: (canonicalNodeId: string) => void;
}) {
  const canonicalNodes = nodes.filter((node) => node.id === (node.data.canonicalNodeId ?? node.id));
  const candidates = canonicalNodes.filter((node) =>
    node.id !== (frame.data.canonicalNodeId ?? frame.id)
    && allowsComposition(frame.data.kind, node.data.kind)
    && !locationPlacementWouldCycle(nodes, node.data.canonicalNodeId ?? node.id, frame.id)
    && !nodes.some((instance) => (instance.data.canonicalNodeId ?? instance.id) === node.id && instance.parentId === frame.id)
  );
  return (
    <DialogShell onClose={onClose} title={tr("authoring.addLinkedNode", { name: frame.data.title })}>
      <div className="space-y-2">
        {candidates.map((node) => (
          <button className="flex w-full items-center gap-3 rounded-md border border-slate-200 px-3 py-2 text-left hover:border-sky-400 hover:bg-sky-50" key={node.id} onClick={() => onPick(node.id)} type="button">
            {(() => { const Icon = NODE_META[node.data.kind].Icon; return <Icon size={16} style={{ color: NODE_COLORS[node.data.kind] }} aria-hidden="true" />; })()}
            <span className="min-w-0"><strong className="block truncate text-sm">{node.data.title}</strong><span className="text-xs text-slate-500">{displayNodeKind(node.data.kind)}</span></span>
          </button>
        ))}
        {candidates.length === 0 ? <p className="text-sm text-slate-500">{tr("authoring.noCompatibleNodes")}</p> : null}
      </div>
    </DialogShell>
  );
}

export function DeleteSelectionDialog({
  deleteBlocked,
  edgeLabels,
  impactKey,
  nodes,
  onAnalyze,
  onClose,
  onDelete
}: {
  deleteBlocked: boolean;
  edgeLabels: string[];
  impactKey: string;
  nodes: Node<NarrativeNodeData>[];
  onAnalyze: (origin: HTMLButtonElement) => void;
  onClose: () => void;
  onDelete: () => void;
}) {
  const canonicalCount = nodes.filter((node) => !node.data.isLinkedInstance).length;
  const linkedCount = nodes.length - canonicalCount;
  return (
    <DialogShell onClose={onClose} title={tr("authoring.deleteSelection")}>
      <p className="text-sm leading-6 text-slate-600">{tr("authoring.deleteSelectionImpact", { canonical: canonicalCount, edges: edgeLabels.length, linked: linkedCount })}</p>
      <div className="mt-3 max-h-64 overflow-auto rounded border border-slate-200 bg-slate-50 p-3">
        {nodes.map((node) => <div className="text-sm text-slate-700" key={node.id}>{node.data.isLinkedInstance ? tr("authoring.linkedInstance") : displayNodeKind(node.data.kind)}: <strong>{node.data.title}</strong></div>)}
        {edgeLabels.map((label, index) => <div className="text-sm text-slate-700" key={`${label}-${index}`}>{tr("workspace.edges", { count: 1 })}: <strong>{label}</strong></div>)}
      </div>
      {deleteBlocked ? <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{tr("impact.callerBlocked")}</p> : null}
      <div className="mt-4 flex justify-end gap-2">
        <button className="rounded border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700" onClick={onClose} type="button">{tr("common.cancel")}</button>
        <button className="inline-flex items-center gap-2 rounded border border-teal-300 bg-white px-3 py-2 text-sm font-semibold text-teal-800" data-impact-origin={impactKey} onClick={(event) => onAnalyze(event.currentTarget)} type="button"><ScanSearch size={15} aria-hidden="true" />{tr("impact.analyzeChange")}</button>
        <button className="inline-flex items-center gap-2 rounded bg-red-700 px-3 py-2 text-sm font-semibold text-white disabled:bg-slate-400" disabled={deleteBlocked} onClick={onDelete} title={deleteBlocked ? tr("impact.callerBlocked") : undefined} type="button"><Trash2 size={15} aria-hidden="true" />{tr("common.delete")}</button>
      </div>
    </DialogShell>
  );
}

export function DeleteEntityDialog({ deleteBlocked, edgeCount, impactKey, node, onAnalyze, onClose, onDelete, placementCount }: { deleteBlocked: boolean; edgeCount: number; impactKey: string; node: Node<NarrativeNodeData>; onAnalyze: (origin: HTMLButtonElement) => void; onClose: () => void; onDelete: () => void; placementCount: number }) {
  return (
    <DialogShell onClose={onClose} title={tr("authoring.deleteNamed", { name: node.data.title })}>
      <p className="text-sm text-slate-700">{tr("authoring.deleteEntityImpact", { edges: edgeCount, placements: placementCount })}</p>
      <p className="mt-2 text-sm text-slate-500">{tr("authoring.deletePlacementHint")}</p>
      {deleteBlocked ? <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{tr("impact.callerBlocked")}</p> : null}
      <div className="mt-5 flex justify-end gap-2">
        <button className="rounded-md border border-slate-300 px-3 py-2 text-sm" onClick={onClose} type="button">{tr("common.cancel")}</button>
        <button className="inline-flex items-center gap-2 rounded-md border border-teal-300 bg-white px-3 py-2 text-sm font-semibold text-teal-800" data-impact-origin={impactKey} onClick={(event) => onAnalyze(event.currentTarget)} type="button"><ScanSearch size={15} aria-hidden="true" />{tr("impact.analyzeChange")}</button>
        <button className="rounded-md bg-rose-700 px-3 py-2 text-sm font-semibold text-white disabled:bg-slate-400" disabled={deleteBlocked} onClick={onDelete} title={deleteBlocked ? tr("impact.callerBlocked") : undefined} type="button">{tr("authoring.deleteEntity")}</button>
      </div>
    </DialogShell>
  );
}

export function NodeContextMenu({ canCreate, onAnalyze, onPick, x, y }: {
  canCreate: boolean;
  onAnalyze?: (origin: HTMLButtonElement) => void;
  onPick: (kind: NarrativeNodeData["kind"]) => void;
  x: number;
  y: number;
}) {
  const top = Math.max(8, Math.min(y, window.innerHeight - NODE_CONTEXT_MENU_HEIGHT - 8));

  return (
    <div aria-label={onAnalyze ? tr("impact.selection") : tr("authoring.createNode")} className="fixed z-50 w-52 rounded-md border border-slate-200 bg-white p-1 shadow-lg" role="menu" style={{ left: x, top }}>
      {onAnalyze ? (
        <button className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm font-semibold text-teal-800 hover:bg-teal-50" onClick={(event) => onAnalyze(event.currentTarget)} title={tr("impact.openWorkspace")} type="button">
          <ScanSearch size={16} aria-hidden="true" />{tr("impact.openWorkspace")}
        </button>
      ) : null}
      {onAnalyze && canCreate ? <span className="my-1 block h-px bg-slate-200" aria-hidden="true" /> : null}
      {canCreate ? NODE_KINDS.map((kind) => {
        const Icon = NODE_META[kind].Icon;
        return (
          <button className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-slate-100" key={kind} onClick={() => onPick(kind)} title={kind === "Scene" ? tr("tool.sceneFrame") : kind === "Location" ? tr("tool.locationFrame") : displayNodeKind(kind)} type="button">
            <Icon size={16} style={{ color: NODE_META[kind].color }} aria-hidden="true" />
            {kind === "Scene" ? tr("tool.sceneFrame") : kind === "Location" ? tr("tool.locationFrame") : displayNodeKind(kind)}
          </button>
        );
      }) : null}
    </div>
  );
}

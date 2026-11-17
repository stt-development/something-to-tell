import type {
ImpactResourceRef
} from "@something-to-tell/contracts/impact-analysis";
import {
MarkerType,
type Edge,
type Node,
type XYPosition
} from "@xyflow/react";
import {
RotateCcw,
ScanSearch,
ShieldCheck,
Sparkles,
X
} from "lucide-react";
import { useEffect,useRef,useState } from "react";
import { absoluteNodePosition } from "../../composition/layout";
import {
tr
} from "../../localization/i18n";
import type { PlaybackSession } from "../../playback/contracts";
import { RuntimeApiError } from "../../runtime/apiClient";
import { useGraphStore } from "../../state/graphStore";
import {
type EdgeDraft,
type GraphPatch,
type GraphPatchOperation,
type NarrativeEdgeData,
type NarrativeEdgeType,
type NarrativeNodeData,
type NodeDraft,
type SceneAnalysisResponse
} from "../../types";

import { relationshipTypeForEdge } from "../graph/graphProjection";
import { DialogShell,LabeledInput } from "../shared/DialogShell";
import { analysisOperationLabel,patchOperationTitle } from "../story/storyFlowLocal";
import { AnalysisPreviewMaps,EDGE_TYPES,NODE_KINDS,OperationDecision,displayRelationshipType,impactResourceKey } from "../workspaceShared";

/** Prevents checkpoint token changes while an actionable agent proposal is pending. */
export function analysisBlocksAutosave(
  canonSuggestionStatus: string | null,
  resolutionOperation: string | null,
  resolutionRunStatus: string | null
): boolean {
  return canonSuggestionStatus === "pending"
    || resolutionOperation !== null
    || resolutionRunStatus === "queued"
    || resolutionRunStatus === "running";
}

export function SceneAnalysisPanel({
  decisionLoading,
  error,
  loading,
  onAnalyze,
  onAnalyzePatch,
  onClose,
  onDecideOperation,
  operationDecisions,
  patchBlocked,
  result,
  sceneText: graphSceneText,
  title: graphTitle
}: {
  decisionLoading: boolean;
  error: string | null;
  loading: boolean;
  onAnalyze: (title: string, sceneText: string) => Promise<void>;
  onAnalyzePatch: (origin: HTMLButtonElement) => void;
  onClose: () => void;
  onDecideOperation: (operationIndex: number, decision: OperationDecision) => Promise<void>;
  operationDecisions: Record<number, OperationDecision>;
  patchBlocked: boolean;
  result: SceneAnalysisResponse | null;
  sceneText: string;
  title: string;
}) {
  const [title, setTitle] = useState(graphTitle);
  const [sceneText, setSceneText] = useState(graphSceneText);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setTitle(graphTitle);
    setSceneText(graphSceneText);
  }, [graphSceneText, graphTitle]);
  useEffect(() => closeRef.current?.focus(), []);

  const status = loading ? "running" : error ? "failed" : result ? "completed" : "idle";

  return (
    <aside className="scene-analysis-panel" aria-label={tr("authoring.sceneAnalysis")}>
      <header className="scene-analysis-workspace-header">
        <div>
          <span><Sparkles size={16} aria-hidden="true" />{tr("authoring.sceneAnalysis")}</span>
          <strong>{result ? tr("analysis.suggestedChanges", { count: result.patch.operations.length }) : tr("analysis.patchPreview")}</strong>
        </div>
        <div className="scene-analysis-workspace-actions">
          <span className="scene-analysis-run-state" data-status={status}>{tr(`analysisHub.status.${status}`)}</span>
          <button aria-label={tr("common.close")} className="icon-button" onClick={onClose} ref={closeRef} title={tr("analysis.close")} type="button">
            <X size={17} aria-hidden="true" />
          </button>
        </div>
      </header>
      <form
        className="scene-analysis-controls"
        onSubmit={(event) => {
          event.preventDefault();
          void onAnalyze(title.trim() || tr("analysis.untitledScene"), sceneText);
        }}
      >
        <div className="scene-analysis-disclosure">
          <ShieldCheck size={15} aria-hidden="true" />
          {tr("analysis.localProvider")}
        </div>
        <LabeledInput label={tr("analysis.sceneTitle")} onChange={setTitle} value={title} />
        <label className="block text-sm font-semibold text-slate-700">
          {tr("analysis.sceneText")}
          <textarea
            className="mt-1 min-h-36 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            onChange={(event) => setSceneText(event.target.value)}
            value={sceneText}
          />
        </label>
        {error ? <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{error}</div> : null}
        <div className="scene-analysis-command-row">
          <button className="scene-analysis-primary-command" disabled={loading || !sceneText.trim()} type="submit">
            <Sparkles size={16} aria-hidden="true" />
            {tr(loading ? "analysis.analyzing" : "analysis.analyzeScene")}
          </button>
          <button className="scene-analysis-secondary-command" onClick={() => setSceneText(graphSceneText)} type="button">
            <RotateCcw size={15} aria-hidden="true" />
            {tr("analysis.refreshGraph")}
          </button>
        </div>
      </form>
      {result ? (
        <PatchPreview
          decisionLoading={decisionLoading}
          onAnalyze={onAnalyzePatch}
          onDecideOperation={onDecideOperation}
          operationDecisions={operationDecisions}
          patchBlocked={patchBlocked}
          result={result}
        />
      ) : null}
    </aside>
  );
}

export function PatchPreview({
  decisionLoading,
  onAnalyze,
  onDecideOperation,
  operationDecisions,
  patchBlocked,
  result
}: {
  decisionLoading: boolean;
  onAnalyze: (origin: HTMLButtonElement) => void;
  onDecideOperation: (operationIndex: number, decision: OperationDecision) => Promise<void>;
  operationDecisions: Record<number, OperationDecision>;
  patchBlocked: boolean;
  result: SceneAnalysisResponse;
}) {
  const persisted = Boolean(result.suggestion_id);
  return (
    <section className="scene-analysis-results space-y-3" aria-label={tr("analysis.patchPreview")}>
      <div className="flex items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
        <div className="text-xs font-semibold text-amber-800">{tr(persisted ? "analysis.reviewEach" : "analysis.localReview")}</div>
        <div className="flex items-center gap-2">
          <div className="text-xs text-amber-700">{tr("analysis.reviewed", { reviewed: Object.keys(operationDecisions).length, total: result.patch.operations.length })}</div>
          <button className="inline-flex items-center gap-1 rounded border border-amber-300 bg-white px-2 py-1 text-xs font-semibold text-amber-900" data-impact-origin={sceneImpactCallerKey(result)} disabled={!scenePatchImpactResources(result.patch).length} onClick={(event) => onAnalyze(event.currentTarget)} title={!scenePatchImpactResources(result.patch).length ? tr("impact.noExistingTargets") : undefined} type="button">
            <ScanSearch size={13} aria-hidden="true" />{tr("impact.analyzeChange")}
          </button>
        </div>
      </div>
      {patchBlocked ? <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{tr("impact.callerBlocked")}</div> : null}
      <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{tr("authoring.extractedFacts")}</div>
        <div className="mt-2 space-y-2">
          {result.extracted_facts.length ? (
            result.extracted_facts.map((fact) => (
              <article className="rounded border border-slate-200 bg-white px-2 py-1.5 text-xs" key={fact.id}>
                <div className="font-semibold text-slate-800">{fact.title}</div>
                <div className="mt-1 text-slate-600">{fact.summary || fact.evidence.text}</div>
              </article>
            ))
          ) : (
            <div className="text-xs text-slate-500">{tr("authoring.noFacts")}</div>
          )}
        </div>
      </div>
      <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{tr("authoring.suggestedOperations")}</div>
        <div className="mt-2 space-y-2">
          {result.patch.operations.length ? (
            result.patch.operations.map((operation, index) => (
              <PatchOperationPreview
                decision={operationDecisions[index]}
                disabled={decisionLoading || patchBlocked}
                key={`${operation.op}-${index}`}
                onDecide={(decision) => void onDecideOperation(index, decision)}
                operation={operation}
              />
            ))
          ) : (
            <div className="text-xs text-slate-500">{result.warnings[0] ?? tr("analysis.noChanges")}</div>
          )}
        </div>
      </div>
    </section>
  );
}

export function PatchOperationPreview({
  decision,
  disabled,
  onDecide,
  operation,
}: {
  decision?: OperationDecision;
  disabled: boolean;
  onDecide: (decision: OperationDecision) => void;
  operation: GraphPatchOperation;
}) {
  const isEdge = operation.op === "create_edge" || operation.op === "update_edge";
  return (
    <article className={`patch-operation ${isEdge ? "patch-operation-edge" : "patch-operation-node"}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{tr(isEdge ? "analysis.suggestedEdge" : "analysis.suggestedNode")}</div>
        {decision ? <span className={`operation-decision operation-decision-${decision}`}>{tr(`analysis.${decision}` as "analysis.approved")}</span> : null}
      </div>
      <div className="mt-1 text-sm font-semibold text-slate-800">{patchOperationTitle(operation)}</div>
      <div className="mt-1 text-xs text-slate-600">{analysisOperationLabel(operation.op)}</div>
      {!decision ? (
        <div className="mt-2 flex items-center gap-2">
          <button className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700" disabled={disabled} onClick={() => onDecide("rejected")} type="button">
            {tr("authoring.reject")}
          </button>
          <button className="rounded bg-emerald-700 px-2 py-1 text-xs font-semibold text-white disabled:bg-slate-400" disabled={disabled} onClick={() => onDecide("approved")} title={tr("analysis.applyChange")} type="button">
            {tr("authoring.approve")}
          </button>
        </div>
      ) : null}
    </article>
  );
}

export function AnalysisOperationDialog({
  decision,
  loading,
  onClose,
  onDecide,
  operation,
  operationIndex,
}: {
  decision?: OperationDecision;
  loading: boolean;
  onClose: () => void;
  onDecide: (decision: OperationDecision) => Promise<void>;
  operation: GraphPatchOperation;
  operationIndex: number;
}) {
  const isEdge = operation.op === "create_edge" || operation.op === "update_edge";
  return (
    <DialogShell onClose={onClose} title={tr("analysis.suggestion")}>
      <section aria-label={tr("analysis.suggestionReview")} className="space-y-4">
        <div className={`patch-operation ${isEdge ? "patch-operation-edge" : "patch-operation-node"}`}>
          <div className="text-xs font-bold uppercase tracking-wide text-slate-500">{tr("analysis.suggestionNumber", { count: operationIndex + 1 })}</div>
          <div className="mt-1 text-lg font-semibold text-slate-900">{patchOperationTitle(operation)}</div>
          <div className="mt-2 text-sm text-slate-600">{analysisOperationLabel(operation.op)}</div>
          <pre className="mt-3 max-h-64 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">{JSON.stringify(operation, null, 2)}</pre>
        </div>
        {decision ? (
          <div className={`operation-decision operation-decision-${decision}`}>{tr(`analysis.${decision}` as "analysis.approved")}</div>
        ) : (
          <div className="flex items-center justify-end gap-2">
            <button className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700" disabled={loading} onClick={() => void onDecide("rejected")} type="button">
              {tr("authoring.reject")}
            </button>
            <button className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white disabled:bg-slate-400" disabled={loading} onClick={() => void onDecide("approved")} title={tr("analysis.applyChange")} type="button">
              {tr(loading ? "analysis.applying" : "authoring.approve")}
            </button>
          </div>
        )}
      </section>
    </DialogShell>
  );
}

export function buildAnalysisPreviewMaps(
  result: SceneAnalysisResponse | null,
  graphNodes: Array<Node<NarrativeNodeData>> = [],
  graphEdges: Array<{ data?: NarrativeEdgeData; id: string; source: string; target: string }> = [],
  operationDecisions: Record<number, OperationDecision> = {}
): AnalysisPreviewMaps {
  const nodes = new Map<string, string>();
  const edges = new Map<string, string>();
  const nodeOperations = new Map<string, number[]>();
  const edgeOperations = new Map<string, number[]>();
  const previewEdges: Array<Edge<NarrativeEdgeData>> = [];
  if (!result) {
    return { edgeOperations, edges, nodeOperations, nodes, previewEdges };
  }
  const nodesByClientId = new Map<string, Node<NarrativeNodeData>>();
  const nodesByTitleKind = new Map<string, Node<NarrativeNodeData>>();
  for (const node of graphNodes) {
    nodesByTitleKind.set(nodeMatchKey(node.data.kind, node.data.title), node);
  }

  for (const [operationIndex, operation] of result.patch.operations.entries()) {
    const preview = patchOperationTitle(operation);
    if (operation.op === "create_node") {
      const matchingNode = nodesByTitleKind.get(nodeMatchKey(operation.node.kind, operation.node.title));
      if (matchingNode) {
        nodesByClientId.set(operation.client_id, matchingNode);
        if (!operationDecisions[operationIndex]) {
          addNodeAnalysisPreview(nodes, matchingNode.id, preview);
          addAnalysisOperation(nodeOperations, matchingNode.id, operationIndex);
        }
      }
    }
    if (operationDecisions[operationIndex]) {
      continue;
    }
    if (operation.op === "update_node") {
      addNodeAnalysisPreview(nodes, operation.node_id, preview);
      addAnalysisOperation(nodeOperations, operation.node_id, operationIndex);
    }
    if (operation.op === "update_edge") {
      edges.set(operation.edge_id, preview);
      addAnalysisOperation(edgeOperations, operation.edge_id, operationIndex);
    }
    if (operation.op === "create_edge") {
      const sourceNodeId = operation.edge.source.node_id ?? (operation.edge.source.client_id ? nodesByClientId.get(operation.edge.source.client_id)?.id : undefined);
      const targetNodeId = operation.edge.target.node_id ?? (operation.edge.target.client_id ? nodesByClientId.get(operation.edge.target.client_id)?.id : undefined);
      if (sourceNodeId) {
        addNodeAnalysisPreview(nodes, sourceNodeId, `${preview}: source`);
        addAnalysisOperation(nodeOperations, sourceNodeId, operationIndex);
      }
      if (targetNodeId) {
        addNodeAnalysisPreview(nodes, targetNodeId, `${preview}: target`);
        addAnalysisOperation(nodeOperations, targetNodeId, operationIndex);
      }
      if (sourceNodeId && targetNodeId) {
        const matchingEdge = graphEdges.find(
          (edge) => edge.source === sourceNodeId && edge.target === targetNodeId && (edge.data?.relationshipType ?? "depends_on") === operation.edge.relationship_type
        );
        if (matchingEdge) {
          edges.set(matchingEdge.id, preview);
          addAnalysisOperation(edgeOperations, matchingEdge.id, operationIndex);
        } else {
          previewEdges.push(analysisPreviewEdge(operation.client_id, sourceNodeId, targetNodeId, operation.edge.relationship_type, preview, operationIndex));
        }
      }
    }
  }

  return { edgeOperations, edges, nodeOperations, nodes, previewEdges };
}

export function addAnalysisOperation(operations: Map<string, number[]>, elementId: string, operationIndex: number) {
  operations.set(elementId, [...(operations.get(elementId) ?? []), operationIndex]);
}

/** Maps stable runtime error codes to concise author-facing analysis states. */
export function analysisErrorMessage(error: unknown): string {
  if (error instanceof RuntimeApiError) {
    const labels: Record<string, string> = {
      extraction_failed: tr("errors.extractionFailed"),
      patch_validation_failed: tr("errors.invalidAnalysisPatch"),
      provider_unavailable: tr("errors.providerUnavailable")
    };
    return `${labels[error.code] ?? tr("errors.analysisFailed")}: ${error.message}`;
  }
  return error instanceof Error ? error.message : tr("errors.sceneAnalysisFailed");
}

/** Builds one concise live-region update from the runtime-owned session result. */
export function playbackSessionAnnouncement(
  session: PlaybackSession,
  action: string,
  includeLatestChanges = true
): string {
  const title = session.step?.title ?? "Playback beat";
  const changes = includeLatestChanges ? session.trace.at(-1)?.state_changes.length ?? 0 : 0;
  const status = session.status === "ended"
    ? " Ending reached."
    : session.status === "blocked"
      ? " Playback is blocked."
      : "";
  return `${action} ${title}.${changes ? ` ${changes} state ${changes === 1 ? "change" : "changes"} applied.` : ""}${status}`;
}

export function operationDecisionsFromMetadata(metadata: Record<string, unknown>): Record<number, OperationDecision> {
  const value = metadata.operation_decisions;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, OperationDecision] => entry[1] === "approved" || entry[1] === "rejected")
  );
}

export function addNodeAnalysisPreview(nodes: Map<string, string>, nodeId: string, preview: string) {
  const current = nodes.get(nodeId);
  nodes.set(nodeId, current ? `${current} / ${preview}` : preview);
}

export function buildLocalSceneAnalysisPreview(
  projectId: string,
  title: string,
  sceneText: string,
  graphNodes: Array<Node<NarrativeNodeData>>,
  graphEdges: Array<Edge<NarrativeEdgeData>> = []
): SceneAnalysisResponse {
  const extracted_facts: SceneAnalysisResponse["extracted_facts"] = [];
  const operations: GraphPatchOperation[] = [];
  const nodesByTitleKind = new Map(graphNodes.map((node) => [nodeMatchKey(node.data.kind, node.data.title), node]));
  const nodesByTitle = new Map(graphNodes.map((node) => [normalizeTitle(node.data.title), node]));
  const clientIdsByTitle = new Map<string, string>();

  for (const { line, start, end } of sceneLines(sceneText)) {
    const relationship = line.match(/^Relationship\s*:\s*(.+?)\s+([a-z_]+)\s+(.+?)(?:\s+-\s*(.+))?$/);
    if (relationship) {
      const relationshipType = relationship[2] as NarrativeEdgeType;
      if (!EDGE_TYPES.includes(relationshipType)) {
        continue;
      }
      const sourceTitle = relationship[1]!.trim();
      const targetTitle = relationship[3]!.trim();
      const summary = relationship[4]?.trim() || `${sourceTitle} ${displayRelationshipType(relationshipType)} ${targetTitle}.`;
      extracted_facts.push({
        id: `fact-edge-${slugFor(sourceTitle, relationshipType, targetTitle)}`,
        kind: "edge",
        title: `${sourceTitle} ${displayRelationshipType(relationshipType)} ${targetTitle}`,
        summary,
        evidence: { text: line, start, end },
        metadata: { relationship_type: relationshipType, source_title: sourceTitle, target_title: targetTitle }
      });
      const sourceNode = nodesByTitle.get(normalizeTitle(sourceTitle));
      const targetNode = nodesByTitle.get(normalizeTitle(targetTitle));
      const existingEdge = sourceNode && targetNode
        ? graphEdges.some((edge) => edge.source === sourceNode.id && edge.target === targetNode.id && edge.data?.relationshipType === relationshipType)
        : false;
      if (!existingEdge) {
        operations.push({
          op: "create_edge",
          client_id: `edge-${slugFor(sourceTitle, relationshipType, targetTitle)}`,
          edge: {
            source: sourceNode ? { node_id: sourceNode.id } : { client_id: clientIdsByTitle.get(normalizeTitle(sourceTitle)) ?? `node-${slugFor(sourceTitle)}` },
            target: targetNode ? { node_id: targetNode.id } : { client_id: clientIdsByTitle.get(normalizeTitle(targetTitle)) ?? `node-${slugFor(targetTitle)}` },
            relationship_type: relationshipType,
            label: displayRelationshipType(relationshipType),
            condition: "",
            metadata: { evidence: { text: line, start, end } }
          }
        });
      }
      continue;
    }

    const node = line.match(/^([A-Za-z]+)\s*:\s*([^-]+?)(?:\s+-\s*(.+))?$/);
    if (!node) {
      continue;
    }
    const kind = node[1] as NarrativeNodeData["kind"];
    if (!NODE_KINDS.includes(kind)) {
      continue;
    }
    const nodeTitle = node[2]!.trim();
    const summary = node[3]?.trim() || `${kind} mentioned in scene.`;
    extracted_facts.push({
      id: `fact-node-${slugFor(kind, nodeTitle)}`,
      kind: "node",
      title: nodeTitle,
      summary,
      evidence: { text: line, start, end },
      metadata: { node_kind: kind }
    });
    const existingNode = nodesByTitleKind.get(nodeMatchKey(kind, nodeTitle));
    if (existingNode && (existingNode.data.title !== nodeTitle || existingNode.data.summary !== summary)) {
      operations.push({ op: "update_node", node_id: existingNode.id, updates: { title: nodeTitle, summary, metadata: { evidence: { text: line, start, end } } } });
    } else if (!existingNode) {
      const clientId = `node-${slugFor(kind, nodeTitle)}`;
      clientIdsByTitle.set(normalizeTitle(nodeTitle), clientId);
      operations.push({
        op: "create_node",
        client_id: clientId,
        node: { kind, title: nodeTitle, summary, body: "", status: "suggested", metadata: { evidence: { text: line, start, end } } }
      });
    }
  }

  return {
    project_id: projectId,
    suggestion_id: null,
    provider: "deterministic",
    extracted_facts,
    patch: { title: `${title} local preview`, description: "Local scene analysis preview.", operations, metadata: { source: "frontend_fallback" } },
    warnings: operations.length ? ["Runtime unavailable; this preview is not persisted."] : ["No applicable graph changes were found."]
  };
}

/** Serializes canonical entities, not repeated visual placements, into analyzer input. */
export function buildGraphAnalysisText(nodes: Array<Node<NarrativeNodeData>>, edges: Array<Edge<NarrativeEdgeData>>): string {
  const canonicalNodes = nodes.filter((node) => !node.data.isLinkedInstance);
  const nodeTitles = new Map(canonicalNodes.map((node) => [node.data.canonicalNodeId ?? node.id, node.data.title]));
  const nodeLines = canonicalNodes.map((node) => `${node.data.kind}: ${node.data.title} - ${node.data.summary}`);
  const edgeLines = edges.flatMap((edge) => {
    const source = nodeTitles.get(edge.source);
    const target = nodeTitles.get(edge.target);
    return source && target ? [`Relationship: ${source} ${edge.data?.relationshipType ?? "depends_on"} ${target}`] : [];
  });
  return [...nodeLines, ...edgeLines].join("\n");
}

/** Resolves the smallest containing frame and delegates linked-placement creation. */
export function createLinkedInstanceFromDrop(
  dataTransfer: Pick<DataTransfer, "getData">,
  point: XYPosition,
  nodes: Array<Node<NarrativeNodeData>>,
  addLinkedInstance: (canonicalNodeId: string, frameId: string) => { message: string; valid: boolean }
) {
  const canonicalNodeId = dataTransfer.getData("application/x-stt-canonical-node");
  if (!canonicalNodeId) return null;
  const frame = nodes.filter((node) => {
    if (!node.data.isFrame) return false;
    const position = absoluteNodePosition(nodes, node);
    return point.x >= position.x
      && point.x <= position.x + (node.width ?? 0)
      && point.y >= position.y
      && point.y <= position.y + (node.height ?? 0);
  }).sort((left, right) => ((left.width ?? 0) * (left.height ?? 0)) - ((right.width ?? 0) * (right.height ?? 0)))[0];
  return frame ? addLinkedInstance(canonicalNodeId, frame.id) : null;
}

/** Applies a persisted-looking patch operation to the in-memory fallback graph. */
export function applyLocalAnalysisOperation(
  operation: GraphPatchOperation,
  nodes: Array<Node<NarrativeNodeData>>,
  actions: {
    addEdge: (draft: EdgeDraft) => void;
    addNode: (draft: NodeDraft) => void;
    updateEdge: (edgeId: string, draft: EdgeDraft) => void;
    updateNode: (nodeId: string, draft: NodeDraft) => void;
  }
) {
  if (operation.op === "create_node") {
    actions.addNode({ kind: operation.node.kind, summary: operation.node.summary, tags: [], title: operation.node.title });
  } else if (operation.op === "update_node") {
    const current = nodes.find((node) => node.id === operation.node_id);
    if (current) {
      actions.updateNode(current.id, {
        kind: current.data.kind,
        summary: operation.updates.summary ?? current.data.summary,
        tags: current.data.tags,
        title: operation.updates.title ?? current.data.title
      });
    }
  } else if (operation.op === "create_edge") {
    const sourceId = operation.edge.source.node_id;
    const targetId = operation.edge.target.node_id;
    if (sourceId && targetId) {
      actions.addEdge({
        label: operation.edge.label,
        relationshipType: operation.edge.relationship_type,
        source: sourceId,
        target: targetId
      });
    }
  } else {
    const current = useGraphStore.getState().getActiveGraph().edges.find((edge) => edge.id === operation.edge_id);
    if (current) {
      actions.updateEdge(current.id, {
        label: operation.updates.label ?? current.data?.label ?? "",
        relationshipType: operation.updates.relationship_type ?? relationshipTypeForEdge(current),
        source: current.source,
        target: current.target
      });
    }
  }
}

/** Produces a stable client-side identity for remembering local decisions. */
export function operationFingerprint(operation: GraphPatchOperation): string {
  return JSON.stringify(stripOperationMetadata(operation));
}

/** Maps legacy Scene graph patches to the existing resources they may modify. */
export function scenePatchImpactResources(patch: GraphPatch): ImpactResourceRef[] {
  const resources = patch.operations.flatMap((operation): ImpactResourceRef[] => {
    if (operation.op === "update_node") return [{ owner_type: "node", owner_id: operation.node_id, context_type: null, context_id: null }];
    if (operation.op === "update_edge") return [{ owner_type: "edge", owner_id: operation.edge_id, context_type: null, context_id: null }];
    if (operation.op === "create_edge") {
      return [operation.edge.source.node_id, operation.edge.target.node_id]
        .filter((id): id is string => Boolean(id))
        .map((id) => ({ owner_type: "node", owner_id: id, context_type: null, context_id: null }));
    }
    return [];
  });
  return [...new Map(resources.map((resource) => [impactResourceKey(resource), resource])).values()];
}

/** Keeps a Scene review caller stable while its immutable preview is unchanged. */
export function sceneImpactCallerKey(result: SceneAnalysisResponse): string {
  return `scene-suggestion:${result.suggestion_id ?? result.patch.operations.map(operationFingerprint).join("|")}`;
}

export function stripOperationMetadata(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripOperationMetadata);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== "metadata").map(([key, item]) => [key, stripOperationMetadata(item)])
    );
  }
  return value;
}

export function nextAnalysisNodePosition(count: number): XYPosition {
  return { x: 160 + (count % 4) * 300, y: 140 + Math.floor(count / 4) * 200 };
}

export function sceneLines(sceneText: string) {
  const lines: Array<{ end: number; line: string; start: number }> = [];
  let cursor = 0;
  for (const rawLine of sceneText.split(/\n/)) {
    const line = rawLine.trim();
    const start = cursor + rawLine.indexOf(line);
    if (line) {
      lines.push({ end: start + line.length, line, start });
    }
    cursor += rawLine.length + 1;
  }
  return lines;
}

export function analysisPreviewEdge(
  clientId: string,
  source: string,
  target: string,
  relationshipType: NarrativeEdgeType,
  preview: string,
  operationIndex: number
): Edge<NarrativeEdgeData> {
  return {
    id: `analysis-preview-${clientId}`,
    source,
    target,
    label: "analysis",
    data: {
      analysisOperationIndex: operationIndex,
      analysisPreview: preview,
      label: displayRelationshipType(relationshipType),
      relationshipType
    },
    markerEnd: { type: MarkerType.ArrowClosed, color: "#f59e0b" },
    style: { stroke: "#f59e0b", strokeDasharray: "6 4", strokeWidth: 5 }
  };
}

export function nodeMatchKey(kind: string, title: string) {
  return `${kind}:${title.toLocaleLowerCase()}`.replace(/\s+/g, " ").trim();
}

export function normalizeTitle(title: string) {
  return title.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

export function slugFor(...parts: string[]) {
  return parts.join("-").toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "suggested";
}

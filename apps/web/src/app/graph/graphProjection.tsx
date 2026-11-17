import {
type Edge,
type Node,
type XYPosition
} from "@xyflow/react";
import { type CSSProperties,type ReactNode } from "react";
import { createAbsoluteNodePositionResolver } from "../../composition/layout";
import {
localizeRuntimeText,
tr
} from "../../localization/i18n";
import {
type WorkspaceMode
} from "../../story-flow/workspace";
import {
NARRATIVE_EDGE_TYPES,
type FrameDraft,
type NarrativeEdgeData,
type NarrativeEdgeType,
type NarrativeIssue,
type NarrativeNodeData,
type NodeDraft
} from "../../types";

import { FrameContentCounts,FrameDrawState,FrameKind,GraphFilterState,ISSUE_COLORS,NODE_COLORS,NodePresentationMetrics,RelationshipInspection,ToolMode,displayNodeKind } from "../workspaceShared";
import { countFrameChildren } from "./frameContentCounts";

export function defaultNodeDraft(kind: NarrativeNodeData["kind"]): NodeDraft {
  return {
    kind,
    title: tr("authoring.newNodeNamed", { kind: displayNodeKind(kind) }),
    summary: tr("authoring.newNarrativeNote"),
    tags: []
  };
}

export function defaultFrameDraft(kind: FrameKind): FrameDraft {
  return {
    kind,
    title: tr("authoring.newFrameNamed", { kind: displayNodeKind(kind) }),
    summary: tr(kind === "Scene" ? "authoring.sceneCompositionArea" : "authoring.locationCompositionArea"),
    tags: []
  };
}

export function frameKindForTool(mode: ToolMode): FrameKind | null {
  if (mode === "scene-frame") {
    return "Scene";
  }
  if (mode === "location-frame") {
    return "Location";
  }
  return null;
}

export function FrameDrawPreview({ draw }: { draw: FrameDrawState }) {
  const left = Math.min(draw.startScreen.x, draw.currentScreen.x);
  const top = Math.min(draw.startScreen.y, draw.currentScreen.y);
  const width = Math.abs(draw.currentScreen.x - draw.startScreen.x);
  const height = Math.abs(draw.currentScreen.y - draw.startScreen.y);
  return (
    <div
      aria-hidden="true"
      className="frame-draw-preview"
      style={{
        "--frame-color": NODE_COLORS[draw.kind],
        height: Math.max(1, height),
        left,
        top,
        width: Math.max(1, width)
      } as CSSProperties}
    />
  );
}

// Filters are view-only: the returned graph is a canvas projection, never a
// persisted mutation of the project graph in Zustand or the runtime.
export function filterGraphForView<TNode extends Node<NarrativeNodeData>, TEdge extends { source: string; target: string }>(
  nodes: TNode[],
  edges: TEdge[],
  filters: Pick<GraphFilterState, "kinds" | "query">
) {
  const query = filters.query.trim().toLowerCase();
  const activeKinds = new Set(filters.kinds);
  const matchingNodes = nodes.filter((node) => {
    if (!activeKinds.has(node.data.kind)) {
      return false;
    }
    if (!query) {
      return true;
    }
    return [node.data.title, node.data.summary, ...node.data.tags].some((value) => value.toLowerCase().includes(query));
  });
  const matchingIds = new Set(matchingNodes.map((node) => node.id));
  // Filtering can hide a parent frame; orphaned children use a temporary root projection.
  let worldPosition: ReturnType<typeof createAbsoluteNodePositionResolver> | undefined;
  const filteredNodes = matchingNodes.map((node) => {
    if (!node.parentId || matchingIds.has(node.parentId)) return node;
    worldPosition ??= createAbsoluteNodePositionResolver(nodes);
    return { ...node, parentId: undefined, position: worldPosition(node) };
  });
  const visibleNodeIds = new Set(filteredNodes.map((node) => node.id));

  return {
    edges: edges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)),
    nodes: filteredNodes
  };
}

/** Resolves navigation against the current projection rather than canonical canvas coordinates. */
export function nodeForWorkspaceFocus<TNode extends Node<NarrativeNodeData>>(
  canonicalNode: TNode,
  workspaceNodes: TNode[],
  mode: WorkspaceMode
): TNode {
  if (mode !== "flow") return canonicalNode;
  const canonicalId = canonicalNode.data.canonicalNodeId ?? canonicalNode.id;
  return workspaceNodes.find((candidate) => (candidate.data.canonicalNodeId ?? candidate.id) === canonicalId) ?? canonicalNode;
}

/** Spatial containment replaces direct frame-child arrows only in the canvas projection. */
export function hideDirectFrameChildEdges<TEdge extends { source: string; target: string }>(
  nodes: readonly Node<NarrativeNodeData>[],
  edges: readonly TEdge[]
): TEdge[] {
  const frameIds = new Set(nodes.filter((node) => node.data.isFrame).map((node) => node.id));
  const parentByChild = new Map(
    nodes
      .filter((node) => node.parentId && frameIds.has(node.parentId))
      .map((node) => [node.id, node.parentId!])
  );
  return edges.filter((edge) =>
    parentByChild.get(edge.target) !== edge.source
    && parentByChild.get(edge.source) !== edge.target
  );
}

/** Keeps semantic traversal relationships out of normal React Flow arrow rendering. */
export function hideSemanticEdges<TEdge extends { data?: NarrativeEdgeData }>(edges: readonly TEdge[]): TEdge[] {
  return edges.filter((edge) => edge.data?.canvasVisibility !== "hidden");
}

/** Selects the HTML-label renderer only for visible semantic Graph edges. */
export function canvasEdgeType(
  edge: Pick<Edge<NarrativeEdgeData>, "data" | "type">,
  workspaceMode: WorkspaceMode
): string | undefined {
  return workspaceMode === "relationships" && edge.data?.relationshipType
    ? "relationship"
    : edge.type;
}

/** Resolves canonical Character members from hidden `member_of` relationships. */
export function factionMembers(
  nodes: readonly Node<NarrativeNodeData>[],
  edges: readonly Edge<NarrativeEdgeData>[],
  factionId: string
): Node<NarrativeNodeData>[] {
  const faction = nodes.find((node) => node.id === factionId);
  const canonicalFactionId = faction?.data.canonicalNodeId ?? faction?.id ?? factionId;
  const memberIds = new Set(edges
    .filter((edge) => edge.data?.relationshipType === "member_of" && edge.target === canonicalFactionId)
    .map((edge) => edge.source));
  return nodes.filter((node) => !node.data.isLinkedInstance && node.data.kind === "Character" && memberIds.has(node.data.canonicalNodeId ?? node.id));
}

/** Derives reusable card metrics from canonical graph and placement state. */
export function nodePresentationMetrics(
  nodes: readonly Node<NarrativeNodeData>[],
  edges: readonly Edge<NarrativeEdgeData>[],
  node: Node<NarrativeNodeData>
): NodePresentationMetrics {
  const canonicalNodeId = node.data.canonicalNodeId ?? node.id;
  return {
    incoming: edges.filter((edge) => edge.target === canonicalNodeId).length,
    instances: nodes.filter((candidate) => (candidate.data.canonicalNodeId ?? candidate.id) === canonicalNodeId).length,
    outgoing: edges.filter((edge) => edge.source === canonicalNodeId).length
  };
}

export function isCompactSemanticKind(kind: NarrativeNodeData["kind"]) {
  return kind === "Character" || kind === "Quest" || kind === "Lore" || kind === "Item" || kind === "Event";
}

/** Projects collapse and focused-frame state without mutating placement membership. */
export function projectFrameWorkspace<TNode extends Node<NarrativeNodeData>, TEdge extends { source: string; target: string }>(
  nodes: readonly TNode[],
  edges: readonly TEdge[],
  focusedFrameId: string | null
): { nodes: TNode[]; edges: TEdge[] } {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const isDescendantOf = (node: TNode, frameId: string) => {
    let parentId = node.parentId;
    const visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
      if (parentId === frameId) return true;
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
    return false;
  };
  const collapsedFrameIds = nodes
    .filter((node) => node.data.isFrame && node.data.presentationState === "collapsed")
    .map((node) => node.id);
  const visibleNodes = nodes.filter((node) => {
    if (collapsedFrameIds.some((frameId) => isDescendantOf(node, frameId))) return false;
    return !focusedFrameId || node.id === focusedFrameId || isDescendantOf(node, focusedFrameId);
  });
  // A nested focused frame becomes the temporary projection root while its
  // persisted parent and relative coordinates remain untouched in the store.
  const projectedNodes = focusedFrameId
    ? visibleNodes.map((node) => node.id === focusedFrameId
      ? { ...node, parentId: undefined, position: { x: 0, y: 0 } } as TNode
      : node)
    : visibleNodes;
  const visibleIds = new Set(projectedNodes.map((node) => node.id));
  return {
    nodes: [...projectedNodes],
    edges: edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
  };
}

/** Counts direct placements shown in a Scene or Location header. */
export function frameContentCounts(nodes: readonly Node<NarrativeNodeData>[], frameId: string): FrameContentCounts {
  return countFrameChildren(nodes.filter((node) => node.parentId === frameId));
}

export function filterIssuesForView(issues: NarrativeIssue[], filters: Pick<GraphFilterState, "issueSeverities" | "issueStatuses">) {
  const severities = new Set(filters.issueSeverities);
  const statuses = new Set(filters.issueStatuses);
  return issues.filter((issue) => severities.has(issue.severity) && statuses.has(issue.status));
}

export function issuesForNode(issues: NarrativeIssue[], nodeId: string) {
  return issues.filter((issue) => issue.nodeId === nodeId);
}

export function issuesForEdge(issues: NarrativeIssue[], edgeId: string) {
  return issues.filter((issue) => issue.edgeId === edgeId);
}

/** Selects generated issues that explicitly target one Dialogue branch owner. */
export function issuesForDialogueOwner(issues: NarrativeIssue[], ownerId: string) {
  return issues.filter((issue) => issue.dialogueOwnerIds?.includes(ownerId));
}

export function issuePreviewForNode(issues: NarrativeIssue[], nodeId: string) {
  const nodeIssues = issuesForNode(issues, nodeId);
  if (nodeIssues.length === 0) {
    return "";
  }
  const [firstIssue] = nodeIssues;
  const suffix = nodeIssues.length > 1 ? ` +${nodeIssues.length - 1} more` : "";
  const title = localizeRuntimeText(firstIssue!.title, firstIssue!.titleParameters);
  const description = localizeRuntimeText(firstIssue!.description, firstIssue!.descriptionParameters);
  return `${title}: ${description}${suffix}`;
}

export function applyIssueOverlays<TNode extends Node<NarrativeNodeData>, TEdge extends { data?: NarrativeEdgeData; id: string; style?: CSSProperties }>(
  nodes: TNode[],
  edges: TEdge[],
  issues: NarrativeIssue[]
) {
  const issuesByNode = groupIssuesByTarget(issues, "nodeId");
  const issuesByEdge = groupIssuesByTarget(issues, "edgeId");

  return {
    nodes: nodes.map((node) => {
      const nodeIssues = issuesByNode.get(node.id) ?? [];
      const severity = highestIssueSeverity(nodeIssues);
      return {
        ...node,
        data: {
          ...node.data,
          issueCount: nodeIssues.length,
          issueSeverity: severity
        }
      };
    }),
    edges: edges.map((edge) => {
      const edgeIssues = issuesByEdge.get(edge.id) ?? [];
      const severity = highestIssueSeverity(edgeIssues);
      return {
        ...edge,
        data: {
          ...edge.data,
          issueCount: edgeIssues.length,
          issueSeverity: severity
        },
        style: severity ? { ...edge.style, stroke: ISSUE_COLORS[severity], strokeWidth: 4 } : edge.style
      };
    })
  };
}

export function applySelectionHighlights<TEdge extends { id: string; source: string; style?: CSSProperties; target: string }>(
  edges: TEdge[],
  selection: { id: string; type: "edge" | "node" | "project" } | null
) {
  return edges.map((edge) => {
    const isConnectedToSelectedNode = selection?.type === "node" && (edge.source === selection.id || edge.target === selection.id);
    const isSelectedEdge = selection?.type === "edge" && edge.id === selection.id;
    if (!isConnectedToSelectedNode && !isSelectedEdge) {
      return edge;
    }

    return {
      ...edge,
      animated: true,
      style: {
        ...edge.style,
        filter: "drop-shadow(0 0 5px rgb(15 23 42 / 45%))",
        strokeWidth: Math.max(typeof edge.style?.strokeWidth === "number" ? edge.style.strokeWidth : 3, 5)
      }
    };
  });
}

export function applyAnalysisHighlights<TEdge extends { data?: NarrativeEdgeData; id: string; label?: ReactNode; style?: CSSProperties }>(
  edges: TEdge[],
  analysisEdges: Map<string, string>,
  edgeOperations: Map<string, number[]> = new Map()
) {
  return edges.map((edge) => {
    const preview = analysisEdges.get(edge.id);
    if (!preview) {
      return edge;
    }

    return {
      ...edge,
      animated: true,
      data: {
        ...edge.data,
        analysisOperationIndex: edgeOperations.get(edge.id)?.[0],
        analysisPreview: preview
      },
      label: "analysis",
      labelBgPadding: [8, 4],
      labelBgBorderRadius: 6,
      labelBgStyle: { fill: "#fffbeb", stroke: "#f59e0b", strokeWidth: 1 },
      labelStyle: { fill: "#92400e", fontSize: 11, fontWeight: 800 },
      style: {
        ...edge.style,
        stroke: "#f59e0b",
        strokeDasharray: "6 4",
        strokeWidth: Math.max(typeof edge.style?.strokeWidth === "number" ? edge.style.strokeWidth : 3, 5)
      }
    };
  });
}

export function getNodeNeighborhood<TNode extends { id: string }, TEdge extends { source: string; target: string }>(nodes: TNode[], edges: TEdge[], nodeId: string) {
  const connectedNodeIds = new Set<string>([nodeId]);
  const connectedEdges = edges.filter((edge) => {
    const isConnected = edge.source === nodeId || edge.target === nodeId;
    if (isConnected) {
      connectedNodeIds.add(edge.source);
      connectedNodeIds.add(edge.target);
    }
    return isConnected;
  });

  return {
    edges: connectedEdges,
    nodes: nodes.filter((node) => connectedNodeIds.has(node.id))
  };
}

export function graphCenter(nodes: Array<{ height?: number | null; position: XYPosition; width?: number | null }>) {
  const centers = nodes.map((node) => ({
    x: node.position.x + (node.width ?? 260) / 2,
    y: node.position.y + (node.height ?? 156) / 2
  }));

  return {
    x: centers.reduce((sum, center) => sum + center.x, 0) / centers.length,
    y: centers.reduce((sum, center) => sum + center.y, 0) / centers.length
  };
}

export function groupIssuesByTarget(issues: NarrativeIssue[], target: "edgeId" | "nodeId") {
  const grouped = new Map<string, NarrativeIssue[]>();
  for (const issue of issues) {
    const targetId = issue[target];
    if (!targetId) {
      continue;
    }
    grouped.set(targetId, [...(grouped.get(targetId) ?? []), issue]);
  }
  return grouped;
}

export function highestIssueSeverity(issues: NarrativeIssue[]) {
  if (issues.some((issue) => issue.severity === "critical")) {
    return "critical";
  }
  if (issues.some((issue) => issue.severity === "warning")) {
    return "warning";
  }
  return issues.some((issue) => issue.severity === "info") ? "info" : undefined;
}

export function buildRelationshipInspection(
  nodes: Node<NarrativeNodeData>[],
  edges: Array<{ data?: NarrativeEdgeData; id: string; label?: ReactNode; source: string; target: string; type?: string }>,
  selection: { id: string; type: "edge" | "node" | "project" } | null
): RelationshipInspection | null {
  if (!selection || selection.type === "project") {
    return null;
  }

  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  if (selection.type === "node") {
    const selectedNode = nodesById.get(selection.id);
    if (!selectedNode) {
      return null;
    }

    return {
      incoming: edges
        .filter((edge) => edge.target === selectedNode.id)
        .map((edge) => ({ edgeId: edge.id, label: edgeLabel(edge), node: nodesById.get(edge.source) }))
        .filter((relationship): relationship is { edgeId: string; label: string; node: Node<NarrativeNodeData> } => Boolean(relationship.node)),
      itemTitle: selectedNode.data.title,
      outgoing: edges
        .filter((edge) => edge.source === selectedNode.id)
        .map((edge) => ({ edgeId: edge.id, label: edgeLabel(edge), node: nodesById.get(edge.target) }))
        .filter((relationship): relationship is { edgeId: string; label: string; node: Node<NarrativeNodeData> } => Boolean(relationship.node)),
      type: "node"
    };
  }

  const selectedEdge = edges.find((edge) => edge.id === selection.id);
  if (!selectedEdge) {
    return null;
  }

  return {
    edge: {
      id: selectedEdge.id,
      label: edgeLabel(selectedEdge),
      source: nodesById.get(selectedEdge.source) ?? null,
      target: nodesById.get(selectedEdge.target) ?? null,
      type: relationshipTypeForEdge(selectedEdge),
      ...(selectedEdge.data?.dialogueElementId ? { dialogueElementId: selectedEdge.data.dialogueElementId } : {})
    },
    incoming: [],
    itemTitle: edgeLabel(selectedEdge) || selectedEdge.id,
    outgoing: [],
    type: "edge"
  };
}

export function edgeLabel(edge: { data?: NarrativeEdgeData; label?: ReactNode }) {
  return String(edge.data?.label ?? edge.label ?? "");
}

export function relationshipTypeForEdge(edge: { data?: NarrativeEdgeData; type?: string }): NarrativeEdgeType {
  if (edge.data?.relationshipType && (NARRATIVE_EDGE_TYPES as readonly string[]).includes(edge.data.relationshipType)) {
    return edge.data.relationshipType as NarrativeEdgeType;
  }

  return (NARRATIVE_EDGE_TYPES as readonly string[]).includes(edge.type ?? "") ? (edge.type as NarrativeEdgeType) : "depends_on";
}

export function nodeIdFromConnectionNode(node: { id?: string } | null | undefined) {
  return typeof node?.id === "string" ? node.id : null;
}

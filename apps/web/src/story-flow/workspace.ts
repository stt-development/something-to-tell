import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type { NarrativeEdgeData, NarrativeNodeData } from "../types";
import type { FlowInvocation } from "@something-to-tell/contracts/composable-story-flow";
import type { FlowIntegrityFact, FlowTransition, StoryFlow, StoryFlowBootstrapDraft, StoryFlowIntegrityReport, StoryFlowNode, StoryFlowSnapshot } from "./contracts";
import { buildIncomingTransitionLookup } from "./incomingTransitions";

export const WORKSPACE_MODES = ["flow", "story", "relationships"] as const;
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

export interface ProjectWorkspacePreference {
  mode: WorkspaceMode;
  activeFlowId: string | null;
}

export interface StoryFlowFact {
  code: "ending" | "missing_entry" | "unreachable_member";
  level: "error" | "info" | "warning";
  label: string;
  nodeId?: string;
}

export interface StoryFlowNodeRole {
  branch: boolean;
  ending: boolean;
  entry: boolean;
  unreachable: boolean;
}

const FLOW_COLUMN_SPACING = 430;
const FLOW_SHARED_ROUTE_COLUMN_SPACING = 600;
const FLOW_ROW_SPACING = 280;

/** Projects one immutable canonical graph into the selected authoring view. */
export function projectGraphForWorkspace(
  nodes: Node<NarrativeNodeData>[],
  relationshipEdges: Edge<NarrativeEdgeData>[],
  mode: WorkspaceMode,
  snapshot: StoryFlowSnapshot | null,
  flows: StoryFlowSnapshot[] = []
): { nodes: Node<NarrativeNodeData>[]; edges: Edge<NarrativeEdgeData>[] } {
  if (mode === "relationships") {
    const canonicalIds = new Set(nodes.map((node) => node.data.canonicalNodeId ?? node.id));
    const flowEdges = snapshot?.transitions
      .filter((transition) => canonicalIds.has(transition.source_node_id) && canonicalIds.has(transition.target_node_id))
      .map(flowTransitionEdge) ?? [];
    const boundaryEdges = snapshot ? sceneBoundaryEdges(snapshot, canonicalIds) : [];
    const invocationEdges = snapshot ? flowInvocationEdges(snapshot, flows, canonicalIds) : [];
    // Graph overlays flow order without reclassifying semantic relationships.
    return { nodes, edges: spreadFlowRouteLabels([...relationshipEdges, ...flowEdges, ...boundaryEdges, ...invocationEdges]) };
  }
  if (mode === "story") {
    return { nodes: [], edges: [] };
  }
  if (!snapshot) {
    return { nodes: [], edges: [] };
  }

  const memberIds = new Set(snapshot.nodes.map((membership) => membership.node_id));
  const positions = flowNodePositions(snapshot);
  const projectedNodes: Node<NarrativeNodeData>[] = nodes
    .filter((node) => {
      const canonicalId = node.data.canonicalNodeId ?? node.id;
      return node.id === canonicalId && memberIds.has(canonicalId);
    })
    .map((node) => {
      const { extent: _extent, parentId: _parentId, ...rootNode } = node;
      return {
        ...rootNode,
        height: node.data.isFrame ? 132 : Math.min(node.height ?? 156, 180),
        position: positions.get(node.data.canonicalNodeId ?? node.id) ?? { x: 0, y: 0 },
        width: node.data.isFrame ? 210 : Math.min(node.width ?? 200, 200),
        data: {
          ...node.data,
          containerNodeId: undefined,
          presentationState: node.data.isFrame ? "collapsed" : node.data.presentationState
        }
      };
    });
  // Called entries are read-only portals in Flow. They keep the call route
  // visible without copying membership into the caller or creating an edge.
  const portalIds = new Set(projectedNodes.map((node) => node.id));
  const lastMemberColumn = Math.max(0, ...projectedNodes.map((node) => node.position.x));
  const lastMemberRow = Math.max(0, ...projectedNodes.map((node) => node.position.y));
  const callPortals = (snapshot.invocations ?? []).flatMap((invocation, index) => {
    const targetFlow = flows.find((item) => item.flow.id === invocation.target_flow_id);
    const entryId = targetFlow?.flow.entry_node_id;
    const canonical = entryId
      ? nodes.find((node) => node.id === entryId && (node.data.canonicalNodeId ?? node.id) === entryId)
      : undefined;
    if (!canonical || portalIds.has(canonical.id)) return [];
    portalIds.add(canonical.id);
    const { extent: _extent, parentId: _parentId, ...rootNode } = canonical;
    return [{
      ...rootNode,
      position: { x: lastMemberColumn + FLOW_COLUMN_SPACING, y: lastMemberRow + (index + 1) * FLOW_ROW_SPACING },
      width: 200,
      height: Math.min(canonical.height ?? 156, 180),
      data: {
        ...canonical.data,
        callContext: targetFlow?.flow.name ?? invocation.target_flow_id,
        containerNodeId: undefined
      }
    }];
  });
  projectedNodes.push(...callPortals);
  const visibleIds = new Set(projectedNodes.map((node) => node.id));
  return {
    nodes: projectedNodes,
    edges: spreadFlowRouteLabels([
      ...snapshot.transitions
      .filter((transition) => visibleIds.has(transition.source_node_id) && visibleIds.has(transition.target_node_id))
      .map(flowTransitionEdge),
      ...sceneBoundaryEdges(snapshot, visibleIds),
      ...flowInvocationEdges(snapshot, flows, visibleIds)
    ])
  };
}

/** Places flow members by traversal depth while keeping parallel branches legible. */
function flowNodePositions(snapshot: StoryFlowSnapshot): Map<string, { x: number; y: number }> {
  const members = new Set(snapshot.nodes.map((membership) => membership.node_id));
  const outgoing = new Map<string, FlowTransition[]>();
  for (const transition of snapshot.transitions) {
    outgoing.set(transition.source_node_id, [...(outgoing.get(transition.source_node_id) ?? []), transition]);
  }
  for (const boundary of snapshot.scene_boundaries) {
    if (!outgoing.get(boundary.scene_node_id)?.some((transition) => transition.target_node_id === boundary.entry_node_id)) {
      outgoing.set(boundary.scene_node_id, [
        ...(outgoing.get(boundary.scene_node_id) ?? []),
        virtualBoundaryTransition(snapshot, boundary)
      ]);
    }
  }
  const depth = new Map<string, number>();
  const queue = snapshot.flow.entry_node_id && members.has(snapshot.flow.entry_node_id)
    ? [snapshot.flow.entry_node_id]
    : [];
  if (queue[0]) depth.set(queue[0], 0);
  while (queue.length) {
    const source = queue.shift()!;
    const nextDepth = (depth.get(source) ?? 0) + 1;
    for (const transition of outgoing.get(source) ?? []) {
      if (!members.has(transition.target_node_id)) continue;
      const previous = depth.get(transition.target_node_id);
      if (previous === undefined || nextDepth < previous) {
        depth.set(transition.target_node_id, nextDepth);
        queue.push(transition.target_node_id);
      }
    }
  }
  const groups = new Map<number, string[]>();
  for (const membership of [...snapshot.nodes].sort((left, right) => left.presentation_order - right.presentation_order)) {
    // Disconnected members remain in the entry layer and are reported separately by integrity checks.
    const memberDepth = depth.get(membership.node_id) ?? 0;
    groups.set(memberDepth, [...(groups.get(memberDepth) ?? []), membership.node_id]);
  }
  const orderedDepths = [...groups.keys()].sort((left, right) => left - right);
  const orderByNode = new Map<string, number>();
  let incoming: ReturnType<typeof buildIncomingTransitionLookup> | undefined;
  for (const memberDepth of orderedDepths) {
    const nodeIds = groups.get(memberDepth)!;
    if (memberDepth > 0) {
      // Parent barycentres keep sibling routes close and reduce edge crossings without mutating author order.
      nodeIds.sort((left, right) => {
        // No row scores are cached: known parent rows change between depth groups.
        incoming ??= buildIncomingTransitionLookup(snapshot.transitions);
        return parentOrder(incoming.get(left) ?? [], orderByNode) - parentOrder(incoming.get(right) ?? [], orderByNode);
      });
    }
    nodeIds.forEach((nodeId, index) => orderByNode.set(nodeId, index));
  }
  const pairCounts = new Map<string, number>();
  for (const transition of snapshot.transitions) {
    const key = nodePairKey(transition.source_node_id, transition.target_node_id);
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }
  const wideBoundaries = new Set<number>();
  for (const transition of snapshot.transitions) {
    if ((pairCounts.get(nodePairKey(transition.source_node_id, transition.target_node_id)) ?? 0) < 2) continue;
    const sourceDepth = depth.get(transition.source_node_id);
    const targetDepth = depth.get(transition.target_node_id);
    if (sourceDepth !== undefined && targetDepth !== undefined && Math.abs(sourceDepth - targetDepth) === 1) {
      wideBoundaries.add(Math.min(sourceDepth, targetDepth));
    }
  }
  const xByDepth = new Map<number, number>([[0, 0]]);
  for (let memberDepth = 1; memberDepth <= Math.max(0, ...orderedDepths); memberDepth += 1) {
    const previous = xByDepth.get(memberDepth - 1) ?? 0;
    xByDepth.set(memberDepth, previous + (wideBoundaries.has(memberDepth - 1)
      ? FLOW_SHARED_ROUTE_COLUMN_SPACING
      : FLOW_COLUMN_SPACING));
  }
  const positions = new Map<string, { x: number; y: number }>();
  for (const [memberDepth, nodeIds] of groups) {
    nodeIds.forEach((nodeId, index) => {
      // The horizontal corridor reserves room for a full edge label between 210px cards.
      positions.set(nodeId, { x: xByDepth.get(memberDepth) ?? 0, y: index * FLOW_ROW_SPACING });
    });
  }
  return positions;
}

/** Returns the average known parent row while preserving stable order for roots. */
function parentOrder(transitions: readonly FlowTransition[], orderByNode: Map<string, number>): number {
  const parentRows = transitions
    .map((transition) => orderByNode.get(transition.source_node_id))
    .filter((row): row is number => row !== undefined);
  return parentRows.length ? parentRows.reduce((sum, row) => sum + row, 0) / parentRows.length : Number.MAX_SAFE_INTEGER;
}

/** Assigns separate label lanes to routes leaving the same node. */
function spreadFlowRouteLabels(edges: Edge<NarrativeEdgeData>[]): Edge<NarrativeEdgeData>[] {
  const routeIndexes = new Map<string, number>();
  const routeCounts = new Map<string, number>();
  const pairCounts = new Map<string, number>();
  const pairRouteCounts = new Map<string, number>();
  const pairRouteIndexes = new Map<string, number>();
  const pairDirections = new Map<string, Set<string>>();
  for (const edge of edges) {
    const pair = flowRoutePairKey(edge);
    pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
    if (!edge.data?.flowTransition && !edge.data?.flowInvocation && !edge.data?.sceneBoundary) continue;
    routeCounts.set(edge.source, (routeCounts.get(edge.source) ?? 0) + 1);
    pairRouteCounts.set(pair, (pairRouteCounts.get(pair) ?? 0) + 1);
    pairDirections.set(pair, new Set([
      ...(pairDirections.get(pair) ?? []),
      `${edge.source}\u0000${edge.target}`
    ]));
  }
  return edges.map((edge) => {
    const isFlowRoute = Boolean(
      edge.data?.flowTransition || edge.data?.flowInvocation || edge.data?.sceneBoundary
    );
    const count = routeCounts.get(edge.source) ?? 0;
    if (!isFlowRoute || !count || !edge.data) return edge;
    const index = routeIndexes.get(edge.source) ?? 0;
    routeIndexes.set(edge.source, index + 1);
    // Keep sibling labels distinguishable without detaching them visually from
    // their own path. The previous fixed 32px step grew without a useful bound.
    const labelOffset = count === 1
      ? 0
      : ((index / (count - 1)) * 2 - 1) * 10;
    const pair = flowRoutePairKey(edge);
    const pairCount = pairCounts.get(pair) ?? 1;
    const pairRouteCount = pairRouteCounts.get(pair) ?? 1;
    const pairRouteIndex = pairRouteIndexes.get(pair) ?? 0;
    pairRouteIndexes.set(pair, pairRouteIndex + 1);
    const centerReserved = pairCount > pairRouteCount;
    const pairLane = pairCount <= 1
      ? 0
      : centerReserved
        ? (pairRouteIndex % 2 === 0 ? 1 : -1)
          * ((Math.floor(pairRouteIndex / 2) + 1) / Math.ceil(pairRouteCount / 2))
        : pairRouteCount === 1
          ? 0
          : -1 + (pairRouteIndex / (pairRouteCount - 1)) * 2;
    // Reciprocal routes share one visual corridor. Orienting their lanes by the
    // canonical endpoint order moves their labels to opposite screen positions.
    const labelLane = pairLane * (edge.source <= edge.target ? 1 : -1);
    const reciprocalReturn = edge.source !== edge.target
      && edge.data.flowTransition?.kind === "return"
      && pairDirections.get(pair)?.has(`${edge.target}\u0000${edge.source}`) === true;
    return {
      ...edge,
      sourceHandle: reciprocalReturn ? "top" : edge.data.flowInvocation ? "bottom" : "right",
      targetHandle: reciprocalReturn ? "top" : "left",
      data: {
        ...edge.data,
        flowRouteLabelOffset: labelOffset,
        flowRouteLabelLane: reciprocalReturn ? 0 : labelLane,
        flowRouteArc: reciprocalReturn
      }
    };
  });
}

/** Groups both directions between two nodes into one visual label corridor. */
function flowRoutePairKey(edge: Pick<Edge, "source" | "target">): string {
  return nodePairKey(edge.source, edge.target);
}

/** Creates one stable key for either direction through a node pair. */
function nodePairKey(source: string, target: string): string {
  return source <= target ? `${source}\u0000${target}` : `${target}\u0000${source}`;
}

/** Builds a visibly raised cubic route and places its label near the apex. */
export function flowRouteArcPath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number
): [string, number, number] {
  const horizontalDistance = Math.abs(targetX - sourceX);
  const verticalDistance = Math.abs(targetY - sourceY);
  const height = Math.round(Math.max(140, Math.min(260, horizontalDistance * 0.34 + verticalDistance * 0.12)));
  const path = `M${sourceX},${sourceY} C${sourceX},${sourceY - height} ${targetX},${targetY - height} ${targetX},${targetY}`;
  return [path, (sourceX + targetX) / 2, (sourceY + targetY) / 2 - height * 0.75];
}

/** Move a colliding label along its route while keeping it away from endpoint cards. */
export function shiftedFlowLabelPosition(
  labelX: number,
  labelY: number,
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  requestedLane: number
): { x: number; y: number } {
  const deltaX = targetX - sourceX;
  const deltaY = targetY - sourceY;
  const distance = Math.hypot(deltaX, deltaY);
  if (!distance || !requestedLane) return { x: labelX, y: labelY };
  const shift = Math.max(-1, Math.min(1, requestedLane))
    * Math.min(96, distance * 0.3);
  return {
    x: labelX + (deltaX / distance) * shift,
    y: labelY + (deltaY / distance) * shift
  };
}

/** Derives read-only entry, branch, ending, and reachability presentation. */
export function analyzeStoryFlow(snapshot: StoryFlowSnapshot | null): {
  facts: StoryFlowFact[];
  roles: Map<string, StoryFlowNodeRole>;
} {
  if (!snapshot) return { facts: [], roles: new Map() };
  const memberIds = new Set(snapshot.nodes.map((membership) => membership.node_id));
  const outgoing = new Map<string, FlowTransition[]>();
  for (const transition of snapshot.transitions) {
    outgoing.set(transition.source_node_id, [...(outgoing.get(transition.source_node_id) ?? []), transition]);
  }
  const invocationCounts = new Map<string, number>();
  for (const invocation of snapshot.invocations ?? []) {
    invocationCounts.set(invocation.source_node_id, (invocationCounts.get(invocation.source_node_id) ?? 0) + 1);
  }
  for (const boundary of snapshot.scene_boundaries) {
    if (!outgoing.get(boundary.scene_node_id)?.some((transition) => transition.target_node_id === boundary.entry_node_id)) {
      outgoing.set(boundary.scene_node_id, [
        ...(outgoing.get(boundary.scene_node_id) ?? []),
        virtualBoundaryTransition(snapshot, boundary)
      ]);
    }
  }
  const reachable = new Set<string>();
  const pending = snapshot.flow.entry_node_id ? [snapshot.flow.entry_node_id] : [];
  while (pending.length) {
    const nodeId = pending.shift()!;
    if (reachable.has(nodeId) || !memberIds.has(nodeId)) continue;
    reachable.add(nodeId);
    for (const transition of outgoing.get(nodeId) ?? []) pending.push(transition.target_node_id);
  }

  const facts: StoryFlowFact[] = [];
  if (!snapshot.flow.entry_node_id || !memberIds.has(snapshot.flow.entry_node_id)) {
    facts.push({ code: "missing_entry", level: "error", label: "Entry is missing or outside this flow" });
  }
  const roles = new Map<string, StoryFlowNodeRole>();
  for (const membership of snapshot.nodes) {
    const siblings = outgoing.get(membership.node_id) ?? [];
    const outgoingCount = siblings.length + (invocationCounts.get(membership.node_id) ?? 0);
    const role = {
      branch: outgoingCount > 1,
      ending: outgoingCount === 0,
      entry: membership.node_id === snapshot.flow.entry_node_id,
      unreachable: Boolean(snapshot.flow.entry_node_id) && !reachable.has(membership.node_id)
    };
    roles.set(membership.node_id, role);
    if (role.ending) facts.push({ code: "ending", level: "info", label: "Ending", nodeId: membership.node_id });
    if (role.unreachable) facts.push({ code: "unreachable_member", level: "warning", label: "Unreachable member", nodeId: membership.node_id });
  }
  return { facts, roles };
}

/** Projects calls as amber dashed routes, never as semantic relationships. */
export function flowInvocationEdges(
  snapshot: StoryFlowSnapshot,
  flows: StoryFlowSnapshot[],
  visibleIds: Set<string>
): Edge<NarrativeEdgeData>[] {
  return (snapshot.invocations ?? []).flatMap((invocation) => {
    const targetFlow = flows.find((item) => item.flow.id === invocation.target_flow_id);
    const targetNodeId = targetFlow?.flow.entry_node_id;
    if (!visibleIds.has(invocation.source_node_id) || !targetNodeId || !visibleIds.has(targetNodeId)) return [];
    const targetExitIds = new Set(targetFlow?.exits?.map((item) => item.id) ?? []);
    const mappedExitIds = new Set((snapshot.bindings ?? [])
      .filter((item) => item.invocation_id === invocation.id)
      .map((item) => item.exit_id));
    const invalid = !targetFlow?.flow.entry_node_id
      || [...targetExitIds].some((exitId) => !mappedExitIds.has(exitId));
    return [flowInvocationEdge(invocation, targetNodeId, targetFlow?.flow.name ?? invocation.target_flow_id, invalid)];
  });
}

function flowInvocationEdge(
  invocation: FlowInvocation,
  targetNodeId: string,
  targetFlowName: string,
  invalid: boolean
): Edge<NarrativeEdgeData> {
  const color = invalid ? "#dc2626" : "#b45309";
  return {
    id: `flow-invocation:${invocation.id}`,
    type: "storyFlow",
    source: invocation.source_node_id,
    target: targetNodeId,
    label: invocation.label || targetFlowName,
    markerEnd: { type: MarkerType.ArrowClosed, color },
    reconnectable: false,
    data: {
      label: invocation.label || targetFlowName,
      flowInvocation: {
        invocationId: invocation.id,
        sourceFlowId: invocation.source_flow_id,
        targetFlowId: invocation.target_flow_id,
        priority: invocation.priority,
        isDefault: invocation.is_default,
        condition: invocation.condition,
        invalid
      }
    },
    style: { stroke: color, strokeDasharray: "10 5", strokeWidth: 4 }
  };
}

/** Mirrors the local presentation facts through the complete runtime report contract. */
export function localStoryFlowIntegrity(snapshot: StoryFlowSnapshot | null): StoryFlowIntegrityReport | null {
  if (!snapshot) return null;
  const facts: FlowIntegrityFact[] = analyzeStoryFlow(snapshot).facts.map((fact) => ({
    code: fact.code,
    level: fact.level,
    message: fact.label,
    action: fact.code === "ending"
      ? "Keep it as an ending or add a continuation."
      : fact.code === "unreachable_member"
        ? "Connect it to the route or remove it from this Story Flow."
        : "Choose an existing member as the Story Flow entry.",
    flow_id: snapshot.flow.id,
    node_id: fact.nodeId ?? null,
    transition_id: null,
    scene_node_id: null,
    container_node_id: null,
    placement_id: null,
    relationship_id: null
  }));
  return { project_id: snapshot.flow.project_id, flow_id: snapshot.flow.id, facts };
}

export function defaultWorkspacePreference(flows: StoryFlowSnapshot[]): ProjectWorkspacePreference {
  return {
    mode: "relationships",
    activeFlowId: flows.find((snapshot) => snapshot.flow.status !== "archived")?.flow.id ?? null
  };
}

/** Supplies neutral defaults for the two ordered empty-project starter commands. */
export function emptyProjectStoryDraft(kind: StoryFlowBootstrapDraft["kind"]): StoryFlowBootstrapDraft {
  return kind === "Scene"
    ? {
        kind,
        title: "Opening Scene",
        summary: "First playable scene.",
        position: { x: 160, y: 120 },
        size: { width: 520, height: 360 }
      }
    : {
        kind,
        title: "Opening Event",
        summary: "First event in the story.",
        position: { x: 160, y: 120 },
        size: { width: 260, height: 156 }
      };
}

function flowTransitionEdge(transition: FlowTransition): Edge<NarrativeEdgeData> {
  return {
    id: `story-flow:${transition.id}`,
    type: "storyFlow",
    source: transition.source_node_id,
    target: transition.target_node_id,
    label: transition.label || transition.kind,
    markerEnd: { type: MarkerType.ArrowClosed, color: "#0f766e" },
    reconnectable: true,
    data: {
      label: transition.label || transition.kind,
      flowTransition: {
        flowId: transition.flow_id,
        transitionId: transition.id,
        kind: transition.kind,
        priority: transition.priority,
        isDefault: transition.is_default,
        condition: transition.condition
      }
    },
    style: {
      stroke: "#0f766e",
      strokeWidth: 3,
      strokeDasharray:
        transition.kind === "branch"
          ? "9 5"
          : transition.kind === "optional"
            ? "3 5"
            : transition.kind === "return"
              ? "10 4 2 4"
              : undefined
    }
  };
}

/** Renders one Scene-entry transition only when an explicit transition does not already explain it. */
function sceneBoundaryEdges(snapshot: StoryFlowSnapshot, visibleIds: Set<string>): Edge<NarrativeEdgeData>[] {
  return snapshot.scene_boundaries.flatMap((boundary) => {
    if (!visibleIds.has(boundary.scene_node_id) || !visibleIds.has(boundary.entry_node_id)) return [];
    if (snapshot.transitions.some((transition) =>
      transition.source_node_id === boundary.scene_node_id && transition.target_node_id === boundary.entry_node_id
    )) return [];
    return [{
      id: `story-boundary:${boundary.id}`,
      type: "storyFlow",
      source: boundary.scene_node_id,
      target: boundary.entry_node_id,
      label: "Scene entry",
      markerEnd: { type: MarkerType.ArrowClosed, color: "#0369a1" },
      reconnectable: false,
      data: {
        label: "Scene entry",
        sceneBoundary: {
          boundaryId: boundary.id,
          flowId: boundary.flow_id,
          sceneNodeId: boundary.scene_node_id,
          entryNodeId: boundary.entry_node_id,
          exitNodeIds: boundary.exit_node_ids
        }
      },
      style: { stroke: "#0369a1", strokeDasharray: "5 4", strokeWidth: 3 }
    }];
  });
}

function virtualBoundaryTransition(
  snapshot: StoryFlowSnapshot,
  boundary: StoryFlowSnapshot["scene_boundaries"][number]
): FlowTransition {
  return {
    transition_version: 1,
    id: `boundary:${boundary.id}`,
    project_id: snapshot.flow.project_id,
    flow_id: snapshot.flow.id,
    source_node_id: boundary.scene_node_id,
    target_node_id: boundary.entry_node_id,
    kind: "next",
    label: "Scene entry",
    condition: "",
    priority: -1,
    is_default: false,
    metadata: { scene_boundary_id: boundary.id },
    created_at: boundary.created_at,
    updated_at: boundary.updated_at
  };
}

import type { Node } from "@xyflow/react";
import type { NarrativeNodeData, NodeDraft } from "../types";
import type { FlowTransition, FlowTransitionDraft, SceneFlowBoundary, StoryFlowNode, StoryFlowSnapshot } from "./contracts";

/** Produces the first free sibling priority for a continuation editor. */
export function nextTransitionPriority(snapshot: StoryFlowSnapshot, sourceNodeId: string): number {
  const used = new Set([
    ...snapshot.transitions.filter((item) => item.source_node_id === sourceNodeId).map((item) => item.priority),
    ...(snapshot.invocations ?? []).filter((item) => item.source_node_id === sourceNodeId).map((item) => item.priority)
  ]);
  let priority = 0;
  while (used.has(priority)) priority += 1;
  return priority;
}

/** Reorders only one source's transitions while preserving stable record ids. */
export function reorderOutgoingTransitions(
  snapshot: StoryFlowSnapshot,
  sourceNodeId: string,
  orderedIds: string[]
): StoryFlowSnapshot {
  const siblings = snapshot.transitions.filter((item) => item.source_node_id === sourceNodeId);
  if (orderedIds.length !== siblings.length || new Set(orderedIds).size !== orderedIds.length
    || siblings.some((item) => !orderedIds.includes(item.id))) {
    throw new Error("Transition order must contain every outgoing transition exactly once.");
  }
  const priorityById = new Map(orderedIds.map((id, priority) => [id, priority]));
  return {
    ...snapshot,
    transitions: snapshot.transitions.map((item) =>
      item.source_node_id === sourceNodeId ? { ...item, priority: priorityById.get(item.id)! } : item
    )
  };
}

/** Removes flow-owned order while preserving canonical content and membership. */
export function removeTransitionLocally(snapshot: StoryFlowSnapshot, transitionId: string): StoryFlowSnapshot {
  return { ...snapshot, transitions: snapshot.transitions.filter((item) => item.id !== transitionId) };
}

/** Replaces entry ownership without changing memberships. */
export function setEntryLocally(snapshot: StoryFlowSnapshot, nodeId: string): StoryFlowSnapshot {
  if (!snapshot.nodes.some((item) => item.node_id === nodeId)) throw new Error("Entry node must be a flow member.");
  return { ...snapshot, flow: { ...snapshot.flow, entry_node_id: nodeId, updated_at: new Date().toISOString() } };
}

/** Adds canonical content to a flow and gives the first member an explicit entry. */
export function addMembershipLocally(
  snapshot: StoryFlowSnapshot,
  nodeId: string,
  createId: () => string = () => crypto.randomUUID()
): StoryFlowSnapshot {
  if (snapshot.nodes.some((item) => item.node_id === nodeId)) return snapshot;
  const now = new Date().toISOString();
  const next = {
    ...snapshot,
    nodes: [...snapshot.nodes, localMembership(snapshot, nodeId, now, createId)]
  };
  return snapshot.flow.entry_node_id === null ? setEntryLocally(next, nodeId) : next;
}

/** Builds a complete local fallback for an existing-node continuation. */
export function continueExistingLocally(
  snapshot: StoryFlowSnapshot,
  sourceNodeId: string,
  targetNodeId: string,
  draft: FlowTransitionDraft,
  createId: () => string = () => crypto.randomUUID()
): StoryFlowSnapshot {
  const withSource = addMembershipLocally(snapshot, sourceNodeId, createId);
  const semanticEdgeId = draft.metadata?.semantic_edge_id;
  const existing = typeof semanticEdgeId === "string"
    ? withSource.transitions.find((item) => item.metadata.semantic_edge_id === semanticEdgeId)
    : undefined;
  validateTransitionDraft(
    existing
      ? { ...withSource, transitions: withSource.transitions.filter((item) => item.id !== existing.id) }
      : withSource,
    sourceNodeId,
    targetNodeId,
    draft
  );
  const now = new Date().toISOString();
  const membership = withSource.nodes.find((item) => item.node_id === targetNodeId) ?? localMembership(withSource, targetNodeId, now, createId);
  const nextNodes = withSource.nodes.some((item) => item.node_id === targetNodeId) ? withSource.nodes : [...withSource.nodes, membership];
  if (existing) {
    return {
      ...withSource,
      nodes: nextNodes,
      transitions: withSource.transitions.map((item) => item.id === existing.id
        ? {
            ...existing,
            source_node_id: sourceNodeId,
            target_node_id: targetNodeId,
            ...draft,
            metadata: { ...existing.metadata, ...(draft.metadata ?? {}) },
            updated_at: now
          }
        : item)
    };
  }
  return {
    ...withSource,
    nodes: nextNodes,
    transitions: [...withSource.transitions, localTransition(withSource, sourceNodeId, targetNodeId, draft, now, createId)]
  };
}

/** Creates or replaces a Scene boundary without coupling it to visual placement mutations. */
export function setSceneBoundaryLocally(
  snapshot: StoryFlowSnapshot,
  sceneNodeId: string,
  entryNodeId: string,
  exitNodeIds: string[],
  canonicalChildIds: string[],
  createId: () => string = () => crypto.randomUUID()
): StoryFlowSnapshot {
  const members = new Set(snapshot.nodes.map((item) => item.node_id));
  const children = new Set(canonicalChildIds);
  const references = [entryNodeId, ...exitNodeIds];
  if (!members.has(sceneNodeId) || references.some((nodeId) => !members.has(nodeId))) {
    throw new Error("Scene boundary references must belong to the selected Story Flow.");
  }
  if (new Set(exitNodeIds).size !== exitNodeIds.length || references.some((nodeId) => !children.has(nodeId))) {
    throw new Error("Scene boundary entry and exits must be canonical Scene children.");
  }
  const now = new Date().toISOString();
  const existing = snapshot.scene_boundaries.find((item) => item.scene_node_id === sceneNodeId);
  const boundary: SceneFlowBoundary = existing
    ? { ...existing, entry_node_id: entryNodeId, exit_node_ids: exitNodeIds, updated_at: now }
    : {
        boundary_version: 1,
        id: `boundary-local-${createId()}`,
        project_id: snapshot.flow.project_id,
        flow_id: snapshot.flow.id,
        scene_node_id: sceneNodeId,
        entry_node_id: entryNodeId,
        exit_node_ids: exitNodeIds,
        metadata: { local_fallback: true },
        created_at: now,
        updated_at: now
      };
  return {
    ...snapshot,
    scene_boundaries: [...snapshot.scene_boundaries.filter((item) => item.scene_node_id !== sceneNodeId), boundary],
    scene_children: { ...snapshot.scene_children, [sceneNodeId]: canonicalChildIds }
  };
}

/** Removes only Flow-owned Scene routing and preserves the Scene and placements. */
export function removeSceneBoundaryLocally(snapshot: StoryFlowSnapshot, sceneNodeId: string): StoryFlowSnapshot {
  return {
    ...snapshot,
    scene_boundaries: snapshot.scene_boundaries.filter((item) => item.scene_node_id !== sceneNodeId)
  };
}

/** Builds the graph node and aggregate records used when runtime continuation is unavailable. */
export function continueNewLocally(
  snapshot: StoryFlowSnapshot,
  sourceNodeId: string,
  nodeDraft: NodeDraft,
  transitionDraft: FlowTransitionDraft,
  position: { x: number; y: number },
  createId: () => string = () => crypto.randomUUID()
): { node: Node<NarrativeNodeData>; snapshot: StoryFlowSnapshot } {
  const nodeId = `node-local-${createId()}`;
  const node: Node<NarrativeNodeData> = {
    id: nodeId,
    type: "narrative",
    position,
    width: 260,
    height: 156,
    data: {
      kind: nodeDraft.kind,
      label: nodeDraft.title,
      title: nodeDraft.title,
      summary: nodeDraft.summary,
      tags: nodeDraft.tags,
      ...(nodeDraft.kind === "Scene" || nodeDraft.kind === "Location" ? { isFrame: true } : {})
    }
  };
  return { node, snapshot: continueExistingLocally(snapshot, sourceNodeId, nodeId, transitionDraft, createId) };
}

function validateTransitionDraft(
  snapshot: StoryFlowSnapshot,
  sourceNodeId: string,
  targetNodeId: string,
  draft: FlowTransitionDraft
) {
  if (sourceNodeId === targetNodeId) throw new Error("Flow transition endpoints must be distinct.");
  if (!snapshot.nodes.some((item) => item.node_id === sourceNodeId)) throw new Error("Continuation source must be a flow member.");
  if (snapshot.transitions.some((item) => item.source_node_id === sourceNodeId && item.priority === draft.priority)) {
    throw new Error("Transition priority must be unique for its source.");
  }
  if (draft.is_default && draft.condition.trim()) throw new Error("Default branch cannot have a condition.");
  if (draft.kind === "branch" && !draft.is_default && !draft.condition.trim()) {
    throw new Error("Non-default branch requires a condition.");
  }
}

function localMembership(
  snapshot: StoryFlowSnapshot,
  nodeId: string,
  now: string,
  createId: () => string
): StoryFlowNode {
  return {
    flow_node_version: 1,
    id: `membership-local-${createId()}`,
    project_id: snapshot.flow.project_id,
    flow_id: snapshot.flow.id,
    node_id: nodeId,
    presentation_order: Math.max(-1, ...snapshot.nodes.map((item) => item.presentation_order)) + 1,
    metadata: { local_fallback: true },
    created_at: now,
    updated_at: now
  };
}

function localTransition(
  snapshot: StoryFlowSnapshot,
  sourceNodeId: string,
  targetNodeId: string,
  draft: FlowTransitionDraft,
  now: string,
  createId: () => string
): FlowTransition {
  return {
    transition_version: 1,
    id: `transition-local-${createId()}`,
    project_id: snapshot.flow.project_id,
    flow_id: snapshot.flow.id,
    source_node_id: sourceNodeId,
    target_node_id: targetNodeId,
    ...draft,
    metadata: { local_fallback: true, ...(draft.metadata ?? {}) },
    created_at: now,
    updated_at: now
  };
}

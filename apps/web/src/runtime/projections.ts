/* Pure runtime DTO to frontend model projections and mutation payload builders. */
import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type { ProjectCompositionSnapshot, VisualPlacement } from "../composition/contracts";
import { orderHydratedPlacements } from "./orderHydratedPlacements";
import type { DialogueDocument } from "../dialogue/contracts";
import type { PlaybackTypedEffect } from "../playback/contracts";
import type { QuestDocument } from "../quest/contracts";
import type { FlowTransition, StoryFlowSnapshot } from "../story-flow/contracts";
import { NARRATIVE_EDGE_TYPES, NARRATIVE_NODE_KINDS, type NarrativeEdgeData, type NarrativeIssue, type NarrativeNodeData, type NarrativeProject, type NarrativeRelationshipType, type ProjectDraft, type ProjectStatus } from "../types";
import type { RuntimeEdge, RuntimeGraphSnapshot, RuntimeIssue, RuntimeNode, RuntimeProject, RuntimeProjectSessionResponse } from "./apiTypes";
export const DEFAULT_NODE_SIZE = { height: 156, width: 260 };
/** Projects a validated session document into the current React Flow store shape. */
export function projectSessionToGraphSnapshot(response: RuntimeProjectSessionResponse): RuntimeGraphSnapshot {
  const { document, session } = response;
  const dialogueByNode = new Map(document.dialogues.map((item) => [item.node_id, item.document]));
  const questByNode = new Map(document.quests.map((item) => [item.node_id, item.document]));
  const runtimeNodes = document.nodes.map((node) => ({
    ...node,
    metadata: {
      ...node.metadata,
      ...(dialogueByNode.has(node.id) ? { dialogue_document: dialogueByNode.get(node.id) } : {}),
      ...(questByNode.has(node.id) ? { quest_document: questByNode.get(node.id) } : {})
    }
  }));
  const composition: ProjectCompositionSnapshot = {
    composition_version: 1,
    project_id: session.project_id,
    placements: document.placements.map((placement) => ({
      placement_version: 1,
      id: placement.id,
      project_id: placement.project_id,
      canonical_node_id: placement.canonical_node_id,
      container_node_id: placement.container_node_id,
      position: { x: placement.x, y: placement.y },
      size: { width: placement.width, height: placement.height },
      is_primary: placement.is_primary,
      presentation_state: placement.presentation_state === "collapsed" ? "collapsed" : "expanded",
      metadata: placement.metadata
    })),
    semantic_relationships: []
  };
  return {
    activeProjectId: session.project_id,
    activeSessionId: session.session_id,
    projectSession: session,
    autosave: document.manifest.settings.autosave,
    manifest: document.manifest,
    edges: document.edges.map(runtimeEdgeToFlowEdge),
    issues: document.issues.map(runtimeIssueToNarrativeIssue),
    nodes: applyRuntimeComposition(runtimeNodes.map(runtimeNodeToFlowNode), composition),
    playbackEffectsByFlow: projectDocumentPlaybackEffects(document.engine_tags),
    projects: [{
        id: session.project_id,
        name: document.manifest.name,
        description: document.manifest.description,
        path: session.project_path,
        status: "open",
        updatedAt: document.manifest.updated_at.slice(0, 10)
      }],
    storyFlows: projectDocumentStoryFlows(document)
  };
}
export function projectDocumentStoryFlows(document: RuntimeProjectSessionResponse["document"]): StoryFlowSnapshot[] {
  return document.story_flows.map((flow) => {
    const invocations = document.flow_invocations.filter((item) => item.source_flow_id === flow.id);
    const invocationIds = new Set(invocations.map((item) => item.id));
    return {
      snapshot_version: 1,
      flow: {
        flow_version: 1,
        id: flow.id,
        project_id: flow.project_id,
        name: flow.name,
        description: flow.description,
        kind: flow.kind === "side" || flow.kind === "standalone" ? flow.kind : "main",
        status: flow.status === "active" || flow.status === "archived" ? flow.status : "draft",
        entry_node_id: flow.entry_node_id,
        metadata: flow.metadata,
        created_at: flow.created_at,
        updated_at: flow.updated_at
      },
      nodes: document.story_flow_nodes.filter((node) => node.flow_id === flow.id).map((node) => ({
        flow_node_version: 1,
        ...node
      })),
      transitions: document.flow_transitions.filter((transition) => transition.flow_id === flow.id).map((transition) => ({
        transition_version: 1,
        ...transition,
        kind: transitionKind(transition.kind)
      })),
      scene_boundaries: document.scene_flow_boundaries.filter((boundary) => boundary.flow_id === flow.id).map((boundary) => ({
        boundary_version: 1,
        ...boundary
      })),
      scene_children: Object.fromEntries(document.scene_flow_boundaries
        .filter((boundary) => boundary.flow_id === flow.id)
        .map((boundary) => [boundary.scene_node_id, [boundary.entry_node_id]])),
      invocations: invocations.map((item) => ({ invocation_version: 1, ...item })),
      exits: document.flow_exits
        .filter((item) => item.flow_id === flow.id)
        .map((item) => ({ exit_version: 1, ...item })),
      bindings: document.flow_exit_bindings
        .filter((item) => invocationIds.has(item.invocation_id))
        .map((item) => ({ binding_version: 1, ...item }))
    };
  });
}
export function projectDocumentPlaybackEffects(tags: RuntimeProjectSessionResponse["document"]["engine_tags"]): Record<string, PlaybackTypedEffect[]> {
  const effects: PlaybackTypedEffect[] = [];
  for (const tag of tags) {
    if (tag.engine !== "playback" || tag.key !== "typed_effect")
      continue;
    try {
      const value = JSON.parse(tag.value) as PlaybackTypedEffect;
      if (value && typeof value.id === "string" && typeof value.flow_id === "string")
        effects.push(value);
    }
    catch {
      // Invalid optional engine metadata cannot prevent the canonical graph from opening.
    }
  }
  return effects.reduce<Record<string, PlaybackTypedEffect[]>>((grouped, effect) => ({
    ...grouped,
    [effect.flow_id]: [...(grouped[effect.flow_id] ?? []), effect]
  }), {});
}
export function transitionKind(value: string): FlowTransition["kind"] {
  return value === "branch" || value === "optional" || value === "return" ? value : "next";
}
export function runtimeProjectToNarrativeProject(project: RuntimeProject): NarrativeProject {
  return {
    id: project.id,
    name: project.name,
    description: stringMetadata(project.metadata.description, ""),
    path: project.path,
    status: statusMetadata(project.metadata.status),
    updatedAt: project.updated_at.slice(0, 10)
  };
}
export function runtimeNodeToFlowNode(node: RuntimeNode): Node<NarrativeNodeData> {
  const position = positionMetadata(node.metadata.position);
  const width = numberMetadata(node.metadata.width, DEFAULT_NODE_SIZE.width);
  const height = numberMetadata(node.metadata.height, DEFAULT_NODE_SIZE.height);
  const kind = kindMetadata(node.metadata.kind ?? node.type);
  const tags = tagsMetadata(node.metadata.tags);
  const dialogueDocument = kind === "Dialogue" ? dialogueDocumentMetadata(node.metadata.dialogue_document) : undefined;
  const questDocument = kind === "Quest" ? questDocumentMetadata(node.metadata.quest_document) : undefined;
  const requirement = kind === "Condition" ? requirementMetadata(node.metadata.requirement) : undefined;
  const outcome = kind === "Consequence" ? outcomeMetadata(node.metadata.outcome) : undefined;
  const isFrame = node.metadata.composition_frame === true && (kind === "Scene" || kind === "Location");
  const rootPlacementId = stringMetadata(node.metadata.root_placement_id, null);
  return {
    id: node.id,
    type: "narrative",
    position,
    width,
    height,
    data: {
      kind,
      label: stringMetadata(node.metadata.label, node.title),
      summary: node.summary || node.body,
      tags,
      title: node.title,
      ...(dialogueDocument ? { dialogueDocument } : {}),
      ...(questDocument ? { questDocument } : {}),
      ...(requirement ? { requirement } : {}),
      ...(outcome ? { outcome } : {}),
      ...(kind === "Character" ? { characterRole: stringMetadata(node.metadata.character_role, "") } : {}),
      ...(kind === "Item" ? { itemPurpose: stringMetadata(node.metadata.item_purpose, "") } : {}),
      ...(isFrame ? { isFrame: true } : {}),
      ...(rootPlacementId ? { rootPlacementId } : {})
    }
  };
}
export function applyRuntimeComposition(nodes: Node<NarrativeNodeData>[], snapshot: ProjectCompositionSnapshot): Node<NarrativeNodeData>[] {
  const placementsByCanonical = new Map<string, VisualPlacement[]>();
  for (const placement of snapshot.placements) {
    placementsByCanonical.set(placement.canonical_node_id, [...(placementsByCanonical.get(placement.canonical_node_id) ?? []), placement]);
  }
  const projected = nodes.flatMap((node) => {
    const placements = placementsByCanonical.get(node.id) ?? [];
    if (placements.length === 0)
      return [{ ...node, data: { ...node.data, canonicalNodeId: node.id } }];
    return [...placements].sort((left, right) => Number(right.is_primary) - Number(left.is_primary)).map((placement) => ({
      ...node,
      id: placement.is_primary ? node.id : `placement:${placement.id}`,
      parentId: placement.container_node_id ?? undefined,
      position: placement.position,
      width: placement.size.width,
      height: placement.size.height,
      data: {
        ...node.data,
        canonicalNodeId: node.id,
        isLinkedInstance: !placement.is_primary,
        placementId: placement.id,
        containerNodeId: placement.container_node_id ?? undefined,
        presentationState: placement.presentation_state,
        ...(placementExpandedFrameSize(placement) ? { expandedFrameSize: placementExpandedFrameSize(placement) } : {})
      }
    }));
  });
  return orderHydratedPlacements(projected);
}
export function placementExpandedFrameSize(placement: VisualPlacement) {
  const value = placement.metadata.expanded_frame_size;
  if (!value || typeof value !== "object")
    return undefined;
  const size = value as {
    width?: unknown;
    height?: unknown;
  };
  return typeof size.width === "number" && typeof size.height === "number"
    ? { width: size.width, height: size.height }
    : undefined;
}
export function runtimeEdgeToFlowEdge(edge: RuntimeEdge): Edge<NarrativeEdgeData> {
  const dialogueElementId = stringMetadata(edge.metadata.dialogue_element_id, null);
  const questStageId = stringMetadata(edge.metadata.quest_stage_id, null);
  const questBranchId = stringMetadata(edge.metadata.quest_branch_id, null);
  const outcomeFlowComposition = outcomeFlowCompositionMetadata(edge.metadata.outcome_flow_composition);
  return {
    id: edge.id,
    source: edge.source_node_id,
    sourceHandle: stringMetadata(edge.metadata.sourceHandle, null),
    target: edge.target_node_id,
    targetHandle: stringMetadata(edge.metadata.targetHandle, null),
    label: edge.label,
    data: {
      label: edge.label,
      relationshipType: relationshipTypeMetadata(edge.type),
      ...(edge.metadata.canvas_visibility === "hidden" ? { canvasVisibility: "hidden" as const } : {}),
      ...(dialogueElementId ? { dialogueElementId } : {}),
      ...(questStageId ? { questStageId } : {}),
      ...(questBranchId ? { questBranchId } : {}),
      ...(outcomeFlowComposition ? { outcomeFlowComposition } : {})
    },
    markerEnd: { type: MarkerType.ArrowClosed },
    reconnectable: true,
    style: { stroke: "#475569", strokeWidth: 3 }
  };
}
export function runtimeIssueToNarrativeIssue(issue: RuntimeIssue): NarrativeIssue {
  const messageParameters = recordMetadata(issue.metadata.message_parameters);
  const recommendationParameters = recordMetadata(issue.metadata.recommendation_parameters);
  const dialogueOwnerIds = dialogueIssueOwnerIds(issue.metadata);
  return {
    id: issue.id,
    projectId: issue.project_id,
    nodeId: issue.node_id,
    edgeId: issue.edge_id,
    title: stringMetadata(issue.metadata.message_key, issue.title),
    ...(messageParameters ? { titleParameters: messageParameters } : {}),
    description: stringMetadata(issue.metadata.recommendation_key, issue.description),
    ...(recommendationParameters ? { descriptionParameters: recommendationParameters } : {}),
    ...(dialogueOwnerIds.length ? { dialogueOwnerIds } : {}),
    severity: issueSeverity(issue.severity),
    status: issueStatus(issue.status)
  };
}
export /** Collects exact line, choice, and answer identities from extensible analysis metadata. */ function dialogueIssueOwnerIds(metadata: Record<string, unknown>): string[] {
  const candidates: unknown[] = [
    metadata.scope,
    ...(Array.isArray(metadata.targets) ? metadata.targets : []),
    ...(Array.isArray(metadata.evidence)
      ? metadata.evidence.map((item) => recordMetadata(item)?.owner)
      : [])
  ];
  const ownerIds = candidates.flatMap((candidate) => {
    const owner = recordMetadata(candidate);
    const ownerType = owner?.owner_type;
    const ownerId = owner?.owner_id;
    return typeof ownerType === "string"
      && (ownerType === "dialogue_element" || ownerType === "dialogue_option")
      && typeof ownerId === "string"
      ? [ownerId]
      : [];
  });
  for (const key of ["dialogue_element_id", "dialogue_option_id"] as const) {
    const ownerId = metadata[key];
    if (typeof ownerId === "string")
      ownerIds.push(ownerId);
  }
  return [...new Set(ownerIds)];
}
export /** Retains only object-shaped localization parameters from extensible metadata. */ function recordMetadata(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
export function projectDraftToRuntimeCreate(draft: ProjectDraft) {
  return {
    format_version: 1,
    metadata: {
      description: draft.description,
      status: "open"
    },
    name: draft.name,
    path: draft.path ?? "~/Stories"
  };
}
export function flowNodeToRuntimePayload(projectId: string, node: Node<NarrativeNodeData>) {
  return {
    body: node.data.summary,
    metadata: {
      height: node.height ?? DEFAULT_NODE_SIZE.height,
      kind: node.data.kind,
      label: node.data.label,
      position: node.position,
      tags: node.data.tags,
      width: node.width ?? DEFAULT_NODE_SIZE.width,
      ...(node.data.kind === "Dialogue" && node.data.dialogueDocument ? { dialogue_document: node.data.dialogueDocument } : {}),
      ...(node.data.kind === "Quest" && node.data.questDocument ? { quest_document: node.data.questDocument } : {}),
      ...(node.data.kind === "Condition" && node.data.requirement ? { requirement: node.data.requirement } : {}),
      ...(node.data.kind === "Consequence" && node.data.outcome ? { outcome: node.data.outcome } : {}),
      ...(node.data.kind === "Character" ? { character_role: node.data.characterRole ?? "" } : {}),
      ...(node.data.kind === "Item" ? { item_purpose: node.data.itemPurpose ?? "" } : {})
    },
    project_id: projectId,
    status: "canon",
    summary: node.data.summary,
    title: node.data.title,
    type: node.data.kind
  };
}
export function dialogueDocumentMetadata(value: unknown): DialogueDocument | undefined {
  // Detailed invariant validation remains owned by the dedicated runtime route;
  // this guard only prevents malformed generic node metadata from crashing UI hydration.
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as Partial<DialogueDocument>;
  return candidate.dialogue_version === 1 && Array.isArray(candidate.participants) && Array.isArray(candidate.elements)
    ? (candidate as DialogueDocument)
    : undefined;
}
export function questDocumentMetadata(value: unknown): QuestDocument | undefined {
  // Full graph/reference validation remains owned by the dedicated Quest route.
  if (typeof value !== "object" || value === null)
    return undefined;
  const candidate = value as Partial<QuestDocument>;
  return candidate.quest_version === 1 && Array.isArray(candidate.stages) && Array.isArray(candidate.prerequisite_node_ids) && Array.isArray(candidate.reward_node_ids)
    ? (candidate as QuestDocument)
    : undefined;
}
export /** Reads optional specialized fields without rejecting legacy generic nodes. */ function requirementMetadata(value: unknown): NarrativeNodeData["requirement"] | undefined {
  if (typeof value !== "object" || value === null)
    return undefined;
  const candidate = value as {
    expression?: unknown;
    predicate?: unknown;
    subject?: unknown;
  };
  if (typeof candidate.subject !== "string" || typeof candidate.predicate !== "string")
    return undefined;
  return {
    subject: candidate.subject,
    predicate: candidate.predicate,
    ...(typeof candidate.expression === "string" && candidate.expression ? { expression: candidate.expression } : {})
  };
}
export /** Reads Outcome targets defensively because imported metadata is untrusted. */ function outcomeMetadata(value: unknown): NarrativeNodeData["outcome"] | undefined {
  if (typeof value !== "object" || value === null)
    return undefined;
  const candidate = value as {
    effect?: unknown;
    targetNodeIds?: unknown;
  };
  if (typeof candidate.effect !== "string" || !Array.isArray(candidate.targetNodeIds))
    return undefined;
  return { effect: candidate.effect, targetNodeIds: candidate.targetNodeIds.filter((id): id is string => typeof id === "string") };
}
export function flowEdgeToRuntimePayload(projectId: string, edge: Edge<NarrativeEdgeData>) {
  const label = typeof edge.label === "string" ? edge.label : edge.data?.label ?? "";
  const relationshipType = edge.data?.relationshipType ?? "depends_on";
  return {
    condition: "",
    label,
    metadata: {
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      ...(edge.data?.dialogueElementId ? { dialogue_element_id: edge.data.dialogueElementId } : {}),
      ...(edge.data?.questStageId ? { quest_stage_id: edge.data.questStageId } : {}),
      ...(edge.data?.questBranchId ? { quest_branch_id: edge.data.questBranchId } : {}),
      ...(edge.data?.outcomeFlowComposition ? { outcome_flow_composition: outcomeFlowCompositionPayload(edge.data.outcomeFlowComposition) } : {}),
      ...(edge.data?.canvasVisibility ? { canvas_visibility: edge.data.canvasVisibility } : {})
    },
    project_id: projectId,
    source_node_id: edge.source,
    target_node_id: edge.target,
    type: relationshipType
  };
}
export function stringMetadata(value: unknown, fallback: string): string;
export function stringMetadata(value: unknown, fallback: null): string | null;
export function stringMetadata(value: unknown, fallback: string | null) {
  return typeof value === "string" ? value : fallback;
}
export function relationshipTypeMetadata(value: unknown): NarrativeRelationshipType {
  const supported = [...NARRATIVE_EDGE_TYPES, "contains", "member_of"] as readonly string[];
  return typeof value === "string" && supported.includes(value) ? (value as NarrativeRelationshipType) : "depends_on";
}
export /** Reads only complete specialized-outcome call references from persisted edge metadata. */ function outcomeFlowCompositionMetadata(value: unknown): NarrativeEdgeData["outcomeFlowComposition"] | null {
  if (typeof value !== "object" || value === null)
    return null;
  const candidate = value as Record<string, unknown>;
  const invocationId = stringMetadata(candidate.invocation_id ?? candidate.invocationId, null);
  const sourceFlowId = stringMetadata(candidate.source_flow_id ?? candidate.sourceFlowId, null);
  const targetFlowId = stringMetadata(candidate.target_flow_id ?? candidate.targetFlowId, null);
  return invocationId && sourceFlowId && targetFlowId ? { invocationId, sourceFlowId, targetFlowId } : null;
}
export /** Serializes the frontend association into runtime-owned snake-case metadata. */ function outcomeFlowCompositionPayload(value: NarrativeEdgeData["outcomeFlowComposition"] | undefined) {
  return value ? {
    invocation_id: value.invocationId,
    source_flow_id: value.sourceFlowId,
    target_flow_id: value.targetFlowId
  } : null;
}
export function numberMetadata(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
export function positionMetadata(value: unknown) {
  if (typeof value !== "object" || value === null) {
    return { x: 0, y: 0 };
  }
  const candidate = value as {
    x?: unknown;
    y?: unknown;
  };
  return {
    x: numberMetadata(candidate.x, 0),
    y: numberMetadata(candidate.y, 0)
  };
}
export function tagsMetadata(value: unknown) {
  return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === "string") : [];
}
export function kindMetadata(value: unknown): NarrativeNodeData["kind"] {
  // Runtime files can contain stale or external metadata, so unknown kinds degrade safely.
  return typeof value === "string" && (NARRATIVE_NODE_KINDS as readonly string[]).includes(value) ? (value as NarrativeNodeData["kind"]) : "Scene";
}
export function statusMetadata(value: unknown): ProjectStatus {
  return value === "draft" || value === "open" || value === "archived" ? value : "open";
}
export function issueSeverity(value: unknown): NarrativeIssue["severity"] {
  return value === "critical" || value === "warning" || value === "info" ? value : "info";
}
export function issueStatus(value: unknown): NarrativeIssue["status"] {
  return value === "open" || value === "review" || value === "ignored" || value === "resolved" ? value : "open";
}

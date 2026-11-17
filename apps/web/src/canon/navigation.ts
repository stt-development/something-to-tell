import type { CanonIssueProjection, CanonOwnerRef } from "@something-to-tell/contracts/canon-check";
import type { NarrativeEffectOwnerRef } from "@something-to-tell/contracts/narrative-state";
import type { Edge, Node } from "@xyflow/react";
import type { NarrativeStateSnapshot } from "../narrative-state/contracts";
import type { StoryFlowSnapshot } from "../story-flow/contracts";
import type { NarrativeEdgeData, NarrativeNodeData } from "../types";

export type CanonAuthoringSurface = "dialogue" | "flow" | "graph" | "playback" | "quest" | "story" | "temporal";

export interface CanonOwnerResolution {
  canvasEdgeId: string | null;
  found: boolean;
  focusOwnerId: string;
  flowId: string | null;
  nodeId: string | null;
  sourceNodeId: string | null;
  surface: CanonAuthoringSurface;
  temporalOwner: NarrativeEffectOwnerRef | null;
}

/** Projects one selected Issue without adding label-adjacent canvas badges. */
export function highlightCanonTargets<
  TNode extends Node<NarrativeNodeData>,
  TEdge extends Edge<NarrativeEdgeData>
>(
  nodes: readonly TNode[],
  edges: readonly TEdge[],
  issue: CanonIssueProjection | null,
  preview: string
): { edges: TEdge[]; nodes: TNode[] } {
  const nodeIds = new Set(
    (issue?.metadata.targets ?? []).flatMap((owner) => {
      const nodeId = canonOwnerNodeId(owner, nodes);
      return nodeId ? [nodeId] : [];
    })
  );
  const edgeIds = new Set(
    (issue?.metadata.targets ?? []).flatMap((owner) => {
      const edgeId = canonOwnerCanvasEdgeId(owner);
      return edgeId ? [edgeId] : [];
    })
  );
  const edgeColor = issue?.severity === "critical" ? "#dc2626" : issue?.severity === "warning" ? "#d97706" : "#2563eb";
  return {
    nodes: nodes.map((node) => {
      const selected = nodeIds.has(node.data.canonicalNodeId ?? node.id);
      return {
        ...node,
        data: {
          ...node.data,
          canonTarget: selected,
          canonIssuePreview: selected ? preview : undefined,
          canonIssueSeverity: selected ? issue?.severity : undefined,
          canonIssueStatus: selected ? issue?.status : undefined
        }
      } as TNode;
    }),
    edges: edges.map((edge) => {
      const selected = edgeIds.has(edge.id);
      return {
        ...edge,
        data: {
          ...edge.data,
          canonTarget: selected,
          canonIssuePreview: selected ? preview : undefined,
          canonIssueSeverity: selected ? issue?.severity : undefined,
          canonIssueStatus: selected ? issue?.status : undefined
        } as NarrativeEdgeData,
        style: selected ? {
          ...edge.style,
          stroke: edgeColor,
          strokeDasharray: issue?.status === "ignored" || issue?.status === "resolved" ? "7 5" : edge.style?.strokeDasharray,
          strokeWidth: 5
        } : edge.style
      } as TEdge;
    })
  };
}

/** Resolves one generic runtime owner into existing authoring identities. */
export function resolveCanonOwner(
  owner: CanonOwnerRef,
  nodes: readonly Node<NarrativeNodeData>[],
  flows: readonly StoryFlowSnapshot[],
  narrativeState: NarrativeStateSnapshot | null,
  edges: readonly Edge[] = []
): CanonOwnerResolution {
  const nodeId = canonOwnerNodeId(owner, nodes);
  const initialState = owner.owner_type === "initial_state"
    ? narrativeState?.initial_states.find((item) => item.id === owner.owner_id)
    : null;
  const flowId = initialState?.flow_id ?? canonOwnerFlowId(owner, flows);
  const temporalOwner = canonTemporalOwner(owner, nodes, narrativeState);
  const flowRecord = resolveFlowRecord(owner, flows);
  const exactNestedOwner = nestedOwnerExists(owner, nodes);
  const nested = owner.owner_type.startsWith("dialogue_") || owner.owner_type.startsWith("quest_");
  const found = Boolean(nested
    ? exactNestedOwner
    : owner.owner_type === "project"
      || Boolean(nodeId || temporalOwner || flowRecord || initialState)
      || (owner.owner_type === "edge" && edges.some((item) => item.id === owner.owner_id))
      || (owner.owner_type === "effect" && narrativeState?.effects.some((item) => item.id === owner.owner_id))
      || (owner.owner_type === "effect_binding" && narrativeState?.bindings.some((item) => item.id === owner.owner_id)));
  return {
    canvasEdgeId: canonOwnerCanvasEdgeId(owner),
    found,
    focusOwnerId: owner.owner_id,
    flowId,
    nodeId,
    sourceNodeId: flowRecord?.sourceNodeId ?? nodeId,
    surface: canonOwnerSurface(owner),
    temporalOwner
  };
}

/** Finds the canonical node behind nested Dialogue, Quest, and placement refs. */
export function canonOwnerNodeId(
  owner: CanonOwnerRef,
  nodes: readonly Node<NarrativeNodeData>[]
): string | null {
  if (owner.owner_type === "node") {
    return nodes.some((node) => (node.data.canonicalNodeId ?? node.id) === owner.owner_id)
      ? owner.owner_id
      : null;
  }
  if (owner.owner_type === "placement") {
    const placement = nodes.find((node) => node.data.placementId === owner.owner_id);
    return placement ? placement.data.canonicalNodeId ?? placement.id : null;
  }
  if (owner.context_type === "node" && owner.context_id) return owner.context_id;

  if (owner.owner_type === "dialogue_element" || owner.owner_type === "dialogue_option") {
    return nodes.find((node) => node.data.dialogueDocument?.elements.some((element) =>
      element.id === owner.owner_id
      || (element.kind === "choice" && element.options.some((option) => option.id === owner.owner_id))
    ))?.data.canonicalNodeId ?? null;
  }
  if (["quest_stage", "quest_branch", "quest_outcome"].includes(owner.owner_type)) {
    return nodes.find((node) => node.data.questDocument?.stages.some((stage) =>
      stage.id === owner.owner_id
      || stage.id === owner.context_id
      || stage.branches.some((branch) => branch.id === owner.owner_id)
    ))?.data.canonicalNodeId ?? null;
  }
  return null;
}

/** Maps runtime flow records to their React Flow edge identities. */
export function canonOwnerCanvasEdgeId(owner: CanonOwnerRef): string | null {
  if (owner.owner_type === "edge") return owner.owner_id;
  if (owner.owner_type === "flow_transition") return `story-flow:${owner.owner_id}`;
  if (owner.owner_type === "flow_invocation") return `flow-invocation:${owner.owner_id}`;
  return null;
}

/** Locates a directly or indirectly owned Story Flow. */
export function canonOwnerFlowId(
  owner: CanonOwnerRef,
  flows: readonly StoryFlowSnapshot[]
): string | null {
  if (owner.owner_type === "flow") return owner.owner_id;
  if (owner.context_type === "flow" && owner.context_id) return owner.context_id;
  if (owner.owner_type === "initial_state") return null;
  return flows.find((flow) =>
    flow.transitions.some((transition) => owner.owner_type === "flow_transition" && transition.id === owner.owner_id)
    || (flow.invocations ?? []).some((invocation) => owner.owner_type === "flow_invocation" && invocation.id === owner.owner_id)
    || (flow.exits ?? []).some((flowExit) => owner.owner_type === "flow_exit" && flowExit.id === owner.owner_id)
    || (flow.bindings ?? []).some((binding) => owner.owner_type === "flow_exit_binding" && binding.id === owner.owner_id)
    || (flow.scene_boundaries ?? []).some((boundary) => owner.owner_type === "scene_boundary" && boundary.id === owner.owner_id)
  )?.flow.id ?? null;
}

/** Converts Canon effect records back to the exact existing temporal owner. */
export function canonTemporalOwner(
  owner: CanonOwnerRef,
  nodes: readonly Node<NarrativeNodeData>[],
  snapshot: NarrativeStateSnapshot | null
): NarrativeEffectOwnerRef | null {
  if (!snapshot) return null;
  if (owner.owner_type === "effect" || owner.owner_type === "effect_binding") {
    const binding = owner.owner_type === "effect"
      ? snapshot.bindings.find((candidate) => candidate.effect_id === owner.owner_id)
      : snapshot.bindings.find((candidate) => candidate.id === owner.owner_id);
    return binding?.owner ?? null;
  }
  if (["flow_transition", "flow_invocation", "flow_exit"].includes(owner.owner_type)) {
    return { owner_version: 1, owner_kind: owner.owner_type as "flow_transition" | "flow_invocation" | "flow_exit", owner_id: owner.owner_id };
  }
  if (owner.owner_type === "dialogue_element" || owner.owner_type === "dialogue_option") {
    const nodeId = canonOwnerNodeId(owner, nodes);
    return nodeId ? { owner_version: 1, owner_kind: owner.owner_type, owner_id: owner.owner_id, context_node_id: nodeId } : null;
  }
  if (owner.owner_type === "quest_branch" || owner.owner_type === "quest_outcome") {
    const nodeId = canonOwnerNodeId(owner, nodes);
    return nodeId ? { owner_version: 1, owner_kind: owner.owner_type, owner_id: owner.owner_id, context_node_id: nodeId } : null;
  }
  return null;
}

function canonOwnerSurface(owner: CanonOwnerRef): CanonAuthoringSurface {
  if (owner.owner_type.startsWith("dialogue_")) return "dialogue";
  if (owner.owner_type.startsWith("quest_")) return "quest";
  if (owner.owner_type === "effect" || owner.owner_type === "effect_binding" || owner.owner_type === "initial_state") return "temporal";
  if (owner.owner_type === "playback_definition") return "playback";
  if (owner.owner_type === "flow" || owner.owner_type.startsWith("flow_") || owner.owner_type === "scene_boundary") return "flow";
  return "graph";
}

/** Finds exact Flow-owned records and the node that visually anchors them. */
function resolveFlowRecord(
  owner: CanonOwnerRef,
  flows: readonly StoryFlowSnapshot[]
): { flowId: string; sourceNodeId: string | null } | null {
  for (const flow of flows) {
    if (owner.owner_type === "flow" && flow.flow.id === owner.owner_id) {
      return { flowId: flow.flow.id, sourceNodeId: flow.flow.entry_node_id };
    }
    const transition = flow.transitions.find((item) => owner.owner_type === "flow_transition" && item.id === owner.owner_id);
    if (transition) return { flowId: flow.flow.id, sourceNodeId: transition.source_node_id };
    const invocation = (flow.invocations ?? []).find((item) => owner.owner_type === "flow_invocation" && item.id === owner.owner_id);
    if (invocation) return { flowId: flow.flow.id, sourceNodeId: invocation.source_node_id };
    const flowExit = (flow.exits ?? []).find((item) => owner.owner_type === "flow_exit" && item.id === owner.owner_id);
    if (flowExit) return { flowId: flow.flow.id, sourceNodeId: flowExit.source_node_id };
    const binding = (flow.bindings ?? []).find((item) => owner.owner_type === "flow_exit_binding" && item.id === owner.owner_id);
    if (binding) {
      const caller = (flow.invocations ?? []).find((item) => item.id === binding.invocation_id);
      return { flowId: flow.flow.id, sourceNodeId: caller?.source_node_id ?? null };
    }
    const boundary = (flow.scene_boundaries ?? []).find((item) => owner.owner_type === "scene_boundary" && item.id === owner.owner_id);
    if (boundary) return { flowId: flow.flow.id, sourceNodeId: boundary.scene_node_id };
  }
  return null;
}

/** Distinguishes a valid context node from the exact nested record requested. */
function nestedOwnerExists(owner: CanonOwnerRef, nodes: readonly Node<NarrativeNodeData>[]): boolean {
  if (owner.owner_type === "dialogue_element" || owner.owner_type === "dialogue_option") {
    return nodes.some((node) => node.data.dialogueDocument?.elements.some((element) =>
      (owner.owner_type === "dialogue_element" && element.id === owner.owner_id)
      || (owner.owner_type === "dialogue_option" && element.kind === "choice" && element.options.some((option) => option.id === owner.owner_id))
    ));
  }
  if (owner.owner_type === "quest_stage" || owner.owner_type === "quest_branch" || owner.owner_type === "quest_outcome") {
    return nodes.some((node) => node.data.questDocument?.stages.some((stage) =>
      (owner.owner_type === "quest_stage" && stage.id === owner.owner_id)
      || ((owner.owner_type === "quest_branch" || owner.owner_type === "quest_outcome") && stage.branches.some((branch) => branch.id === owner.owner_id))
    ));
  }
  return false;
}

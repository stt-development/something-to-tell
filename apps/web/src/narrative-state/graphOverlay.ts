import type { NarrativeEffectOwnerRef } from "@something-to-tell/contracts/narrative-state";
import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type { NarrativeEdgeData, NarrativeNodeData, Selection } from "../types";
import type { TemporalEffectPresentation } from "./projection";

export interface TemporalGraphOverlay {
  affectedNodeIds: Set<string>;
  edges: Edge<NarrativeEdgeData>[];
}

/** Resolves the selected canvas step without treating a semantic edge as executable. */
export function temporalOwnerForGraphSelection(
  selection: Selection | null,
  nodes: Node<NarrativeNodeData>[],
  edges: Edge<NarrativeEdgeData>[]
): NarrativeEffectOwnerRef | null {
  if (selection?.type === "node") {
    const node = nodes.find((candidate) => candidate.id === selection.id);
    return node ? { owner_version: 1, owner_kind: "node_entry", owner_id: node.data.canonicalNodeId ?? node.id } : null;
  }
  if (selection?.type !== "edge") return null;
  const edge = edges.find((candidate) => candidate.id === selection.id);
  if (edge?.data?.flowTransition) {
    return { owner_version: 1, owner_kind: "flow_transition", owner_id: edge.data.flowTransition.transitionId };
  }
  if (edge?.data?.flowInvocation) {
    return { owner_version: 1, owner_kind: "flow_invocation", owner_id: edge.data.flowInvocation.invocationId };
  }
  return null;
}

/** Adds presentation-only current-holder edges while leaving authored edges untouched. */
export function projectTemporalGraphOverlay(
  effects: TemporalEffectPresentation[],
  nodes: Node<NarrativeNodeData>[]
): TemporalGraphOverlay {
  const canonicalIds = new Set(nodes.map((node) => node.data.canonicalNodeId ?? node.id));
  const affectedNodeIds = new Set(effects.flatMap((effect) => effect.affectedNodeIds));
  const lastTransferByItem = new Map<string, TemporalEffectPresentation>();
  for (const effect of effects) {
    if (effect.effect.operation === "transfer_item") lastTransferByItem.set(effect.effect.payload.item_node_id, effect);
  }
  const edges = [...lastTransferByItem.values()].flatMap((presentation) => {
    if (presentation.effect.operation !== "transfer_item") return [];
    const holder = presentation.effect.payload.to_holder;
    const holderNodeId = "node_id" in holder ? holder.node_id : undefined;
    if (!holderNodeId || !canonicalIds.has(holderNodeId) || !canonicalIds.has(presentation.effect.payload.item_node_id)) return [];
    return [{
      id: `temporal-state:${presentation.bindingId}`,
      source: holderNodeId,
      target: presentation.effect.payload.item_node_id,
      label: presentation.effect.explanation,
      data: {
        label: presentation.effect.explanation,
        temporalStateOverlay: { effectId: presentation.effect.id }
      },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#0f766e" },
      reconnectable: false,
      selectable: false,
      style: { stroke: "#0f766e", strokeDasharray: "7 5", strokeWidth: 4 },
      type: "default"
    } satisfies Edge<NarrativeEdgeData>];
  });
  return { affectedNodeIds, edges };
}

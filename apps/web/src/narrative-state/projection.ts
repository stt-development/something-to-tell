import type { NarrativeEffectDefinition, NarrativeEffectOwnerRef, StateHolderRef } from "@something-to-tell/contracts/narrative-state";
import type { Node } from "@xyflow/react";
import type { NarrativeNodeData } from "../types";
import type { NarrativeStateSnapshot } from "./contracts";
import { effectsForOwner, narrativeOwnerKey } from "./editor";

export type TemporalStateValue =
  | { kind: "holder"; holder: StateHolderRef }
  | { kind: "boolean"; value: boolean }
  | { kind: "quest_status"; value: "inactive" | "active" | "completed" | "failed" | null }
  | { kind: "dialogue_choice"; value: string | null };

export interface TemporalEffectPresentation {
  affectedNodeIds: string[];
  affectedNodeTitles: Record<string, string>;
  after: TemporalStateValue;
  before: TemporalStateValue;
  bindingId: string;
  effect: NarrativeEffectDefinition;
  owner: NarrativeEffectOwnerRef;
  subjectId: string;
  subjectTitle: string;
}

export interface TemporalStateProjection {
  byOwner: Map<string, TemporalEffectPresentation[]>;
  effects: TemporalEffectPresentation[];
}

/** Projects explicit before/after contracts without pretending to execute every branch. */
export function projectTemporalState(
  snapshot: NarrativeStateSnapshot | null,
  nodes: Node<NarrativeNodeData>[]
): TemporalStateProjection {
  // Treat an incomplete transport response as unavailable presentation data;
  // graph authoring must remain usable while an older runtime is upgrading.
  if (!snapshot || !Array.isArray(snapshot.bindings) || !Array.isArray(snapshot.effects) || !Array.isArray(snapshot.initial_states)) {
    return { byOwner: new Map(), effects: [] };
  }
  const canonical = new Map(nodes.filter((node) => !node.data.isLinkedInstance).map((node) => [node.data.canonicalNodeId ?? node.id, node]));
  const byOwner = new Map<string, TemporalEffectPresentation[]>();
  const effects: TemporalEffectPresentation[] = [];
  const ownerKeys = new Map(snapshot.bindings.map((binding) => [narrativeOwnerKey(binding.owner), binding.owner]));

  for (const [key, owner] of ownerKeys) {
    const presentations = effectsForOwner(owner, snapshot.bindings, snapshot.effects).map(({ binding, effect }) =>
      presentationFor(effect, binding.id, owner, canonical, snapshot)
    );
    if (presentations.length) {
      byOwner.set(key, presentations);
      effects.push(...presentations);
    }
  }
  return { byOwner, effects };
}

/** Finds one exact temporal owner's presentations using the shared stable key. */
export function temporalEffectsForOwner(
  projection: TemporalStateProjection,
  owner: NarrativeEffectOwnerRef | null
): TemporalEffectPresentation[] {
  return owner ? projection.byOwner.get(narrativeOwnerKey(owner)) ?? [] : [];
}

function presentationFor(
  effect: NarrativeEffectDefinition,
  bindingId: string,
  owner: NarrativeEffectOwnerRef,
  nodes: Map<string, Node<NarrativeNodeData>>,
  snapshot: NarrativeStateSnapshot
): TemporalEffectPresentation {
  if (effect.operation === "transfer_item") {
    const holderNodeIds = [effect.payload.from_holder, effect.payload.to_holder].flatMap((holder) =>
      "node_id" in holder && holder.node_id ? [holder.node_id] : []
    );
    return base(effect, bindingId, owner, effect.payload.item_node_id, nodes, {
      before: { kind: "holder", holder: effect.payload.from_holder },
      after: { kind: "holder", holder: effect.payload.to_holder },
      affectedNodeIds: [effect.payload.item_node_id, ...holderNodeIds]
    });
  }
  if (effect.operation === "set_flag" || effect.operation === "clear_flag") {
    const after = effect.operation === "set_flag";
    return {
      bindingId,
      effect,
      owner,
      subjectId: effect.payload.flag,
      subjectTitle: effect.payload.flag,
      before: { kind: "boolean", value: !after },
      after: { kind: "boolean", value: after },
      affectedNodeIds: [],
      affectedNodeTitles: {}
    };
  }
  if (effect.operation === "set_quest_status") {
    const initialValues = new Set(snapshot.initial_states.map((state) => state.quest_statuses[effect.payload.quest_node_id]).filter((value) => value !== undefined));
    return base(effect, bindingId, owner, effect.payload.quest_node_id, nodes, {
      before: { kind: "quest_status", value: initialValues.size === 1 ? [...initialValues][0]! : null },
      after: { kind: "quest_status", value: effect.payload.status },
      affectedNodeIds: [effect.payload.quest_node_id]
    });
  }
  return base(effect, bindingId, owner, effect.payload.dialogue_node_id, nodes, {
    before: { kind: "dialogue_choice", value: null },
    after: { kind: "dialogue_choice", value: effect.payload.choice_id },
    affectedNodeIds: [effect.payload.dialogue_node_id]
  });
}

function base(
  effect: NarrativeEffectDefinition,
  bindingId: string,
  owner: NarrativeEffectOwnerRef,
  subjectId: string,
  nodes: Map<string, Node<NarrativeNodeData>>,
  change: Pick<TemporalEffectPresentation, "affectedNodeIds" | "after" | "before">
): TemporalEffectPresentation {
  return {
    ...change,
    affectedNodeIds: [...new Set(change.affectedNodeIds)],
    affectedNodeTitles: Object.fromEntries(change.affectedNodeIds.map((nodeId) => [nodeId, nodes.get(nodeId)?.data.title ?? nodeId])),
    bindingId,
    effect,
    owner,
    subjectId,
    subjectTitle: nodes.get(subjectId)?.data.title ?? subjectId
  };
}

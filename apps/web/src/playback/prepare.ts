import type { Node } from "@xyflow/react";
import type { StoryFlowSnapshot } from "../story-flow/contracts";
import type { NarrativeNodeData } from "../types";
import type { NarrativeStateSnapshot } from "../narrative-state/contracts";
import type { NarrativeEffectOwnerRef } from "@something-to-tell/contracts/narrative-state";
import type {
  PlaybackCanonicalNode,
  PlaybackPrepareCommand,
  PlaybackTypedEffect
} from "./contracts";

interface PlaybackRevisionInput {
  canonicalNodes: PlaybackCanonicalNode[];
  dialogueDocuments: PlaybackPrepareCommand["dialogue_documents"];
  questDocuments: PlaybackPrepareCommand["quest_documents"];
  snapshots: StoryFlowSnapshot[];
  typedEffects: PlaybackTypedEffect[];
  initialState: PlaybackPrepareCommand["initial_state"];
}

/** Projects authoring records into the explicit runtime-owned prepare command. */
export function buildPlaybackPrepareCommand(
  snapshot: StoryFlowSnapshot,
  nodes: Node<NarrativeNodeData>[],
  typedEffects: PlaybackTypedEffect[] = [],
  flows: StoryFlowSnapshot[] = [snapshot],
  narrativeState: NarrativeStateSnapshot | null = null
): PlaybackPrepareCommand {
  const reachableFlows = reachablePlaybackFlows(snapshot, flows);
  const reachableFlowIds = new Set(reachableFlows.map((flow) => flow.flow.id));
  const authoredEffects = playbackEffectsFromNarrativeState(narrativeState, reachableFlows);
  const reachableEffects = [...typedEffects, ...authoredEffects]
    .filter((effect) => reachableFlowIds.has(effect.flow_id))
    .sort(comparePlaybackEffects);
  const initialState = playbackInitialState(narrativeState, snapshot.flow.id);
  const canonicalById = new Map<string, Node<NarrativeNodeData>>();
  nodes.forEach((node) => {
    const canonicalId = node.data.canonicalNodeId ?? node.id;
    if (!canonicalById.has(canonicalId) || node.id === canonicalId) {
      canonicalById.set(canonicalId, node);
    }
  });
  const memberIds = reachableFlows.flatMap((flow) => flow.nodes.map((membership) => membership.node_id));
  const stateReferenceIds = [
    ...Object.keys(initialState.item_holders),
    ...Object.values(initialState.item_holders).flatMap((holder) => holder.node_id ? [holder.node_id] : []),
    ...Object.keys(initialState.quest_states),
    ...reachableEffects.flatMap(playbackEffectNodeIds)
  ];
  const canonicalIds = [...new Set([...memberIds, ...stateReferenceIds])];
  const canonicalNodes = canonicalIds.flatMap((nodeId) => {
    const node = canonicalById.get(nodeId);
    return node ? [playbackCanonicalNode(node, nodeId, snapshot.flow.project_id)] : [];
  });
  const dialogueDocuments = Object.fromEntries(
    canonicalNodes.flatMap((node) => {
      const document = canonicalById.get(node.id)?.data.dialogueDocument;
      return document ? [[node.id, document]] : [];
    })
  );
  const questDocuments = Object.fromEntries(
    canonicalNodes.flatMap((node) => {
      const document = canonicalById.get(node.id)?.data.questDocument;
      return document ? [[node.id, document]] : [];
    })
  );
  const revisionInput = {
    canonicalNodes,
    dialogueDocuments,
    questDocuments,
    snapshots: reachableFlows,
    typedEffects: reachableEffects,
    initialState
  };
  return {
    command_version: 1,
    snapshot,
    snapshots: reachableFlows,
    canonical_nodes: canonicalNodes,
    dialogue_documents: dialogueDocuments,
    quest_documents: questDocuments,
    typed_effects: reachableEffects,
    initial_state: revisionInput.initialState,
    source_revision: playbackSourceRevision(revisionInput)
  };
}

/** Projects accepted temporal bindings into executable, exactly-owned effects. */
export function playbackEffectsFromNarrativeState(
  snapshot: NarrativeStateSnapshot | null,
  flows: StoryFlowSnapshot[]
): PlaybackTypedEffect[] {
  if (!snapshot) return [];
  const effectById = new Map(snapshot.effects.map((effect) => [effect.id, effect]));
  return snapshot.bindings.flatMap((binding) => {
    if (!isPlaybackOwner(binding.owner)) return [];
    const authored = effectById.get(binding.effect_id);
    const ownerFlowIds = playbackFlowIdsForOwner(binding.owner, flows);
    if (!authored || ownerFlowIds.length === 0) return [];
    return ownerFlowIds.map((flowId) => ({
      effect_version: authored.effect_version,
      id: ownerFlowIds.length === 1 ? binding.id : `${binding.id}:${flowId}`,
      project_id: authored.project_id,
      flow_id: flowId,
      owner_node_id: binding.owner.owner_kind === "node_entry"
        ? binding.owner.owner_id
        : binding.owner.context_node_id ?? null,
      owner_transition_id: ["flow_transition", "flow_invocation", "flow_exit"].includes(binding.owner.owner_kind)
        ? binding.owner.owner_id
        : null,
      review_status: "accepted" as const,
      repeatable: authored.repeat_policy === "per_visit",
      explanation: authored.explanation,
      authored_effect_id: authored.id,
      owner_kind: binding.owner.owner_kind,
      owner_id: binding.owner.owner_id,
      context_node_id: binding.owner.context_node_id ?? null,
      application_order: binding.application_order,
      operation: authored.operation,
      payload: authored.payload
    } as PlaybackTypedEffect));
  }).sort(comparePlaybackEffects);
}

/** Resolves a runtime effect id back to the persisted owner used by authoring. */
export function narrativeOwnerForPlaybackEffect(
  snapshot: NarrativeStateSnapshot | null,
  playbackEffectId: string
): NarrativeEffectOwnerRef | null {
  if (!snapshot) return null;
  const exact = snapshot.bindings.find((binding) => binding.id === playbackEffectId);
  if (exact) return exact.owner;
  const qualified = [...snapshot.bindings]
    .sort((left, right) => right.id.length - left.id.length)
    .find((binding) => playbackEffectId.startsWith(`${binding.id}:`));
  return qualified?.owner ?? null;
}

function isPlaybackOwner(
  owner: NarrativeEffectOwnerRef
): owner is NarrativeEffectOwnerRef {
  return ["node_entry", "flow_transition", "flow_invocation", "flow_exit", "dialogue_element", "dialogue_option", "quest_branch", "quest_outcome"].includes(owner.owner_kind);
}

function playbackFlowIdsForOwner(owner: NarrativeEffectOwnerRef, flows: StoryFlowSnapshot[]): string[] {
  if (owner.context_node_id) {
    return flows
      .filter((flow) => flow.nodes.some((member) => member.node_id === owner.context_node_id))
      .map((flow) => flow.flow.id);
  }
  return playbackOwnerFlows(flows).get(`${owner.owner_kind}:${owner.owner_id}`) ?? [];
}

function playbackOwnerFlows(flows: StoryFlowSnapshot[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const add = (kind: string, ownerId: string, flowId: string) => {
    const key = `${kind}:${ownerId}`;
    const values = result.get(key) ?? [];
    if (!values.includes(flowId)) values.push(flowId);
    result.set(key, values);
  };
  for (const flow of flows) {
    flow.nodes.forEach((member) => add("node_entry", member.node_id, flow.flow.id));
    flow.transitions.forEach((transition) => add("flow_transition", transition.id, flow.flow.id));
    (flow.invocations ?? []).forEach((invocation) => add("flow_invocation", invocation.id, invocation.source_flow_id));
    (flow.exits ?? []).forEach((exit) => add("flow_exit", exit.id, exit.flow_id));
  }
  return result;
}

function comparePlaybackEffects(left: PlaybackTypedEffect, right: PlaybackTypedEffect): number {
  return (left.application_order ?? 0) - (right.application_order ?? 0) || left.id.localeCompare(right.id);
}

/** Lists canonical targets needed to validate one executable effect. */
function playbackEffectNodeIds(effect: PlaybackTypedEffect): string[] {
  if (effect.operation === "transfer_item") {
    return [
      effect.payload.item_node_id,
      ...[effect.payload.from_holder, effect.payload.to_holder].flatMap((holder) => holder.node_id ? [holder.node_id] : [])
    ];
  }
  if (effect.operation === "add_inventory" || effect.operation === "remove_inventory") return [effect.payload.node_id];
  if (effect.operation === "set_quest_status") return [effect.payload.quest_node_id];
  if (effect.operation === "record_dialogue_choice") return [effect.payload.dialogue_node_id];
  return [];
}

/** Stable definition-wide revision used by inspect, choose, and stale return. */
export function playbackSourceRevision(input: PlaybackRevisionInput): string {
  const serialized = stableSerialize({
    canonical_nodes: input.canonicalNodes,
    dialogue_documents: input.dialogueDocuments,
    flow_snapshots: input.snapshots,
    initial_state: input.initialState,
    quest_documents: input.questDocuments,
    typed_effects: input.typedEffects
  });
  let hash = 14695981039346656037n;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= BigInt(serialized.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return `${input.snapshots[0]!.flow.id}:${hash.toString(16).padStart(16, "0")}`;
}

/** Projects one root Flow's authored state into the transient Playback contract. */
export function playbackInitialState(
  snapshot: NarrativeStateSnapshot | null,
  flowId: string
): PlaybackPrepareCommand["initial_state"] {
  const authored = snapshot?.initial_states.find((state) => state.flow_id === flowId);
  const holders = Object.fromEntries(
    (authored?.item_custody ?? []).map((custody) => [custody.item_node_id, custody.holder])
  );
  return {
    state_version: 1,
    flags: { ...(authored?.flags ?? {}) },
    inventory_node_ids: Object.entries(holders)
      .filter(([, holder]) => holder.kind === "player" || holder.kind === "party")
      .map(([itemId]) => itemId)
      .sort(),
    item_holders: holders,
    quest_states: { ...(authored?.quest_statuses ?? {}) },
    dialogue_choice_ids: {},
    visited_node_ids: [],
    applied_effect_ids: []
  };
}

/** Selects only the call graph reachable from the requested root Flow. */
function reachablePlaybackFlows(root: StoryFlowSnapshot, flows: StoryFlowSnapshot[]): StoryFlowSnapshot[] {
  const byId = new Map([...flows, root].map((flow) => [flow.flow.id, flow]));
  const ordered: StoryFlowSnapshot[] = [];
  const visited = new Set<string>();
  function visit(flow: StoryFlowSnapshot) {
    if (visited.has(flow.flow.id)) return;
    visited.add(flow.flow.id);
    ordered.push(flow);
    for (const invocation of flow.invocations ?? []) {
      const target = byId.get(invocation.target_flow_id);
      if (target) visit(target);
    }
  }
  visit(root);
  return ordered;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function playbackCanonicalNode(
  node: Node<NarrativeNodeData>,
  canonicalId: string,
  projectId: string
): PlaybackCanonicalNode {
  return {
    node_version: 1,
    id: canonicalId,
    project_id: projectId,
    type: node.data.kind,
    title: node.data.title,
    summary: node.data.summary,
    body: node.data.summary,
    status: "canon",
    metadata: {
      tags: [...node.data.tags],
      ...(node.data.requirement ? { requirement: node.data.requirement } : {}),
      ...(node.data.outcome ? { outcome: node.data.outcome } : {}),
      ...(node.data.characterRole ? { character_role: node.data.characterRole } : {}),
      ...(node.data.itemPurpose ? { item_purpose: node.data.itemPurpose } : {})
    }
  };
}

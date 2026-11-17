/**
 * Shared TypeScript mirror of the runtime-owned Phase 3.11 state contracts.
 * Python validation remains authoritative; keep this module synchronized with
 * services/runtime/stt_runtime/schemas/narrative_state.py.
 */

export type NarrativeStateNodeKind =
  | "Character"
  | "Quest"
  | "Scene"
  | "Lore"
  | "Location"
  | "Dialogue"
  | "Faction"
  | "Item"
  | "Event"
  | "Condition"
  | "Consequence";

export type QuestStateStatus = "inactive" | "active" | "completed" | "failed";
export type EffectRepeatPolicy = "once" | "per_visit";

export interface NarrativeStateCanonicalNodeRef {
  id: string;
  project_id: string;
  type: NarrativeStateNodeKind;
}

export interface NarrativeStateFlowRef {
  id: string;
  project_id: string;
}

/** Canonical holder kinds require a node; intrinsic holders explicitly forbid one. */
export type StateHolderRef =
  | { holder_version: 1; kind: "character" | "location" | "faction"; node_id: string }
  | { holder_version: 1; kind: "player" | "party" | "unowned"; node_id?: never };

export interface ItemCustody {
  custody_version: 1;
  item_node_id: string;
  holder: StateHolderRef;
}

export interface FlowInitialState {
  state_version: 1;
  project_id: string;
  flow_id: string;
  flags: Record<string, boolean>;
  item_custody: ItemCustody[];
  quest_statuses: Record<string, QuestStateStatus>;
}

export interface TransferItemPayload {
  item_node_id: string;
  from_holder: StateHolderRef;
  to_holder: StateHolderRef;
}

export interface FlagEffectPayload {
  flag: string;
}

export interface QuestStatusEffectPayload {
  quest_node_id: string;
  status: QuestStateStatus;
}

export interface DialogueChoiceEffectPayload {
  dialogue_node_id: string;
  choice_id: string;
}

interface NarrativeEffectDefinitionBase {
  effect_version: 1;
  id: string;
  project_id: string;
  repeat_policy: EffectRepeatPolicy;
  explanation: string;
}

export type NarrativeEffectDefinition =
  | (NarrativeEffectDefinitionBase & { operation: "transfer_item"; payload: TransferItemPayload })
  | (NarrativeEffectDefinitionBase & { operation: "set_flag"; payload: FlagEffectPayload })
  | (NarrativeEffectDefinitionBase & { operation: "clear_flag"; payload: FlagEffectPayload })
  | (NarrativeEffectDefinitionBase & { operation: "set_quest_status"; payload: QuestStatusEffectPayload })
  | (NarrativeEffectDefinitionBase & { operation: "record_dialogue_choice"; payload: DialogueChoiceEffectPayload });

export type NarrativeEffectOwnerRef =
  | { owner_version: 1; owner_kind: "node_entry" | "flow_transition" | "flow_invocation" | "flow_exit"; owner_id: string; context_node_id?: never }
  | { owner_version: 1; owner_kind: "dialogue_element" | "dialogue_option" | "quest_branch" | "quest_outcome"; owner_id: string; context_node_id: string };

export interface NarrativeEffectOwnerRecordRef {
  project_id: string;
  owner: NarrativeEffectOwnerRef;
}

export interface NarrativeEffectBinding {
  binding_version: 1;
  id: string;
  project_id: string;
  effect_id: string;
  owner: NarrativeEffectOwnerRef;
  application_order: number;
}

export interface NarrativeStateContract {
  contract_version: 1;
  project_id: string;
  canonical_nodes: NarrativeStateCanonicalNodeRef[];
  flows: NarrativeStateFlowRef[];
  owners: NarrativeEffectOwnerRecordRef[];
  initial_states: FlowInitialState[];
  effects: NarrativeEffectDefinition[];
  bindings: NarrativeEffectBinding[];
}

export type NarrativeStateValidationCode =
  | "owner_mismatch"
  | "duplicate_id"
  | "duplicate_initial_state"
  | "duplicate_item_custody"
  | "missing_flow"
  | "missing_node"
  | "invalid_node_type"
  | "invalid_holder"
  | "same_transfer_holder"
  | "invalid_owner_context"
  | "duplicate_owner"
  | "missing_effect"
  | "missing_owner"
  | "invalid_application_order"
  | "duplicate_application_order";

export interface NarrativeStateValidationIssue {
  code: NarrativeStateValidationCode;
  record_id?: string;
}

const HOLDER_NODE_TYPES = {
  character: "Character",
  location: "Location",
  faction: "Faction"
} as const;

const CONTEXT_NODE_TYPES = {
  dialogue_element: "Dialogue",
  dialogue_option: "Dialogue",
  quest_branch: "Quest",
  quest_outcome: "Quest"
} as const;

/** Mirrors cross-record runtime checks without mutating caller-owned collections. */
export function validateNarrativeStateContract(contract: NarrativeStateContract): NarrativeStateValidationIssue[] {
  const issues: NarrativeStateValidationIssue[] = [];
  const nodes = new Map(contract.canonical_nodes.map((node) => [node.id, node]));
  const flowIds = new Set(contract.flows.map((flow) => flow.id));

  validateOwnedIds(contract.canonical_nodes, contract.project_id, "node", issues);
  validateOwnedIds(contract.flows, contract.project_id, "flow", issues);
  validateOwnedIds(contract.effects, contract.project_id, "effect", issues);
  validateOwnedIds(contract.bindings, contract.project_id, "binding", issues);

  const ownerKeys = new Set<string>();
  for (const record of contract.owners) {
    if (record.project_id !== contract.project_id) add(issues, "owner_mismatch", record.owner.owner_id);
    const key = ownerKey(record.owner);
    if (ownerKeys.has(key)) add(issues, "duplicate_owner", record.owner.owner_id);
    ownerKeys.add(key);
    validateOwner(record.owner, nodes, issues);
  }

  const initialFlows = new Set<string>();
  for (const state of contract.initial_states) {
    if (state.project_id !== contract.project_id) add(issues, "owner_mismatch", state.flow_id);
    if (!flowIds.has(state.flow_id)) add(issues, "missing_flow", state.flow_id);
    if (initialFlows.has(state.flow_id)) add(issues, "duplicate_initial_state", state.flow_id);
    initialFlows.add(state.flow_id);
    const itemIds = new Set<string>();
    for (const custody of state.item_custody) {
      if (itemIds.has(custody.item_node_id)) add(issues, "duplicate_item_custody", custody.item_node_id);
      itemIds.add(custody.item_node_id);
      requireNodeType(custody.item_node_id, "Item", nodes, custody.item_node_id, issues);
      validateHolder(custody.holder, nodes, custody.item_node_id, issues);
    }
    for (const questNodeId of Object.keys(state.quest_statuses)) {
      requireNodeType(questNodeId, "Quest", nodes, questNodeId, issues);
    }
  }

  const effectIds = new Set(contract.effects.map((effect) => effect.id));
  for (const effect of contract.effects) validateEffect(effect, nodes, issues);

  const applicationOrders = new Set<string>();
  for (const binding of contract.bindings) {
    if (!effectIds.has(binding.effect_id)) add(issues, "missing_effect", binding.id);
    const key = ownerKey(binding.owner);
    if (!ownerKeys.has(key)) add(issues, "missing_owner", binding.id);
    if (!Number.isInteger(binding.application_order) || binding.application_order < 0) {
      add(issues, "invalid_application_order", binding.id);
    }
    const orderKey = `${key}\u0000${binding.application_order}`;
    if (applicationOrders.has(orderKey)) add(issues, "duplicate_application_order", binding.id);
    applicationOrders.add(orderKey);
  }
  return issues;
}

function validateEffect(
  effect: NarrativeEffectDefinition,
  nodes: Map<string, NarrativeStateCanonicalNodeRef>,
  issues: NarrativeStateValidationIssue[]
) {
  if (effect.operation === "transfer_item") {
    requireNodeType(effect.payload.item_node_id, "Item", nodes, effect.id, issues);
    validateHolder(effect.payload.from_holder, nodes, effect.id, issues);
    validateHolder(effect.payload.to_holder, nodes, effect.id, issues);
    if (holderKey(effect.payload.from_holder) === holderKey(effect.payload.to_holder)) {
      add(issues, "same_transfer_holder", effect.id);
    }
  } else if (effect.operation === "set_quest_status") {
    requireNodeType(effect.payload.quest_node_id, "Quest", nodes, effect.id, issues);
  } else if (effect.operation === "record_dialogue_choice") {
    requireNodeType(effect.payload.dialogue_node_id, "Dialogue", nodes, effect.id, issues);
  }
}

function validateHolder(
  holder: StateHolderRef,
  nodes: Map<string, NarrativeStateCanonicalNodeRef>,
  recordId: string,
  issues: NarrativeStateValidationIssue[]
) {
  if (holder.kind in HOLDER_NODE_TYPES) {
    const nodeHolder = holder as Extract<StateHolderRef, { node_id: string }>;
    requireNodeType(nodeHolder.node_id, HOLDER_NODE_TYPES[nodeHolder.kind], nodes, recordId, issues);
  } else if ((holder as { node_id?: string }).node_id !== undefined) {
    add(issues, "invalid_holder", recordId);
  }
}

function validateOwner(
  owner: NarrativeEffectOwnerRef,
  nodes: Map<string, NarrativeStateCanonicalNodeRef>,
  issues: NarrativeStateValidationIssue[]
) {
  if (owner.owner_kind === "node_entry") {
    if (!nodes.has(owner.owner_id)) add(issues, "missing_node", owner.owner_id);
    return;
  }
  if (owner.owner_kind in CONTEXT_NODE_TYPES) {
    const contextual = owner as Extract<NarrativeEffectOwnerRef, { context_node_id: string }>;
    const before = issues.length;
    requireNodeType(
      contextual.context_node_id,
      CONTEXT_NODE_TYPES[contextual.owner_kind],
      nodes,
      owner.owner_id,
      issues
    );
    if (issues.length > before) add(issues, "invalid_owner_context", owner.owner_id);
  }
}

function requireNodeType(
  nodeId: string,
  expected: NarrativeStateNodeKind,
  nodes: Map<string, NarrativeStateCanonicalNodeRef>,
  recordId: string,
  issues: NarrativeStateValidationIssue[]
) {
  const node = nodes.get(nodeId);
  if (!node) add(issues, "missing_node", recordId);
  else if (node.type !== expected) add(issues, "invalid_node_type", recordId);
}

function validateOwnedIds(
  records: readonly { id: string; project_id: string }[],
  projectId: string,
  _label: string,
  issues: NarrativeStateValidationIssue[]
) {
  const ids = new Set<string>();
  for (const record of records) {
    if (record.project_id !== projectId) add(issues, "owner_mismatch", record.id);
    if (ids.has(record.id)) add(issues, "duplicate_id", record.id);
    ids.add(record.id);
  }
}

function holderKey(holder: StateHolderRef): string {
  return `${holder.kind}\u0000${"node_id" in holder ? holder.node_id ?? "" : ""}`;
}

function ownerKey(owner: NarrativeEffectOwnerRef): string {
  return `${owner.owner_kind}\u0000${"context_node_id" in owner ? owner.context_node_id ?? "" : ""}\u0000${owner.owner_id}`;
}

function add(issues: NarrativeStateValidationIssue[], code: NarrativeStateValidationCode, recordId?: string) {
  issues.push({ code, ...(recordId ? { record_id: recordId } : {}) });
}

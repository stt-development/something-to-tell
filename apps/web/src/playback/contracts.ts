import type { DialogueDocument } from "../dialogue/contracts";
import type { QuestDocument } from "../quest/contracts";
import type { FlowTransitionKind, StoryFlowSnapshot } from "../story-flow/contracts";
import type { ComposableFlowGraph, FlowExitBinding } from "@something-to-tell/contracts/composable-story-flow";
import type { StateHolderRef } from "@something-to-tell/contracts/narrative-state";

/**
 * Frontend mirror of the runtime-owned Phase 3.8 playback schema.
 * Keep aligned with services/runtime/stt_runtime/schemas/playback.py until
 * generated shared contracts replace this documented mirror.
 */
export type PlaybackSessionStatus = "ready" | "active" | "blocked" | "ended";
export type PlaybackConditionStatus = "true" | "false" | "invalid";
export type PlaybackConditionDiagnosticCode =
  | "unsupported_version"
  | "malformed_condition"
  | "unknown_condition_path"
  | "unsupported_condition_operator"
  | "unsupported_condition_function"
  | "condition_type_mismatch";
export type PlaybackEffectOperation = PlaybackTypedEffect["operation"];
export type PlaybackFactLevel = "error" | "warning" | "info";
export type QuestPlaybackStatus = "inactive" | "active" | "completed" | "failed";
export type PlaybackFactCode =
  | "empty_flow"
  | "missing_entry"
  | "invalid_entry"
  | "missing_member"
  | "dangling_source"
  | "stale_ownership"
  | "duplicate_effect_id"
  | "unsupported_version"
  | "invalid_definition"
  | "malformed_condition"
  | "unknown_condition_path"
  | "no_eligible_transition"
  | "multiple_unconditional_transitions"
  | "missing_default_branch"
  | "malformed_effect"
  | "conflicting_effects"
  | "repeated_effect"
  | "stale_item_holder"
  | "visit_threshold"
  | "ending_reached"
  | "stale_source_revision"
  | "missing_exit_binding"
  | "call_entered"
  | "exit_reached"
  | "return_completed";

export interface PlaybackCanonicalNode {
  node_version: 1;
  id: string;
  project_id: string;
  type: string;
  title: string;
  summary: string;
  body: string;
  status: string;
  metadata: Record<string, unknown>;
}

interface PlaybackEffectOwner {
  effect_version: 1;
  id: string;
  project_id: string;
  flow_id: string;
  owner_node_id: string | null;
  owner_transition_id: string | null;
  review_status: "accepted";
  repeatable: boolean;
  explanation: string;
  authored_effect_id?: string | null;
  owner_kind?: "node_entry" | "flow_transition" | "flow_invocation" | "flow_exit" | "dialogue_element" | "dialogue_option" | "quest_branch" | "quest_outcome" | null;
  owner_id?: string | null;
  context_node_id?: string | null;
  application_order?: number;
}

export interface SetFlagPlaybackEffect extends PlaybackEffectOwner {
  operation: "set_flag";
  payload: { flag: string };
}

export interface ClearFlagPlaybackEffect extends PlaybackEffectOwner {
  operation: "clear_flag";
  payload: { flag: string };
}

export interface AddInventoryPlaybackEffect extends PlaybackEffectOwner {
  operation: "add_inventory";
  payload: { node_id: string };
}

export interface RemoveInventoryPlaybackEffect extends PlaybackEffectOwner {
  operation: "remove_inventory";
  payload: { node_id: string };
}

export interface TransferItemPlaybackEffect extends PlaybackEffectOwner {
  operation: "transfer_item";
  payload: { item_node_id: string; from_holder: StateHolderRef; to_holder: StateHolderRef };
}

export interface SetQuestStatusPlaybackEffect extends PlaybackEffectOwner {
  operation: "set_quest_status";
  payload: { quest_node_id: string; status: QuestPlaybackStatus };
}

export interface RecordDialogueChoicePlaybackEffect extends PlaybackEffectOwner {
  operation: "record_dialogue_choice";
  payload: { dialogue_node_id: string; choice_id: string };
}

export type PlaybackTypedEffect =
  | SetFlagPlaybackEffect
  | ClearFlagPlaybackEffect
  | AddInventoryPlaybackEffect
  | RemoveInventoryPlaybackEffect
  | TransferItemPlaybackEffect
  | SetQuestStatusPlaybackEffect
  | RecordDialogueChoicePlaybackEffect;

export interface ReviewedPlaybackEffectAdapter {
  adapter_version: 1;
  source_kind: "Outcome" | "Quest" | "Dialogue";
  source_node_id: string;
  effect: PlaybackTypedEffect;
}

export interface PlaybackCondition {
  condition_version: 1 | 2;
  expression: string;
}

export interface PlaybackConditionResult {
  condition_result_version: 1;
  expression: string;
  status: PlaybackConditionStatus;
  value: boolean | null;
  message: string;
  diagnostic_code: PlaybackConditionDiagnosticCode | null;
  children: PlaybackConditionResult[];
}

export interface PlaybackFact {
  fact_version: 1;
  code: PlaybackFactCode;
  level: PlaybackFactLevel;
  message: string;
  action: string;
  flow_id: string | null;
  node_id: string | null;
  transition_id: string | null;
  effect_id: string | null;
  invocation_id?: string | null;
  exit_id?: string | null;
  item_node_id?: string | null;
  holder_kind?: string | null;
  holder_node_id?: string | null;
}

export interface PlaybackState {
  state_version: 1;
  flags: Record<string, boolean>;
  inventory_node_ids: string[];
  item_holders: Record<string, StateHolderRef>;
  quest_states: Record<string, QuestPlaybackStatus>;
  dialogue_choice_ids: Record<string, string[]>;
  visited_node_ids: string[];
  applied_effect_ids: string[];
}

export type PlaybackStateChangeValue = boolean | string | string[] | StateHolderRef | null;

export interface PlaybackStateChange {
  state_change_version: 1;
  effect_id: string;
  authored_effect_id?: string | null;
  operation: PlaybackEffectOperation;
  path: string;
  before: PlaybackStateChangeValue;
  after: PlaybackStateChangeValue;
  explanation: string;
}

export interface PlaybackEffectApplication {
  application_version: 1;
  success: boolean;
  state_before: PlaybackState;
  state_after: PlaybackState;
  applied_effect_ids: string[];
  changes: PlaybackStateChange[];
  facts: PlaybackFact[];
}

export interface PlaybackChoice {
  choice_version: 1;
  transition_id: string;
  source_node_id: string;
  target_node_id: string;
  kind: FlowTransitionKind;
  label: string;
  condition: string;
  priority: number;
  is_default: boolean;
  eligible: boolean;
  disabled_reason: string | null;
  condition_result: PlaybackConditionResult | null;
  effect_ids: string[];
  operation?: "transition" | "call";
  target_flow_id?: string | null;
}

export interface PlaybackDialogueLine {
  line_version: 1;
  element_id: string;
  speaker_node_id: string;
  text: string;
}

export interface PlaybackDialogueSelection {
  selection_version: 1;
  choice_element_id: string;
  option_id: string;
  text: string;
}

export type PlaybackDialogueTurn = PlaybackDialogueLine | PlaybackDialogueSelection;

export interface PlaybackDialogueOption {
  option_version: 1;
  choice_element_id: string;
  option_id: string;
  text: string;
  condition: string;
  eligible: boolean;
  disabled_reason: string | null;
  condition_result: PlaybackConditionResult | null;
}

export interface PlaybackDialogueStep {
  dialogue_step_version: 1;
  dialogue_node_id: string;
  prompt: string;
  turns: PlaybackDialogueTurn[];
  options: PlaybackDialogueOption[];
  complete: boolean;
  outcome_element_id: string | null;
}

export interface PlaybackDialoguePath {
  path_version: 1;
  dialogue_node_id: string;
  option_ids: string[];
}

export interface PlaybackStep {
  step_version: 1;
  node_id: string;
  node_kind: string;
  title: string;
  summary: string;
  dialogue?: PlaybackDialogueStep | null;
  choices: PlaybackChoice[];
  facts: PlaybackFact[];
}

export interface PlaybackTraceEntry {
  trace_version: 1;
  sequence: number;
  node_id: string;
  transition_id: string | null;
  dialogue_option_id?: string | null;
  dialogue_path_before?: PlaybackDialoguePath | null;
  dialogue_path_after?: PlaybackDialoguePath | null;
  condition_results: PlaybackConditionResult[];
  applied_effect_ids: string[];
  state_changes: PlaybackStateChange[];
  state_before: PlaybackState;
  state_after: PlaybackState;
  timestamp: string;
  events?: PlaybackTraceEvent[];
  flow_id_before?: string | null;
  flow_id_after?: string | null;
  call_stack_before?: PlaybackCallFrame[];
  call_stack_after?: PlaybackCallFrame[];
  terminal_exit_before?: PlaybackTerminalExit | null;
  terminal_exit_after?: PlaybackTerminalExit | null;
}

export interface PlaybackCallFrame {
  frame_version: 1;
  invocation_id: string;
  caller_flow_id: string;
  caller_source_node_id: string;
  callee_flow_id: string;
  exit_bindings: FlowExitBinding[];
}

export interface PlaybackTerminalExit {
  result_version: 1;
  exit_id: string;
  flow_id: string;
  key: string;
  label: string;
  source_node_id: string;
}

export interface PlaybackTraceEvent {
  event_version: 1;
  operation: "transition" | "dialogue" | "call" | "exit" | "return";
  flow_id: string;
  node_id: string;
  invocation_id: string | null;
  exit_id: string | null;
  message: string;
}

export interface PlaybackDefinition {
  definition_version: 1;
  project_id: string;
  flow_snapshot: StoryFlowSnapshot;
  flow_snapshots?: StoryFlowSnapshot[];
  composition?: ComposableFlowGraph | null;
  canonical_nodes: PlaybackCanonicalNode[];
  dialogue_documents: Record<string, DialogueDocument>;
  quest_documents: Record<string, QuestDocument>;
  typed_effect_definitions: PlaybackTypedEffect[];
  initial_state: PlaybackState;
  source_revision: string;
}

export interface PlaybackPreparation {
  preparation_version: 1;
  project_id: string;
  flow_id: string | null;
  definition: PlaybackDefinition | null;
  facts: PlaybackFact[];
}

export interface PlaybackSession {
  session_version: 1;
  id: string;
  project_id: string;
  flow_id: string;
  current_flow_id?: string;
  source_revision: string;
  visit_threshold: number;
  status: PlaybackSessionStatus;
  current_node_id: string | null;
  state: PlaybackState;
  dialogue_path?: PlaybackDialoguePath | null;
  step: PlaybackStep | null;
  trace: PlaybackTraceEntry[];
  facts: PlaybackFact[];
  call_stack?: PlaybackCallFrame[];
  terminal_exit?: PlaybackTerminalExit | null;
}

export interface PlaybackPrepareCommand {
  command_version: 1;
  snapshot: StoryFlowSnapshot;
  snapshots?: StoryFlowSnapshot[];
  canonical_nodes: PlaybackCanonicalNode[];
  dialogue_documents: Record<string, DialogueDocument>;
  quest_documents: Record<string, QuestDocument>;
  typed_effects: PlaybackTypedEffect[];
  initial_state: PlaybackState;
  source_revision: string;
}

export interface PlaybackStartCommand {
  command_version: 1;
  definition: PlaybackDefinition;
  initial_state: PlaybackState | null;
  visit_threshold: number;
}

export interface PlaybackRevisionCommand {
  command_version: 1;
  source_revision: string;
}

export interface PlaybackChooseCommand extends PlaybackRevisionCommand {
  transition_id?: string | null;
  dialogue_option_id?: string | null;
  allow_visit_threshold: boolean;
}

export interface PlaybackRestartCommand {
  command_version: 1;
  definition: PlaybackDefinition;
  initial_state: PlaybackState | null;
  visit_threshold: number | null;
}

export interface PlaybackDefinitionValidationIssue {
  code: "duplicate_effect_id" | "duplicate_node" | "missing_member" | "stale_ownership";
  message: string;
  owner_id?: string;
}

/** Guards cross-record ownership when runtime definitions hydrate the UI. */
export function validatePlaybackDefinition(definition: PlaybackDefinition): PlaybackDefinitionValidationIssue[] {
  const issues: PlaybackDefinitionValidationIssue[] = [];
  const flow = definition.flow_snapshot.flow;
  const snapshots = definition.flow_snapshots?.length ? definition.flow_snapshots : [definition.flow_snapshot];
  const memberIds = new Set(snapshots.flatMap((snapshot) => snapshot.nodes.map((membership) => membership.node_id)));
  const membersByFlow = new Map(snapshots.map((snapshot) => [snapshot.flow.id, new Set(snapshot.nodes.map((membership) => membership.node_id))]));
  const nodeIds = new Set<string>();
  definition.canonical_nodes.forEach((node) => {
    if (nodeIds.has(node.id)) issues.push(issue("duplicate_node", `Duplicate canonical node: ${node.id}`, node.id));
    nodeIds.add(node.id);
    if (node.project_id !== definition.project_id) {
      issues.push(issue("stale_ownership", `Canonical node belongs to another project: ${node.id}`, node.id));
    }
  });
  memberIds.forEach((nodeId) => {
    if (!nodeIds.has(nodeId)) issues.push(issue("missing_member", `Missing canonical flow member: ${nodeId}`, nodeId));
  });
  nodeIds.forEach((nodeId) => {
    if (!memberIds.has(nodeId)) issues.push(issue("stale_ownership", `Canonical node is outside flow membership: ${nodeId}`, nodeId));
  });
  if (flow.project_id !== definition.project_id) {
    issues.push(issue("stale_ownership", "Story Flow belongs to another project.", flow.id));
  }
  const transitionIds = new Set(snapshots.flatMap((snapshot) => snapshot.transitions.map((transition) => transition.id)));
  const effectIds = new Set<string>();
  definition.typed_effect_definitions.forEach((effect) => {
    if (effectIds.has(effect.id)) issues.push(issue("duplicate_effect_id", `Duplicate effect id: ${effect.id}`, effect.id));
    effectIds.add(effect.id);
    const hasNodeOwner = effect.owner_node_id !== null;
    const hasTransitionOwner = effect.owner_transition_id !== null;
    const validOwner = hasNodeOwner !== hasTransitionOwner
      && (hasNodeOwner
        ? membersByFlow.get(effect.flow_id)?.has(effect.owner_node_id!) === true
        : transitionIds.has(effect.owner_transition_id!));
    if (effect.project_id !== definition.project_id || effect.flow_id !== flow.id || !validOwner) {
      issues.push(issue("stale_ownership", `Effect has stale ownership: ${effect.id}`, effect.id));
    }
  });
  Object.keys(definition.dialogue_documents).forEach((nodeId) => validateDocumentOwner(nodeId, "Dialogue", definition, issues));
  Object.keys(definition.quest_documents).forEach((nodeId) => validateDocumentOwner(nodeId, "Quest", definition, issues));
  return issues;
}

function validateDocumentOwner(
  nodeId: string,
  kind: string,
  definition: PlaybackDefinition,
  issues: PlaybackDefinitionValidationIssue[]
) {
  const owner = definition.canonical_nodes.find((node) => node.id === nodeId);
  if (!owner || owner.type !== kind) {
    issues.push(issue("stale_ownership", `${kind} document has a stale owner: ${nodeId}`, nodeId));
  }
}

function issue(
  code: PlaybackDefinitionValidationIssue["code"],
  message: string,
  ownerId?: string
): PlaybackDefinitionValidationIssue {
  return { code, message, ...(ownerId ? { owner_id: ownerId } : {}) };
}

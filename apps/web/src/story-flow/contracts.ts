/**
 * Frontend mirror of the runtime-owned Phase 3.7 Story Flow schema.
 * Keep this module aligned with services/runtime/stt_runtime/schemas/story_flow.py
 * until generated shared contracts replace the documented mirror.
 */
import type { FlowExit, FlowExitBinding, FlowInvocation } from "@something-to-tell/contracts/composable-story-flow";
export const STORY_FLOW_KINDS = ["main", "side", "standalone"] as const;
export const STORY_FLOW_STATUSES = ["draft", "active", "archived"] as const;
export const FLOW_TRANSITION_KINDS = ["next", "branch", "optional", "return"] as const;

export type StoryFlowKind = (typeof STORY_FLOW_KINDS)[number];
export type StoryFlowStatus = (typeof STORY_FLOW_STATUSES)[number];
export type FlowTransitionKind = (typeof FLOW_TRANSITION_KINDS)[number];
export type FlowIntegrityLevel = "error" | "warning" | "info";
export type FlowIntegrityFactCode =
  | "missing_entry"
  | "invalid_entry"
  | "unreachable_member"
  | "dangling_transition_endpoint"
  | "cross_project_reference"
  | "duplicate_membership"
  | "duplicate_transition_priority"
  | "multiple_default_branches"
  | "conditioned_default_branch"
  | "branch_without_condition"
  | "invalid_scene_boundary"
  | "cycle"
  | "ending"
  | "no_ending"
  | "dangling_placement"
  | "missing_canonical_node"
  | "invalid_child_kind"
  | "duplicate_placement"
  | "containment_cycle"
  | "stale_membership";

export interface StoryFlow {
  flow_version: 1;
  id: string;
  project_id: string;
  name: string;
  description: string;
  kind: StoryFlowKind;
  status: StoryFlowStatus;
  entry_node_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface StoryFlowNode {
  flow_node_version: 1;
  id: string;
  project_id: string;
  flow_id: string;
  node_id: string;
  presentation_order: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface FlowTransition {
  transition_version: 1;
  id: string;
  project_id: string;
  flow_id: string;
  source_node_id: string;
  target_node_id: string;
  kind: FlowTransitionKind;
  label: string;
  condition: string;
  priority: number;
  is_default: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SceneFlowBoundary {
  boundary_version: 1;
  id: string;
  project_id: string;
  flow_id: string;
  scene_node_id: string;
  entry_node_id: string;
  exit_node_ids: string[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface StoryFlowSnapshot {
  snapshot_version: 1;
  flow: StoryFlow;
  nodes: StoryFlowNode[];
  transitions: FlowTransition[];
  scene_boundaries: SceneFlowBoundary[];
  /** Canonical composition projection used only to validate Scene references. */
  scene_children: Record<string, string[]>;
  /** Phase 3.10 call records projected with their source/owning flow. */
  invocations?: FlowInvocation[];
  exits?: FlowExit[];
  bindings?: FlowExitBinding[];
}

export interface StoryFlowBootstrapDraft {
  kind: "Scene" | "Event";
  title: string;
  summary: string;
  position: { x: number; y: number };
  size: { height: number; width: number };
}

/** Fields shared by button and drag-connect continuation commands. */
export interface FlowTransitionDraft {
  kind: FlowTransitionKind;
  label: string;
  condition: string;
  priority: number;
  is_default: boolean;
  metadata?: Record<string, unknown>;
}

export interface StoryFlowDeletionImpact {
  flow_id: string;
  membership_count: number;
  transition_count: number;
  scene_boundary_count: number;
  invocation_ids?: string[];
  exit_ids?: string[];
  binding_ids?: string[];
  agent_memory_ids?: string[];
  canonical_nodes_deleted: false;
}

export interface StoryFlowNodeDeletionImpact {
  flow_id: string;
  node_id: string;
  transition_ids: string[];
  scene_boundary_ids: string[];
  removes_entry: boolean;
  canonical_node_deleted: false;
}

export interface FlowIntegrityFact {
  code: FlowIntegrityFactCode;
  level: FlowIntegrityLevel;
  message: string;
  action: string;
  flow_id: string | null;
  node_id: string | null;
  transition_id: string | null;
  scene_node_id: string | null;
  container_node_id: string | null;
  placement_id: string | null;
  relationship_id: string | null;
}

export interface StoryFlowIntegrityReport {
  project_id: string;
  flow_id: string | null;
  facts: FlowIntegrityFact[];
}

export interface StoryFlowValidationIssue {
  code:
    | "active_without_members"
    | "branch_without_condition"
    | "conditioned_default"
    | "duplicate_boundary"
    | "duplicate_exit"
    | "duplicate_membership"
    | "duplicate_membership_id"
    | "duplicate_presentation_order"
    | "duplicate_priority"
    | "duplicate_transition_id"
    | "empty_entry"
    | "flow_mismatch"
    | "invalid_endpoint"
    | "invalid_entry"
    | "invalid_scene_child"
    | "missing_entry"
    | "missing_scene_projection"
    | "multiple_defaults"
    | "project_mismatch"
    | "self_transition";
  message: string;
  record_id?: string;
}

/** Validates cross-record invariants before a Story Flow reaches the runtime. */
export function validateStoryFlowSnapshot(snapshot: StoryFlowSnapshot): StoryFlowValidationIssue[] {
  const issues: StoryFlowValidationIssue[] = [];
  const flow = snapshot.flow;
  const membershipIds = new Set<string>();
  const memberNodeIds = new Set<string>();
  const presentationOrders = new Set<number>();

  for (const membership of snapshot.nodes) {
    validateOwner(membership, flow, "Flow membership", issues);
    if (membershipIds.has(membership.id)) {
      issues.push(issue("duplicate_membership_id", `Duplicate flow membership id: ${membership.id}`, membership.id));
    }
    if (memberNodeIds.has(membership.node_id)) {
      issues.push(issue("duplicate_membership", `Duplicate flow membership for node: ${membership.node_id}`, membership.id));
    }
    if (presentationOrders.has(membership.presentation_order)) {
      issues.push(issue("duplicate_presentation_order", `Duplicate flow presentation order: ${membership.presentation_order}`, membership.id));
    }
    membershipIds.add(membership.id);
    memberNodeIds.add(membership.node_id);
    presentationOrders.add(membership.presentation_order);
  }

  if (snapshot.nodes.length === 0) {
    if (flow.entry_node_id !== null) issues.push(issue("empty_entry", "Empty flow cannot have an entry node.", flow.id));
    if (flow.status === "active") issues.push(issue("active_without_members", "Active flow requires at least one member.", flow.id));
  } else if (flow.status === "active" && flow.entry_node_id === null) {
    issues.push(issue("missing_entry", "Active non-empty flow requires an entry node.", flow.id));
  }
  if (flow.entry_node_id !== null && !memberNodeIds.has(flow.entry_node_id)) {
    issues.push(issue("invalid_entry", "Flow entry node must be a member.", flow.id));
  }

  const transitionIds = new Set<string>();
  const sourcePriorities = new Set<string>();
  const defaultSources = new Set<string>();
  for (const transition of snapshot.transitions) {
    validateOwner(transition, flow, "Flow transition", issues);
    if (transitionIds.has(transition.id)) {
      issues.push(issue("duplicate_transition_id", `Duplicate flow transition id: ${transition.id}`, transition.id));
    }
    if (transition.source_node_id === transition.target_node_id) {
      issues.push(issue("self_transition", "Flow transition endpoints must be distinct.", transition.id));
    }
    if (!memberNodeIds.has(transition.source_node_id) || !memberNodeIds.has(transition.target_node_id)) {
      issues.push(issue("invalid_endpoint", "Flow transition endpoints must be members.", transition.id));
    }
    if (transition.is_default && transition.condition.trim()) {
      issues.push(issue("conditioned_default", "Default flow transition cannot have a condition.", transition.id));
    }
    if (transition.kind === "branch" && !transition.is_default && !transition.condition.trim()) {
      issues.push(issue("branch_without_condition", "Non-default branch transition requires a condition.", transition.id));
    }
    const priorityKey = `${transition.source_node_id}\u0000${transition.priority}`;
    if (sourcePriorities.has(priorityKey)) {
      issues.push(issue("duplicate_priority", `Duplicate transition priority from source: ${transition.source_node_id}`, transition.id));
    }
    if (transition.is_default && defaultSources.has(transition.source_node_id)) {
      issues.push(issue("multiple_defaults", `Multiple default transitions from source: ${transition.source_node_id}`, transition.id));
    }
    transitionIds.add(transition.id);
    sourcePriorities.add(priorityKey);
    if (transition.is_default) defaultSources.add(transition.source_node_id);
  }

  const boundaryIds = new Set<string>();
  const boundaryScenes = new Set<string>();
  for (const boundary of snapshot.scene_boundaries) {
    validateOwner(boundary, flow, "Scene flow boundary", issues);
    if (boundaryIds.has(boundary.id) || boundaryScenes.has(boundary.scene_node_id)) {
      issues.push(issue("duplicate_boundary", `Duplicate Scene flow boundary: ${boundary.scene_node_id}`, boundary.id));
    }
    if (new Set(boundary.exit_node_ids).size !== boundary.exit_node_ids.length) {
      issues.push(issue("duplicate_exit", "Scene flow exit node ids must be unique.", boundary.id));
    }
    const references = [boundary.scene_node_id, boundary.entry_node_id, ...boundary.exit_node_ids];
    if (references.some((nodeId) => !memberNodeIds.has(nodeId))) {
      issues.push(issue("invalid_scene_child", "Scene flow boundary references must be flow members.", boundary.id));
    }
    const children = snapshot.scene_children[boundary.scene_node_id];
    if (!children) {
      issues.push(issue("missing_scene_projection", `Scene child projection missing for boundary: ${boundary.scene_node_id}`, boundary.id));
    } else if (!children.includes(boundary.entry_node_id) || boundary.exit_node_ids.some((nodeId) => !children.includes(nodeId))) {
      issues.push(issue("invalid_scene_child", "Scene flow boundary references must be canonical Scene children.", boundary.id));
    }
    if (boundary.scene_node_id === boundary.entry_node_id || boundary.exit_node_ids.includes(boundary.scene_node_id)) {
      issues.push(issue("invalid_scene_child", "Scene flow boundary children must differ from the Scene node.", boundary.id));
    }
    boundaryIds.add(boundary.id);
    boundaryScenes.add(boundary.scene_node_id);
  }
  return issues;
}

function validateOwner(
  record: { flow_id: string; project_id: string; id: string },
  flow: StoryFlow,
  label: string,
  issues: StoryFlowValidationIssue[]
) {
  if (record.project_id !== flow.project_id) {
    issues.push(issue("project_mismatch", `${label} belongs to another project.`, record.id));
  }
  if (record.flow_id !== flow.id) {
    issues.push(issue("flow_mismatch", `${label} belongs to another flow.`, record.id));
  }
}

function issue(code: StoryFlowValidationIssue["code"], message: string, recordId?: string): StoryFlowValidationIssue {
  return { code, message, ...(recordId ? { record_id: recordId } : {}) };
}

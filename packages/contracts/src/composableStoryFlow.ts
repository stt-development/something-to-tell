/**
 * Shared TypeScript mirror of the runtime-owned Phase 3.10 contracts.
 * Python validation remains authoritative; keep this module synchronized with
 * services/runtime/stt_runtime/schemas/composable_story_flow.py.
 */

export interface FlowInvocation {
  invocation_version: 1;
  id: string;
  project_id: string;
  source_flow_id: string;
  source_node_id: string;
  target_flow_id: string;
  label: string;
  condition: string;
  priority: number;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface FlowExit {
  exit_version: 1;
  id: string;
  project_id: string;
  flow_id: string;
  key: string;
  label: string;
  source_node_id: string;
  created_at: string;
  updated_at: string;
}

export interface FlowExitBinding {
  binding_version: 1;
  id: string;
  project_id: string;
  invocation_id: string;
  exit_id: string;
  target_node_id: string;
  created_at: string;
  updated_at: string;
}

export interface ComposableStoryFlow {
  id: string;
  project_id: string;
  entry_node_id: string | null;
}

export interface ComposableStoryFlowNode {
  id: string;
  project_id: string;
  flow_id: string;
  node_id: string;
}

export interface ComposableFlowTransition {
  id: string;
  project_id: string;
  flow_id: string;
  source_node_id: string;
  target_node_id: string;
  condition: string;
  priority: number;
  is_default: boolean;
}

export type ComposableFlowRoute = ComposableFlowTransition | FlowInvocation;

export interface ComposableFlowGraph {
  composition_version: 1;
  project_id: string;
  flows: ComposableStoryFlow[];
  memberships: ComposableStoryFlowNode[];
  transitions: ComposableFlowTransition[];
  invocations: FlowInvocation[];
  exits: FlowExit[];
  bindings: FlowExitBinding[];
}

export type ComposableFlowValidationCode =
  | "conditioned_default"
  | "duplicate_binding"
  | "duplicate_default"
  | "duplicate_exit_key"
  | "duplicate_id"
  | "duplicate_membership"
  | "duplicate_priority"
  | "flow_cycle"
  | "invalid_binding_exit"
  | "invalid_binding_target"
  | "invalid_entry"
  | "invalid_exit_source"
  | "invalid_invocation_source"
  | "missing_reference"
  | "owner_mismatch"
  | "self_invocation"
  | "terminal_exit_continues";

export interface ComposableFlowValidationIssue {
  code: ComposableFlowValidationCode;
  record_id?: string;
}

/** Returns a new deterministic projection and never sorts either caller-owned input. */
export function orderOutgoingRoutes(
  transitions: readonly ComposableFlowTransition[],
  invocations: readonly FlowInvocation[]
): ComposableFlowRoute[] {
  return [...transitions, ...invocations].sort((left, right) => {
    const leftOwner = routeOwner(left);
    const rightOwner = routeOwner(right);
    return leftOwner.flowId.localeCompare(rightOwner.flowId)
      || leftOwner.nodeId.localeCompare(rightOwner.nodeId)
      || left.priority - right.priority
      || Number(isInvocation(left)) - Number(isInvocation(right))
      || left.id.localeCompare(right.id);
  });
}

/** Mirrors the strict executable graph checks used by the runtime boundary. */
export function validateComposableFlowGraph(graph: ComposableFlowGraph): ComposableFlowValidationIssue[] {
  const issues: ComposableFlowValidationIssue[] = [];
  const flowById = new Map(graph.flows.map((flow) => [flow.id, flow]));
  checkUniqueIds(graph, issues);

  const members = new Set<string>();
  for (const membership of graph.memberships) {
    if (membership.project_id !== graph.project_id) add(issues, "owner_mismatch", membership.id);
    if (!flowById.has(membership.flow_id)) add(issues, "missing_reference", membership.id);
    const key = pair(membership.flow_id, membership.node_id);
    if (members.has(key)) add(issues, "duplicate_membership", membership.id);
    members.add(key);
  }
  for (const flow of graph.flows) {
    if (flow.project_id !== graph.project_id) add(issues, "owner_mismatch", flow.id);
    if (flow.entry_node_id !== null && !members.has(pair(flow.id, flow.entry_node_id))) add(issues, "invalid_entry", flow.id);
  }

  for (const transition of graph.transitions) {
    if (transition.project_id !== graph.project_id) add(issues, "owner_mismatch", transition.id);
    if (!flowById.has(transition.flow_id)) add(issues, "missing_reference", transition.id);
    if (!members.has(pair(transition.flow_id, transition.source_node_id)) || !members.has(pair(transition.flow_id, transition.target_node_id))) {
      add(issues, "missing_reference", transition.id);
    }
    if (transition.is_default && transition.condition.trim()) add(issues, "conditioned_default", transition.id);
  }

  for (const invocation of graph.invocations) {
    if (invocation.project_id !== graph.project_id) add(issues, "owner_mismatch", invocation.id);
    if (invocation.source_flow_id === invocation.target_flow_id) add(issues, "self_invocation", invocation.id);
    const callee = flowById.get(invocation.target_flow_id);
    if (!flowById.has(invocation.source_flow_id) || !callee) add(issues, "missing_reference", invocation.id);
    if (!members.has(pair(invocation.source_flow_id, invocation.source_node_id))) add(issues, "invalid_invocation_source", invocation.id);
    if (callee && (callee.entry_node_id === null || !members.has(pair(callee.id, callee.entry_node_id)))) add(issues, "invalid_entry", invocation.id);
    if (invocation.is_default && invocation.condition.trim()) add(issues, "conditioned_default", invocation.id);
  }

  validateRouteNamespace(graph, issues);
  validateCallCycles(graph, flowById, issues);
  const exitById = validateExits(graph, flowById, members, issues);
  validateBindings(graph, exitById, members, issues);
  return issues;
}

function validateRouteNamespace(graph: ComposableFlowGraph, issues: ComposableFlowValidationIssue[]) {
  const priorities = new Set<string>();
  const defaults = new Set<string>();
  for (const route of orderOutgoingRoutes(graph.transitions, graph.invocations)) {
    const owner = routeOwner(route);
    const ownerKey = pair(owner.flowId, owner.nodeId);
    const priorityKey = pair(ownerKey, String(route.priority));
    if (priorities.has(priorityKey)) add(issues, "duplicate_priority", route.id);
    if (route.is_default && defaults.has(ownerKey)) add(issues, "duplicate_default", route.id);
    priorities.add(priorityKey);
    if (route.is_default) defaults.add(ownerKey);
  }
}

function validateCallCycles(
  graph: ComposableFlowGraph,
  flowById: Map<string, ComposableStoryFlow>,
  issues: ComposableFlowValidationIssue[]
) {
  const targets = new Map([...flowById.keys()].map((id) => [id, new Set<string>()]));
  for (const invocation of graph.invocations) targets.get(invocation.source_flow_id)?.add(invocation.target_flow_id);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (flowId: string): boolean => {
    if (visiting.has(flowId)) return true;
    if (visited.has(flowId)) return false;
    visiting.add(flowId);
    for (const target of [...(targets.get(flowId) ?? [])].sort()) if (visit(target)) return true;
    visiting.delete(flowId);
    visited.add(flowId);
    return false;
  };
  if ([...flowById.keys()].sort().some(visit)) add(issues, "flow_cycle");
}

function validateExits(
  graph: ComposableFlowGraph,
  flowById: Map<string, ComposableStoryFlow>,
  members: Set<string>,
  issues: ComposableFlowValidationIssue[]
): Map<string, FlowExit> {
  const exits = new Map<string, FlowExit>();
  const keys = new Set<string>();
  const outgoing = new Set(orderOutgoingRoutes(graph.transitions, graph.invocations).map((route) => {
    const owner = routeOwner(route);
    return pair(owner.flowId, owner.nodeId);
  }));
  for (const flowExit of graph.exits) {
    if (flowExit.project_id !== graph.project_id) add(issues, "owner_mismatch", flowExit.id);
    if (!flowById.has(flowExit.flow_id)) add(issues, "missing_reference", flowExit.id);
    if (!members.has(pair(flowExit.flow_id, flowExit.source_node_id))) add(issues, "invalid_exit_source", flowExit.id);
    const key = pair(flowExit.flow_id, flowExit.key);
    if (keys.has(key)) add(issues, "duplicate_exit_key", flowExit.id);
    if (outgoing.has(pair(flowExit.flow_id, flowExit.source_node_id))) add(issues, "terminal_exit_continues", flowExit.id);
    keys.add(key);
    exits.set(flowExit.id, flowExit);
  }
  return exits;
}

function validateBindings(
  graph: ComposableFlowGraph,
  exits: Map<string, FlowExit>,
  members: Set<string>,
  issues: ComposableFlowValidationIssue[]
) {
  const invocationById = new Map(graph.invocations.map((invocation) => [invocation.id, invocation]));
  const mappings = new Set<string>();
  for (const binding of graph.bindings) {
    if (binding.project_id !== graph.project_id) add(issues, "owner_mismatch", binding.id);
    const invocation = invocationById.get(binding.invocation_id);
    const flowExit = exits.get(binding.exit_id);
    if (!invocation || !flowExit) {
      add(issues, "missing_reference", binding.id);
      continue;
    }
    if (flowExit.flow_id !== invocation.target_flow_id) add(issues, "invalid_binding_exit", binding.id);
    if (!members.has(pair(invocation.source_flow_id, binding.target_node_id))) add(issues, "invalid_binding_target", binding.id);
    const mapping = pair(binding.invocation_id, binding.exit_id);
    if (mappings.has(mapping)) add(issues, "duplicate_binding", binding.id);
    mappings.add(mapping);
  }
}

function checkUniqueIds(graph: ComposableFlowGraph, issues: ComposableFlowValidationIssue[]) {
  for (const records of [graph.flows, graph.memberships, graph.transitions, graph.invocations, graph.exits, graph.bindings]) {
    const ids = new Set<string>();
    for (const record of records) {
      if (ids.has(record.id)) add(issues, "duplicate_id", record.id);
      ids.add(record.id);
    }
  }
}

function isInvocation(route: ComposableFlowRoute): route is FlowInvocation {
  return "source_flow_id" in route;
}

function routeOwner(route: ComposableFlowRoute): { flowId: string; nodeId: string } {
  return isInvocation(route)
    ? { flowId: route.source_flow_id, nodeId: route.source_node_id }
    : { flowId: route.flow_id, nodeId: route.source_node_id };
}

function pair(left: string, right: string): string {
  return `${left}\u0000${right}`;
}

function add(issues: ComposableFlowValidationIssue[], code: ComposableFlowValidationCode, recordId?: string) {
  issues.push({ code, ...(recordId ? { record_id: recordId } : {}) });
}

import type { Edge, Node } from "@xyflow/react";
import type { FlowExit, FlowExitBinding, FlowInvocation } from "@something-to-tell/contracts/composable-story-flow";
import type { NarrativeEdgeData, NarrativeNodeData, NarrativeRelationshipType } from "../types";
import type { FlowTransition, StoryFlowSnapshot } from "./contracts";

export interface StorySemanticContext {
  counterpartId: string;
  counterpartTitle: string;
  direction: "incoming" | "outgoing";
  label: string;
  relationshipType: NarrativeRelationshipType;
}

export interface StoryDocumentSection {
  boundarySceneId: string | null;
  breadcrumbs: StoryFlowBreadcrumb[];
  callPath: string[];
  depth: number;
  flowId: string;
  flowName: string;
  id: string;
  kind: "section";
  node: Node<NarrativeNodeData>;
  reference: "cycle" | "rejoin" | null;
  returnFrom: { exitId: string; exitLabel: string; invocationId: string } | null;
  semanticContext: StorySemanticContext[];
  via: FlowTransition | null;
}

export interface StoryFlowBreadcrumb {
  flowId: string;
  name: string;
}

export interface StoryDocumentCall {
  breadcrumbs: StoryFlowBreadcrumb[];
  callPath: string[];
  cycle: boolean;
  id: string;
  invocation: FlowInvocation;
  kind: "call";
  sourceFlowId: string;
  sourceNode: Node<NarrativeNodeData>;
  targetFlow: StoryFlowSnapshot | null;
}

export interface StoryDocumentExit {
  binding: FlowExitBinding | null;
  breadcrumbs: StoryFlowBreadcrumb[];
  callPath: string[];
  flowExit: FlowExit;
  id: string;
  invocationId: string | null;
  kind: "exit";
  targetNode: Node<NarrativeNodeData> | null;
}

export type StoryDocumentEntry = StoryDocumentSection | StoryDocumentCall | StoryDocumentExit;

export interface StoryDocumentProjection {
  entries: StoryDocumentEntry[];
  sections: StoryDocumentSection[];
  unreachable: Node<NarrativeNodeData>[];
}

/** Builds a read-only document projection; canonical content remains node-owned. */
export function projectStoryDocument(
  nodes: Node<NarrativeNodeData>[],
  semanticEdges: Edge<NarrativeEdgeData>[],
  snapshot: StoryFlowSnapshot | null,
  flows: StoryFlowSnapshot[] = snapshot ? [snapshot] : []
): StoryDocumentProjection {
  if (!snapshot?.flow.entry_node_id) return { entries: [], sections: [], unreachable: canonicalMembers(nodes, snapshot) };

  const canonicalNodes = new Map(
    nodes
      .filter((node) => !node.data.isLinkedInstance && (node.data.canonicalNodeId ?? node.id) === node.id)
      .map((node) => [node.id, node])
  );
  const flowById = new Map([...flows, snapshot].map((flow) => [flow.flow.id, flow]));
  const rootFlowId = snapshot.flow.id;
  const entries: StoryDocumentEntry[] = [];
  const sections: StoryDocumentSection[] = [];
  const presented = new Set<string>();
  const rootReachable = new Set<string>();
  // These indices live only for this projection. Reused calls share input work,
  // not traversal state: occurrence paths and cycle/rejoin ownership stay below.
  const flowInputs = new Map<StoryFlowSnapshot, {
    members: Set<string>;
    outgoing: Map<string, FlowTransition[]>;
  }>();
  const semanticByNode = new Map<string, Edge<NarrativeEdgeData>[]>();
  for (const edge of semanticEdges) {
    if (edge.data?.flowTransition) continue;
    const source = edge.source;
    const target = edge.target;
    for (const id of source === target ? [source] : [source, target]) {
      const bucket = semanticByNode.get(id);
      if (bucket) bucket.push(edge);
      else semanticByNode.set(id, [edge]);
    }
  }

  function inputsFor(flow: StoryFlowSnapshot) {
    const current = flowInputs.get(flow);
    if (current) return current;
    const members = new Set(flow.nodes.map((membership) => membership.node_id));
    const outgoing = new Map<string, FlowTransition[]>();
    for (const transition of flow.transitions) {
      const source = transition.source_node_id;
      const bucket = outgoing.get(source);
      if (bucket) bucket.push(transition);
      else outgoing.set(source, [transition]);
    }
    for (const bucket of outgoing.values()) {
      bucket.sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
    }
    const result = { members, outgoing };
    flowInputs.set(flow, result);
    return result;
  }

  type ReturnContext = {
    breadcrumbs: StoryFlowBreadcrumb[];
    callPath: string[];
    callerFlow: StoryFlowSnapshot;
    callerNodePath: Set<string>;
    callerFlowPath: Set<string>;
    depth: number;
    invocation: FlowInvocation;
  };

  function visit(
    flow: StoryFlowSnapshot,
    nodeId: string,
    depth: number,
    via: FlowTransition | null,
    nodePath: Set<string>,
    callPath: string[],
    breadcrumbs: StoryFlowBreadcrumb[],
    flowPath: Set<string>,
    boundarySceneId: string | null = null,
    returnFrom: StoryDocumentSection["returnFrom"] = null,
    returnContext: ReturnContext | null = null
  ) {
    const node = canonicalNodes.get(nodeId);
    const { members, outgoing: outgoingBySource } = inputsFor(flow);
    if (!node || !members.has(nodeId)) return;
    if (flow.flow.id === rootFlowId) rootReachable.add(nodeId);
    const contextNodeId = `${callPath.join(">") || flow.flow.id}:${nodeId}`;
    const reference = nodePath.has(nodeId) ? "cycle" : presented.has(contextNodeId) ? "rejoin" : null;
    const section: StoryDocumentSection = {
      boundarySceneId,
      breadcrumbs,
      callPath,
      depth,
      flowId: flow.flow.id,
      flowName: flow.flow.name,
      id: `${callPath.join(":") || flow.flow.id}:${via?.id ?? returnFrom?.exitId ?? "entry"}:${nodeId}:${sections.length}`,
      kind: "section",
      node,
      reference,
      returnFrom,
      semanticContext: semanticContextFor(nodeId, canonicalNodes, semanticByNode.get(nodeId) ?? []),
      via
    };
    sections.push(section);
    entries.push(section);
    if (reference) return;

    presented.add(contextNodeId);
    const nextPath = new Set(nodePath).add(nodeId);
    const outgoing = outgoingBySource.get(nodeId) ?? [];
    const boundary = flow.scene_boundaries.find((candidate) => candidate.scene_node_id === nodeId);
    const boundaryTransition = boundary
      ? outgoing.find((transition) => transition.target_node_id === boundary.entry_node_id) ?? null
      : null;
    if (boundary && boundary.entry_node_id !== nodeId) {
      // Reuse an explicit matching transition for editing while presenting the
      // configured Scene entry only once.
      visit(flow, boundary.entry_node_id, depth + 1, boundaryTransition, nextPath, callPath, breadcrumbs, flowPath, boundary.scene_node_id, null, returnContext);
    }

    const exits = (flow.exits ?? []).filter((flowExit) => flowExit.source_node_id === nodeId);
    if (exits.length) {
      for (const flowExit of exits) {
        const binding = returnContext
          ? (returnContext.callerFlow.bindings ?? []).find((candidate) =>
              candidate.invocation_id === returnContext.invocation.id && candidate.exit_id === flowExit.id
            ) ?? null
          : null;
        const targetNode = binding ? canonicalNodes.get(binding.target_node_id) ?? null : null;
        entries.push({
          binding,
          breadcrumbs,
          callPath,
          flowExit,
          id: `${callPath.join(":") || flow.flow.id}:exit:${flowExit.id}`,
          invocationId: returnContext?.invocation.id ?? null,
          kind: "exit",
          targetNode
        });
        if (binding && returnContext) {
          visit(
            returnContext.callerFlow,
            binding.target_node_id,
            returnContext.depth,
            null,
            returnContext.callerNodePath,
            returnContext.callPath,
            returnContext.breadcrumbs,
            returnContext.callerFlowPath,
            null,
            { exitId: flowExit.id, exitLabel: flowExit.label || flowExit.key, invocationId: returnContext.invocation.id },
            null
          );
        }
      }
      return;
    }

    const transitions = outgoing.filter((transition) =>
      !boundary || transition.target_node_id !== boundary.entry_node_id
    );
    const invocations = (flow.invocations ?? []).filter((invocation) => invocation.source_node_id === nodeId);
    const routes = [
      ...transitions.map((transition) => ({ id: transition.id, kind: "transition" as const, priority: transition.priority, transition })),
      ...invocations.map((invocation) => ({ id: invocation.id, invocation, kind: "call" as const, priority: invocation.priority }))
    ].sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
    const branches = routes.length > 1;
    for (const route of routes) {
      if (route.kind === "transition") {
        // Preserve logical depth for compact route markers without narrowing the text column.
        const nextDepth = branches || route.transition.kind !== "next" ? depth + 1 : depth;
        visit(flow, route.transition.target_node_id, nextDepth, route.transition, nextPath, callPath, breadcrumbs, flowPath, null, null, returnContext);
        continue;
      }
      const targetFlow = flowById.get(route.invocation.target_flow_id) ?? null;
      const cycle = Boolean(targetFlow && flowPath.has(targetFlow.flow.id));
      entries.push({
        breadcrumbs: targetFlow ? [...breadcrumbs, { flowId: targetFlow.flow.id, name: targetFlow.flow.name }] : breadcrumbs,
        callPath,
        cycle,
        id: `${callPath.join(":") || flow.flow.id}:call:${route.invocation.id}`,
        invocation: route.invocation,
        kind: "call",
        sourceFlowId: flow.flow.id,
        sourceNode: node,
        targetFlow
      });
      if (!targetFlow?.flow.entry_node_id || cycle) continue;
      const targetCallPath = [...callPath, route.invocation.id];
      const targetBreadcrumbs = [...breadcrumbs, { flowId: targetFlow.flow.id, name: targetFlow.flow.name }];
      visit(
        targetFlow,
        targetFlow.flow.entry_node_id,
        depth + 1,
        null,
        new Set(),
        targetCallPath,
        targetBreadcrumbs,
        new Set(flowPath).add(targetFlow.flow.id),
        null,
        null,
        {
          breadcrumbs,
          callPath,
          callerFlow: flow,
          callerFlowPath: flowPath,
          callerNodePath: nextPath,
          depth: depth + 1,
          invocation: route.invocation
        }
      );
    }
  }

  const rootBreadcrumbs = [{ flowId: snapshot.flow.id, name: snapshot.flow.name }];
  visit(snapshot, snapshot.flow.entry_node_id, 0, null, new Set(), [], rootBreadcrumbs, new Set([snapshot.flow.id]));
  const order = new Map(snapshot.nodes.map((membership) => [membership.node_id, membership.presentation_order]));
  const rootMembers = new Set(snapshot.nodes.map((membership) => membership.node_id));
  const unreachable = [...rootMembers]
    .filter((nodeId) => !rootReachable.has(nodeId))
    .map((nodeId) => canonicalNodes.get(nodeId))
    .filter((node): node is Node<NarrativeNodeData> => Boolean(node))
    .sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
  return { entries, sections, unreachable };
}

function canonicalMembers(nodes: Node<NarrativeNodeData>[], snapshot: StoryFlowSnapshot | null): Node<NarrativeNodeData>[] {
  if (!snapshot) return [];
  const members = new Set(snapshot.nodes.map((membership) => membership.node_id));
  return nodes.filter((node) =>
    !node.data.isLinkedInstance
    && (node.data.canonicalNodeId ?? node.id) === node.id
    && members.has(node.id)
  );
}

function semanticContextFor(
  nodeId: string,
  nodes: Map<string, Node<NarrativeNodeData>>,
  edges: Edge<NarrativeEdgeData>[]
): StorySemanticContext[] {
  return edges.flatMap((edge) => {
    if (edge.data?.flowTransition || (edge.source !== nodeId && edge.target !== nodeId)) return [];
    const outgoing = edge.source === nodeId;
    const counterpartId = outgoing ? edge.target : edge.source;
    const counterpart = nodes.get(counterpartId);
    const relationshipType = edge.data?.relationshipType;
    if (!counterpart || !relationshipType) return [];
    return [{
      counterpartId,
      counterpartTitle: counterpart.data.title,
      direction: outgoing ? "outgoing" as const : "incoming" as const,
      label: edge.data?.label || relationshipType,
      relationshipType
    }];
  }).sort((left, right) =>
    left.relationshipType.localeCompare(right.relationshipType)
    || left.counterpartTitle.localeCompare(right.counterpartTitle)
  );
}

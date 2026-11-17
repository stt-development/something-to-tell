import type { FlowInvocation } from "@something-to-tell/contracts/composable-story-flow";
import {
type Node
} from "@xyflow/react";
import {
tr
} from "../../localization/i18n";
import { RuntimeApiError } from "../../runtime/apiClient";
import { type StoryFlowBootstrapDraft,type StoryFlowDeletionImpact,type StoryFlowKind,type StoryFlowSnapshot } from "../../story-flow/contracts";
import {
WORKSPACE_MODES,
type ProjectWorkspacePreference,
type WorkspaceMode
} from "../../story-flow/workspace";
import {
type GraphPatchOperation,
type NarrativeNodeData
} from "../../types";

import { WORKSPACE_PREFERENCES_KEY,displayNodeKind,displayRelationshipType } from "../workspaceShared";

export function readWorkspacePreferences(): Record<string, ProjectWorkspacePreference> {
  try {
    const value = window.localStorage.getItem(WORKSPACE_PREFERENCES_KEY);
    if (!value) return {};
    const parsed = JSON.parse(value) as Record<string, Partial<ProjectWorkspacePreference>>;
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, preference]) => WORKSPACE_MODES.includes(preference.mode as WorkspaceMode))
        .map(([projectId, preference]) => [
          projectId,
          {
            mode: preference.mode as WorkspaceMode,
            activeFlowId: typeof preference.activeFlowId === "string" ? preference.activeFlowId : null
          }
        ])
    );
  } catch {
    return {};
  }
}

/** Creates an offline draft flow without inventing memberships or order. */
export function localStoryFlowSnapshot(
  projectId: string,
  draft: { description: string; kind: StoryFlowKind; name: string }
): StoryFlowSnapshot {
  const now = new Date().toISOString();
  return {
    snapshot_version: 1,
    flow: {
      flow_version: 1,
      id: `flow-local-${Date.now()}`,
      project_id: projectId,
      name: draft.name,
      description: draft.description,
      kind: draft.kind,
      status: "draft",
      entry_node_id: null,
      metadata: { local_fallback: true },
      created_at: now,
      updated_at: now
    },
    nodes: [],
    transitions: [],
    scene_boundaries: [],
    scene_children: {}
  };
}

/** Produces the complete local equivalent of the runtime starter transaction. */
export function localEmptyProjectBootstrap(
  projectId: string,
  draft: StoryFlowBootstrapDraft
): { node: Node<NarrativeNodeData>; snapshot: StoryFlowSnapshot } {
  const now = new Date().toISOString();
  const token = Date.now();
  const nodeId = `node-local-entry-${token}`;
  const flowId = `flow-local-main-${token}`;
  const placementId = `placement-local-entry-${token}`;
  const node: Node<NarrativeNodeData> = {
    id: nodeId,
    type: "narrative",
    position: draft.position,
    width: draft.size.width,
    height: draft.size.height,
    data: {
      kind: draft.kind,
      label: draft.title,
      title: draft.title,
      summary: draft.summary,
      tags: [],
      placementId,
      rootPlacementId: placementId,
      ...(draft.kind === "Scene" ? { isFrame: true } : {})
    }
  };
  return {
    node,
    snapshot: {
      snapshot_version: 1,
      flow: {
        flow_version: 1,
        id: flowId,
        project_id: projectId,
        name: "Main Story",
        description: "Primary playable story order.",
        kind: "main",
        status: "active",
        entry_node_id: nodeId,
        metadata: { local_fallback: true, created_with_empty_project_workflow: true },
        created_at: now,
        updated_at: now
      },
      nodes: [{
        flow_node_version: 1,
        id: `${flowId}:member:${nodeId}`,
        project_id: projectId,
        flow_id: flowId,
        node_id: nodeId,
        presentation_order: 0,
        metadata: { local_fallback: true },
        created_at: now,
        updated_at: now
      }],
      transitions: [],
      scene_boundaries: [],
      scene_children: {},
      invocations: [],
      exits: [],
      bindings: []
    }
  };
}

export function localStoryFlowDeletionImpact(snapshot: StoryFlowSnapshot): StoryFlowDeletionImpact {
  return {
    flow_id: snapshot.flow.id,
    membership_count: snapshot.nodes.length,
    transition_count: snapshot.transitions.length,
    scene_boundary_count: snapshot.scene_boundaries.length,
    invocation_ids: (snapshot.invocations ?? []).map((item) => item.id),
    exit_ids: (snapshot.exits ?? []).map((item) => item.id),
    binding_ids: (snapshot.bindings ?? []).map((item) => item.id),
    agent_memory_ids: [],
    canonical_nodes_deleted: false
  };
}

export function patchOperationTitle(operation: GraphPatchOperation) {
  switch (operation.op) {
    case "create_node":
      return `${displayNodeKind(operation.node.kind)}: ${operation.node.title}`;
    case "update_node":
      return operation.updates.title ? tr("analysis.updateNamed", { name: operation.updates.title }) : tr("analysis.updateNodeNamed", { name: operation.node_id });
    case "create_edge":
      return displayRelationshipType(operation.edge.relationship_type);
    case "update_edge":
      return tr("analysis.updateEdgeNamed", { name: operation.edge_id });
  }
}

/** Maps stable patch operation codes to author-facing localized labels. */
export function analysisOperationLabel(operation: GraphPatchOperation["op"]) {
  const labels = {
    create_edge: "analysis.createEdge",
    create_node: "analysis.createNode",
    update_edge: "analysis.updateEdge",
    update_node: "analysis.updateNode"
  } as const;
  return tr(labels[operation]);
}

/** Rehydrates composition fields omitted by base Story Flow snapshots after an atomic rewrite. */
export function mergeAtomicOutcomeFlowResult(
  flows: StoryFlowSnapshot[],
  previousInvocationId: string | null,
  result: { invocation: FlowInvocation; sourceFlow: StoryFlowSnapshot; targetFlow: StoryFlowSnapshot }
): StoryFlowSnapshot[] {
  const previousSource = flows.find((candidate) => candidate.flow.id === result.sourceFlow.flow.id);
  const sourceFlow: StoryFlowSnapshot = {
    ...result.sourceFlow,
    bindings: (previousSource?.bindings ?? []).filter((binding) => binding.invocation_id !== previousInvocationId),
    exits: previousSource?.exits ?? [],
    invocations: [
      ...(previousSource?.invocations ?? []).filter((invocation) =>
        invocation.id !== previousInvocationId && invocation.id !== result.invocation.id
      ),
      result.invocation
    ]
  };
  return flows
    .filter((candidate) => candidate.flow.id !== sourceFlow.flow.id && candidate.flow.id !== result.targetFlow.flow.id)
    .concat(sourceFlow, result.targetFlow);
}

/** Localizes stable composition command failures while retaining unexpected detail. */
export function composableFlowErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof RuntimeApiError)) return error instanceof Error ? error.message : fallback;
  const keys = {
    composable_flow_outcome_association_invalid: "composableFlow.error.composable_flow_outcome_association_invalid",
    composable_flow_outcome_not_found: "composableFlow.error.composable_flow_outcome_not_found",
    composable_flow_outcome_origin_invalid: "composableFlow.error.composable_flow_outcome_origin_invalid"
  } as const;
  const key = keys[error.code as keyof typeof keys];
  return key ? tr(key) : error.message;
}

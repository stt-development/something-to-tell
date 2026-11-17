/* Flow runtime endpoint ownership. */
import type { FlowExit, FlowExitBinding, FlowInvocation } from "@something-to-tell/contracts/composable-story-flow";
import type { NarrativeEffectDefinition, NarrativeEffectOwnerRef } from "@something-to-tell/contracts/narrative-state";
import { type Node } from "@xyflow/react";
import type { VisualPlacement } from "../composition/contracts";
import type { NarrativeEffectBindingRecord, NarrativeStateDeletionImpact, NarrativeStateSnapshot, RelationshipInitialStateApplyResponse, RelationshipInitialStatePreview, RuntimeNarrativeStatePersistence } from "../narrative-state/contracts";
import type { FlowTransition, StoryFlow, StoryFlowDeletionImpact, StoryFlowIntegrityReport, StoryFlowNode, StoryFlowSnapshot } from "../story-flow/contracts";
import type { ProgressionDecision, ProgressionMigrationReview } from "../story-flow/progressionMigration";
import { type NarrativeNodeData } from "../types";
import type { RuntimeEdge, RuntimeNode, RuntimeStoryFlowPersistence } from "./apiTypes";
import { runtimeEdgeToFlowEdge, runtimeNodeToFlowNode } from "./projections";
import type { RuntimeTransport } from "./transport";
export function createFlowRuntimeClient(transport: RuntimeTransport, projectRevision = 0): RuntimeStoryFlowPersistence & RuntimeNarrativeStatePersistence {
  const { deleteJson, deleteResource, getJson, sendJson } = transport;
  return {
    async listStoryFlowSnapshots(projectId: string): Promise<StoryFlowSnapshot[]> {
      const flows = await getJson<StoryFlow[]>(`/story-flows?project_id=${encodeURIComponent(projectId)}`);
      return Promise.all(flows.map((flow) => getJson<StoryFlowSnapshot>(`/story-flows/${encodeURIComponent(flow.id)}`)));
    },
    async createStoryFlow(projectId, draft): Promise<StoryFlowSnapshot> {
      const flow = await sendJson<StoryFlow>("POST", "/story-flows", {
        project_id: projectId,
        name: draft.name,
        description: draft.description,
        kind: draft.kind,
        status: "draft",
        metadata: {}
      });
      return getJson<StoryFlowSnapshot>(`/story-flows/${encodeURIComponent(flow.id)}`);
    },
    async updateStoryFlow(snapshot, draft): Promise<StoryFlowSnapshot> {
      return sendJson<StoryFlowSnapshot>("PUT", `/story-flows/${encodeURIComponent(snapshot.flow.id)}`, {
        project_id: snapshot.flow.project_id,
        name: draft.name,
        description: draft.description,
        kind: draft.kind,
        status: snapshot.flow.status,
        metadata: snapshot.flow.metadata
      });
    },
    async archiveStoryFlow(flow): Promise<StoryFlow> {
      return sendJson<StoryFlow>("POST", `/story-flows/${encodeURIComponent(flow.id)}/archive`, {
        project_id: flow.project_id
      });
    },
    async getStoryFlowDeletionImpact(flowId): Promise<StoryFlowDeletionImpact> {
      return getJson<StoryFlowDeletionImpact>(`/story-flows/${encodeURIComponent(flowId)}/impact`);
    },
    async deleteStoryFlow(flowId): Promise<void> {
      await deleteResource(`/story-flows/${encodeURIComponent(flowId)}?confirmed=true`);
    },
    /** Creates a call route without manufacturing a semantic relationship edge. */
    async createFlowInvocation(projectId, sourceFlowId, sourceNodeId, targetFlowId, draft): Promise<FlowInvocation> {
      return sendJson<FlowInvocation>("POST", "/flow-composition/invocations", {
        project_id: projectId,
        expected_revision: projectRevision,
        source_flow_id: sourceFlowId,
        source_node_id: sourceNodeId,
        target_flow_id: targetFlowId,
        label: draft.label,
        condition: draft.condition,
        priority: draft.priority,
        is_default: draft.isDefault
      });
    },
    /** Reuses a call site while preserving its identity and return bindings. */
    async updateFlowInvocation(projectId, invocationId, sourceFlowId, sourceNodeId, targetFlowId, draft): Promise<FlowInvocation> {
      return sendJson<FlowInvocation>("PUT", `/flow-composition/invocations/${encodeURIComponent(invocationId)}`, {
        project_id: projectId,
        expected_revision: projectRevision,
        source_flow_id: sourceFlowId,
        source_node_id: sourceNodeId,
        target_flow_id: targetFlowId,
        label: draft.label,
        condition: draft.condition,
        priority: draft.priority,
        is_default: draft.isDefault
      });
    },
    async createFlowExit(projectId, flowId, sourceNodeId, key, label): Promise<FlowExit> {
      return sendJson<FlowExit>("POST", "/flow-composition/exits", {
        project_id: projectId,
        expected_revision: projectRevision,
        flow_id: flowId,
        source_node_id: sourceNodeId,
        key,
        label
      });
    },
    async createFlowExitBinding(projectId, invocationId, exitId, targetNodeId): Promise<FlowExitBinding> {
      return sendJson<FlowExitBinding>("POST", "/flow-composition/bindings", {
        project_id: projectId,
        expected_revision: projectRevision,
        invocation_id: invocationId,
        exit_id: exitId,
        target_node_id: targetNodeId
      });
    },
    async updateFlowExitBinding(projectId, bindingId, invocationId, exitId, targetNodeId): Promise<FlowExitBinding> {
      return sendJson<FlowExitBinding>("PUT", `/flow-composition/bindings/${encodeURIComponent(bindingId)}`, {
        project_id: projectId,
        expected_revision: projectRevision,
        invocation_id: invocationId,
        exit_id: exitId,
        target_node_id: targetNodeId
      });
    },
    async deleteFlowInvocation(projectId, invocationId): Promise<void> {
      await deleteJson(`/flow-composition/invocations/${encodeURIComponent(invocationId)}`, {
        project_id: projectId,
        expected_revision: projectRevision,
        impact_reviewed: true
      });
    },
    async deleteFlowExit(projectId, exitId): Promise<void> {
      await deleteJson(`/flow-composition/exits/${encodeURIComponent(exitId)}`, {
        project_id: projectId,
        expected_revision: projectRevision,
        impact_reviewed: true
      });
    },
    /** Loads explicit temporal state without inferring it from semantic relationships. */
    async getNarrativeStateSnapshot(projectId: string): Promise<NarrativeStateSnapshot> {
      return getJson<NarrativeStateSnapshot>(`/narrative-state/projects/${encodeURIComponent(projectId)}`);
    },
    async createNarrativeEffect(projectId: string, effect: NarrativeEffectDefinition): Promise<NarrativeEffectDefinition> {
      return sendJson<NarrativeEffectDefinition>("POST", "/narrative-state/effects", {
        project_id: projectId,
        expected_revision: projectRevision,
        effect
      });
    },
    async updateNarrativeEffect(projectId: string, effect: NarrativeEffectDefinition): Promise<NarrativeEffectDefinition> {
      return sendJson<NarrativeEffectDefinition>("PUT", `/narrative-state/effects/${encodeURIComponent(effect.id)}`, {
        project_id: projectId,
        expected_revision: projectRevision,
        effect
      });
    },
    async getNarrativeEffectImpact(effectId: string): Promise<NarrativeStateDeletionImpact> {
      return getJson<NarrativeStateDeletionImpact>(`/narrative-state/effects/${encodeURIComponent(effectId)}/impact`);
    },
    async deleteNarrativeEffect(projectId: string, effectId: string, impactReviewed: boolean): Promise<void> {
      await deleteJson(`/narrative-state/effects/${encodeURIComponent(effectId)}`, {
        project_id: projectId,
        expected_revision: projectRevision,
        impact_reviewed: impactReviewed
      });
    },
    async createNarrativeEffectBinding(projectId: string, effectId: string, owner: NarrativeEffectOwnerRef, applicationOrder: number): Promise<NarrativeEffectBindingRecord> {
      return sendJson<NarrativeEffectBindingRecord>("POST", "/narrative-state/bindings", {
        project_id: projectId,
        expected_revision: projectRevision,
        effect_id: effectId,
        owner,
        application_order: applicationOrder
      });
    },
    async deleteNarrativeEffectBinding(projectId: string, bindingId: string): Promise<void> {
      await deleteJson(`/narrative-state/bindings/${encodeURIComponent(bindingId)}`, {
        project_id: projectId,
        expected_revision: projectRevision
      });
    },
    async reorderNarrativeEffectBindings(projectId: string, owner: NarrativeEffectOwnerRef, bindings: Array<{
      binding_id: string;
      application_order: number;
    }>): Promise<NarrativeEffectBindingRecord[]> {
      return sendJson<NarrativeEffectBindingRecord[]>("PUT", "/narrative-state/bindings/reorder", {
        project_id: projectId,
        expected_revision: projectRevision,
        owner,
        bindings
      });
    },
    async previewRelationshipInitialState(projectId: string, edgeId: string, flowId: string): Promise<RelationshipInitialStatePreview> {
      return sendJson<RelationshipInitialStatePreview>("POST", "/narrative-state/relationship-imports/preview", {
        project_id: projectId,
        edge_id: edgeId,
        flow_id: flowId
      });
    },
    async applyRelationshipInitialState(projectId: string, edgeId: string, flowId: string): Promise<RelationshipInitialStateApplyResponse> {
      return sendJson<RelationshipInitialStateApplyResponse>("POST", "/narrative-state/relationship-imports", {
        project_id: projectId,
        expected_revision: projectRevision,
        edge_id: edgeId,
        flow_id: flowId,
        impact_reviewed: true
      });
    },
    /** Consumes the runtime's all-or-nothing specialized outcome composition command. */
    async createOutcomeSideFlow(projectId, edgeId, sourceFlowId, draft) {
      const response = await sendJson<{
        edge: RuntimeEdge;
        invocation: FlowInvocation;
        source_flow: StoryFlowSnapshot;
        target_flow: StoryFlowSnapshot;
      }>("POST", "/flow-composition/outcomes/new-side-flow", {
        project_id: projectId,
        expected_revision: projectRevision,
        edge_id: edgeId,
        source_flow_id: sourceFlowId,
        name: draft.name,
        description: draft.description,
        label: draft.label,
        condition: draft.condition,
        priority: draft.priority,
        is_default: draft.isDefault
      });
      return {
        edge: runtimeEdgeToFlowEdge(response.edge),
        invocation: response.invocation,
        sourceFlow: response.source_flow,
        targetFlow: response.target_flow
      };
    },
    async bootstrapStoryFlow(projectId, draft): Promise<{
      node: Node<NarrativeNodeData>;
      snapshot: StoryFlowSnapshot;
    }> {
      const result = await sendJson<{
        node: RuntimeNode;
        placement: VisualPlacement;
        membership: StoryFlowNode;
        snapshot: StoryFlowSnapshot;
      }>("POST", "/story-flows/bootstrap", {
        project_id: projectId,
        flow_name: "Main Story",
        flow_description: "Primary playable story order.",
        node: {
          type: draft.kind,
          title: draft.title,
          summary: draft.summary,
          metadata: { created_with_empty_project_workflow: true }
        },
        position: draft.position,
        size: draft.size
      });
      const node = runtimeNodeToFlowNode(result.node);
      return {
        node: {
          ...node,
          position: result.placement.position,
          width: result.placement.size.width,
          height: result.placement.size.height,
          data: {
            ...node.data,
            placementId: result.placement.id,
            rootPlacementId: result.placement.id
          }
        },
        snapshot: result.snapshot
      };
    },
    async continueStoryFlowExisting(snapshot, sourceNodeId, targetNodeId, transition): Promise<StoryFlowSnapshot> {
      const result = await sendJson<{
        snapshot: StoryFlowSnapshot;
      }>("POST", `/story-flows/${encodeURIComponent(snapshot.flow.id)}/continue-existing`, {
        project_id: snapshot.flow.project_id,
        source_node_id: sourceNodeId,
        target_node_id: targetNodeId,
        transition
      });
      return result.snapshot;
    },
    async continueStoryFlowNew(snapshot, sourceNodeId, node, transition): Promise<{
      node: Node<NarrativeNodeData>;
      snapshot: StoryFlowSnapshot;
    }> {
      const result = await sendJson<{
        node: RuntimeNode;
        snapshot: StoryFlowSnapshot;
      }>("POST", `/story-flows/${encodeURIComponent(snapshot.flow.id)}/continue-new`, {
        project_id: snapshot.flow.project_id,
        source_node_id: sourceNodeId,
        node: { type: node.kind, title: node.title, summary: node.summary, metadata: {} },
        transition
      });
      return { node: runtimeNodeToFlowNode(result.node), snapshot: result.snapshot };
    },
    async setStoryFlowEntry(snapshot, nodeId): Promise<StoryFlowSnapshot> {
      return sendJson<StoryFlowSnapshot>("POST", `/story-flows/${encodeURIComponent(snapshot.flow.id)}/entry`, {
        project_id: snapshot.flow.project_id,
        node_id: nodeId
      });
    },
    async addStoryFlowMembership(snapshot, nodeId): Promise<StoryFlowSnapshot> {
      return sendJson<StoryFlowSnapshot>("POST", `/story-flows/${encodeURIComponent(snapshot.flow.id)}/nodes`, {
        project_id: snapshot.flow.project_id,
        node_id: nodeId,
        metadata: {}
      });
    },
    async setStoryFlowSceneBoundary(snapshot, sceneNodeId, entryNodeId, exitNodeIds): Promise<StoryFlowSnapshot> {
      return sendJson<StoryFlowSnapshot>("PUT", `/story-flows/${encodeURIComponent(snapshot.flow.id)}/scenes/${encodeURIComponent(sceneNodeId)}/boundary`, {
        project_id: snapshot.flow.project_id,
        entry_node_id: entryNodeId,
        exit_node_ids: exitNodeIds,
        metadata: {}
      });
    },
    async deleteStoryFlowSceneBoundary(snapshot, sceneNodeId): Promise<void> {
      await deleteResource(`/story-flows/${encodeURIComponent(snapshot.flow.id)}/scenes/${encodeURIComponent(sceneNodeId)}/boundary`);
    },
    async reorderStoryFlowTransitions(snapshot, sourceNodeId, transitionIds): Promise<StoryFlowSnapshot> {
      return sendJson<StoryFlowSnapshot>("PUT", `/story-flows/${encodeURIComponent(snapshot.flow.id)}/nodes/${encodeURIComponent(sourceNodeId)}/transition-order`, {
        project_id: snapshot.flow.project_id,
        source_node_id: sourceNodeId,
        transition_ids: transitionIds
      });
    },
    async updateStoryFlowTransition(snapshot, transition, endpoints): Promise<FlowTransition> {
      return sendJson<FlowTransition>("PUT", `/story-flows/${encodeURIComponent(snapshot.flow.id)}/transitions/${encodeURIComponent(transition.id)}`, {
        project_id: snapshot.flow.project_id,
        source_node_id: endpoints.sourceNodeId,
        target_node_id: endpoints.targetNodeId,
        kind: transition.kind,
        label: transition.label,
        condition: transition.condition,
        priority: transition.priority,
        is_default: transition.is_default,
        metadata: transition.metadata
      });
    },
    async deleteStoryFlowTransition(snapshot, transitionId): Promise<void> {
      await deleteResource(`/story-flows/${encodeURIComponent(snapshot.flow.id)}/transitions/${encodeURIComponent(transitionId)}`);
    },
    async getStoryFlowIntegrity(flowId): Promise<StoryFlowIntegrityReport> {
      return getJson<StoryFlowIntegrityReport>(`/story-flows/${encodeURIComponent(flowId)}/integrity`);
    },
    async reviewProgressionMigrations(projectId): Promise<ProgressionMigrationReview> {
      return getJson<ProgressionMigrationReview>(`/progression-migrations?project_id=${encodeURIComponent(projectId)}`);
    },
    async rejectProgressionMigration(projectId, fingerprint): Promise<ProgressionDecision> {
      return sendJson<ProgressionDecision>("POST", `/progression-migrations/${encodeURIComponent(fingerprint)}/reject`, { project_id: projectId });
    },
    async acceptProgressionMigration(projectId, fingerprint, flowId, draft) {
      return sendJson<{
        decision: ProgressionDecision;
        snapshot: StoryFlowSnapshot;
      }>("POST", `/progression-migrations/${encodeURIComponent(fingerprint)}/accept`, {
        project_id: projectId,
        flow_id: flowId,
        preserve_relationship: draft.preserveRelationship,
        kind: draft.kind,
        label: draft.label,
        condition: draft.condition,
        is_default: false
      });
    }
  };
}

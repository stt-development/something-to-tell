import {
type Edge
} from "@xyflow/react";
import {
tr
} from "../../localization/i18n";
import { createRuntimeApiClient } from "../../runtime/apiClient";
import {
addMembershipLocally,
continueExistingLocally,
nextTransitionPriority,
setEntryLocally
} from "../../story-flow/authoring";
import { type FlowTransitionDraft,type StoryFlowSnapshot } from "../../story-flow/contracts";
import {
acceptProgressionCandidateLocally,
projectProgressionMigrationReview,
rejectProgressionCandidateLocally,
type ProgressionCandidate,
type ProgressionDecision,
type ProgressionMigrationReview
} from "../../story-flow/progressionMigration";
import {
type ProjectWorkspacePreference
} from "../../story-flow/workspace";
import {
type NarrativeEdgeData
} from "../../types";


import type { Dispatch,SetStateAction } from "react";
import { useGraphStore } from "../../state/graphStore";
import { relationshipTypeForEdge } from "../graph/graphProjection";
import type { Dialog,OutcomeDeletionImpact,OutcomeFlowCommand } from "../workspaceShared";
import { composableFlowErrorMessage,localStoryFlowSnapshot,mergeAtomicOutcomeFlowResult } from "./storyFlowLocal";

type GraphStoreState = ReturnType<typeof useGraphStore.getState>;

export interface OutcomeControllerContext {
  activeProjectId: string;
  deleteEdge: GraphStoreState["deleteEdge"];
  edges: Edge<NarrativeEdgeData>[];
  localProgressionDecisions: ProgressionDecision[];
  outcomeFlowEdge: Edge<NarrativeEdgeData> | null;
  outcomeReturnDialog: "edit-dialogue" | "edit-quest" | null;
  progressionReview: ProgressionMigrationReview | null;
  projectStoryFlows: StoryFlowSnapshot[];
  reconcileRuntimeEdge: GraphStoreState["reconcileRuntimeEdge"];
  removePersistedEdge: GraphStoreState["removePersistedEdge"];
  replaceProjectStoryFlows: (next: StoryFlowSnapshot[]) => void;
  runtimeAuthoringAvailable: boolean;
  runtimePersistence: ReturnType<typeof createRuntimeApiClient>;
  selectItem: GraphStoreState["selectItem"];
  setDialog: Dispatch<SetStateAction<Dialog>>;
  setFlowActionError: Dispatch<SetStateAction<string | null>>;
  setLocalProgressionDecisions: Dispatch<SetStateAction<ProgressionDecision[]>>;
  setOutcomeFlowEdge: Dispatch<SetStateAction<Edge<NarrativeEdgeData> | null>>;
  setOutcomeReturnDialog: Dispatch<SetStateAction<"edit-dialogue" | "edit-quest" | null>>;
  setProgressionLoading: Dispatch<SetStateAction<boolean>>;
  setProgressionReview: Dispatch<SetStateAction<ProgressionMigrationReview | null>>;
  updateEdge: GraphStoreState["updateEdge"];
  updateWorkspacePreference: (update: Partial<ProjectWorkspacePreference>) => void;
}

/** Owns graph outcomes, side-flow integration, and progression migration decisions. */
export function createOutcomeController(context: OutcomeControllerContext) {
  const {
    activeProjectId, deleteEdge, edges, localProgressionDecisions, outcomeFlowEdge,
    outcomeReturnDialog, progressionReview, projectStoryFlows, reconcileRuntimeEdge,
    removePersistedEdge, replaceProjectStoryFlows, runtimeAuthoringAvailable,
    runtimePersistence, selectItem, setDialog, setFlowActionError,
    setLocalProgressionDecisions, setOutcomeFlowEdge, setOutcomeReturnDialog,
    setProgressionLoading, setProgressionReview, updateEdge, updateWorkspacePreference
  } = context;


  function openOutcomeFlow(edge: Edge<NarrativeEdgeData>, returnDialog: "edit-dialogue" | "edit-quest") {
    setOutcomeFlowEdge(edge);
    setOutcomeReturnDialog(returnDialog);
    setFlowActionError(null);
    setDialog("integrate-outcome");
  }



  function outcomeStoryFlowNames(edge: Edge<NarrativeEdgeData>) {
    const direct = projectStoryFlows
      .filter((snapshot) => snapshot.transitions.some((transition) => transition.metadata.semantic_edge_id === edge.id))
      .map((snapshot) => snapshot.flow.name);
    const composition = edge.data?.outcomeFlowComposition;
    const called = composition
      ? projectStoryFlows.find((snapshot) => snapshot.flow.id === composition.targetFlowId)?.flow.name
      : null;
    return [...new Set([...direct, ...(called ? [called] : [])])];
  }



  function outcomeDeletionImpact(edge: Edge<NarrativeEdgeData>): OutcomeDeletionImpact {
    const composition = edge.data?.outcomeFlowComposition;
    const directFlows = projectStoryFlows.filter((snapshot) =>
      snapshot.transitions.some((transition) => transition.metadata.semantic_edge_id === edge.id)
    );
    const caller = composition
      ? projectStoryFlows.find((snapshot) => snapshot.flow.id === composition.sourceFlowId)
      : null;
    const invocation = caller?.invocations?.find((candidate) => candidate.id === composition?.invocationId);
    const targetName = composition
      ? projectStoryFlows.find((snapshot) => snapshot.flow.id === composition.targetFlowId)?.flow.name
      : null;
    return {
      callCount: invocation ? 1 : 0,
      flowNames: [...new Set([...directFlows.map((snapshot) => snapshot.flow.name), ...(targetName ? [targetName] : [])])],
      returnCount: invocation ? (caller?.bindings ?? []).filter((binding) => binding.invocation_id === invocation.id).length : 0,
      transitionCount: directFlows.reduce((count, snapshot) => count + snapshot.transitions.filter((transition) => transition.metadata.semantic_edge_id === edge.id).length, 0)
    };
  }



  function updateOutcomeComposition(edge: Edge<NarrativeEdgeData>, composition: NarrativeEdgeData["outcomeFlowComposition"] | null) {
    updateEdge(edge.id, {
      label: String(edge.data?.label ?? edge.label ?? ""),
      outcomeFlowComposition: composition,
      relationshipType: relationshipTypeForEdge(edge),
      source: edge.source,
      sourceHandle: edge.sourceHandle,
      target: edge.target,
      targetHandle: edge.targetHandle
    });
  }



  async function removeOutcomeInvocation(edge: Edge<NarrativeEdgeData>, flows: StoryFlowSnapshot[]) {
    const composition = edge.data?.outcomeFlowComposition;
    if (!composition) return flows;
    if (runtimeAuthoringAvailable) {
      await runtimePersistence.deleteFlowInvocation(activeProjectId, composition.invocationId);
    }
    return flows.map((snapshot) => snapshot.flow.id === composition.sourceFlowId
      ? {
          ...snapshot,
          bindings: (snapshot.bindings ?? []).filter((binding) => binding.invocation_id !== composition.invocationId),
          invocations: (snapshot.invocations ?? []).filter((invocation) => invocation.id !== composition.invocationId)
        }
      : snapshot);
  }



  async function removeOutcomeTransitions(edge: Edge<NarrativeEdgeData>, flows: StoryFlowSnapshot[]) {
    const removals = flows.flatMap((snapshot) => snapshot.transitions
      .filter((transition) => transition.metadata.semantic_edge_id === edge.id)
      .map((transition) => ({ snapshot, transition })));
    if (runtimeAuthoringAvailable) {
      for (const removal of removals) {
        await runtimePersistence.deleteStoryFlowTransition(removal.snapshot, removal.transition.id);
      }
    }
    return flows.map((snapshot) => ({
      ...snapshot,
      transitions: snapshot.transitions.filter((transition) => transition.metadata.semantic_edge_id !== edge.id)
    }));
  }



  async function deleteSpecializedOutcome(edgeId: string) {
    const edge = edges.find((candidate) => candidate.id === edgeId);
    if (!edge) return;
    setFlowActionError(null);
    try {
      let flows = await removeOutcomeInvocation(edge, projectStoryFlows);
      flows = await removeOutcomeTransitions(edge, flows);
      replaceProjectStoryFlows(flows);
      deleteEdge(edge.id);
      selectItem({ type: "node", id: edge.source });
    } catch (error) {
      setFlowActionError(error instanceof Error ? error.message : tr("flow.outcomeDeleteFailed"));
    }
  }



  async function integrateOutcomeIntoFlow(command: OutcomeFlowCommand) {
    if (!outcomeFlowEdge) return;
    const edge = outcomeFlowEdge;
    let flows = projectStoryFlows;
    let sourceFlow = flows.find((candidate) => candidate.flow.id === command.sourceFlowId);
    if (!sourceFlow) return;
    const metadata = {
      semantic_edge_id: edge.id,
      ...(edge.data?.dialogueElementId
        ? { dialogue_element_id: edge.data.dialogueElementId }
        : {}),
      ...(edge.data?.questStageId ? { quest_stage_id: edge.data.questStageId } : {}),
      ...(edge.data?.questBranchId ? { quest_branch_id: edge.data.questBranchId } : {})
    };
    setFlowActionError(null);
    try {
      if (command.mode === "new" && runtimeAuthoringAvailable) {
        const composed = await runtimePersistence.createOutcomeSideFlow(
          activeProjectId,
          edge.id,
          command.sourceFlowId,
          {
            condition: command.condition,
            description: tr("flow.outcomeSideFlowDescription"),
            isDefault: command.isDefault,
            label: command.label,
            name: command.newFlowName,
            priority: command.priority
          }
        );
        reconcileRuntimeEdge(composed.edge);
        const replaced = mergeAtomicOutcomeFlowResult(
          flows,
          edge.data?.outcomeFlowComposition?.invocationId ?? null,
          composed
        );
        replaceProjectStoryFlows(replaced);
        updateWorkspacePreference({ activeFlowId: command.sourceFlowId });
        selectItem({ type: "node", id: edge.source });
        setDialog(outcomeReturnDialog);
        setOutcomeFlowEdge(null);
        return;
      }
      if (command.mode === "direct") {
        flows = await removeOutcomeInvocation(edge, flows);
        const currentSource = flows.find((candidate) => candidate.flow.id === command.sourceFlowId);
        if (!currentSource) return;
        const existing = currentSource.transitions.find((transition) => transition.metadata.semantic_edge_id === edge.id);
        const draft: FlowTransitionDraft = {
          condition: command.condition,
          is_default: existing?.is_default ?? false,
          kind: command.kind,
          label: String(edge.data?.label ?? edge.label ?? ""),
          metadata,
          priority: existing?.priority ?? nextTransitionPriority(currentSource, edge.source)
        };
        const updated = runtimeAuthoringAvailable
          ? await runtimePersistence.continueStoryFlowExisting(currentSource, edge.source, edge.target, draft)
          : continueExistingLocally(currentSource, edge.source, edge.target, draft);
        flows = flows.map((candidate) => candidate.flow.id === currentSource.flow.id ? updated : candidate);
        updateOutcomeComposition(edge, null);
      } else {
        flows = await removeOutcomeTransitions(edge, flows);
        sourceFlow = flows.find((candidate) => candidate.flow.id === command.sourceFlowId);
        if (!sourceFlow) return;
        let targetFlow = command.mode === "existing"
          ? flows.find((candidate) => candidate.flow.id === command.targetFlowId)
          : null;
        if (command.mode === "new") {
          targetFlow = runtimeAuthoringAvailable
            ? await runtimePersistence.createStoryFlow(activeProjectId, {
                description: tr("flow.outcomeSideFlowDescription"),
                kind: "side",
                name: command.newFlowName
              })
            : localStoryFlowSnapshot(activeProjectId, {
                description: tr("flow.outcomeSideFlowDescription"),
                kind: "side",
                name: command.newFlowName
              });
          // A new outcome flow starts from the existing canonical target; no
          // specialized content or canonical node is copied into the flow.
          targetFlow = runtimeAuthoringAvailable
            ? await runtimePersistence.addStoryFlowMembership(targetFlow, edge.target)
            : addMembershipLocally(targetFlow, edge.target);
          targetFlow = runtimeAuthoringAvailable
            ? await runtimePersistence.setStoryFlowEntry(targetFlow, edge.target)
            : setEntryLocally(targetFlow, edge.target);
          flows = [...flows, targetFlow];
        }
        if (!targetFlow || targetFlow.flow.id === sourceFlow.flow.id) throw new Error(tr("flow.callTargetInvalid"));
        if (!sourceFlow.nodes.some((member) => member.node_id === edge.source)) {
          sourceFlow = runtimeAuthoringAvailable
            ? await runtimePersistence.addStoryFlowMembership(sourceFlow, edge.source)
            : addMembershipLocally(sourceFlow, edge.source);
          flows = flows.map((candidate) => candidate.flow.id === sourceFlow!.flow.id ? sourceFlow! : candidate);
        }
        const association = edge.data?.outcomeFlowComposition;
        let invocation = association
          ? sourceFlow.invocations?.find((candidate) => candidate.id === association.invocationId)
          : null;
        if (invocation && (invocation.source_flow_id !== sourceFlow.flow.id || invocation.target_flow_id !== targetFlow.flow.id)) {
          flows = await removeOutcomeInvocation(edge, flows);
          sourceFlow = flows.find((candidate) => candidate.flow.id === command.sourceFlowId)!;
          invocation = null;
        }
        if (!invocation) {
          const now = new Date().toISOString();
          invocation = runtimeAuthoringAvailable
            ? await runtimePersistence.createFlowInvocation(activeProjectId, sourceFlow.flow.id, edge.source, targetFlow.flow.id, command)
            : {
                condition: command.condition,
                created_at: now,
                id: `invocation-local-${crypto.randomUUID()}`,
                invocation_version: 1 as const,
                is_default: command.isDefault,
                label: command.label,
                priority: command.priority,
                project_id: activeProjectId,
                source_flow_id: sourceFlow.flow.id,
                source_node_id: edge.source,
                target_flow_id: targetFlow.flow.id,
                updated_at: now
              };
          sourceFlow = { ...sourceFlow, invocations: [...(sourceFlow.invocations ?? []), invocation] };
          flows = flows.map((candidate) => candidate.flow.id === sourceFlow!.flow.id ? sourceFlow! : candidate);
        } else {
          const updatedInvocation = runtimeAuthoringAvailable
            ? await runtimePersistence.updateFlowInvocation(
                activeProjectId,
                invocation.id,
                sourceFlow.flow.id,
                edge.source,
                targetFlow.flow.id,
                command
              )
            : {
                ...invocation,
                condition: command.condition,
                is_default: command.isDefault,
                label: command.label,
                priority: command.priority,
                updated_at: new Date().toISOString()
              };
          invocation = updatedInvocation;
          sourceFlow = {
            ...sourceFlow,
            invocations: (sourceFlow.invocations ?? []).map((candidate) => candidate.id === updatedInvocation.id ? updatedInvocation : candidate)
          };
          flows = flows.map((candidate) => candidate.flow.id === sourceFlow!.flow.id ? sourceFlow! : candidate);
        }
        updateOutcomeComposition(edge, {
          invocationId: invocation.id,
          sourceFlowId: sourceFlow.flow.id,
          targetFlowId: targetFlow.flow.id
        });
      }
      replaceProjectStoryFlows(flows);
      updateWorkspacePreference({ activeFlowId: command.sourceFlowId });
      // Specialized editors are node-owned; edge persistence must not leave
      // their return dialog without the source node selection it requires.
      selectItem({ type: "node", id: edge.source });
      setDialog(outcomeReturnDialog);
      setOutcomeFlowEdge(null);
    } catch (error) {
      setFlowActionError(composableFlowErrorMessage(error, "Outcome integration failed"));
    }
  }



  async function openProgressionMigration() {
    setProgressionLoading(true);
    setFlowActionError(null);
    setDialog("progression-migration");
    try {
      if (runtimeAuthoringAvailable) {
        setProgressionReview(await runtimePersistence.reviewProgressionMigrations(activeProjectId));
      } else {
        let remembered = localProgressionDecisions;
        setProgressionReview(projectProgressionMigrationReview(activeProjectId, edges, projectStoryFlows, remembered));
      }
    } catch (error) {
      setFlowActionError(error instanceof Error ? error.message : "Progression review failed");
    } finally {
      setProgressionLoading(false);
    }
  }



  async function rejectProgressionMigration(candidate: ProgressionCandidate) {
    if (!progressionReview) return;
    try {
      const decision = runtimeAuthoringAvailable
        ? await runtimePersistence.rejectProgressionMigration(activeProjectId, candidate.fingerprint)
        : rejectProgressionCandidateLocally(candidate);
      if (!runtimeAuthoringAvailable) setLocalProgressionDecisions((current) => [...current, decision]);
      setProgressionReview({
        ...progressionReview,
        pending: progressionReview.pending.filter((item) => item.fingerprint !== candidate.fingerprint),
        decisions: [...progressionReview.decisions, decision]
      });
    } catch (error) {
      setFlowActionError(error instanceof Error ? error.message : "Progression rejection failed");
    }
  }



  async function acceptProgressionMigration(
    candidate: ProgressionCandidate,
    command: { condition: string; flowId: string; kind: FlowTransitionDraft["kind"]; preserveRelationship: boolean }
  ) {
    if (!progressionReview) return;
    const flow = projectStoryFlows.find((snapshot) => snapshot.flow.id === command.flowId);
    if (!flow) return;
    try {
      let snapshot: StoryFlowSnapshot;
      let decision: ProgressionDecision;
      if (runtimeAuthoringAvailable) {
        const result = await runtimePersistence.acceptProgressionMigration(
          activeProjectId,
          candidate.fingerprint,
          command.flowId,
          {
            preserveRelationship: command.preserveRelationship,
            kind: command.kind,
            label: candidate.label,
            condition: command.condition
          }
        );
        snapshot = result.snapshot;
        decision = result.decision;
      } else {
        snapshot = continueExistingLocally(flow, candidate.source_node_id, candidate.target_node_id, {
          kind: command.kind,
          label: candidate.label,
          condition: command.condition,
          priority: nextTransitionPriority(flow, candidate.source_node_id),
          is_default: false,
          metadata: {
            semantic_edge_id: candidate.edge_id,
            progression_migration_fingerprint: candidate.fingerprint,
            ...candidate.origin_metadata
          }
        });
        const transition = snapshot.transitions.find((item) => item.metadata.progression_migration_fingerprint === candidate.fingerprint)!;
        decision = acceptProgressionCandidateLocally(
          candidate,
          command.flowId,
          transition.id,
          command.preserveRelationship
        );
        setLocalProgressionDecisions((current) => [...current, decision]);
      }
      replaceProjectStoryFlows(projectStoryFlows.map((item) => item.flow.id === command.flowId ? snapshot : item));
      if (!command.preserveRelationship) {
        if (runtimeAuthoringAvailable) removePersistedEdge(candidate.edge_id);
        else deleteEdge(candidate.edge_id);
      }
      setProgressionReview({
        ...progressionReview,
        pending: progressionReview.pending.filter((item) => item.fingerprint !== candidate.fingerprint),
        decisions: [...progressionReview.decisions, decision]
      });
    } catch (error) {
      setFlowActionError(error instanceof Error ? error.message : "Progression migration failed");
    }
  }

  return { openOutcomeFlow, outcomeStoryFlowNames, outcomeDeletionImpact, updateOutcomeComposition, removeOutcomeInvocation, removeOutcomeTransitions, deleteSpecializedOutcome, integrateOutcomeIntoFlow, openProgressionMigration, rejectProgressionMigration, acceptProgressionMigration };
}

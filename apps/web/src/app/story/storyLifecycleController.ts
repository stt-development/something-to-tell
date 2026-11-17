import type { FlowExit,FlowInvocation } from "@something-to-tell/contracts/composable-story-flow";
import {
useReactFlow,
type Node
} from "@xyflow/react";
import {
tr
} from "../../localization/i18n";
import { createRuntimeApiClient } from "../../runtime/apiClient";
import {
addMembershipLocally,
continueExistingLocally,
continueNewLocally,
removeSceneBoundaryLocally,
setEntryLocally,
setSceneBoundaryLocally
} from "../../story-flow/authoring";
import { type FlowTransitionDraft,type StoryFlowBootstrapDraft,type StoryFlowDeletionImpact,type StoryFlowKind,type StoryFlowSnapshot } from "../../story-flow/contracts";
import {
emptyProjectStoryDraft,
type ProjectWorkspacePreference,
type WorkspaceMode
} from "../../story-flow/workspace";
import {
type NarrativeNodeData,
type NodeDraft
} from "../../types";


import type { Dispatch,SetStateAction } from "react";
import { useGraphStore } from "../../state/graphStore";
import type { Dialog } from "../workspaceShared";
import { localEmptyProjectBootstrap,localStoryFlowDeletionImpact,localStoryFlowSnapshot } from "./storyFlowLocal";

type GraphStoreState = ReturnType<typeof useGraphStore.getState>;

export interface StoryLifecycleControllerContext {
  activeProjectId: string;
  activeProjectName: string;
  activeStoryFlow: StoryFlowSnapshot | null;
  addNodeAt: GraphStoreState["addNodeAt"];
  applyBootstrapNode: GraphStoreState["applyBootstrapNode"];
  boundarySceneId: string | null;
  chooseStoryFlow: (flowId: string) => void;
  chooseWorkspaceMode: (mode: WorkspaceMode) => void;
  durableAuthoring: boolean;
  emptyStarterLoading: StoryFlowBootstrapDraft["kind"] | null;
  entryCandidateId: string | null;
  flowAuthoringSourceId: string | null;
  flowExitSourceId: string | null;
  flowInvocationSourceId: string | null;
  getActiveGraph: GraphStoreState["getActiveGraph"];
  nodes: Node<NarrativeNodeData>[];
  readProjectRailOpen: () => boolean;
  projectStoryFlows: StoryFlowSnapshot[];
  reconcileRuntimeNode: GraphStoreState["reconcileRuntimeNode"];
  runtimeAuthoringAvailable: boolean;
  runtimePersistence: ReturnType<typeof createRuntimeApiClient>;
  screenToFlowPosition: ReturnType<typeof useReactFlow>["screenToFlowPosition"];
  setCompletedEmptyWorkflowProjectNames: Dispatch<SetStateAction<string[]>>;
  setDialog: Dispatch<SetStateAction<Dialog>>;
  setEmptyStarterError: Dispatch<SetStateAction<string | null>>;
  setEmptyStarterLoading: Dispatch<SetStateAction<StoryFlowBootstrapDraft["kind"] | null>>;
  setEmptyWorkflowNotice: Dispatch<SetStateAction<string | null>>;
  setEmptyWorkflowProjectNames: Dispatch<SetStateAction<string[]>>;
  setFlowActionError: Dispatch<SetStateAction<string | null>>;
  setFlowAuthoringSourceId: Dispatch<SetStateAction<string | null>>;
  setFlowAuthoringTargetId: Dispatch<SetStateAction<string | null>>;
  setFlowDeleteImpact: Dispatch<SetStateAction<StoryFlowDeletionImpact | null>>;
  setFlowExitSourceId: Dispatch<SetStateAction<string | null>>;
  setFlowInvocationSourceId: Dispatch<SetStateAction<string | null>>;
  setFreshProjectId: GraphStoreState["setFreshProjectId"];
  setSelectedInvocationId: Dispatch<SetStateAction<string | null>>;
  setStoryFlowsByProject: Dispatch<SetStateAction<Record<string, StoryFlowSnapshot[]>>>;
  updateWorkspacePreference: (update: Partial<ProjectWorkspacePreference>) => void;
  visibleStoryFlows: StoryFlowSnapshot[];
}

/** Owns Story Flow lifecycle, membership, invocation, exit, and scene-boundary commands. */
export function createStoryLifecycleController(context: StoryLifecycleControllerContext) {
  const {
    activeProjectId, activeProjectName, activeStoryFlow, addNodeAt, applyBootstrapNode,
    boundarySceneId, chooseStoryFlow, chooseWorkspaceMode, durableAuthoring,
    emptyStarterLoading, entryCandidateId, flowAuthoringSourceId, flowExitSourceId,
    flowInvocationSourceId, getActiveGraph, nodes, readProjectRailOpen, projectStoryFlows,
    reconcileRuntimeNode, runtimeAuthoringAvailable, runtimePersistence,
    screenToFlowPosition, setCompletedEmptyWorkflowProjectNames, setDialog,
    setEmptyStarterError, setEmptyStarterLoading, setEmptyWorkflowNotice,
    setEmptyWorkflowProjectNames, setFlowActionError, setFlowAuthoringSourceId,
    setFlowAuthoringTargetId, setFlowDeleteImpact, setFlowExitSourceId,
    setFlowInvocationSourceId, setFreshProjectId, setSelectedInvocationId,
    setStoryFlowsByProject, updateWorkspacePreference, visibleStoryFlows
  } = context;


  function replaceProjectStoryFlows(next: StoryFlowSnapshot[]) {
    setStoryFlowsByProject((current) => ({ ...current, [activeProjectId]: next }));
  }



  async function createStoryFlow(draft: { description: string; kind: StoryFlowKind; name: string }) {
    setFlowActionError(null);
    if (visibleStoryFlows.some((snapshot) => snapshot.flow.name.trim().toLocaleLowerCase() === draft.name.trim().toLocaleLowerCase())) {
      setFlowActionError("A Story Flow with this name already exists.");
      return;
    }
    let created: StoryFlowSnapshot;
    try {
      created = runtimeAuthoringAvailable
        ? await runtimePersistence.createStoryFlow(activeProjectId, draft)
        : localStoryFlowSnapshot(activeProjectId, draft);
    } catch (error) {
      if (durableAuthoring) {
        setFlowActionError(error instanceof Error ? error.message : "Story Flow creation failed");
        return;
      }
      // Legacy fixture workspaces retain an isolated fallback for component tests.
      setFlowActionError(`${error instanceof Error ? error.message : "Runtime create failed"}. Created locally.`);
      created = localStoryFlowSnapshot(activeProjectId, draft);
    }
    replaceProjectStoryFlows([...projectStoryFlows, created]);
    // Creation is part of Graph authoring, so keep the current projection while
    // making the new flow the active transition overlay.
    updateWorkspacePreference({ activeFlowId: created.flow.id });
    setDialog(null);
  }



  async function startEmptyProjectStory(kind: StoryFlowBootstrapDraft["kind"]) {
    if (emptyStarterLoading || getActiveGraph().nodes.length > 0) return;
    const draft = emptyProjectStoryDraft(kind);
    setEmptyStarterLoading(kind);
    setEmptyStarterError(null);
    setEmptyWorkflowNotice(runtimeAuthoringAvailable ? null : "Runtime unavailable. Working locally.");
    let result: { node: Node<NarrativeNodeData>; snapshot: StoryFlowSnapshot };
    try {
      result = runtimeAuthoringAvailable
        ? await runtimePersistence.bootstrapStoryFlow(activeProjectId, draft)
        : localEmptyProjectBootstrap(activeProjectId, draft);
    } catch (error) {
      if (durableAuthoring) {
        setEmptyStarterError(error instanceof Error ? error.message : "Runtime bootstrap failed");
        setEmptyStarterLoading(null);
        return;
      }
      result = localEmptyProjectBootstrap(activeProjectId, draft);
      setEmptyWorkflowNotice(`${error instanceof Error ? error.message : "Runtime bootstrap failed"}. Working locally.`);
    }
    if (!applyBootstrapNode(result.node)) {
      setEmptyStarterError("The project changed before the starter finished. Reopen the project to reconcile runtime state.");
      setEmptyStarterLoading(null);
      return;
    }
    replaceProjectStoryFlows([result.snapshot]);
    updateWorkspacePreference({ activeFlowId: result.snapshot.flow.id, mode: "flow" });
    setEmptyWorkflowProjectNames((names) => names.filter((name) => name !== activeProjectName));
    setFreshProjectId(null);
    setCompletedEmptyWorkflowProjectNames((names) => [...new Set([...names, activeProjectName])]);
    setEmptyStarterLoading(null);
  }



  function createWorldbuildingNode(draft: NodeDraft) {
    // Convert a visible canvas anchor through the current React Flow viewport;
    // fixed flow coordinates can land beneath the project and tool rails.
    const screenAnchor = { x: readProjectRailOpen() ? 344 : 80, y: 136 };
    addNodeAt(draft, screenToFlowPosition(screenAnchor));
    setEmptyWorkflowProjectNames((names) => names.filter((name) => name !== activeProjectName));
    setFreshProjectId(null);
    setCompletedEmptyWorkflowProjectNames((names) => [...new Set([...names, activeProjectName])]);
    setEmptyStarterError(null);
    setEmptyWorkflowNotice(runtimeAuthoringAvailable ? null : "Runtime unavailable. Working locally.");
    setDialog(null);
    chooseWorkspaceMode("relationships");
  }



  async function renameStoryFlow(draft: { description: string; kind: StoryFlowKind; name: string }) {
    if (!activeStoryFlow) return;
    setFlowActionError(null);
    let updated: StoryFlowSnapshot;
    try {
      updated = runtimeAuthoringAvailable
        ? await runtimePersistence.updateStoryFlow(activeStoryFlow, draft)
        : {
            ...activeStoryFlow,
            flow: { ...activeStoryFlow.flow, ...draft, updated_at: new Date().toISOString() }
          };
    } catch (error) {
      setFlowActionError(error instanceof Error ? error.message : "Story Flow update failed");
      return;
    }
    replaceProjectStoryFlows(projectStoryFlows.map((snapshot) => snapshot.flow.id === updated.flow.id ? updated : snapshot));
    setDialog(null);
  }



  async function archiveStoryFlow(snapshot: StoryFlowSnapshot) {
    setFlowActionError(null);
    try {
      const archivedFlow = runtimeAuthoringAvailable
        ? await runtimePersistence.archiveStoryFlow(snapshot.flow)
        : { ...snapshot.flow, status: "archived" as const, updated_at: new Date().toISOString() };
      const next = projectStoryFlows.map((candidate) =>
        candidate.flow.id === snapshot.flow.id ? { ...candidate, flow: archivedFlow } : candidate
      );
      replaceProjectStoryFlows(next);
      const nextVisible = next.find((candidate) => candidate.flow.status !== "archived");
      updateWorkspacePreference({ activeFlowId: nextVisible?.flow.id ?? null });
    } catch (error) {
      setFlowActionError(error instanceof Error ? error.message : "Story Flow archive failed");
    }
  }



  async function previewStoryFlowDeletion(snapshot: StoryFlowSnapshot) {
    setFlowActionError(null);
    try {
      setFlowDeleteImpact(
        runtimeAuthoringAvailable
          ? await runtimePersistence.getStoryFlowDeletionImpact(snapshot.flow.id)
          : localStoryFlowDeletionImpact(snapshot)
      );
      chooseStoryFlow(snapshot.flow.id);
      setDialog("delete-flow");
    } catch (error) {
      setFlowActionError(error instanceof Error ? error.message : "Story Flow impact loading failed");
    }
  }



  async function confirmStoryFlowDeletion() {
    if (!activeStoryFlow) return;
    setFlowActionError(null);
    try {
      if (runtimeAuthoringAvailable) await runtimePersistence.deleteStoryFlow(activeStoryFlow.flow.id);
      const next = projectStoryFlows.filter((snapshot) => snapshot.flow.id !== activeStoryFlow.flow.id);
      replaceProjectStoryFlows(next);
      updateWorkspacePreference({
        activeFlowId: next.find((snapshot) => snapshot.flow.status !== "archived")?.flow.id ?? null
      });
      setFlowDeleteImpact(null);
      setDialog(null);
    } catch (error) {
      setFlowActionError(error instanceof Error ? error.message : "Story Flow deletion failed");
    }
  }



  function replaceActiveStoryFlow(snapshot: StoryFlowSnapshot) {
    replaceProjectStoryFlows(projectStoryFlows.map((candidate) => candidate.flow.id === snapshot.flow.id
      ? {
          ...snapshot,
          invocations: snapshot.invocations ?? candidate.invocations ?? [],
          exits: snapshot.exits ?? candidate.exits ?? [],
          bindings: snapshot.bindings ?? candidate.bindings ?? []
        }
      : candidate));
  }



  function openContinueFlow(sourceNodeId: string, targetNodeId: string | null = null) {
    if (!activeStoryFlow) return;
    setFlowActionError(null);
    setFlowAuthoringSourceId(sourceNodeId);
    setFlowAuthoringTargetId(targetNodeId);
    setDialog("continue-flow");
  }



  async function continueStoryFlow(command: {
    mode: "existing" | "new";
    targetNodeId: string;
    node: NodeDraft;
    transition: FlowTransitionDraft;
  }) {
    if (!activeStoryFlow || !flowAuthoringSourceId) return;
    setFlowActionError(null);
    const sourceNode = nodes.find((node) => (node.data.canonicalNodeId ?? node.id) === flowAuthoringSourceId);
    const position = { x: (sourceNode?.position.x ?? 120) + 320, y: sourceNode?.position.y ?? 120 };
    try {
      if (command.mode === "existing") {
        const snapshot = runtimeAuthoringAvailable
          ? await runtimePersistence.continueStoryFlowExisting(activeStoryFlow, flowAuthoringSourceId, command.targetNodeId, command.transition)
          : continueExistingLocally(activeStoryFlow, flowAuthoringSourceId, command.targetNodeId, command.transition);
        replaceActiveStoryFlow(snapshot);
      } else {
        const result = runtimeAuthoringAvailable
          ? await runtimePersistence.continueStoryFlowNew(activeStoryFlow, flowAuthoringSourceId, command.node, command.transition)
          : continueNewLocally(activeStoryFlow, flowAuthoringSourceId, command.node, command.transition, position);
        reconcileRuntimeNode({ ...result.node, position });
        replaceActiveStoryFlow(result.snapshot);
      }
      setDialog(null);
      setFlowAuthoringTargetId(null);
    } catch (error) {
      if (durableAuthoring) {
        setFlowActionError(error instanceof Error ? error.message : "Runtime continuation failed");
        return;
      }
      const result = command.mode === "existing"
        ? { snapshot: continueExistingLocally(activeStoryFlow, flowAuthoringSourceId, command.targetNodeId, command.transition), node: null }
        : continueNewLocally(activeStoryFlow, flowAuthoringSourceId, command.node, command.transition, position);
      if (result.node) reconcileRuntimeNode(result.node);
      replaceActiveStoryFlow(result.snapshot);
      setFlowActionError(`${error instanceof Error ? error.message : "Runtime continuation failed"}. Saved locally.`);
      setDialog(null);
    }
  }



  function openFlowInvocation(sourceNodeId: string) {
    if (!activeStoryFlow) return;
    setFlowActionError(null);
    setFlowInvocationSourceId(sourceNodeId);
    setSelectedInvocationId(null);
    setDialog("call-flow");
  }



  async function createFlowInvocation(command: {
    mode: "existing" | "new";
    targetFlowId: string;
    newFlowName: string;
    label: string;
    condition: string;
    priority: number;
    isDefault: boolean;
  }) {
    if (!activeStoryFlow || !flowInvocationSourceId) return;
    setFlowActionError(null);
    let targetFlow = projectStoryFlows.find((item) => item.flow.id === command.targetFlowId);
    let flows = projectStoryFlows;
    try {
      if (command.mode === "new") {
        targetFlow = runtimeAuthoringAvailable
          ? await runtimePersistence.createStoryFlow(activeProjectId, {
              name: command.newFlowName,
              description: tr("flow.createdSideFlowDescription"),
              kind: "side"
            })
          : localStoryFlowSnapshot(activeProjectId, {
              name: command.newFlowName,
              description: tr("flow.createdSideFlowDescription"),
              kind: "side"
            });
        flows = [...flows, targetFlow];
      }
      if (!targetFlow || targetFlow.flow.id === activeStoryFlow.flow.id) throw new Error(tr("flow.callTargetInvalid"));
      const now = new Date().toISOString();
      const invocation = runtimeAuthoringAvailable
        ? await runtimePersistence.createFlowInvocation(
            activeProjectId,
            activeStoryFlow.flow.id,
            flowInvocationSourceId,
            targetFlow.flow.id,
            command
          )
        : {
            invocation_version: 1 as const,
            id: `invocation-local-${crypto.randomUUID()}`,
            project_id: activeProjectId,
            source_flow_id: activeStoryFlow.flow.id,
            source_node_id: flowInvocationSourceId,
            target_flow_id: targetFlow.flow.id,
            label: command.label,
            condition: command.condition,
            priority: command.priority,
            is_default: command.isDefault,
            created_at: now,
            updated_at: now
          };
      flows = flows.map((item) => item.flow.id === activeStoryFlow.flow.id
        ? { ...item, invocations: [...(item.invocations ?? []), invocation] }
        : item);
      replaceProjectStoryFlows(flows);
      setSelectedInvocationId(invocation.id);
      setDialog("flow-call-bindings");
    } catch (error) {
      setFlowActionError(error instanceof Error ? error.message : tr("flow.callCreateFailed"));
    }
  }



  function openFlowExit(sourceNodeId: string) {
    setFlowActionError(null);
    setFlowExitSourceId(sourceNodeId);
    setDialog("flow-exit");
  }



  async function createFlowExit(key: string, label: string) {
    if (!activeStoryFlow || !flowExitSourceId) return;
    setFlowActionError(null);
    try {
      const now = new Date().toISOString();
      const flowExit = runtimeAuthoringAvailable
        ? await runtimePersistence.createFlowExit(
            activeProjectId,
            activeStoryFlow.flow.id,
            flowExitSourceId,
            key,
            label
          )
        : {
            exit_version: 1 as const,
            id: `exit-local-${crypto.randomUUID()}`,
            project_id: activeProjectId,
            flow_id: activeStoryFlow.flow.id,
            key,
            label,
            source_node_id: flowExitSourceId,
            created_at: now,
            updated_at: now
          };
      replaceActiveStoryFlow({
        ...activeStoryFlow,
        exits: [...(activeStoryFlow.exits ?? []), flowExit]
      });
      setDialog(null);
    } catch (error) {
      setFlowActionError(error instanceof Error ? error.message : tr("flow.exitCreateFailed"));
    }
  }



  async function saveFlowExitBinding(invocation: FlowInvocation, flowExit: FlowExit, targetNodeId: string) {
    if (!activeStoryFlow) return;
    const existing = (activeStoryFlow.bindings ?? []).find((item) =>
      item.invocation_id === invocation.id && item.exit_id === flowExit.id
    );
    try {
      const now = new Date().toISOString();
      const binding = runtimeAuthoringAvailable
        ? existing
          ? await runtimePersistence.updateFlowExitBinding(activeProjectId, existing.id, invocation.id, flowExit.id, targetNodeId)
          : await runtimePersistence.createFlowExitBinding(activeProjectId, invocation.id, flowExit.id, targetNodeId)
        : existing
          ? { ...existing, target_node_id: targetNodeId, updated_at: now }
          : {
              binding_version: 1 as const,
              id: `binding-local-${crypto.randomUUID()}`,
              project_id: activeProjectId,
              invocation_id: invocation.id,
              exit_id: flowExit.id,
              target_node_id: targetNodeId,
              created_at: now,
              updated_at: now
            };
      replaceActiveStoryFlow({
        ...activeStoryFlow,
        bindings: [...(activeStoryFlow.bindings ?? []).filter((item) => item.id !== binding.id), binding]
      });
    } catch (error) {
      setFlowActionError(error instanceof Error ? error.message : tr("flow.bindingSaveFailed"));
    }
  }



  async function deleteFlowInvocation(invocation: FlowInvocation) {
    if (!activeStoryFlow) return;
    try {
      if (runtimeAuthoringAvailable) await runtimePersistence.deleteFlowInvocation(activeProjectId, invocation.id);
      replaceActiveStoryFlow({
        ...activeStoryFlow,
        invocations: (activeStoryFlow.invocations ?? []).filter((item) => item.id !== invocation.id),
        bindings: (activeStoryFlow.bindings ?? []).filter((item) => item.invocation_id !== invocation.id)
      });
      setSelectedInvocationId(null);
      setDialog(null);
    } catch (error) {
      setFlowActionError(error instanceof Error ? error.message : tr("flow.callDeleteFailed"));
    }
  }



  async function confirmStoryFlowEntry() {
    if (!activeStoryFlow || !entryCandidateId) return;
    try {
      replaceActiveStoryFlow(runtimeAuthoringAvailable
        ? await runtimePersistence.setStoryFlowEntry(activeStoryFlow, entryCandidateId)
        : setEntryLocally(activeStoryFlow, entryCandidateId));
      setDialog(null);
    } catch (error) {
      setFlowActionError(error instanceof Error ? error.message : "Entry update failed");
    }
  }



  async function addNodeToActiveStoryFlow(nodeId: string): Promise<StoryFlowSnapshot | null> {
    if (!activeStoryFlow) {
      setFlowActionError("Create or select a Story Flow first.");
      return null;
    }
    if (activeStoryFlow.nodes.some((item) => item.node_id === nodeId)) return activeStoryFlow;
    try {
      const snapshot = runtimeAuthoringAvailable
        ? await runtimePersistence.addStoryFlowMembership(activeStoryFlow, nodeId)
        : addMembershipLocally(activeStoryFlow, nodeId);
      replaceActiveStoryFlow(snapshot);
      return snapshot;
    } catch (error) {
      if (durableAuthoring) {
        setFlowActionError(error instanceof Error ? error.message : "Runtime membership failed");
        return null;
      }
      const snapshot = addMembershipLocally(activeStoryFlow, nodeId);
      replaceActiveStoryFlow(snapshot);
      setFlowActionError(`${error instanceof Error ? error.message : "Runtime membership failed"}. Saved locally.`);
      return snapshot;
    }
  }



  function canonicalSceneChildren(sceneNodeId: string) {
    const childIds = nodes
      .filter((node) => node.parentId === sceneNodeId)
      .map((node) => node.data.canonicalNodeId ?? node.id);
    return [...new Set(childIds)]
      .map((nodeId) => nodes.find((node) => node.id === nodeId && !node.data.isLinkedInstance))
      .filter((node): node is Node<NarrativeNodeData> => Boolean(node));
  }



  async function saveSceneBoundary(entryNodeId: string, exitNodeIds: string[]) {
    if (!activeStoryFlow || !boundarySceneId) return;
    const childIds = canonicalSceneChildren(boundarySceneId).map((node) => node.id);
    setFlowActionError(null);
    try {
      const snapshot = runtimeAuthoringAvailable
        ? await runtimePersistence.setStoryFlowSceneBoundary(activeStoryFlow, boundarySceneId, entryNodeId, exitNodeIds)
        : setSceneBoundaryLocally(activeStoryFlow, boundarySceneId, entryNodeId, exitNodeIds, childIds);
      replaceActiveStoryFlow(snapshot);
      setDialog(null);
    } catch (error) {
      setFlowActionError(error instanceof Error ? error.message : "Scene boundary update failed");
    }
  }



  async function deleteSceneBoundary() {
    if (!activeStoryFlow || !boundarySceneId) return;
    try {
      if (runtimeAuthoringAvailable) {
        await runtimePersistence.deleteStoryFlowSceneBoundary(activeStoryFlow, boundarySceneId);
      }
      replaceActiveStoryFlow(removeSceneBoundaryLocally(activeStoryFlow, boundarySceneId));
      setDialog(null);
    } catch (error) {
      setFlowActionError(error instanceof Error ? error.message : "Scene boundary deletion failed");
    }
  }

  return { replaceProjectStoryFlows, createStoryFlow, startEmptyProjectStory, createWorldbuildingNode, renameStoryFlow, archiveStoryFlow, previewStoryFlowDeletion, confirmStoryFlowDeletion, replaceActiveStoryFlow, openContinueFlow, continueStoryFlow, openFlowInvocation, createFlowInvocation, openFlowExit, createFlowExit, saveFlowExitBinding, deleteFlowInvocation, confirmStoryFlowEntry, addNodeToActiveStoryFlow, canonicalSceneChildren, saveSceneBoundary, deleteSceneBoundary };
}

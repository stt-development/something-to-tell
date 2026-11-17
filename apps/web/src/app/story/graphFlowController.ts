import type {
CanonOwnerRef
} from "@something-to-tell/contracts/canon-check";
import {
type Edge,
type Node
} from "@xyflow/react";
import { createRuntimeApiClient } from "../../runtime/apiClient";
import { useGraphStore } from "../../state/graphStore";
import {
removeTransitionLocally,
reorderOutgoingTransitions
} from "../../story-flow/authoring";
import { type FlowTransition,type StoryFlowSnapshot } from "../../story-flow/contracts";
import {
projectGraphForWorkspace,
type ProjectWorkspacePreference,
type WorkspaceMode
} from "../../story-flow/workspace";
import {
type CanvasSelection,
type NarrativeEdgeData,
type NarrativeNodeData
} from "../../types";


import type { Dispatch,SetStateAction } from "react";
import { nodeForWorkspaceFocus } from "../graph/graphProjection";
import type { Dialog,FlowTransitionEdit,PendingGraphConnection } from "../workspaceShared";

export interface GraphFlowControllerContext {
  activeStoryFlow: StoryFlowSnapshot | null;
  addNodeToActiveStoryFlow: (nodeId: string) => Promise<StoryFlowSnapshot | null>;
  canvasEdges: Edge<NarrativeEdgeData>[];
  canvasSelection: CanvasSelection;
  chooseStoryFlow: (flowId: string) => void;
  chooseWorkspaceMode: (mode: WorkspaceMode) => void;
  deleteEdge: (edgeId: string) => void;
  deleteNode: (nodeId: string) => void;
  focusRenderedNode: (node: Node<NarrativeNodeData>, zoom?: number) => void;
  nodes: Node<NarrativeNodeData>[];
  onConnect: (connection: Parameters<ReturnType<typeof useGraphStore.getState>["onConnect"]>[0]) => void;
  openDialogueEditor: (node: Node<NarrativeNodeData>) => Promise<void>;
  openContinueFlow: (sourceNodeId: string, targetNodeId?: string | null) => void;
  openQuestEditor: (node: Node<NarrativeNodeData>) => Promise<void>;
  pendingGraphConnection: PendingGraphConnection | null;
  projectStoryFlows: StoryFlowSnapshot[];
  removeInstance: (nodeId: string) => void;
  removePersistedEdge: (edgeId: string) => void;
  replaceActiveStoryFlow: (next: StoryFlowSnapshot) => void;
  runtimeAuthoringAvailable: boolean;
  runtimePersistence: ReturnType<typeof createRuntimeApiClient>;
  selectItem: ReturnType<typeof useGraphStore.getState>["selectItem"];
  setCanonFocusedOwner: Dispatch<SetStateAction<CanonOwnerRef | null>>;
  setCanvasSelection: Dispatch<SetStateAction<CanvasSelection>>;
  setDialog: Dispatch<SetStateAction<Dialog>>;
  setFlowActionError: Dispatch<SetStateAction<string | null>>;
  setPendingGraphConnection: Dispatch<SetStateAction<PendingGraphConnection | null>>;
  updateWorkspacePreference: (update: Partial<ProjectWorkspacePreference>) => void;
  visibleStoryFlows: StoryFlowSnapshot[];
}

/** Owns canvas-to-flow connections, transition edits, deletion, and Story navigation. */
export function createGraphFlowController(context: GraphFlowControllerContext) {
  const {
    activeStoryFlow, addNodeToActiveStoryFlow, canvasEdges, canvasSelection, chooseStoryFlow, chooseWorkspaceMode,
    deleteEdge, deleteNode, focusRenderedNode, nodes, onConnect, openContinueFlow, openDialogueEditor,
    openQuestEditor, pendingGraphConnection, projectStoryFlows, removeInstance, removePersistedEdge,
    replaceActiveStoryFlow, runtimeAuthoringAvailable, runtimePersistence, selectItem,
    setCanonFocusedOwner, setCanvasSelection, setDialog, setFlowActionError,
    setPendingGraphConnection, updateWorkspacePreference, visibleStoryFlows
  } = context;


  async function beginFlowConnection(sourceNodeId: string, targetNodeId: string) {
    if (!activeStoryFlow) {
      setFlowActionError("Create or select a Story Flow before adding story transitions.");
      return;
    }
    // Story Flow owns canonical content, never a linked visual placement.
    const sourceId = nodes.find((node) => node.id === sourceNodeId)?.data.canonicalNodeId ?? sourceNodeId;
    const targetId = nodes.find((node) => node.id === targetNodeId)?.data.canonicalNodeId ?? targetNodeId;
    if (sourceId === targetId) {
      setFlowActionError("A Story Flow transition must connect two different canonical nodes.");
      return;
    }
    if (!activeStoryFlow.nodes.some((item) => item.node_id === sourceId)) {
      await addNodeToActiveStoryFlow(sourceId);
    }
    openContinueFlow(sourceId, targetId);
  }



  function chooseGraphConnection(connection: PendingGraphConnection) {
    setPendingGraphConnection(connection);
    setFlowActionError(null);
    setDialog("choose-connection");
  }



  function completeGraphConnection(intent: "relationship" | "flow") {
    if (!pendingGraphConnection) return;
    const connection = pendingGraphConnection;
    setPendingGraphConnection(null);
    setDialog(null);
    if (intent === "flow") {
      void beginFlowConnection(connection.source, connection.target);
    } else {
      onConnect(connection);
    }
  }



  async function reorderFlowTransition(transition: FlowTransition, direction: -1 | 1) {
    if (!activeStoryFlow) return;
    const siblings = activeStoryFlow.transitions
      .filter((item) => item.source_node_id === transition.source_node_id)
      .sort((left, right) => left.priority - right.priority);
    const index = siblings.findIndex((item) => item.id === transition.id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= siblings.length) return;
    [siblings[index], siblings[nextIndex]] = [siblings[nextIndex]!, siblings[index]!];
    const ids = siblings.map((item) => item.id);
    try {
      replaceActiveStoryFlow(runtimeAuthoringAvailable
        ? await runtimePersistence.reorderStoryFlowTransitions(activeStoryFlow, transition.source_node_id, ids)
        : reorderOutgoingTransitions(activeStoryFlow, transition.source_node_id, ids));
    } catch (error) {
      setFlowActionError(error instanceof Error ? error.message : "Transition reorder failed");
    }
  }



  async function removeFlowTransition(transition: FlowTransition) {
    if (!activeStoryFlow) return;
    try {
      if (runtimeAuthoringAvailable) await runtimePersistence.deleteStoryFlowTransition(activeStoryFlow, transition.id);
      replaceActiveStoryFlow(removeTransitionLocally(activeStoryFlow, transition.id));
      selectItem(null);
    } catch (error) {
      setFlowActionError(error instanceof Error ? error.message : "Transition removal failed");
    }
  }



  async function deleteCanvasSelection() {
    const selectedNodeIds = new Set(canvasSelection.nodeIds);
    const selectedEdgeIds = new Set(canvasSelection.edgeIds);
    try {
      const flowTransitions = activeStoryFlow?.transitions.filter((transition) => selectedEdgeIds.has(`story-flow:${transition.id}`)) ?? [];
      if (runtimeAuthoringAvailable) {
        for (const transition of flowTransitions) {
          await runtimePersistence.deleteStoryFlowTransition(activeStoryFlow!, transition.id);
        }
      }
      if (activeStoryFlow && flowTransitions.length) {
        const removedIds = new Set(flowTransitions.map((transition) => transition.id));
        replaceActiveStoryFlow({
          ...activeStoryFlow,
          transitions: activeStoryFlow.transitions.filter((transition) => !removedIds.has(transition.id))
        });
      }
      for (const edgeId of selectedEdgeIds) {
        if (!edgeId.startsWith("story-flow:")) deleteEdge(edgeId);
      }
      const selectedNodes = nodes.filter((node) => selectedNodeIds.has(node.id));
      for (const node of selectedNodes.filter((candidate) => candidate.data.isLinkedInstance)) removeInstance(node.id);
      for (const node of selectedNodes.filter((candidate) => !candidate.data.isLinkedInstance)) deleteNode(node.id);
      setCanvasSelection({ edgeIds: [], nodeIds: [] });
      selectItem(null);
      setDialog(null);
    } catch (error) {
      setFlowActionError(error instanceof Error ? error.message : "Selection deletion failed");
    }
  }



  async function reconnectFlowTransition(transition: FlowTransition, sourceNodeId: string, targetNodeId: string) {
    if (!activeStoryFlow || sourceNodeId === targetNodeId) return;
    try {
      const updated = runtimeAuthoringAvailable
        ? await runtimePersistence.updateStoryFlowTransition(activeStoryFlow, transition, { sourceNodeId, targetNodeId })
        : { ...transition, source_node_id: sourceNodeId, target_node_id: targetNodeId, updated_at: new Date().toISOString() };
      replaceActiveStoryFlow({
        ...activeStoryFlow,
        transitions: activeStoryFlow.transitions.map((item) => item.id === transition.id ? updated : item)
      });
    } catch (error) {
      setFlowActionError(error instanceof Error ? error.message : "Transition reconnect failed");
    }
  }



  async function updateStoryTransition(transition: FlowTransition, updates: Partial<FlowTransitionEdit>) {
    if (!activeStoryFlow) return false;
    const next = { ...transition, ...updates, updated_at: new Date().toISOString() };
    try {
      const saved = runtimeAuthoringAvailable
        ? await runtimePersistence.updateStoryFlowTransition(activeStoryFlow, next, {
            sourceNodeId: next.source_node_id,
            targetNodeId: next.target_node_id
          })
        : next;
      replaceActiveStoryFlow({
        ...activeStoryFlow,
        transitions: activeStoryFlow.transitions.map((item) => item.id === transition.id ? saved : item)
      });
      return true;
    } catch (error) {
      setFlowActionError(error instanceof Error ? error.message : "Transition update failed");
      return false;
    }
  }



  function editStoryNode(node: Node<NarrativeNodeData>) {
    if (node.data.kind === "Dialogue") {
      setCanonFocusedOwner(null);
      void openDialogueEditor(node);
    } else if (node.data.kind === "Quest") {
      void openQuestEditor(node);
    } else {
      selectItem({ type: "node", id: node.id });
      setDialog("edit-node");
    }
  }



  function openStoryNodeInWorkspace(node: Node<NarrativeNodeData>, mode: "flow" | "relationships") {
    updateWorkspacePreference({ mode, activeFlowId: activeStoryFlow?.flow.id ?? null });
    selectItem({ type: "node", id: node.id });
    const projection = projectGraphForWorkspace(nodes, canvasEdges, mode, activeStoryFlow, projectStoryFlows);
    const rendered = nodeForWorkspaceFocus(node, projection.nodes, mode);
    window.setTimeout(() => focusRenderedNode(rendered), 100);
  }



  /** Opens a composed Story source in its owning Flow instead of the root projection. */
  function openComposedStorySource(flowId: string, nodeId?: string) {
    const targetFlow = visibleStoryFlows.find((snapshot) => snapshot.flow.id === flowId);
    updateWorkspacePreference({ mode: "flow", activeFlowId: flowId });
    if (!targetFlow || !nodeId) {
      selectItem(null);
      return;
    }
    const node = nodes.find((candidate) => (candidate.data.canonicalNodeId ?? candidate.id) === nodeId && candidate.id === nodeId);
    if (!node) return;
    selectItem({ type: "node", id: node.id });
    const projection = projectGraphForWorkspace(nodes, canvasEdges, "flow", targetFlow, visibleStoryFlows);
    window.setTimeout(() => focusRenderedNode(nodeForWorkspaceFocus(node, projection.nodes, "flow")), 100);
  }

  return { beginFlowConnection, chooseGraphConnection, completeGraphConnection, reorderFlowTransition, removeFlowTransition, deleteCanvasSelection, reconnectFlowTransition, updateStoryTransition, editStoryNode, openStoryNodeInWorkspace, openComposedStorySource };
}

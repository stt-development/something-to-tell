import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useGraphStore } from "../../state/graphStore";

/** Workspace consumption only; Zustand remains the sole graph mirror. */
export function selectWorkspaceStore(state: ReturnType<typeof useGraphStore.getState>) {
  return {
    // An imperative getActiveGraph call does not establish a React subscription.
    activeGraph: state.graphs[state.activeProjectId],
    activeProjectId: state.activeProjectId,
    activeSessionId: state.activeSessionId,
    activeProjectManifest: state.activeProjectManifest,
    freshProjectId: state.freshProjectId,
    attachProjectSession: state.attachProjectSession,
    applyBootstrapNode: state.applyBootstrapNode,
    reconcileRuntimeNode: state.reconcileRuntimeNode,
    addEdgeBetweenNodes: state.addEdgeBetweenNodes,
    addFactionMember: state.addFactionMember,
    addFrameAt: state.addFrameAt,
    addLinkedInstance: state.addLinkedInstance,
    addNodeAt: state.addNodeAt,
    completeNodeDrop: state.completeNodeDrop,
    completeGroupMove: state.completeGroupMove,
    completeNodeResize: state.completeNodeResize,
    closeActiveProject: state.closeActiveProject,
    createDialogueTransition: state.createDialogueTransition,
    createQuestTransition: state.createQuestTransition,
    getActiveGraph: state.getActiveGraph,
    fitFrame: state.fitFrame,
    loadRuntimeSnapshot: state.loadRuntimeSnapshot,
    onConnect: state.onConnect,
    onEdgesChange: state.onEdgesChange,
    onNodesChange: state.onNodesChange,
    playbackEffectsByFlow: state.playbackEffectsByFlow,
    projects: state.projects,
    deleteEdge: state.deleteEdge,
    deleteNode: state.deleteNode,
    reconnectEdge: state.reconnectEdge,
    removeInstance: state.removeInstance,
    removeFactionMember: state.removeFactionMember,
    removePersistedEdge: state.removePersistedEdge,
    runtimeError: state.runtimeError,
    runtimeStatus: state.runtimeStatus,
    selection: state.selection,
    selectItem: state.selectItem,
    markProjectSessionDirty: state.markProjectSessionDirty,
    reconcileRuntimeEdge: state.reconcileRuntimeEdge,
    setProjectSessionState: state.setProjectSessionState,
    setFreshProjectId: state.setFreshProjectId,
    setRuntimePersistence: state.setRuntimePersistence,
    storyFlowsByProject: state.storyFlowsByProject,
    toggleFrameCollapse: state.toggleFrameCollapse,
    updateEdge: state.updateEdge,
    updateDialogueDocument: state.updateDialogueDocument,
    updateQuestDocument: state.updateQuestDocument,
    updateNode: state.updateNode
  };
}

/** Ignore transport publication and other projects' graph dictionary entries. */
export function useWorkspaceStore() {
  const workspace = useGraphStore(useShallow(selectWorkspaceStore));
  const session = useGraphStore(useShallow(selectWorkspaceSession));
  return useMemo(() => ({ ...workspace, activeProjectSession: session }), [workspace, session]);
}
/** Status and error subscribers are local; concurrency/connection metadata stays live. */
export function selectWorkspaceSession(state: ReturnType<typeof useGraphStore.getState>) {
  if (!state.activeProjectSession) return null;
  const { save_error: _saveError, save_status: _saveStatus, ...session } = state.activeProjectSession;
  return session;
}

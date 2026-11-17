import type {
CanonIssueProjection,
CanonOwnerRef
} from "@something-to-tell/contracts/canon-check";
import type { NarrativeEffectOwnerRef } from "@something-to-tell/contracts/narrative-state";
import {
type ProjectSettings
} from "@something-to-tell/contracts/project-manifest";
import type {
ProjectSessionSaveAsResponse
} from "@something-to-tell/contracts/project-session";
import {
MarkerType,
ReactFlowProvider,
useReactFlow,
type Node,
type XYPosition
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback,useEffect,useMemo,useRef } from "react";
import { useTranslation } from "react-i18next";
import { type CanonDiagnosticFocus } from "./canon/CanonDiagnosticMarker";
import { CanonIssueActionProvider } from "./canon/CanonIssueActions";
import { canonTemporalOwner,highlightCanonTargets,resolveCanonOwner,type CanonAuthoringSurface } from "./canon/navigation";
import { ViewportTooltip } from "./components/ViewportTooltip";
import { absoluteNodePosition } from "./composition/layout";
import { createEmptyDialogueDocument } from "./dialogue/contracts";
import { projectImpactExperiences } from "./impact/consequences";
import { projectImpactHighlights } from "./impact/navigation";
import {
applyProjectLocale,
i18next,
localizeRuntimeError,
tr
} from "./localization/i18n";
import { NarrativeEffectEditor } from "./narrative-state/EffectEditor";
import { narrativeOwnerKey } from "./narrative-state/editor";
import { projectTemporalGraphOverlay,temporalOwnerForGraphSelection } from "./narrative-state/graphOverlay";
import { projectTemporalState,temporalEffectsForOwner } from "./narrative-state/projection";
import {
PlaybackWorkspace
} from "./playback/PlaybackWorkspace";
import { createQuestDocument } from "./quest/contracts";
import { createRuntimeApiClient,projectSessionToGraphSnapshot,RuntimeApiError } from "./runtime/apiClient";
import type { RuntimeStyleRewriteApprovalResponse } from "./runtime/apiTypes";
import { useGraphStore } from "./state/graphStore";
import { projectStoryDocument } from "./story-flow/storyDocument";
import {
analyzeStoryFlow,
defaultWorkspacePreference,
localStoryFlowIntegrity,
projectGraphForWorkspace,
type ProjectWorkspacePreference,
type WorkspaceMode
} from "./story-flow/workspace";
import {
createCanvasSelection,
type Selection as GraphSelection,
type NarrativeNodeData
} from "./types";

import { analysisErrorMessage,applyLocalAnalysisOperation,buildAnalysisPreviewMaps,buildLocalSceneAnalysisPreview,nextAnalysisNodePosition,operationDecisionsFromMetadata,operationFingerprint } from "./app/analysis/sceneAnalysis";
import { applyAnalysisHighlights,applyIssueOverlays,applySelectionHighlights,buildRelationshipInspection,canvasEdgeType,factionMembers,filterGraphForView,filterIssuesForView,getNodeNeighborhood,graphCenter,hideDirectFrameChildEdges,hideSemanticEdges,issuePreviewForNode,issuesForEdge,issuesForNode,nodeForWorkspaceFocus,projectFrameWorkspace } from "./app/graph/graphProjection";
import { DEFAULT_WORKSPACE,NarrativeNodeRenderData,OperationDecision,PendingProjectAction,ProjectCreationRequest,ToolMode,WORKSPACE_PREFERENCES_KEY,impactFindingPreview,impactSeedKeys,isEditableHistoryTarget } from "./app/workspaceShared";
export { analysisBlocksAutosave,buildAnalysisPreviewMaps,buildGraphAnalysisText,buildLocalSceneAnalysisPreview,createLinkedInstanceFromDrop } from "./app/analysis/sceneAnalysis";
export { DialogueEditorDialog } from "./app/dialogue/DialogueEditorDialog";
export { EditEdgeDialog } from "./app/editors/EditNodeDialog";
export { FrameDescriptionControl } from "./app/graph/GraphNodeContent";
export { applyIssueOverlays,applySelectionHighlights,buildRelationshipInspection,canvasEdgeType,factionMembers,filterGraphForView,filterIssuesForView,getNodeNeighborhood,hideDirectFrameChildEdges,hideSemanticEdges,nodeForWorkspaceFocus,nodePresentationMetrics,projectFrameWorkspace } from "./app/graph/graphProjection";
export { CurrentProjectPanel,projectTreeEntries } from "./app/project/ProjectPanels";
export { ProjectStartScreen } from "./app/project/ProjectStartScreen";
export { ConnectionTypeDialog,FlowCallBindingsDialog,OutcomeFlowDialog,ProgressionMigrationDialog,SceneFlowBoundaryDialog } from "./app/story/StoryFlowDialogs";
export { composableFlowErrorMessage,mergeAtomicOutcomeFlowResult } from "./app/story/storyFlowLocal";
export { calculateFrameBounds,displayNodeKind,impactCallerBlockAfterClose,isEditableHistoryTarget,projectHistoryTooltip,withoutDoubleAppliedDescendantMoves } from "./app/workspaceShared";

import { useWorkspaceState } from "./app/shell/useWorkspaceState";
import { useCanvasFitView } from "./app/graph/CanvasFitControls";
import { NODE_DOM_VIRTUALIZATION_ENABLED } from "./app/graph/canvasDomExperiment";
import { INITIAL_CANVAS_FIT_OPTIONS } from "./app/graph/canvasFitPadding";
import { closeAcquiredSession, enterProjectSession } from "./app/project/projectSessionEntry";
import { ProjectEntryReleaseProvider, useProjectEntryReleaseReporter } from "./app/project/ProjectEntryReleaseNotice";
import { useFrameDrawPointerHandlers } from "./app/shell/useFrameDrawPointerHandlers";
import { useFrameDrawCompletion } from "./app/shell/useFrameDrawCompletion";
import { useNodeResizeActions } from "./app/shell/useNodeResizeActions";
import { useFramePlacementActions } from "./app/shell/useFramePlacementActions";
import { useFlowMembershipActions } from "./app/shell/useFlowMembershipActions";
import { useFlowCallOpenActions } from "./app/shell/useFlowCallOpenActions";
import { useFlowCallLists } from "./app/shell/useFlowCallLists";
import { useFlowExitLists } from "./app/shell/useFlowExitLists";
import { useNodeDataAssembly } from "./app/shell/useNodeDataAssembly";
import { useNodeWrapperAssembly } from "./app/shell/useNodeWrapperAssembly";
import { useQuestCanvasMetrics } from "./app/shell/useQuestCanvasMetrics";
import { useDialogueCanvasMetrics } from "./app/shell/useDialogueCanvasMetrics";
import { useFrameContentCounts } from "./app/shell/useFrameContentCounts";
import { useNodePresentationMetrics } from "./app/shell/useNodePresentationMetrics";
import { useFactionMemberTitles } from "./app/shell/useFactionMemberTitles";
import { useOutcomeTargetTitles } from "./app/shell/useOutcomeTargetTitles";
import { useSceneBoundarySummaries } from "./app/shell/useSceneBoundarySummaries";
import { useWorkspaceStore } from "./app/shell/workspaceStore";
import type { SavedConfirmationHandle } from "./app/shell/SaveStatusIndicator";
import { ProjectSessionLifecycle } from "./app/shell/ProjectSessionLifecycle";
import { useProjectSave } from "./app/shell/useProjectSave";
import { registerNativeCloseHandler, resolveNativeClose } from "./runtime/nativeClose";
import { GraphFilterVisibilityProvider } from "./app/shell/GraphFilterVisibility";
import { FlowSummaryVisibilityProvider } from "./app/shell/FlowSummaryVisibility";
import { CanvasContextMenuProvider, useCanvasContextMenuDispatch } from "./app/shell/CanvasContextMenu";
import { ProjectRailLayoutProvider, useProjectRailVisibilityReader } from "./app/shell/ProjectRailLayout";
import { WorkspaceDialogProvider, useWorkspaceDialogCommands } from "./app/shell/WorkspaceDialog";
import { RemoteRecoveryProvider } from "./app/project/RemoteRecoveryProvider";
import { useRemoteRecovery, RemoteRecoveryLauncher } from "./app/project/RemoteRecoveryContext";

import { ProjectStartScreen,configureNewProjectStorage,configureNewProjectStyle } from "./app/project/ProjectStartScreen";
import { projectFolder } from "./app/workspaceShared";

import { createPlaybackController } from "./app/playback/playbackController";

import { createStoryLifecycleController } from "./app/story/storyLifecycleController";

import { createOutcomeController } from "./app/story/outcomeController";

import { AppWorkspaceView } from "./app/shell/AppWorkspaceView";

import { createGraphFlowController } from "./app/story/graphFlowController";

import { createAnalysisProviderController } from "./app/analysis/analysisProviderController";

import { createImpactNavigationController } from "./app/impact/impactNavigationController";

interface AppProps {
  /** Keeps the dormant Scene Text Import workflow covered without exposing it in production. */
  sceneTextImportEnabled?: boolean;
}

export function App({ sceneTextImportEnabled = false }: AppProps) {
  const activeProjectId = useGraphStore((state) => state.activeProjectId);
  const projectLocale = useGraphStore((state) => state.activeProjectManifest?.settings.ui_locale ?? null);
  useTranslation();

  useEffect(() => {
    void applyProjectLocale(projectLocale);
  }, [projectLocale]);

  return (
    <ReactFlowProvider>
      <ProjectEntryReleaseProvider>
        {activeProjectId ? (
          <GraphFilterVisibilityProvider>
            <FlowSummaryVisibilityProvider>
              <CanvasContextMenuProvider><ProjectRailLayoutProvider>
                <WorkspaceDialogProvider><RemoteRecoveryProvider><AppWorkspace sceneTextImportEnabled={sceneTextImportEnabled} /></RemoteRecoveryProvider></WorkspaceDialogProvider>
              </ProjectRailLayoutProvider></CanvasContextMenuProvider>
            </FlowSummaryVisibilityProvider>
          </GraphFilterVisibilityProvider>
        ) : <ProjectStartScreen />}
        <ViewportTooltip />
      </ProjectEntryReleaseProvider>
    </ReactFlowProvider>
  );
}

function AppWorkspace({ sceneTextImportEnabled }: { sceneTextImportEnabled: boolean }) {
  const { monitor: remoteRecovery } = useRemoteRecovery();
  const reportEntryReleaseFailure = useProjectEntryReleaseReporter();
  const setContextMenu = useCanvasContextMenuDispatch();
  const readProjectRailOpen = useProjectRailVisibilityReader();
  const { setDialog, readDialog } = useWorkspaceDialogCommands();
  const savedConfirmationRef = useRef<SavedConfirmationHandle | null>(null);
  const {
    activeGraph,
    activeProjectId,
    activeSessionId,
    activeProjectSession,
    activeProjectManifest,
    freshProjectId,
    attachProjectSession,
    applyBootstrapNode,
    reconcileRuntimeNode,
    addEdgeBetweenNodes,
    addFactionMember,
    addFrameAt,
    addLinkedInstance,
    addNodeAt,
    completeNodeDrop,
    completeGroupMove,
    completeNodeResize,
    closeActiveProject,
    createDialogueTransition,
    createQuestTransition,
    getActiveGraph,
    fitFrame,
    loadRuntimeSnapshot,
    onConnect,
    onEdgesChange,
    onNodesChange,
    playbackEffectsByFlow,
    projects,
    deleteEdge,
    deleteNode,
    reconnectEdge,
    removeInstance,
    removeFactionMember,
    removePersistedEdge,
    runtimeError,
    runtimeStatus,
    selection,
    selectItem,
    markProjectSessionDirty,
    reconcileRuntimeEdge,
    setProjectSessionState,
    setFreshProjectId,
    setRuntimePersistence,
    storyFlowsByProject: initialStoryFlowsByProject,
    toggleFrameCollapse,
    updateEdge,
    updateDialogueDocument,
    updateQuestDocument,
    updateNode
  } = useWorkspaceStore();
  const { narrativeStateSnapshot, setNarrativeStateSnapshot, selectedTemporalOwner, setSelectedTemporalOwner, pendingProjectAction, setPendingProjectAction, graphFilter, setGraphFilter, canvasSelection, setCanvasSelection, sceneAnalysisOpen, setSceneAnalysisOpen, lastAnalysisTool, setLastAnalysisTool, canonOpen, setCanonOpen, canonRun, setCanonRun, canonIssues, setCanonIssues, selectedCanonIssueId, setSelectedCanonIssueId, canonFocusedOwner, setCanonFocusedOwner, canonSuggestion, setCanonSuggestion, canonMode, setCanonMode, canonOperation, setCanonOperation, canonError, setCanonError, canonNotice, setCanonNotice, selectCanonIssue, impactOpen, setImpactOpen, impactSeeds, setImpactSeeds, impactRun, setImpactRun, impactOperation, setImpactOperation, impactError, setImpactError, impactResolutionRun, setImpactResolutionRun, impactResolutionOperation, setImpactResolutionOperation, impactResolutionError, setImpactResolutionError, impactResolutionVerificationPending, setImpactResolutionVerificationPending, impactCaller, setImpactCaller, impactBlockedCallerKey, setImpactBlockedCallerKey, sceneAnalysisResult, setSceneAnalysisResult, sceneAnalysisError, setSceneAnalysisError, sceneAnalysisLoading, setSceneAnalysisLoading, sceneDecisionLoading, setSceneDecisionLoading, sceneOperationDecisions, setSceneOperationDecisions, localReviewedOperations, setLocalReviewedOperations, selectedAnalysisOperation, setSelectedAnalysisOperation, toolMode, setToolMode, frameDraw, setFrameDraw, frameDrawRef, suppressPaneClickRef, spacePanActiveRef, alternatePanGestureRef, dragStartNodesRef, groupDragActiveRef, groupDragSelectionRef, workspaceFitTimeoutRef, undoButtonRef, redoButtonRef, analysisHeaderButtonRef, impactOriginRef, projectHistory, setProjectHistory, historyRefreshRevision, setHistoryRefreshRevision, historyBusy, setHistoryBusy, historyError, setHistoryError, compositionDrop, setCompositionDrop, compositionDropRef, compositionNotice, setCompositionNotice, frameAddMenuId, setFrameAddMenuId, focusedFrameId, setFocusedFrameId, connectionSourceId, setConnectionSourceId, connectionTargetId, setConnectionTargetId, pendingGraphConnection, setPendingGraphConnection, dialogueDraft, setDialogueDraft, dialogueLoadError, setDialogueLoadError, dialogueLoading, setDialogueLoading, questDraft, setQuestDraft, questLoadError, setQuestLoadError, questLoading, setQuestLoading, storyFlowsByProject, setStoryFlowsByProject, workspacePreferences, setWorkspacePreferences, flowDeleteImpact, setFlowDeleteImpact, flowIntegrityReport, setFlowIntegrityReport, flowActionError, setFlowActionError, flowAuthoringSourceId, flowAuthoringTargetId, setFlowAuthoringSourceId, setFlowAuthoringTargetId, flowInvocationSourceId, setFlowInvocationSourceId, flowExitSourceId, setFlowExitSourceId, selectedInvocationId, setSelectedInvocationId, entryCandidateId, setEntryCandidateId, boundarySceneId, setBoundarySceneId, outcomeFlowEdge, setOutcomeFlowEdge, outcomeReturnDialog, setOutcomeReturnDialog, progressionReview, setProgressionReview, localProgressionDecisions, setLocalProgressionDecisions, progressionLoading, setProgressionLoading, emptyWorkflowProjectNames, setEmptyWorkflowProjectNames, completedEmptyWorkflowProjectNames, setCompletedEmptyWorkflowProjectNames, emptyStarterLoading, setEmptyStarterLoading, emptyStarterError, setEmptyStarterError, emptyWorkflowNotice, setEmptyWorkflowNotice, playbackOpen, setPlaybackOpen, playbackSession, setPlaybackSession, playbackLoading, setPlaybackLoading, playbackBusy, setPlaybackBusy, playbackError, setPlaybackError, playbackPreparationFacts, setPlaybackPreparationFacts, playbackAnnouncement, setPlaybackAnnouncement, playbackSubmittingRef, playbackOriginModeRef, playbackPlayButtonRef } = useWorkspaceState({ activeProjectId, initialAnalysisTool: sceneTextImportEnabled ? "scene" : "canon", initialStoryFlowsByProject });
  const { getIntersectingNodes, screenToFlowPosition, setCenter } = useReactFlow();
  const noteAuthoringMutation = useCallback(() => {
    markProjectSessionDirty();
    setHistoryRefreshRevision((revision) => revision + 1);
    // A completed result describes the prior working checksum and must not be
    // presented as current after any authoring command.
    setImpactRun((current) => current?.status === "completed" ? { ...current, status: "stale" } : current);
  }, [markProjectSessionDirty]);
  const handleRecoveredProjectSession = useCallback((
    response: Parameters<typeof projectSessionToGraphSnapshot>[0]
  ) => {
    // Preserve the optimistic authoring state while replacing the session id;
    // the interrupted mutation is retried immediately after this callback.
    setProjectSessionState(response.session);
    setHistoryRefreshRevision((revision) => revision + 1);
  }, [setProjectSessionState]);
  const runtimePersistence = useMemo(
    () => createRuntimeApiClient({
      projectSessionId: activeSessionId,
      remoteStorage: activeProjectSession?.remote_storage,
      projectPath: activeProjectSession?.project_path,
      projectRevision: activeProjectSession?.saved_revision ?? 0,
      onMutation: () => { if (!remoteRecovery || remoteRecovery.current()) noteAuthoringMutation(); },
      onRemoteStorageObserved: remoteRecovery?.observe,
      onSessionRecovered: handleRecoveredProjectSession
    }),
    [activeProjectSession?.project_path, activeProjectSession?.saved_revision, activeSessionId, handleRecoveredProjectSession, noteAuthoringMutation, remoteRecovery]
  );
  const canonPersistenceRef = useRef(runtimePersistence);
  const saveProject = useProjectSave(activeSessionId, runtimePersistence, () => savedConfirmationRef.current?.show());
  useEffect(() => {
    // Session metadata can recreate the general client without resetting the
    // current Canon run or its review projection.
    canonPersistenceRef.current = runtimePersistence;
  }, [runtimePersistence]);
  const { nodes, edges, issues } = activeGraph ?? getActiveGraph();
  const selectedCanonIssue = canonIssues?.issues?.find((issue) => issue.id === selectedCanonIssueId) ?? null;
  const canonDiagnosticFocus: CanonDiagnosticFocus | null = selectedCanonIssue && canonFocusedOwner
    ? { issue: selectedCanonIssue, owner: canonFocusedOwner }
    : null;
  const focusedTemporalOwner = canonFocusedOwner && ["effect", "effect_binding"].includes(canonFocusedOwner.owner_type)
    ? canonTemporalOwner(canonFocusedOwner, nodes, narrativeStateSnapshot)
    : null;
  /** Keeps every domain editor on the same runtime-owned temporal state boundary. */
  const renderNarrativeEffects = (owner: NarrativeEffectOwnerRef) => (
    <NarrativeEffectEditor
      canonFocus={focusedTemporalOwner && narrativeOwnerKey(focusedTemporalOwner) === narrativeOwnerKey(owner) ? canonDiagnosticFocus : null}
      nodes={nodes}
      onSnapshot={setNarrativeStateSnapshot}
      owner={owner}
      persistence={runtimePersistence}
      projectId={activeProjectId}
    />
  );
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? projects[0];
  const activeProjectName = activeProject?.name ?? "";
  const durableAuthoring = Boolean(activeSessionId);
  const runtimeAuthoringAvailable = durableAuthoring || runtimeStatus === "ready";
  const projectStoryFlows = storyFlowsByProject[activeProjectId] ?? [];
  const visibleStoryFlows = projectStoryFlows.filter((snapshot) => snapshot.flow.status !== "archived");
  const storedWorkspacePreference = workspacePreferences[activeProjectId] ?? defaultWorkspacePreference(visibleStoryFlows);
  const activeStoryFlow =
    visibleStoryFlows.find((snapshot) => snapshot.flow.id === storedWorkspacePreference.activeFlowId)
    ?? visibleStoryFlows[0]
    ?? null;
  const workspaceMode = storedWorkspacePreference.mode;
  const fitViewCanvas = useCanvasFitView(NODE_DOM_VIRTUALIZATION_ENABLED && workspaceMode === "relationships");
  useEffect(() => setSelectedTemporalOwner(null), [activeProjectId, workspaceMode]);
  useEffect(() => {
    if (!activeSessionId) {
      setProjectHistory(null);
      setHistoryError(null);
      return;
    }
    let current = true;
    void runtimePersistence.inspectProjectHistory(activeSessionId)
      .then((summary) => {
        if (current) {
          setProjectHistory(summary);
          setHistoryError(null);
        }
      })
      .catch((error) => {
        if (current) setHistoryError(localizeRuntimeError(error));
      });
    return () => { current = false; };
  }, [activeSessionId, historyRefreshRevision, runtimePersistence]);
  useEffect(() => {
    setCanonRun(null);
    setCanonIssues(null);
    setSelectedCanonIssueId(null);
    setCanonFocusedOwner(null);
    setCanonSuggestion(null);
    setCanonError(null);
    setCanonNotice(null);
    if (!activeSessionId || !activeProjectId) return;
    let current = true;
    setCanonOperation("loading");
    void canonPersistenceRef.current.listCanonIssues(activeProjectId)
      .then((response) => { if (current) setCanonIssues(response); })
      .catch((error) => { if (current) setCanonError(localizeRuntimeError(error)); })
      .finally(() => { if (current) setCanonOperation(null); });
    return () => { current = false; };
  }, [activeProjectId, activeSessionId]);
  useEffect(() => {
    // Process-local runs never cross project-session identity boundaries.
    setImpactOpen(false);
    setImpactSeeds([]);
    setImpactRun(null);
    setImpactOperation(null);
    setImpactError(null);
    setImpactResolutionRun(null);
    setImpactResolutionOperation(null);
    setImpactResolutionError(null);
    setImpactResolutionVerificationPending(false);
  }, [activeProjectId, activeSessionId]);
  useEffect(() => {
    if (!canonRun || !["queued", "running", "reconciling"].includes(canonRun.status)) return;
    const timer = window.setTimeout(() => {
      void runtimePersistence.inspectCanonRun(canonRun.id)
        .then(async (next) => {
          setCanonRun(next);
          if (next.status === "completed" && activeSessionId) {
            await loadRuntimeSnapshot(() => runtimePersistence.loadProjectSessionSnapshot(activeSessionId));
            const [issuesProjection, history] = await Promise.all([
              runtimePersistence.listCanonIssues(activeProjectId),
              runtimePersistence.inspectProjectHistory(activeSessionId)
            ]);
            setCanonIssues(issuesProjection);
            setProjectHistory(history);
          }
        })
        .catch((error) => setCanonError(localizeRuntimeError(error)));
    }, 600);
    return () => window.clearTimeout(timer);
  }, [activeProjectId, activeSessionId, canonRun, loadRuntimeSnapshot, runtimePersistence]);
  useEffect(() => {
    if (!activeSessionId || !impactRun || !["queued", "running"].includes(impactRun.status)) return;
    const timer = window.setTimeout(() => {
      void runtimePersistence.inspectImpactRun(activeSessionId, impactRun.id)
        .then((response) => {
          setImpactRun(response.run);
          setImpactError(null);
        })
        .catch((error) => setImpactError(localizeRuntimeError(error)));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [activeSessionId, impactRun, runtimePersistence]);
  useEffect(() => {
    if (!activeSessionId || !impactResolutionRun || !["queued", "running"].includes(impactResolutionRun.status)) return;
    const timer = window.setTimeout(() => {
      void runtimePersistence.inspectImpactResolutionRun(activeSessionId, impactResolutionRun.id)
        .then((response) => {
          setImpactResolutionRun(response.run);
          setImpactResolutionError(null);
        })
        .catch((error) => setImpactResolutionError(localizeRuntimeError(error)));
    }, 450);
    return () => window.clearTimeout(timer);
  }, [activeSessionId, impactResolutionRun, runtimePersistence]);
  useEffect(() => {
    let current = true;
    if (!runtimeAuthoringAvailable) {
      setNarrativeStateSnapshot(null);
      return () => { current = false; };
    }
    void runtimePersistence.getNarrativeStateSnapshot(activeProjectId)
      .then((snapshot) => { if (current) setNarrativeStateSnapshot(snapshot); })
      .catch(() => { if (current) setNarrativeStateSnapshot(null); });
    return () => { current = false; };
  }, [activeProjectId, activeSessionId, runtimeAuthoringAvailable, runtimePersistence]);
  const temporalStateProjection = useMemo(
    () => projectTemporalState(narrativeStateSnapshot, nodes),
    [narrativeStateSnapshot, nodes]
  );
  const flowPresentation = useMemo(() => analyzeStoryFlow(activeStoryFlow), [activeStoryFlow]);
  const localIntegrityReport = useMemo(() => localStoryFlowIntegrity(activeStoryFlow), [activeStoryFlow]);
  const storyDocument = useMemo(
    () => projectStoryDocument(nodes, edges, activeStoryFlow, visibleStoryFlows),
    [activeStoryFlow, edges, nodes, visibleStoryFlows]
  );
  const impactExperiences = useMemo(
    () => projectImpactExperiences(impactRun?.status === "completed" ? impactRun.findings : [], storyDocument, visibleStoryFlows),
    [impactRun, storyDocument, visibleStoryFlows]
  );
  const impactResolutionProviderConfigured = useMemo(() => {
    const settings = activeProjectManifest?.settings;
    const assignment = settings?.agent_providers?.agents?.impact_resolver;
    const profileId = assignment?.provider_source === "override"
      ? assignment.provider_profile_override_id
      : settings?.agent_providers?.default_provider_profile_id;
    return Boolean(settings?.impact_resolver?.agent_mode === "configured"
      && settings.impact_resolver?.content_policy === "bounded_evidence"
      && assignment?.model_id
      && profileId);
  }, [activeProjectManifest]);
  const showEmptyProjectStart =
    nodes.length === 0
    && projectStoryFlows.length === 0
    && (
      freshProjectId === activeProjectId
      || emptyWorkflowProjectNames.includes(activeProjectName)
    );

  const { startFrameDraw, continueFrameDraw } = useFrameDrawPointerHandlers({
    toolMode, frameDrawRef, setFrameDraw, screenToFlowPosition
  });

  const { cancelFrameDraw, finishFrameDraw } = useFrameDrawCompletion({
    frameDrawRef, setFrameDraw, addFrameAt, suppressPaneClickRef, setToolMode
  });

  const nodeResizeActions = useNodeResizeActions({ getActiveGraph, dragStartNodesRef, completeNodeResize });

  function updateWorkspacePreference(update: Partial<ProjectWorkspacePreference>) {
    setWorkspacePreferences((current) => {
      const previous = current[activeProjectId] ?? defaultWorkspacePreference(visibleStoryFlows);
      return { ...current, [activeProjectId]: { ...previous, ...update } };
    });
  }

  function chooseWorkspaceMode(mode: WorkspaceMode) {
    updateWorkspacePreference({ mode, activeFlowId: activeStoryFlow?.flow.id ?? null });
    selectItem(null);
  }

  function chooseStoryFlow(flowId: string) {
    // Selecting a flow changes the Graph overlay; the dedicated Flow projection
    // remains an explicit workspace choice instead of an implicit navigation.
    updateWorkspacePreference({ activeFlowId: flowId });
    selectItem(null);
  }

  /** Routes a state summary back to the exact authoring surface that owns it. */
  function openTemporalEffectOwner(owner: NarrativeEffectOwnerRef) {
    const contextualOwner = owner.owner_kind === "dialogue_element"
      || owner.owner_kind === "dialogue_option"
      || owner.owner_kind === "quest_branch"
      || owner.owner_kind === "quest_outcome";
    if (owner.owner_kind === "node_entry" || contextualOwner) {
      const nodeId = owner.owner_kind === "node_entry" ? owner.owner_id : owner.context_node_id;
      const node = nodes.find((candidate) => (candidate.data.canonicalNodeId ?? candidate.id) === nodeId && !candidate.data.isLinkedInstance);
      if (node) editStoryNode(node);
      return;
    }
    if (owner.owner_kind === "flow_transition") {
      const flow = visibleStoryFlows.find((candidate) => candidate.transitions.some((transition) => transition.id === owner.owner_id));
      if (!flow) return;
      updateWorkspacePreference({ mode: "flow", activeFlowId: flow.flow.id });
      selectItem({ type: "edge", id: `story-flow:${owner.owner_id}` });
      return;
    }
    if (owner.owner_kind === "flow_invocation") {
      const flow = visibleStoryFlows.find((candidate) => (candidate.invocations ?? []).some((invocation) => invocation.id === owner.owner_id));
      if (!flow) return;
      updateWorkspacePreference({ mode: "flow", activeFlowId: flow.flow.id });
      setSelectedInvocationId(owner.owner_id);
      selectItem({ type: "edge", id: `flow-invocation:${owner.owner_id}` });
      setDialog("flow-call-bindings");
      return;
    }
    const flow = visibleStoryFlows.find((candidate) => (candidate.exits ?? []).some((flowExit) => flowExit.id === owner.owner_id));
    const flowExit = flow?.exits?.find((candidate) => candidate.id === owner.owner_id);
    if (flow && flowExit) openComposedStorySource(flow.flow.id, flowExit.source_node_id);
  }

  /** Routes one Canon target through the same projection-specific authoring paths. */
  function openCanonIssueTarget(
    owner: CanonOwnerRef,
    destination: "flow" | "graph" | "source" | "story",
    issue?: CanonIssueProjection
  ) {
    const resolved = resolveCanonOwner(owner, nodes, visibleStoryFlows, narrativeStateSnapshot, canvasEdges);
    const diagnosticIssue = issue ?? selectedCanonIssue;
    const playbackDiagnostic = diagnosticIssue?.metadata.issue_version === 2 && diagnosticIssue.metadata.diagnostic.domain === "playback";
    const surface: CanonAuthoringSurface = destination === "source" && playbackDiagnostic
      ? "playback"
      : destination === "source" ? resolved.surface : destination;
    const canonicalNodeId = resolved.nodeId ?? resolved.sourceNodeId;
    const canonicalNode = canonicalNodeId
      ? nodes.find((node) => (node.data.canonicalNodeId ?? node.id) === canonicalNodeId && !node.data.isLinkedInstance)
      : null;

    if (!resolved.found) {
      setCanonNotice(tr("canon.ownerUnavailable"));
      window.setTimeout(() => {
        const evidence = [...document.querySelectorAll<HTMLElement>("[data-canon-evidence-owner]")]
          .find((candidate) => candidate.dataset.canonEvidenceOwner === owner.owner_id);
        evidence?.focus();
      }, 0);
      return;
    }
    setCanonFocusedOwner(owner);
    if (surface === "playback") {
      const flow = visibleStoryFlows.find((candidate) => candidate.flow.id === resolved.flowId || candidate.flow.id === owner.owner_id)
        ?? activeStoryFlow;
      if (flow) void startPlayback(flow);
      return;
    }
    if (surface === "temporal" && resolved.temporalOwner) {
      openTemporalEffectOwner(resolved.temporalOwner);
      setCanonFocusedOwner(owner);
      focusCanonOwnerElement(owner.owner_id);
      return;
    }
    if (surface === "temporal" && resolved.flowId) {
      const flow = visibleStoryFlows.find((candidate) => candidate.flow.id === resolved.flowId);
      if (flow) void startPlayback(flow);
      return;
    }
    if ((surface === "dialogue" || surface === "quest") && canonicalNode) {
      editStoryNode(canonicalNode);
      setCanonFocusedOwner(owner);
      // Keep the exact nested Canon owner visible after focus moves into an
      // input, rather than relying on the editor's short-lived :focus ring.
      focusCanonOwnerElement(owner.owner_id);
      return;
    }
    if (surface === "story" && canonicalNode) {
      const flow = visibleStoryFlows.find((candidate) => candidate.flow.id === resolved.flowId)
        ?? visibleStoryFlows.find((candidate) => candidate.nodes.some((member) => member.node_id === canonicalNodeId))
        ?? activeStoryFlow;
      updateWorkspacePreference({ mode: "story", activeFlowId: flow?.flow.id ?? null });
      selectItem({ type: "node", id: canonicalNode.id });
      if (owner.owner_type === "node" || owner.owner_type === "placement") focusCanonStoryNode(canonicalNodeId!);
      else focusCanonOwnerElement(owner.owner_id);
      return;
    }
    if (surface === "flow") {
      const flow = visibleStoryFlows.find((candidate) => candidate.flow.id === resolved.flowId)
        ?? visibleStoryFlows.find((candidate) => resolved.nodeId && candidate.nodes.some((member) => member.node_id === resolved.nodeId))
        ?? activeStoryFlow;
      if (!flow) return;
      updateWorkspacePreference({ mode: "flow", activeFlowId: flow.flow.id });
      if (owner.owner_type === "scene_boundary") {
        const boundary = flow.scene_boundaries.find((item) => item.id === owner.owner_id);
        if (boundary) {
          setBoundarySceneId(boundary.scene_node_id);
          setDialog("scene-boundary");
          focusCanonOwnerElement(owner.owner_id);
        }
        return;
      }
      if (owner.owner_type === "flow_invocation" || owner.owner_type === "flow_exit_binding") {
        const invocationId = owner.owner_type === "flow_invocation"
          ? owner.owner_id
          : (flow.bindings ?? []).find((item) => item.id === owner.owner_id)?.invocation_id;
        if (invocationId) {
          setSelectedInvocationId(invocationId);
          selectItem({ type: "edge", id: `flow-invocation:${invocationId}` });
          setDialog("flow-call-bindings");
          focusCanonOwnerElement(owner.owner_id);
        }
        return;
      }
      if (owner.owner_type === "flow_exit") {
        const caller = visibleStoryFlows.find((candidate) => (candidate.invocations ?? []).some((item) => item.target_flow_id === flow.flow.id));
        const invocation = caller?.invocations?.find((item) => item.target_flow_id === flow.flow.id);
        if (caller && invocation) {
          updateWorkspacePreference({ mode: "flow", activeFlowId: caller.flow.id });
          setSelectedInvocationId(invocation.id);
          selectItem({ type: "edge", id: `flow-invocation:${invocation.id}` });
          setDialog("flow-call-bindings");
          focusCanonOwnerElement(owner.owner_id);
          return;
        }
      }
      if (resolved.canvasEdgeId) selectItem({ type: "edge", id: resolved.canvasEdgeId });
      else if (canonicalNode) selectItem({ type: "node", id: canonicalNode.id });
      const focusNodeId = canonicalNode?.id
        ?? resolved.sourceNodeId
        ?? flow.flow.entry_node_id;
      const sourceNode = nodes.find((node) => (node.data.canonicalNodeId ?? node.id) === focusNodeId && !node.data.isLinkedInstance);
      if (sourceNode) {
        const projection = projectGraphForWorkspace(nodes, canvasEdges, "flow", flow, visibleStoryFlows);
        window.setTimeout(() => focusRenderedNode(nodeForWorkspaceFocus(sourceNode, projection.nodes, "flow")), 100);
      }
      focusCanonOwnerElement(owner.owner_id);
      return;
    }

    updateWorkspacePreference({ mode: "relationships", activeFlowId: activeStoryFlow?.flow.id ?? null });
    if (resolved.canvasEdgeId) {
      selectItem({ type: "edge", id: resolved.canvasEdgeId });
      const edge = canvasEdges.find((candidate) => candidate.id === resolved.canvasEdgeId);
      const endpoints = edge
        ? nodes.filter((node) => node.id === edge.source || node.id === edge.target)
        : [];
      if (endpoints.length) window.setTimeout(() => void fitViewCanvas({ duration: 300, nodes: endpoints, padding: .2 }), 100);
    } else if (canonicalNode) {
      selectItem({ type: "node", id: canonicalNode.id });
      const projection = projectGraphForWorkspace(nodes, canvasEdges, "relationships", activeStoryFlow, visibleStoryFlows);
      window.setTimeout(() => focusRenderedNode(nodeForWorkspaceFocus(canonicalNode, projection.nodes, "relationships")), 100);
    }
  }

  function focusCanonOwnerElement(ownerId: string) {
    window.setTimeout(() => {
      const target = [...document.querySelectorAll<HTMLElement>("[data-canon-owner-id]")]
        .find((candidate) => candidate.dataset.canonOwnerId === ownerId);
      target?.scrollIntoView?.({ block: "center" });
      target?.focus();
    }, 200);
  }

  function focusCanonStoryNode(nodeId: string) {
    window.setTimeout(() => {
      const beat = [...document.querySelectorAll<HTMLElement>("[data-story-node-id]")]
        .find((candidate) => candidate.dataset.storyNodeId === nodeId);
      beat?.scrollIntoView?.({ block: "center" });
      beat?.focus();
    }, 100);
  }

  function chooseTool(mode: ToolMode) {
    cancelFrameDraw();
    // Flow is a topology projection; canonical creation resumes on Graph.
    if (workspaceMode === "flow" && mode !== "select" && mode !== "pan") {
      updateWorkspacePreference({ mode: "relationships", activeFlowId: activeStoryFlow?.flow.id ?? null });
    }
    if (mode === "pan") {
      setCanvasSelection({ edgeIds: [], nodeIds: [] });
      selectItem(null);
    }
    setToolMode(mode);
  }

  useEffect(() => {
    function cancelOnEscape(event: KeyboardEvent) {
      const target = event.target;
      if (event.key !== "Escape" || (target instanceof Element && target.matches("input, textarea, [contenteditable=true]"))) return;
      if (frameDrawRef.current) cancelFrameDraw();
      setToolMode("select");
      setCanvasSelection({ edgeIds: [], nodeIds: [] });
      selectItem(null);
    }
    function trackSpacePan(event: KeyboardEvent) {
      const target = event.target;
      if (event.code === "Space" && !(target instanceof Element && target.matches("input, textarea, [contenteditable=true]"))) {
        spacePanActiveRef.current = event.type === "keydown";
      }
    }
    function cancelSpacePan() {
      spacePanActiveRef.current = false;
    }
    window.addEventListener("keydown", cancelOnEscape);
    window.addEventListener("keydown", trackSpacePan);
    window.addEventListener("keyup", trackSpacePan);
    window.addEventListener("blur", cancelSpacePan);
    return () => {
      window.removeEventListener("keydown", cancelOnEscape);
      window.removeEventListener("keydown", trackSpacePan);
      window.removeEventListener("keyup", trackSpacePan);
      window.removeEventListener("blur", cancelSpacePan);
    };
  }, []);
  const selectedNode = selection?.type === "node" ? nodes.find((node) => node.id === selection.id) : null;
  const selectedEdge = selection?.type === "edge" ? edges.find((edge) => edge.id === selection.id) : null;
  const selectedNodeIssues = selectedNode ? issuesForNode(issues, selectedNode.data.canonicalNodeId ?? selectedNode.id) : [];
  const selectedFactionMembers = selectedNode?.data.kind === "Faction" ? factionMembers(nodes, edges, selectedNode.id) : [];
  const selectedEdgeIssues = selectedEdge ? issuesForEdge(issues, selectedEdge.id) : [];
  const canvasEdges = useMemo(() => hideSemanticEdges(edges), [edges]);
  const workspaceGraph = useMemo(
    () => projectGraphForWorkspace(nodes, canvasEdges, workspaceMode, activeStoryFlow, projectStoryFlows),
    [activeStoryFlow, canvasEdges, nodes, projectStoryFlows, workspaceMode]
  );
  const temporalCanvasSelection: GraphSelection | null = canvasSelection.nodeIds.length === 1 && canvasSelection.edgeIds.length === 0
    ? { type: "node", id: canvasSelection.nodeIds[0]! }
    : canvasSelection.edgeIds.length === 1 && canvasSelection.nodeIds.length === 0
      ? { type: "edge", id: canvasSelection.edgeIds[0]! }
      : null;
  const derivedTemporalOwner = useMemo(
    // React Flow selection changes and the canonical store can settle in separate events.
    () => workspaceMode === "relationships" ? temporalOwnerForGraphSelection(temporalCanvasSelection ?? selection, nodes, workspaceGraph.edges) : null,
    [nodes, selection, temporalCanvasSelection, workspaceGraph.edges, workspaceMode]
  );
  const selectedTemporalEffects = useMemo(
    () => temporalEffectsForOwner(temporalStateProjection, selectedTemporalOwner ?? derivedTemporalOwner),
    [derivedTemporalOwner, selectedTemporalOwner, temporalStateProjection]
  );
  const temporalGraphOverlay = useMemo(
    () => projectTemporalGraphOverlay(selectedTemporalEffects, nodes),
    [nodes, selectedTemporalEffects]
  );
  const filteredGraph = useMemo(
    () => filterGraphForView(workspaceGraph.nodes, workspaceGraph.edges, graphFilter),
    [graphFilter, workspaceGraph.edges, workspaceGraph.nodes]
  );
  const totalNodeCount = useMemo(() => new Set(nodes.map((node) => node.data.canonicalNodeId ?? node.id)).size, [nodes]);
  const filteredNodeCount = useMemo(
    () => new Set(filteredGraph.nodes.map((node) => node.data.canonicalNodeId ?? node.id)).size,
    [filteredGraph.nodes]
  );
  const filteredFlowTransitionCount = filteredGraph.edges.filter((edge) => edge.data?.flowTransition || edge.data?.flowInvocation).length;
  const filteredRelationshipCount = filteredGraph.edges.length - filteredFlowTransitionCount;
  const presentedGraph = useMemo(
    () => projectFrameWorkspace(filteredGraph.nodes, filteredGraph.edges, focusedFrameId),
    [filteredGraph.edges, filteredGraph.nodes, focusedFrameId]
  );
  const filteredIssues = useMemo(() => filterIssuesForView(issues, graphFilter), [graphFilter, issues]);
  const graphWithIssueOverlays = useMemo(
    () => applyIssueOverlays(presentedGraph.nodes, presentedGraph.edges, filteredIssues),
    [filteredIssues, presentedGraph.edges, presentedGraph.nodes]
  );
  // Older session responses can omit the Canon collection until its first run.
  const canonIssuePreview = selectedCanonIssue
    ? (i18next.exists(selectedCanonIssue.metadata.message_key)
      ? i18next.t(selectedCanonIssue.metadata.message_key, selectedCanonIssue.metadata.message_parameters)
      : selectedCanonIssue.title)
    : "";
  const graphWithCanonHighlights = useMemo(
    () => highlightCanonTargets(
      graphWithIssueOverlays.nodes,
      graphWithIssueOverlays.edges,
      selectedCanonIssue,
      canonIssuePreview
    ),
    [canonIssuePreview, graphWithIssueOverlays.edges, graphWithIssueOverlays.nodes, selectedCanonIssue]
  );
  const graphWithImpactHighlights = useMemo(
    () => projectImpactHighlights(
      graphWithCanonHighlights.nodes,
      graphWithCanonHighlights.edges,
      canonOpen || sceneAnalysisOpen ? null : impactRun,
      tr("impact.highlight.seedPreview"),
      impactFindingPreview
    ),
    [canonOpen, graphWithCanonHighlights.edges, graphWithCanonHighlights.nodes, impactRun, sceneAnalysisOpen]
  );
  const analysisPreviewMaps = useMemo(
    () => buildAnalysisPreviewMaps(sceneAnalysisResult, nodes, edges, sceneOperationDecisions),
    [edges, nodes, sceneAnalysisResult, sceneOperationDecisions]
  );
  const graphWithNavigationOverlays = useMemo(
    () => {
      const highlighted = applyAnalysisHighlights(
        applySelectionHighlights(graphWithImpactHighlights.edges, selection),
        analysisPreviewMaps.edges,
        analysisPreviewMaps.edgeOperations
      );
      const visible = workspaceMode === "flow"
        ? highlighted.filter((edge) => edge.data?.flowTransition || edge.data?.flowInvocation || edge.data?.sceneBoundary)
        : hideSemanticEdges(hideDirectFrameChildEdges(nodes, [...highlighted, ...analysisPreviewMaps.previewEdges]));
      const projected = workspaceMode === "relationships" ? [...visible, ...temporalGraphOverlay.edges] : visible;
      return projected.map((edge) => ({
        ...edge,
        type: canvasEdgeType(edge, workspaceMode),
        selected: canvasSelection.edgeIds.includes(edge.id)
      }));
    },
    [analysisPreviewMaps.edgeOperations, analysisPreviewMaps.edges, analysisPreviewMaps.previewEdges, canvasSelection.edgeIds, graphWithImpactHighlights.edges, nodes, selection, temporalGraphOverlay.edges, workspaceMode]
  );
  const relationshipInspection = useMemo(
    () => workspaceMode === "relationships" ? buildRelationshipInspection(nodes, edges, selection) : null,
    [edges, nodes, selection, workspaceMode]
  );
  const selectedFlowTransition = useMemo(() => {
    if (!activeStoryFlow) return null;
    const selectedId = selection?.type === "edge" && selection.id.startsWith("story-flow:")
      ? selection.id.slice("story-flow:".length)
      : canonFocusedOwner?.owner_type === "flow_transition"
        ? canonFocusedOwner.owner_id
        : null;
    return activeStoryFlow.transitions.find((transition) => transition.id === selectedId) ?? null;
  }, [activeStoryFlow, canonFocusedOwner, selection]);
  const selectedFlowInvocation = useMemo(() => {
    const invocationId = selection?.type === "edge" && selection.id.startsWith("flow-invocation:")
      ? selection.id.slice("flow-invocation:".length)
      : selectedInvocationId;
    return (activeStoryFlow?.invocations ?? []).find((item) => item.id === invocationId) ?? null;
  }, [activeStoryFlow, selectedInvocationId, selection]);
  const dialogueExternalOrigins = useMemo(() => {
    const origins = new Map<string, string[]>();
    for (const edge of edges) {
      const originId = edge.data?.dialogueElementId;
      if (originId) {
        origins.set(edge.source, [...(origins.get(edge.source) ?? []), originId]);
      }
    }
    return origins;
  }, [edges]);
  const { replaceProjectStoryFlows, createStoryFlow, startEmptyProjectStory, createWorldbuildingNode, renameStoryFlow, archiveStoryFlow, previewStoryFlowDeletion, confirmStoryFlowDeletion, replaceActiveStoryFlow, openContinueFlow, continueStoryFlow, openFlowInvocation, createFlowInvocation, openFlowExit, createFlowExit, saveFlowExitBinding, deleteFlowInvocation, confirmStoryFlowEntry, addNodeToActiveStoryFlow, canonicalSceneChildren, saveSceneBoundary, deleteSceneBoundary } = createStoryLifecycleController({
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
  });
  const flowMembershipActions = useFlowMembershipActions({
    projectId: activeProjectId, nodes: graphWithImpactHighlights.nodes, activeStoryFlow, workspaceMode,
    addNodeToActiveStoryFlow, openContinueFlow, openFlowInvocation, openFlowExit,
    setEntryCandidateId, setBoundarySceneId, setFlowActionError, setDialog
  });
  const framePlacementActions = useFramePlacementActions({
    projectId: activeProjectId, nodes: graphWithImpactHighlights.nodes, setFrameAddMenuId, fitFrame, toggleFrameCollapse, openFrameWorkspace
  });
  const flowCallOpenActions = useFlowCallOpenActions({
    projectId: activeProjectId, nodes: graphWithImpactHighlights.nodes, activeStoryFlow, setSelectedInvocationId, setDialog
  });
  const flowCallLists = useFlowCallLists({ projectId: activeProjectId, nodes: graphWithImpactHighlights.nodes, activeStoryFlow, projectStoryFlows, openActions: flowCallOpenActions });
  const flowExitLists = useFlowExitLists({ projectId: activeProjectId, nodes: graphWithImpactHighlights.nodes, activeStoryFlow });
  const questMetrics = useQuestCanvasMetrics({ projectId: activeProjectId, nodes: graphWithImpactHighlights.nodes });
  const dialogueMetrics = useDialogueCanvasMetrics({ projectId: activeProjectId, nodes: graphWithImpactHighlights.nodes, externalOrigins: dialogueExternalOrigins });
  const frameCounts = useFrameContentCounts({ projectId: activeProjectId, rawNodes: nodes, nodes: graphWithImpactHighlights.nodes });
  const topologyMetrics = useNodePresentationMetrics({ projectId: activeProjectId, rawNodes: nodes, rawEdges: edges, nodes: graphWithImpactHighlights.nodes });
  const factionTitles = useFactionMemberTitles({ projectId: activeProjectId, rawNodes: nodes, rawEdges: edges, nodes: graphWithImpactHighlights.nodes });
  const outcomeTitles = useOutcomeTargetTitles({ projectId: activeProjectId, rawNodes: nodes, nodes: graphWithImpactHighlights.nodes });
  const boundarySummaries = useSceneBoundarySummaries({ projectId: activeProjectId, rawNodes: nodes, nodes: graphWithImpactHighlights.nodes, activeStoryFlow });
  const candidateNodes = useMemo<Node<NarrativeNodeRenderData>[]>(
    () =>
      graphWithImpactHighlights.nodes.map((node) => ({
        ...node,
        style: temporalGraphOverlay.affectedNodeIds.has(node.data.canonicalNodeId ?? node.id)
          ? { ...node.style, boxShadow: "0 0 0 4px rgb(13 148 136 / 32%)" }
          : node.style,
        selected: canvasSelection.nodeIds.includes(node.id),
        data: {
          ...node.data,
          analysisOperationIndexes: analysisPreviewMaps.nodeOperations.get(node.id),
          analysisPreview: analysisPreviewMaps.nodes.get(node.id),
          ...(node.data.kind === "Dialogue"
            ? { dialogueMetrics: dialogueMetrics.get(node.id)! }
            : {}),
          ...(node.data.kind === "Quest" ? { questMetrics: questMetrics.get(node.id)! } : {}),
          ...(node.data.kind === "Faction" ? { factionMembers: factionTitles.get(node.id)! } : {}),
          ...(node.data.kind === "Consequence"
            ? { outcomeTargets: outcomeTitles.get(node.id)! }
            : {}),
          presentationMetrics: topologyMetrics.get(node.id)!,
          workspaceMode,
          flowRole: (workspaceMode === "flow" || workspaceMode === "relationships")
            ? flowPresentation.roles.get(node.data.canonicalNodeId ?? node.id)
            : undefined,
          activeFlowName: activeStoryFlow?.flow.name,
          flowMembership: Boolean(activeStoryFlow?.nodes.some((item) => item.node_id === (node.data.canonicalNodeId ?? node.id))),
          ...flowMembershipActions.get(node.data.canonicalNodeId ?? node.id),
          flowCalls: flowCallLists.get(node.id)!,
          flowExits: flowExitLists.get(node.id)!,
          onConfigureSceneBoundary: node.data.kind === "Scene"
            ? flowMembershipActions.get(node.data.canonicalNodeId ?? node.id)?.onConfigureSceneBoundary : undefined,
          sceneBoundarySummary: boundarySummaries.get(node.id),
          onOpenAnalysis: setSelectedAnalysisOperation,
          isConnectionSource: node.id === connectionSourceId,
          isConnectionTarget: node.id === connectionTargetId,
          issuePreview: issuePreviewForNode(filteredIssues, node.id),
          ...nodeResizeActions,
          ...(node.data.isFrame
            ? {
                compositionDropState: compositionDrop?.frameId === node.id ? { message: compositionDrop.message, valid: compositionDrop.valid } : undefined,
                ...framePlacementActions.get(node.id),
                frameContentCounts: frameCounts.get(node.id)!
              }
            : {})
        }
      })),
    [activeStoryFlow, analysisPreviewMaps.nodeOperations, analysisPreviewMaps.nodes, boundarySummaries, canvasSelection.nodeIds, compositionDrop, connectionSourceId, connectionTargetId, dialogueMetrics, edges, factionTitles, filteredIssues, flowCallLists, flowExitLists, flowMembershipActions, flowPresentation.roles, frameCounts, framePlacementActions, graphWithImpactHighlights.nodes, nodeResizeActions, nodes, outcomeTitles, questMetrics, temporalGraphOverlay.affectedNodeIds, topologyMetrics, workspaceMode]
  );
  const assembledNodeData = useNodeDataAssembly({ projectId: activeProjectId, flowId: activeStoryFlow?.flow.id ?? null, workspaceMode, nodes: candidateNodes });
  // Keep current candidate geometry/style/selection; only replace equal data references.
  const dataAssembledNodes = useMemo(() => candidateNodes.every((node) => node.data === assembledNodeData.get(node.id)) ? candidateNodes
    : candidateNodes.map((node) => {
      const data = assembledNodeData.get(node.id)!;
      return node.data === data ? node : { ...node, data };
    }), [assembledNodeData, candidateNodes]);
  const visibleNodes = useNodeWrapperAssembly({ projectId: activeProjectId, flowId: activeStoryFlow?.flow.id ?? null, workspaceMode, nodes: dataAssembledNodes });
  const visibleNodeIdsKey = visibleNodes.map((node) => node.id).join("\u0000");
  const edgeDefaults = useMemo(
    () => ({
      markerEnd: { type: MarkerType.ArrowClosed, color: "#475569" },
      reconnectable: true,
      style: { stroke: "#475569", strokeWidth: 3 }
    }),
    []
  );

  const { beginFlowConnection, chooseGraphConnection, completeGraphConnection, reorderFlowTransition, removeFlowTransition, deleteCanvasSelection, reconnectFlowTransition, updateStoryTransition, editStoryNode, openStoryNodeInWorkspace, openComposedStorySource } = createGraphFlowController({
    activeStoryFlow, addNodeToActiveStoryFlow, canvasEdges, canvasSelection, chooseStoryFlow, chooseWorkspaceMode,
    deleteEdge, deleteNode, focusRenderedNode, nodes, onConnect, openContinueFlow, openDialogueEditor,
    openQuestEditor, pendingGraphConnection, projectStoryFlows, removeInstance, removePersistedEdge,
    replaceActiveStoryFlow, runtimeAuthoringAvailable, runtimePersistence, selectItem,
    setCanonFocusedOwner, setCanvasSelection, setDialog, setFlowActionError,
    setPendingGraphConnection, updateWorkspacePreference, visibleStoryFlows
  });

  const { openOutcomeFlow, outcomeStoryFlowNames, outcomeDeletionImpact, updateOutcomeComposition, removeOutcomeInvocation, removeOutcomeTransitions, deleteSpecializedOutcome, integrateOutcomeIntoFlow, openProgressionMigration, rejectProgressionMigration, acceptProgressionMigration } = createOutcomeController({
    activeProjectId, deleteEdge, edges, localProgressionDecisions, outcomeFlowEdge,
    outcomeReturnDialog, progressionReview, projectStoryFlows, reconcileRuntimeEdge,
    removePersistedEdge, replaceProjectStoryFlows, runtimeAuthoringAvailable,
    runtimePersistence, selectItem, setDialog, setFlowActionError,
    setLocalProgressionDecisions, setOutcomeFlowEdge, setOutcomeReturnDialog,
    setProgressionLoading, setProgressionReview, updateEdge, updateWorkspacePreference
  });

  const { backPlayback, choosePlaybackSelection, exitPlayback, openPlaybackEffectSource, openPlaybackNodeSource, openPlaybackSource, openPlaybackTransitionSource, restartPlayback, returnToPlayback, startPlayback } = createPlaybackController({
    activeStoryFlow, buildEdges: canvasEdges, canonOpen, editStoryNode, focusRenderedNode,
    narrativeStateSnapshot, nodes, openStoryNodeInWorkspace, openTemporalEffectOwner,
    playbackEffectsByFlow, playbackOriginModeRef, playbackPlayButtonRef, playbackSession,
    playbackSubmittingRef, projectStoryFlows, runtimePersistence, selectItem, setDialog,
    setPlaybackAnnouncement, setPlaybackBusy, setPlaybackError, setPlaybackLoading,
    setPlaybackOpen, setPlaybackPreparationFacts, setPlaybackSession,
    updateWorkspacePreference, visibleStoryFlows, workspaceMode
  });

  async function rehydrateHistoryProject(
    response: Parameters<typeof projectSessionToGraphSnapshot>[0]
  ) {
    const current = useGraphStore.getState();
    if (current.activeProjectId !== response.session.project_id
      || (current.activeSessionId && current.activeSessionId !== response.session.session_id)) return;
    // History can replace any document collection, so stale transient views are
    // closed before all durable projections are rebuilt from one response.
    setContextMenu(null);
    setFrameAddMenuId(null);
    setPendingGraphConnection(null);
    setSceneAnalysisResult(null);
    setCanonSuggestion(null);
    setSelectedAnalysisOperation(null);
    setProgressionReview(null);
    setFlowDeleteImpact(null);
    setFlowActionError(null);
    if (!(await loadRuntimeSnapshot(async () => projectSessionToGraphSnapshot(response)))) return;
    try {
      const snapshot = await runtimePersistence.getNarrativeStateSnapshot(response.session.project_id);
      if (useGraphStore.getState().activeSessionId === response.session.session_id) setNarrativeStateSnapshot(snapshot);
    } catch {
      if (useGraphStore.getState().activeSessionId === response.session.session_id) setNarrativeStateSnapshot(null);
    }
  }

  async function applyStyleRewriteApproval(response: RuntimeStyleRewriteApprovalResponse) {
    const current = useGraphStore.getState(), source = response.result.project.session;
    if (current.activeProjectId !== source.project_id || (current.activeSessionId && current.activeSessionId !== source.session_id)) return;
    // Approval is an ordinary dirty history command. Rebuild every projection
    // from its canonical response and close editor drafts bound to old Text.
    setProjectHistory(response.result.history);
    await rehydrateHistoryProject(response.result.project);
    setDialog(null);
  }

  async function runProjectHistory(direction: "undo" | "redo") {
    if (!activeSessionId || !projectHistory || historyBusy) return;
    const command = direction === "undo" ? projectHistory.next_undo : projectHistory.next_redo;
    if (!command) return;
    // The invoked control often becomes disabled after stack movement, so
    // focus the newly available inverse action instead of losing keyboard focus.
    const focusTarget = direction === "undo" ? redoButtonRef : undoButtonRef;
    setHistoryBusy(true);
    setHistoryError(null);
    try {
      const result = direction === "undo"
        ? await runtimePersistence.undoProjectHistory(activeSessionId, projectHistory.history_revision)
        : await runtimePersistence.redoProjectHistory(activeSessionId, projectHistory.history_revision);
      if (useGraphStore.getState().activeSessionId !== activeSessionId) return;
      setProjectHistory(result.history);
      await rehydrateHistoryProject(result.project);
    } catch (error) {
      if (useGraphStore.getState().activeSessionId !== activeSessionId) return;
      setHistoryError(localizeRuntimeError(error));
      // A stale or failed request must still converge controls and projections
      // on the runtime's authoritative unchanged state.
      try {
        const [summary, snapshot] = await Promise.all([
          runtimePersistence.inspectProjectHistory(activeSessionId),
          runtimePersistence.loadProjectSessionSnapshot(activeSessionId)
        ]);
        if (useGraphStore.getState().activeSessionId !== activeSessionId) return;
        if (!(await loadRuntimeSnapshot(async () => snapshot))) return;
        setProjectHistory(summary);
        try {
          setNarrativeStateSnapshot(await runtimePersistence.getNarrativeStateSnapshot(activeProjectId));
        } catch {
          setNarrativeStateSnapshot(null);
        }
      } catch {
        // Preserve the original localized history failure when reconciliation also fails.
      }
    } finally {
      setHistoryBusy(false);
      window.requestAnimationFrame(() => focusTarget.current?.focus());
    }
  }

  useEffect(() => {
    setRuntimePersistence(runtimePersistence);
    return () => setRuntimePersistence(null);
  }, [runtimePersistence, setRuntimePersistence]);

  useEffect(() => {
    function handleHistoryShortcut(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.altKey || readDialog() || isEditableHistoryTarget(event.target)) return;
      const modifier = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const direction = modifier && key === "z"
        ? (event.shiftKey ? "redo" : "undo")
        : event.ctrlKey && !event.metaKey && key === "y"
          ? "redo"
          : null;
      if (!direction) return;
      const command = direction === "undo" ? projectHistory?.next_undo : projectHistory?.next_redo;
      if (!command || historyBusy) return;
      event.preventDefault();
      void runProjectHistory(direction);
    }
    window.addEventListener("keydown", handleHistoryShortcut);
    return () => window.removeEventListener("keydown", handleHistoryShortcut);
  }, [readDialog, historyBusy, projectHistory, runtimePersistence]);

  useEffect(() => {
    try {
      window.localStorage.setItem(WORKSPACE_PREFERENCES_KEY, JSON.stringify(workspacePreferences));
    } catch {
      // Presentation restoration is best-effort and never blocks local authoring.
    }
  }, [workspacePreferences]);

  useEffect(() => {
    if (!durableAuthoring && runtimeError && completedEmptyWorkflowProjectNames.includes(activeProjectName)) {
      setEmptyWorkflowNotice(`${runtimeError.replace(/[.]+$/, "")}. Working locally.`);
    }
  }, [activeProjectName, completedEmptyWorkflowProjectNames, durableAuthoring, runtimeError]);

  useEffect(() => {
    if (workspaceMode === "story") return;
    // Refit after the selected projection has rendered, including restored project preferences.
    workspaceFitTimeoutRef.current = window.setTimeout(() => {
      workspaceFitTimeoutRef.current = null;
      if (workspaceMode === "flow" && visibleNodes.length === 1) {
        const node = visibleNodes[0]!;
        setCenter(
          node.position.x + (node.width ?? 220) / 2,
          node.position.y + (node.height ?? 156) / 2,
          { duration: 260, zoom: 0.9 }
        );
        return;
      }
      void fitViewCanvas({
        duration: 260,
        minZoom: INITIAL_CANVAS_FIT_OPTIONS.minZoom,
        maxZoom: workspaceMode === "flow" ? 0.9 : 1.2,
        nodes: visibleNodes,
        padding: workspaceMode === "flow" ? 0.16 : 0.12
      });
    }, 80);
    return () => {
      if (workspaceFitTimeoutRef.current !== null) window.clearTimeout(workspaceFitTimeoutRef.current);
      workspaceFitTimeoutRef.current = null;
    };
  }, [activeProjectId, activeStoryFlow?.flow.id, fitViewCanvas, setCenter, visibleNodeIdsKey, workspaceMode]);

  useEffect(() => {
    // A project session already supplied the canonical Story Flow snapshots.
    // Global CRUD remains only for legacy workspaces until P3.9-006 migrates mutations.
    if (runtimeStatus !== "ready" || activeSessionId) return;
    let cancelled = false;
    void runtimePersistence.listStoryFlowSnapshots(activeProjectId)
      .then((snapshots) => {
        if (!cancelled) setStoryFlowsByProject((current) => ({ ...current, [activeProjectId]: snapshots }));
      })
      .catch((error) => {
        if (!cancelled) setFlowActionError(error instanceof Error ? error.message : "Story Flow loading failed");
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, activeSessionId, runtimePersistence, runtimeStatus]);

  useEffect(() => {
    // Render deterministic fallback facts immediately, then replace them with
    // the legacy runtime inspection only when no project session owns the snapshot.
    setFlowIntegrityReport(localIntegrityReport);
    if (runtimeStatus !== "ready" || activeSessionId || !activeStoryFlow) return;
    let cancelled = false;
    void runtimePersistence.getStoryFlowIntegrity(activeStoryFlow.flow.id)
      .then((report) => {
        if (!cancelled) setFlowIntegrityReport(report);
      })
      .catch((error) => {
        if (!cancelled) setFlowActionError(error instanceof Error ? error.message : "Integrity inspection failed");
      });
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, activeStoryFlow, localIntegrityReport, runtimePersistence, runtimeStatus]);

  useEffect(() => {
    if (!focusedFrameId) return;
    const timer = window.setTimeout(() => void fitViewCanvas({ duration: 300, padding: 0.14 }), 0);
    return () => window.clearTimeout(timer);
  }, [fitViewCanvas, focusedFrameId]);

  useEffect(() => {
    setFocusedFrameId(null);
  }, [activeProjectId]);

  useEffect(() => {
    setCanvasSelection((current) => {
      if (selection?.type === "node") {
        return current.nodeIds.includes(selection.id) ? current : { edgeIds: [], nodeIds: [selection.id] };
      }
      if (selection?.type === "edge") {
        return current.edgeIds.includes(selection.id) ? current : { edgeIds: [selection.id], nodeIds: [] };
      }
      return current.edgeIds.length || current.nodeIds.length ? { edgeIds: [], nodeIds: [] } : current;
    });
  }, [selection]);

  useEffect(() => {
    function handleGraphDeletion(event: KeyboardEvent) {
      const target = event.target;
      if ((event.key !== "Delete" && event.key !== "Backspace") || (target instanceof Element && target.matches("input, textarea, [contenteditable=true]"))) return;
      if (canvasSelection.nodeIds.length + canvasSelection.edgeIds.length > 1) {
        event.preventDefault();
        setDialog("delete-selection");
        return;
      }
      if (selection?.type === "edge") {
        event.preventDefault();
        if (selectedFlowTransition) void removeFlowTransition(selectedFlowTransition);
        else deleteEdge(selection.id);
      } else if (selectedNode) {
        event.preventDefault();
        if (selectedNode.data.isLinkedInstance) removeInstance(selectedNode.id);
        else setDialog("delete-entity");
      }
    }
    window.addEventListener("keydown", handleGraphDeletion);
    return () => window.removeEventListener("keydown", handleGraphDeletion);
  }, [canvasSelection.edgeIds.length, canvasSelection.nodeIds.length, deleteEdge, removeInstance, selectedFlowTransition, selectedNode, selection]);

  function centerOnNode(node: Node<NarrativeNodeData>, zoom = 1.05) {
    const position = absoluteNodePosition(nodes, node);
    setCenter(position.x + (node.width ?? 260) / 2, position.y + (node.height ?? 156) / 2, {
      duration: 300,
      zoom
    });
  }

  function focusRenderedNode(node: Node<NarrativeNodeData>, zoom = 1.05) {
    void fitViewCanvas({
      duration: 300,
      maxZoom: zoom,
      minZoom: zoom,
      nodes: [node],
      padding: 0
    });
  }

  function openFrameWorkspace(frame: Node<NarrativeNodeData>) {
    if (!frame.data.isFrame) return;
    if (frame.data.presentationState === "collapsed") {
      toggleFrameCollapse(frame.id);
    }
    selectItem({ type: "node", id: frame.id });
    setFocusedFrameId(frame.id);
  }

  function closeFrameWorkspace() {
    setFocusedFrameId(null);
    window.setTimeout(() => void fitViewCanvas({ duration: 300, padding: 0.12 }), 0);
  }

  function focusNode(node: { height?: number | null; id: string; position: XYPosition; width?: number | null }) {
    const graphNode = nodes.find((candidate) => candidate.id === node.id);
    if (!graphNode) return;
    const canonicalNodeId = graphNode.data.canonicalNodeId ?? graphNode.id;
    if (workspaceMode === "story") {
      updateWorkspacePreference({ mode: "relationships", activeFlowId: activeStoryFlow?.flow.id ?? null });
      selectItem({ type: "node", id: node.id });
      const graphProjection = projectGraphForWorkspace(nodes, canvasEdges, "relationships", activeStoryFlow, projectStoryFlows);
      window.setTimeout(() => focusRenderedNode(nodeForWorkspaceFocus(graphNode, graphProjection.nodes, "relationships")), 100);
      return;
    }
    if (workspaceMode === "flow" && !activeStoryFlow?.nodes.some((member) => member.node_id === canonicalNodeId)) {
      updateWorkspacePreference({ mode: "relationships", activeFlowId: activeStoryFlow?.flow.id ?? null });
    }
    if (workspaceFitTimeoutRef.current !== null) window.clearTimeout(workspaceFitTimeoutRef.current);
    selectItem({ type: "node", id: node.id });
    const focusedNode = nodeForWorkspaceFocus(graphNode, workspaceGraph.nodes, workspaceMode);
    window.setTimeout(() => focusRenderedNode(focusedNode), 0);
  }

  function focusSelectedNeighborhood() {
    if (selection?.type !== "node") {
      return;
    }
    const neighborhood = getNodeNeighborhood(nodes, edges, selection.id);
    if (neighborhood.nodes.length === 0) {
      return;
    }
    const center = graphCenter(neighborhood.nodes.map((node) => ({ ...node, position: absoluteNodePosition(nodes, node) })));
    setCenter(center.x, center.y, { duration: 350, zoom: neighborhood.nodes.length > 1 ? 0.82 : 1.05 });
  }

  function selectCanvasElement(type: "edge" | "node", id: string, additive: boolean) {
    const currentIds = type === "node" ? canvasSelection.nodeIds : canvasSelection.edgeIds;
    const nextIds = additive
      ? currentIds.includes(id) ? currentIds.filter((candidate) => candidate !== id) : [...currentIds, id]
      : [id];
    const next = type === "node"
      ? createCanvasSelection(nextIds, additive ? canvasSelection.edgeIds : [])
      : createCanvasSelection(additive ? canvasSelection.nodeIds : [], nextIds);
    setCanvasSelection(next);
    if (nextIds.includes(id)) {
      selectItem({ type, id });
    } else {
      const nodeId = next.nodeIds[0];
      const edgeId = next.edgeIds[0];
      selectItem(nodeId ? { type: "node", id: nodeId } : edgeId ? { type: "edge", id: edgeId } : null);
    }
  }

  useEffect(() => {
    if (!impactOpen || impactCaller) return;
    const nextSeeds = selectedImpactSeeds();
    if (impactSeedKeys(nextSeeds) === impactSeedKeys(impactSeeds)) return;
    // React Flow clears its visual selection while changing projections. Keep
    // the completed run available for Graph, Flow, and Story review until the
    // user selects a different seed or changes authored project data.
    if (nextSeeds.length === 0 && impactRun?.status === "completed") return;
    // A result belongs to its captured seeds; changing selection must never
    // present the previous result as analysis of the newly selected objects.
    setImpactSeeds(nextSeeds);
    setImpactRun(null);
    setImpactError(null);
    setImpactResolutionRun(null);
    setImpactResolutionError(null);
    setImpactResolutionVerificationPending(false);
  }, [canvasSelection.edgeIds, canvasSelection.nodeIds, edges, impactCaller, impactOpen, impactRun?.status, nodes, workspaceGraph.edges]);

  const { impactResourceForNode, impactResourceForEdge, selectedImpactSeeds, openImpactWorkspace, closeImpactWorkspace, selectAnalysisTool, impactResourceLabel, openImpactFinding, openImpactResolutionChange, openImpactStoryProjection } = createImpactNavigationController({
    activeStoryFlow, analysisHeaderButtonRef, canonOpen, canvasSelection, edges,
    focusRenderedNode, impactBlockedCallerKey, impactCaller, impactOpen, impactOriginRef,
    impactRun, impactSeeds, narrativeStateSnapshot, nodes, openCanonIssueTarget,
    sceneAnalysisOpen, selectItem, setCanonOpen, setContextMenu,
    setImpactBlockedCallerKey, setImpactCaller, setImpactError, setImpactOpen,
    setImpactResolutionError, setImpactResolutionRun,
    setImpactResolutionVerificationPending, setImpactRun, setImpactSeeds,
    setLastAnalysisTool, setSceneAnalysisOpen, setSelectedCanonIssueId, startPlayback,
    updateWorkspacePreference, visibleStoryFlows, workspaceGraph
  });

  async function openDialogueEditor(node: Node<NarrativeNodeData>) {
    const fallbackDocument = node.data.dialogueDocument ?? createEmptyDialogueDocument();
    const dialogueNodeId = node.data.canonicalNodeId ?? node.id;
    selectItem({ type: "node", id: node.id });
    setDialogueDraft(fallbackDocument);
    setDialogueLoadError(null);
    setDialogueLoading(false);
    setDialog("edit-dialogue");

    if (!runtimeAuthoringAvailable) {
      return;
    }
    setDialogueLoading(true);
    try {
      setDialogueDraft(await runtimePersistence.loadDialogueDocument(dialogueNodeId));
    } catch (error) {
      // The seeded/local document remains editable when the desktop runtime is unavailable.
      setDialogueLoadError(error instanceof Error ? error.message : "Dialogue loading failed");
    } finally {
      setDialogueLoading(false);
    }
  }

  async function openQuestEditor(node: Node<NarrativeNodeData>) {
    const fallbackDocument = node.data.questDocument ?? createQuestDocument(node.data.title, node.data.summary);
    const questNodeId = node.data.canonicalNodeId ?? node.id;
    selectItem({ type: "node", id: node.id });
    setQuestDraft(fallbackDocument);
    setQuestLoadError(null);
    setQuestLoading(false);
    setDialog("edit-quest");
    if (!runtimeAuthoringAvailable) return;
    setQuestLoading(true);
    try {
      setQuestDraft(await runtimePersistence.loadQuestDocument(questNodeId));
    } catch (error) {
      // Seeded and local Quest documents remain editable without the runtime.
      setQuestLoadError(error instanceof Error ? error.message : "Quest loading failed");
    } finally {
      setQuestLoading(false);
    }
  }

  async function analyzeScene(title: string, sceneText: string) {
    setSceneAnalysisError(null);
    setSceneOperationDecisions({});
    setSelectedAnalysisOperation(null);
    setSceneAnalysisLoading(true);
    try {
      const result = await runtimePersistence.analyzeScene(activeProjectId, title, sceneText);
      setSceneAnalysisResult(result);
    } catch (error) {
      const message = analysisErrorMessage(error);
      if (durableAuthoring) {
        setSceneAnalysisResult(null);
        setSceneAnalysisError(message);
        return;
      }
      const localResult = buildLocalSceneAnalysisPreview(activeProjectId, title, sceneText, nodes, edges);
      const remainingOperations = localResult.patch.operations.filter((operation) => !localReviewedOperations[operationFingerprint(operation)]);
      setSceneAnalysisResult({
        ...localResult,
        patch: {
          ...localResult.patch,
          operations: remainingOperations
        },
        warnings: remainingOperations.length ? localResult.warnings : ["No applicable graph changes were found."]
      });
      setSceneAnalysisError(`${message.replace(/[.]+$/, "")}. Showing local preview.`);
    } finally {
      setSceneAnalysisLoading(false);
    }
  }

  function clearSceneAnalysis() {
    setSceneAnalysisResult(null);
    setSceneAnalysisError(null);
    setSceneOperationDecisions({});
    setSelectedAnalysisOperation(null);
  }

  async function decideSceneOperation(operationIndex: number, decision: OperationDecision) {
    const suggestionId = sceneAnalysisResult?.suggestion_id;
    setSceneAnalysisError(null);
    setSceneDecisionLoading(true);
    try {
      if (!suggestionId) {
        const operation = sceneAnalysisResult?.patch.operations[operationIndex];
        if (!operation) {
          return;
        }
        if (decision === "approved") {
          applyLocalAnalysisOperation(operation, nodes, {
            addEdge: addEdgeBetweenNodes,
            addNode: (draft) => addNodeAt(draft, nextAnalysisNodePosition(nodes.length)),
            updateEdge,
            updateNode
          });
        }
        setLocalReviewedOperations((current) => ({ ...current, [operationFingerprint(operation)]: decision }));
        setSceneOperationDecisions((current) => ({ ...current, [operationIndex]: decision }));
      } else {
        const updated =
          decision === "approved"
            ? await runtimePersistence.approveSuggestionOperation(suggestionId, operationIndex)
            : await runtimePersistence.rejectSuggestionOperation(suggestionId, operationIndex);
        setSceneOperationDecisions(operationDecisionsFromMetadata(updated.metadata));
        if (decision === "approved") {
          await loadRuntimeSnapshot(() => runtimePersistence.loadGraphSnapshot(activeProjectId));
        }
      }
      setSelectedAnalysisOperation(null);
    } catch (error) {
      setSceneAnalysisError(error instanceof Error ? error.message : "Suggestion operation decision failed");
    } finally {
      setSceneDecisionLoading(false);
    }
  }


  const { runCanonCheck, cancelCanonCheck, runImpactAnalysis, cancelImpactAnalysis, runImpactResolution, cancelImpactResolution, decideImpactResolution, verifyApprovedImpactResolution, verifyApprovedImpactResolutionCanon, editImpactResolution, reviewCanonIssue, requestCanonSuggestion, exploreCanonIssue, repairCanonIssue, decideCanonSuggestion } = createAnalysisProviderController({
    activeProjectId, activeProjectManifest, activeProjectSession, activeSessionId,
    canonIssues, canonMode, canonOperation, canonRun, canonSuggestion, impactCaller,
    impactOperation, impactOriginRef, impactResolutionOperation, impactResolutionRun,
    impactRun, impactSeeds, loadRuntimeSnapshot, projectHistory, rehydrateHistoryProject,
    runtimePersistence, setCanonError, setCanonIssues, setCanonMode, setCanonNotice,
    setCanonOpen, setCanonOperation, setCanonRun, setCanonSuggestion, setContextMenu,
    setImpactCaller, setImpactError, setImpactOpen, setImpactOperation,
    setImpactResolutionError, setImpactResolutionOperation, setImpactResolutionRun,
    setImpactResolutionVerificationPending, setImpactRun, setImpactSeeds,
    setLastAnalysisTool, setProjectHistory, setProjectSessionState,
    setSceneAnalysisOpen, setSelectedCanonIssueId
  });

  async function saveProjectAs(command: {
    identity: "preserve" | "regenerate";
    path: string;
    replace_existing: boolean;
  }): Promise<ProjectSessionSaveAsResponse> {
    if (!activeSessionId || !activeProjectSession) {
      throw new Error(tr("save.noActiveProject"));
    }
    const copied = await runtimePersistence.saveProjectSessionAs(activeSessionId, {
      ...command,
      expected_revision: activeProjectSession.saved_revision
    });
    if (useGraphStore.getState().activeSessionId === activeSessionId) setProjectSessionState(copied.source_session);
    return copied;
  }

  async function saveProjectSettings(
    name: string,
    description: string,
    settings: ProjectSettings
  ): Promise<void> {
    if (!activeSessionId) throw new Error("No active project session");
    const accepted = await loadRuntimeSnapshot(async () => projectSessionToGraphSnapshot(
      await runtimePersistence.updateProjectSettings(activeSessionId, {
        name,
        description,
        settings,
        expected_history_revision: projectHistory?.history_revision ?? 0
      })
    ));
    if (!accepted) return;
    noteAuthoringMutation();
    setDialog(null);
  }

  async function migrateProjectStorage(
    targetMode: "local_sqlite" | "postgresql",
    targetProfileId: string | null
  ): Promise<void> {
    if (!activeSessionId || !activeProjectSession) {
      throw new Error("No active project session");
    }
    const accepted = await loadRuntimeSnapshot(async () => projectSessionToGraphSnapshot((await runtimePersistence.migrateStorage({
      session_id: activeSessionId, expected_revision: activeProjectSession.saved_revision,
      target_mode: targetMode, target_profile_id: targetProfileId
    })).project));
    if (!accepted) return;
    setDialog(null);
  }

  async function requestProjectAction(action: PendingProjectAction): Promise<void> {
    if (action.kind === "close" && action.nativeRequestId !== undefined) setPlaybackOpen(false);
    const currentSession = useGraphStore.getState().activeProjectSession;
    if (currentSession && currentSession.save_status !== "clean") {
      setPendingProjectAction(action);
      setDialog("close-project");
      return;
    }
    await executeProjectAction(action);
  }

  async function executeProjectAction(action: PendingProjectAction) {
    if (action.kind === "close") {
      const sessionId = useGraphStore.getState().activeSessionId;
      try {
        if (sessionId) await closeAcquiredSession(runtimePersistence.closeProjectSession, sessionId);
        // Only runtime confirmation releases ownership; a failed request must
        // leave the workspace available for Save, Discard, Cancel, or retry.
        if (useGraphStore.getState().activeSessionId !== sessionId) {
          if (action.nativeRequestId !== undefined) await resolveNativeClose(action.nativeRequestId, false);
          return;
        }
        if (action.nativeRequestId !== undefined) await resolveNativeClose(action.nativeRequestId, true);
        closeActiveProject();
      } catch (error) {
        reportProjectActionFailure(action, sessionId, error);
      }
      return;
    }
    if (action.kind === "open") {
      await switchProjectNow(action.path);
      return;
    }
    await createProjectNow(action.request);
  }

  async function resolvePendingProjectAction(decision: "save" | "discard") {
    if (!pendingProjectAction || !activeSessionId) return;
    const sessionId = activeSessionId;
    const action = pendingProjectAction;
    if (decision === "save" && !(await saveProject("close"))) return;
    if (decision === "discard") {
      try {
        const discarded = await runtimePersistence.discardProjectSession(sessionId);
        if (useGraphStore.getState().activeSessionId !== sessionId) return;
        setProjectSessionState(discarded.session);
      } catch (error) {
        reportProjectActionFailure(action, sessionId, error);
        return;
      }
    }
    if (useGraphStore.getState().activeSessionId !== sessionId) return;
    setPendingProjectAction(null);
    setDialog(null);
    await executeProjectAction(action);
  }

  useEffect(() => registerNativeCloseHandler((nativeRequestId) =>
    requestProjectAction({ kind: "close", nativeRequestId })));

  async function cancelPendingProjectAction() {
    if (pendingProjectAction?.kind === "close" && pendingProjectAction.nativeRequestId !== undefined) {
      try { await resolveNativeClose(pendingProjectAction.nativeRequestId, false); }
      catch (error) { reportProjectActionFailure(pendingProjectAction, activeSessionId, error); return; }
    }
    setPendingProjectAction(null); setDialog(null);
  }

  function reportProjectActionFailure(action: PendingProjectAction, sessionId: string | null, error: unknown) {
    const current = useGraphStore.getState().activeProjectSession;
    if (!current || current.session_id !== sessionId) return;
    // A stale clean mirror can be rejected by the authoritative dirty guard.
    const unsaved = error instanceof RuntimeApiError && error.code === "project_unsaved_changes";
    setProjectSessionState({ ...current, save_status: unsaved ? "dirty" : "error",
      save_error: unsaved ? null : localizeRuntimeError(error) });
    setPendingProjectAction(action);
    setDialog("close-project");
  }

  async function switchProjectNow(projectPath: string) {
    const predecessor = useGraphStore.getState().activeSessionId;
    const opened = await enterProjectSession({ loadSnapshot: loadRuntimeSnapshot,
      acquire: async () => runtimePersistence.openProjectSession({ path: projectPath, recover_stale_lock: false }),
      beforeInstall: async () => { if (predecessor) await closeAcquiredSession(runtimePersistence.closeProjectSession, predecessor); },
      close: runtimePersistence.closeProjectSession, activeSessionId: () => useGraphStore.getState().activeSessionId,
      onReleaseFailure: reportEntryReleaseFailure });
    if (!opened || useGraphStore.getState().activeSessionId !== opened.session.session_id) return;
    attachProjectSession(opened.session.session_id);
    setDialog(null);
  }

  async function createProjectNow({ draft, storageProfile, initialStyle }: ProjectCreationRequest) {
    const parentDirectory = draft.path?.trim() || DEFAULT_WORKSPACE;
    const predecessor = useGraphStore.getState().activeSessionId;
    const configured = await enterProjectSession({ loadSnapshot: loadRuntimeSnapshot,
      acquire: async ({ retain, isCurrent }) => {
        const created = retain(await runtimePersistence.createProjectSession({ description: draft.description, name: draft.name,
          path: projectFolder(parentDirectory, draft.name), settings: draft.settings }));
        if (!isCurrent()) return created;
        const stored = retain(await configureNewProjectStorage(runtimePersistence, created, storageProfile));
        if (!isCurrent()) return stored;
        return retain(await configureNewProjectStyle(stored, initialStyle));
      },
      beforeInstall: async () => { if (predecessor) await closeAcquiredSession(runtimePersistence.closeProjectSession, predecessor); },
      close: runtimePersistence.closeProjectSession, activeSessionId: () => useGraphStore.getState().activeSessionId,
      onReleaseFailure: reportEntryReleaseFailure });
    if (!configured || useGraphStore.getState().activeSessionId !== configured.session.session_id) return;
    attachProjectSession(configured.session.session_id);
    setEmptyWorkflowProjectNames((names) => [...new Set([...names, draft.name])]);
    setDialog(null);
  }

  const sessionLifecycle = <ProjectSessionLifecycle
    canonSuggestionStatus={canonSuggestion?.status ?? null}
    resolutionOperation={impactResolutionOperation}
    resolutionRunStatus={impactResolutionRun?.status ?? null}
    onSave={saveProject}
    persistence={runtimePersistence}
  />;

  if (!activeProject) {
    return <>{sessionLifecycle}<main className="flex h-screen items-center justify-center bg-slate-50 text-slate-900">{tr("workspace.noProject")}</main></>;
  }

  if (playbackOpen) {
    const currentNodeId = playbackSession?.current_node_id;
    const currentNode = currentNodeId
      ? nodes.find((node) => node.id === currentNodeId)
        ?? nodes.find((node) => node.data.canonicalNodeId === currentNodeId)
        ?? null
      : null;
    const playbackNodeLabels = Object.fromEntries(
      nodes.map((node) => [node.data.canonicalNodeId ?? node.id, node.data.title])
    );
    const playbackTransitionLabels = Object.fromEntries(
      visibleStoryFlows.flatMap((flow) => [
        ...flow.transitions.map((transition) => [
          transition.id,
          transition.label || `${playbackNodeLabels[transition.source_node_id] ?? transition.source_node_id} to ${playbackNodeLabels[transition.target_node_id] ?? transition.target_node_id}`
        ] as const),
        ...(flow.invocations ?? []).map((invocation) => [invocation.id, invocation.label || invocation.id] as const)
      ])
    );
    const playbackFlowNames = Object.fromEntries(visibleStoryFlows.map((flow) => [flow.flow.id, flow.flow.name]));
    return (
      <>
      {sessionLifecycle}
      <CanonIssueActionProvider value={{
        busy: canonOperation === "reviewing",
        error: canonError,
        issues: canonIssues?.issues ?? [],
        notice: canonNotice,
        onNavigate: (owner, issue) => openCanonIssueTarget(owner, "source", issue),
        onRepair: repairCanonIssue,
        onReview: (issueId, status) => void reviewCanonIssue(issueId, status)
      }}>
      <main className="h-screen overflow-hidden bg-slate-50 text-slate-900">
        <PlaybackWorkspace
          headerActions={<RemoteRecoveryLauncher />}
          announcement={playbackAnnouncement}
          busy={playbackBusy}
          canonFocus={canonDiagnosticFocus}
          error={playbackError}
          flowName={activeStoryFlow?.flow.name ?? "Story Flow"}
          flowNames={playbackFlowNames}
          localFixture={false}
          loading={playbackLoading}
          node={currentNode}
          nodeLabels={playbackNodeLabels}
          onBack={() => void backPlayback()}
          onChoose={(selection) => void choosePlaybackSelection(selection)}
          onExit={exitPlayback}
          onOpenSource={openPlaybackSource}
          onRestart={() => void restartPlayback()}
          onRetry={() => void startPlayback()}
          preparationFacts={playbackPreparationFacts}
          session={playbackSession}
          transitionLabels={playbackTransitionLabels}
        />
      </main>
      </CanonIssueActionProvider>
      </>
    );
  }

  return <>{sessionLifecycle}<AppWorkspaceView {...{
    acceptProgressionMigration, activeProject, activeProjectId, activeProjectManifest, activeProjectSession, activeSessionId,
    activeStoryFlow, addFactionMember, addFrameAt, addLinkedInstance, addNodeAt, alternatePanGestureRef, applyStyleRewriteApproval,
    analysisHeaderButtonRef, analyzeScene, archiveStoryFlow, beginFlowConnection, boundarySceneId, cancelCanonCheck,
    cancelImpactAnalysis, cancelImpactResolution, canonDiagnosticFocus, canonError, canonFocusedOwner, canonicalSceneChildren,
    canonIssues, canonMode, canonNotice, canonOpen, canonOperation, canonRun,
    canonSuggestion, canvasEdges, canvasSelection, chooseGraphConnection, chooseStoryFlow, chooseTool,
    chooseWorkspaceMode, closeFrameWorkspace, closeImpactWorkspace, completeGraphConnection, completeGroupMove, completeNodeDrop,
    compositionDropRef, compositionNotice, confirmStoryFlowDeletion, confirmStoryFlowEntry, connectionSourceId, connectionTargetId,
    continueFrameDraw, continueStoryFlow, createDialogueTransition, createFlowExit, createFlowInvocation,
    createQuestTransition, createStoryFlow, createWorldbuildingNode, decideCanonSuggestion, decideImpactResolution, decideSceneOperation,
    deleteCanvasSelection, deleteEdge, deleteFlowInvocation, deleteNode, deleteSceneBoundary, deleteSpecializedOutcome,
    dialogueDraft, dialogueLoadError, dialogueLoading, dragStartNodesRef, edgeDefaults,
    edges, editImpactResolution, editStoryNode, emptyStarterError, emptyStarterLoading, emptyWorkflowNotice,
    entryCandidateId, filteredFlowTransitionCount, filteredGraph, filteredNodeCount, filteredRelationshipCount, finishFrameDraw,
    flowActionError, flowAuthoringSourceId, flowAuthoringTargetId, flowDeleteImpact, flowExitSourceId, flowIntegrityReport,
    flowInvocationSourceId, focusedFrameId, focusNode, focusSelectedNeighborhood, frameAddMenuId,
    frameDraw, getActiveGraph, getIntersectingNodes, graphFilter, graphWithImpactHighlights,
    graphWithNavigationOverlays, groupDragActiveRef, groupDragSelectionRef, historyBusy, historyError, impactBlockedCallerKey,
    impactCaller, impactError, impactExperiences, impactOpen, impactOperation, impactResolutionError,
    impactResolutionOperation, impactResolutionProviderConfigured, impactResolutionRun, impactResolutionVerificationPending, impactResourceForEdge, impactResourceForNode,
    impactResourceLabel, impactRun, impactSeeds, integrateOutcomeIntoFlow, lastAnalysisTool, localIntegrityReport,
    migrateProjectStorage, narrativeStateSnapshot, nodes, onConnect, onEdgesChange, onNodesChange,
    openCanonIssueTarget, openComposedStorySource, openContinueFlow, openDialogueEditor, openFlowExit, openFlowInvocation,
    openImpactFinding, openImpactResolutionChange, openImpactStoryProjection, openImpactWorkspace, openOutcomeFlow, openProgressionMigration,
    openQuestEditor, openStoryNodeInWorkspace, openTemporalEffectOwner, outcomeDeletionImpact, outcomeFlowEdge, outcomeReturnDialog,
    outcomeStoryFlowNames, pendingGraphConnection, pendingProjectAction, playbackPlayButtonRef, playbackSession, previewStoryFlowDeletion,
    progressionLoading, progressionReview, projectHistory, projectStoryFlows, questDraft,
    questLoadError, questLoading, reconnectEdge, reconnectFlowTransition, redoButtonRef, rejectProgressionMigration,
    relationshipInspection, removeFactionMember, removeFlowTransition, renameStoryFlow, renderNarrativeEffects, reorderFlowTransition,
    repairCanonIssue, requestProjectAction, resolvePendingProjectAction, cancelPendingProjectAction, returnToPlayback, reviewCanonIssue, runCanonCheck,
    runImpactAnalysis, runImpactResolution, runProjectHistory, runtimePersistence, savedConfirmationRef, saveFlowExitBinding,
    saveProject, saveProjectAs, saveProjectSettings, saveSceneBoundary, sceneAnalysisError, sceneAnalysisLoading,
    sceneAnalysisOpen, sceneAnalysisResult, sceneDecisionLoading, sceneOperationDecisions, screenToFlowPosition, selectAnalysisTool,
    selectCanonIssue, selectCanvasElement, selectedAnalysisOperation, selectedCanonIssueId, selectedEdge, selectedEdgeIssues,
    selectedFactionMembers, selectedFlowInvocation, selectedFlowTransition, selectedImpactSeeds, selectedNode, selectedNodeIssues,
    selectedTemporalEffects, selection, selectItem, setCanonFocusedOwner, setCanonMode, setCanonOpen,
    setCanvasSelection, setCompositionDrop, setCompositionNotice, setConnectionSourceId, setConnectionTargetId, setContextMenu,
    setDialog, setEntryCandidateId, setFlowActionError, setFrameAddMenuId, setGraphFilter,
    setImpactError, setImpactResolutionError, setImpactResolutionRun, setImpactResolutionVerificationPending, setImpactRun,
    setOutcomeFlowEdge, setPendingGraphConnection, setPendingProjectAction, setSceneAnalysisOpen, setSelectedAnalysisOperation,
    setSelectedInvocationId, setSelectedTemporalOwner, setToolMode, showEmptyProjectStart, spacePanActiveRef, startEmptyProjectStory,
    startFrameDraw, startPlayback, storyDocument, suppressPaneClickRef, temporalStateProjection, toolMode,
    totalNodeCount, undoButtonRef, updateDialogueDocument, updateEdge, updateNode, updateQuestDocument,
    updateStoryTransition, updateWorkspacePreference, verifyApprovedImpactResolution, verifyApprovedImpactResolutionCanon, visibleNodes, visibleStoryFlows,
    workspaceMode, sceneTextImportEnabled
  }} /></>;
}

import type {
CanonCheckRun,
CanonFixSuggestion,
CanonIssueListResponse,
CanonOwnerRef,
CanonRunMode
} from "@something-to-tell/contracts/canon-check";
import type {
ImpactAnalysisRun,
ImpactSeed
} from "@something-to-tell/contracts/impact-analysis";
import {
type ImpactResolutionRun
} from "@something-to-tell/contracts/impact-resolution";
import type { NarrativeEffectOwnerRef } from "@something-to-tell/contracts/narrative-state";
import type { ProjectHistorySummary } from "@something-to-tell/contracts/project-history";
import {
type Edge,
type Node
} from "@xyflow/react";
import { useCallback,useEffect,useRef,useState,type Dispatch,type SetStateAction } from "react";
import { type DialogueDocument } from "../../dialogue/contracts";
import type { NarrativeStateSnapshot } from "../../narrative-state/contracts";
import {
type PlaybackWorkspaceError
} from "../../playback/PlaybackWorkspace";
import type { PlaybackFact,PlaybackSession } from "../../playback/contracts";
import { type QuestDocument } from "../../quest/contracts";
import { type StoryFlowBootstrapDraft,type StoryFlowDeletionImpact,type StoryFlowIntegrityReport,type StoryFlowSnapshot } from "../../story-flow/contracts";
import {
type ProgressionDecision,
type ProgressionMigrationReview
} from "../../story-flow/progressionMigration";
import {
type ProjectWorkspacePreference,
type WorkspaceMode
} from "../../story-flow/workspace";
import {
createCanvasSelection,
type CanvasSelection,
type NarrativeEdgeData,
type NarrativeNodeData,
type SceneAnalysisResponse
} from "../../types";


import { readWorkspacePreferences } from "../story/storyFlowLocal";
import type { AnalysisTool,FrameDrawState,GraphFilterState,ImpactCaller,OperationDecision,PendingGraphConnection,PendingProjectAction,ToolMode } from "../workspaceShared";
import { ISSUE_SEVERITIES,NODE_KINDS,sameCanvasSelection } from "../workspaceShared";

interface WorkspaceStateOptions {
  activeProjectId: string;
  initialAnalysisTool?: AnalysisTool;
  initialStoryFlowsByProject: Record<string, StoryFlowSnapshot[]>;
}

/** Owns transient workspace UI state while canonical authoring data remains in the graph store. */
export function useWorkspaceState({ activeProjectId, initialAnalysisTool = "canon", initialStoryFlowsByProject }: WorkspaceStateOptions) {

  const [narrativeStateSnapshot, setNarrativeStateSnapshot] = useState<NarrativeStateSnapshot | null>(null);
  const [selectedTemporalOwner, setTemporalOwner] = useState<NarrativeEffectOwnerRef | null>(null);
  const setSelectedTemporalOwner = useCallback<Dispatch<SetStateAction<NarrativeEffectOwnerRef | null>>>((action) => {
    setTemporalOwner((current) => {
      const next = typeof action === "function" ? action(current) : action;
      return current === next || (current && next
        && current.owner_version === next.owner_version && current.owner_kind === next.owner_kind
        && current.owner_id === next.owner_id && current.context_node_id === next.context_node_id)
        ? current : next;
    });
  }, []);
  const [pendingProjectAction, setPendingProjectAction] = useState<PendingProjectAction | null>(null);
  const [graphFilter, setGraphFilter] = useState<GraphFilterState>({
    issueSeverities: ISSUE_SEVERITIES,
    issueStatuses: ["open", "review"],
    kinds: NODE_KINDS,
    query: ""
  });
  const [canvasSelection, setCanvasSet] = useState<CanvasSelection>(() => createCanvasSelection());
  // Compare inside React's queue so batched direct/functional updates retain their order.
  const setCanvasSelection = useCallback<Dispatch<SetStateAction<CanvasSelection>>>((action) => {
    setCanvasSet((current) => {
      const next = typeof action === "function" ? action(current) : action;
      return sameCanvasSelection(current, next) ? current : next;
    });
  }, []);
  const [sceneAnalysisOpen, setSceneAnalysisOpen] = useState(false);
  const [lastAnalysisTool, setLastAnalysisTool] = useState<AnalysisTool>(initialAnalysisTool);
  const [canonOpen, setCanonOpen] = useState(false);
  const [canonRun, setCanonRun] = useState<CanonCheckRun | null>(null);
  const [canonIssues, setCanonIssues] = useState<CanonIssueListResponse | null>(null);
  const [selectedCanonIssueId, setSelectedCanonIssueId] = useState<string | null>(null);
  const [canonFocusedOwner, setCanonFocusedOwner] = useState<CanonOwnerRef | null>(null);
  const [canonSuggestion, setCanonSuggestion] = useState<CanonFixSuggestion | null>(null);
  const [canonMode, setCanonMode] = useState<CanonRunMode>("deterministic");
  const [canonOperation, setCanonOperation] = useState<"loading" | "running" | "cancelling" | "reviewing" | null>(null);
  const [canonError, setCanonError] = useState<string | null>(null);
  const [canonNotice, setCanonNotice] = useState<string | null>(null);
  const selectCanonIssue = useCallback((issueId: string | null) => {
    setCanonFocusedOwner(null);
    setSelectedCanonIssueId(issueId);
  }, []);
  const [impactOpen, setImpactOpen] = useState(false);
  const [impactSeeds, setImpactSeeds] = useState<ImpactSeed[]>([]);
  const [impactRun, setImpactRun] = useState<ImpactAnalysisRun | null>(null);
  const [impactOperation, setImpactOperation] = useState<"starting" | "cancelling" | null>(null);
  const [impactError, setImpactError] = useState<string | null>(null);
  const [impactResolutionRun, setImpactResolutionRun] = useState<ImpactResolutionRun | null>(null);
  const [impactResolutionOperation, setImpactResolutionOperation] = useState<
    "starting" | "cancelling" | "approving" | "rejecting" | "editing" | null
  >(null);
  const [impactResolutionError, setImpactResolutionError] = useState<string | null>(null);
  const [impactResolutionVerificationPending, setImpactResolutionVerificationPending] = useState(false);
  const [impactCaller, setImpactCaller] = useState<ImpactCaller | null>(null);
  const [impactBlockedCallerKey, setImpactBlockedCallerKey] = useState<string | null>(null);
  const [sceneAnalysisResult, setSceneAnalysisResult] = useState<SceneAnalysisResponse | null>(null);
  const [sceneAnalysisError, setSceneAnalysisError] = useState<string | null>(null);
  const [sceneAnalysisLoading, setSceneAnalysisLoading] = useState(false);
  const [sceneDecisionLoading, setSceneDecisionLoading] = useState(false);
  const [sceneOperationDecisions, setSceneOperationDecisions] = useState<Record<number, OperationDecision>>({});
  const [localReviewedOperations, setLocalReviewedOperations] = useState<Record<string, OperationDecision>>({});
  const [selectedAnalysisOperation, setSelectedAnalysisOperation] = useState<number | null>(null);
  const [toolMode, setToolMode] = useState<ToolMode>("select");
  const [frameDraw, setFrameDraw] = useState<FrameDrawState | null>(null);
  const frameDrawRef = useRef<FrameDrawState | null>(null);
  const suppressPaneClickRef = useRef(false);
  const spacePanActiveRef = useRef(false);
  const alternatePanGestureRef = useRef(false);
  const dragStartNodesRef = useRef<Node<NarrativeNodeData>[] | null>(null);
  const groupDragActiveRef = useRef(false);
  const groupDragSelectionRef = useRef<CanvasSelection | null>(null);
  const workspaceFitTimeoutRef = useRef<number | null>(null);
  const undoButtonRef = useRef<HTMLButtonElement | null>(null);
  const redoButtonRef = useRef<HTMLButtonElement | null>(null);
  const analysisHeaderButtonRef = useRef<HTMLButtonElement | null>(null);
  const impactOriginRef = useRef<HTMLElement | null>(null);
  const [projectHistory, setProjectHistory] = useState<ProjectHistorySummary | null>(null);
  const [historyRefreshRevision, setHistoryRefreshRevision] = useState(0);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [compositionDrop, setCompositionDrop] = useState<{ frameId: string; message: string; valid: boolean } | null>(null);
  const compositionDropRef = useRef<{ frameId: string; message: string; valid: boolean } | null>(null);
  const [compositionNotice, setCompositionNotice] = useState<string | null>(null);
  const [frameAddMenuId, setFrameAddMenuId] = useState<string | null>(null);
  const [focusedFrameId, setFocusedFrameId] = useState<string | null>(null);
  const [connectionSourceId, setConnectionSourceId] = useState<string | null>(null);
  const [connectionTargetId, setConnectionTargetId] = useState<string | null>(null);
  const [pendingGraphConnection, setPendingGraphConnection] = useState<PendingGraphConnection | null>(null);
  const [dialogueDraft, setDialogueDraft] = useState<DialogueDocument | null>(null);
  const [dialogueLoadError, setDialogueLoadError] = useState<string | null>(null);
  const [dialogueLoading, setDialogueLoading] = useState(false);
  const [questDraft, setQuestDraft] = useState<QuestDocument | null>(null);
  const [questLoadError, setQuestLoadError] = useState<string | null>(null);
  const [questLoading, setQuestLoading] = useState(false);
  const [storyFlowsByProject, setStoryFlowsByProject] = useState<Record<string, StoryFlowSnapshot[]>>(
    initialStoryFlowsByProject
  );
  const [workspacePreferences, setWorkspacePreferences] = useState<Record<string, ProjectWorkspacePreference>>(
    readWorkspacePreferences
  );
  const [flowDeleteImpact, setFlowDeleteImpact] = useState<StoryFlowDeletionImpact | null>(null);
  const [flowIntegrityReport, setFlowIntegrityReport] = useState<StoryFlowIntegrityReport | null>(null);
  const [flowActionError, setFlowActionError] = useState<string | null>(null);
  const [flowAuthoringSourceId, setFlowAuthoringSourceId] = useState<string | null>(null);
  const [flowAuthoringTargetId, setFlowAuthoringTargetId] = useState<string | null>(null);
  const [flowInvocationSourceId, setFlowInvocationSourceId] = useState<string | null>(null);
  const [flowExitSourceId, setFlowExitSourceId] = useState<string | null>(null);
  const [selectedInvocationId, setSelectedInvocationId] = useState<string | null>(null);
  const [entryCandidateId, setEntryCandidateId] = useState<string | null>(null);
  const [boundarySceneId, setBoundarySceneId] = useState<string | null>(null);
  const [outcomeFlowEdge, setOutcomeFlowEdge] = useState<Edge<NarrativeEdgeData> | null>(null);
  const [outcomeReturnDialog, setOutcomeReturnDialog] = useState<"edit-dialogue" | "edit-quest" | null>(null);
  const [progressionReview, setProgressionReview] = useState<ProgressionMigrationReview | null>(null);
  const [localProgressionDecisions, setLocalProgressionDecisions] = useState<ProgressionDecision[]>([]);
  const [progressionLoading, setProgressionLoading] = useState(false);
  const [emptyWorkflowProjectNames, setEmptyWorkflowProjectNames] = useState<string[]>([]);
  const [completedEmptyWorkflowProjectNames, setCompletedEmptyWorkflowProjectNames] = useState<string[]>([]);
  const [emptyStarterLoading, setEmptyStarterLoading] = useState<StoryFlowBootstrapDraft["kind"] | null>(null);
  const [emptyStarterError, setEmptyStarterError] = useState<string | null>(null);
  const [emptyWorkflowNotice, setEmptyWorkflowNotice] = useState<string | null>(null);

  useEffect(() => {
    // Session hydration replaces the global project snapshot; mirror its flow
    // collection when project identity changes without overwriting local edits.
    setStoryFlowsByProject((current) => ({
      ...current,
      [activeProjectId]: initialStoryFlowsByProject[activeProjectId] ?? []
    }));
  }, [activeProjectId, initialStoryFlowsByProject]);
  const [playbackOpen, setPlaybackOpen] = useState(false);
  const [playbackSession, setPlaybackSession] = useState<PlaybackSession | null>(null);
  const [playbackLoading, setPlaybackLoading] = useState(false);
  const [playbackBusy, setPlaybackBusy] = useState(false);
  const [playbackError, setPlaybackError] = useState<PlaybackWorkspaceError | null>(null);
  const [playbackPreparationFacts, setPlaybackPreparationFacts] = useState<PlaybackFact[]>([]);
  const [playbackAnnouncement, setPlaybackAnnouncement] = useState("");
  const playbackSubmittingRef = useRef(false);
  const playbackOriginModeRef = useRef<WorkspaceMode>("relationships");
  const playbackPlayButtonRef = useRef<HTMLButtonElement | null>(null);

  return { narrativeStateSnapshot, setNarrativeStateSnapshot, selectedTemporalOwner, setSelectedTemporalOwner, pendingProjectAction, setPendingProjectAction, graphFilter, setGraphFilter, canvasSelection, setCanvasSelection, sceneAnalysisOpen, setSceneAnalysisOpen, lastAnalysisTool, setLastAnalysisTool, canonOpen, setCanonOpen, canonRun, setCanonRun, canonIssues, setCanonIssues, selectedCanonIssueId, setSelectedCanonIssueId, canonFocusedOwner, setCanonFocusedOwner, canonSuggestion, setCanonSuggestion, canonMode, setCanonMode, canonOperation, setCanonOperation, canonError, setCanonError, canonNotice, setCanonNotice, selectCanonIssue, impactOpen, setImpactOpen, impactSeeds, setImpactSeeds, impactRun, setImpactRun, impactOperation, setImpactOperation, impactError, setImpactError, impactResolutionRun, setImpactResolutionRun, impactResolutionOperation, setImpactResolutionOperation, impactResolutionError, setImpactResolutionError, impactResolutionVerificationPending, setImpactResolutionVerificationPending, impactCaller, setImpactCaller, impactBlockedCallerKey, setImpactBlockedCallerKey, sceneAnalysisResult, setSceneAnalysisResult, sceneAnalysisError, setSceneAnalysisError, sceneAnalysisLoading, setSceneAnalysisLoading, sceneDecisionLoading, setSceneDecisionLoading, sceneOperationDecisions, setSceneOperationDecisions, localReviewedOperations, setLocalReviewedOperations, selectedAnalysisOperation, setSelectedAnalysisOperation, toolMode, setToolMode, frameDraw, setFrameDraw, frameDrawRef, suppressPaneClickRef, spacePanActiveRef, alternatePanGestureRef, dragStartNodesRef, groupDragActiveRef, groupDragSelectionRef, workspaceFitTimeoutRef, undoButtonRef, redoButtonRef, analysisHeaderButtonRef, impactOriginRef, projectHistory, setProjectHistory, historyRefreshRevision, setHistoryRefreshRevision, historyBusy, setHistoryBusy, historyError, setHistoryError, compositionDrop, setCompositionDrop, compositionDropRef, compositionNotice, setCompositionNotice, frameAddMenuId, setFrameAddMenuId, focusedFrameId, setFocusedFrameId, connectionSourceId, setConnectionSourceId, connectionTargetId, setConnectionTargetId, pendingGraphConnection, setPendingGraphConnection, dialogueDraft, setDialogueDraft, dialogueLoadError, setDialogueLoadError, dialogueLoading, setDialogueLoading, questDraft, setQuestDraft, questLoadError, setQuestLoadError, questLoading, setQuestLoading, storyFlowsByProject, setStoryFlowsByProject, workspacePreferences, setWorkspacePreferences, flowDeleteImpact, setFlowDeleteImpact, flowIntegrityReport, setFlowIntegrityReport, flowActionError, setFlowActionError, flowAuthoringSourceId, setFlowAuthoringSourceId, flowAuthoringTargetId, setFlowAuthoringTargetId, flowInvocationSourceId, setFlowInvocationSourceId, flowExitSourceId, setFlowExitSourceId, selectedInvocationId, setSelectedInvocationId, entryCandidateId, setEntryCandidateId, boundarySceneId, setBoundarySceneId, outcomeFlowEdge, setOutcomeFlowEdge, outcomeReturnDialog, setOutcomeReturnDialog, progressionReview, setProgressionReview, localProgressionDecisions, setLocalProgressionDecisions, progressionLoading, setProgressionLoading, emptyWorkflowProjectNames, setEmptyWorkflowProjectNames, completedEmptyWorkflowProjectNames, setCompletedEmptyWorkflowProjectNames, emptyStarterLoading, setEmptyStarterLoading, emptyStarterError, setEmptyStarterError, emptyWorkflowNotice, setEmptyWorkflowNotice, playbackOpen, setPlaybackOpen, playbackSession, setPlaybackSession, playbackLoading, setPlaybackLoading, playbackBusy, setPlaybackBusy, playbackError, setPlaybackError, playbackPreparationFacts, setPlaybackPreparationFacts, playbackAnnouncement, setPlaybackAnnouncement, playbackSubmittingRef, playbackOriginModeRef, playbackPlayButtonRef };
}

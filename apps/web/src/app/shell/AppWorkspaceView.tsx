import type {
CanonCheckRun,
CanonFixSuggestion,
CanonIssueListResponse,
CanonIssueProjection,
CanonOwnerRef,
CanonRunMode
} from "@something-to-tell/contracts/canon-check";
import { CanvasNodePresentation, CanvasNodePresentationBridge } from "../graph/CanvasNodePresentation";
import { CanvasSelectableReactFlow, TARGET_SELECTABLE_EXPERIMENT_ENABLED } from "../graph/CanvasSelectableReactFlow";
import { blockHandNodeArrow, STABLE_TOOL_INTERACTION_EXPERIMENT_ENABLED, useExperimentalToolInteractivity } from "../graph/canvasToolInteraction";
import { CanvasEdgeGeometryBridge } from "../graph/CanvasEdgeGeometryBridge";
import { CanvasMiniMap } from "../graph/CanvasMiniMap";
import type { FlowExit,FlowInvocation } from "@something-to-tell/contracts/composable-story-flow";
import type { EngineTagOwnerV1 } from "@something-to-tell/contracts/engine-tags";
import { HelpLauncher } from "../../help/HelpLauncher";
import type {
ImpactAnalysisRun,
ImpactFinding,
ImpactResourceRef,
ImpactSeed
} from "@something-to-tell/contracts/impact-analysis";
import {
type ImpactResolutionRun,
type ImpactSolutionAlternative,
type ImpactVisualChange
} from "@something-to-tell/contracts/impact-resolution";
import type { NarrativeEffectOwnerRef } from "@something-to-tell/contracts/narrative-state";
import type { ProjectHistorySummary } from "@something-to-tell/contracts/project-history";
import {
type ProjectManifestV2,
type ProjectSettings
} from "@something-to-tell/contracts/project-manifest";
import type { ProjectPatch } from "@something-to-tell/contracts/project-patch";
import type {
ProjectSessionSaveAsResponse,
ProjectSessionState
} from "@something-to-tell/contracts/project-session";
import {
Background,
ConnectionMode,
MarkerType,
Panel,
SelectionMode,
useReactFlow,
type Edge,
type Node,
type NodeChange,
type XYPosition
} from "@xyflow/react";
import {
FileOutput,
LocateFixed,
LogOut,
Menu,
Play,
Redo2,
ScanSearch,
  Settings,
  Tags,
Undo2,
X
} from "lucide-react";
import { type MouseEvent as ReactMouseEvent, useMemo, useState } from "react";
import { useProjectRailLayout } from "./ProjectRailLayout";
import { useWorkspaceDialog } from "./WorkspaceDialog";
import { useCanvasClickHandlers } from "./useCanvasClickHandlers";
import { useCanvasChangeHandlers } from "./useCanvasChangeHandlers";
import { useCanvasConnectionHandlers } from "./useCanvasConnectionHandlers";
import { useCanvasReconnectHandlers } from "./useCanvasReconnectHandlers";
import { useCanvasConnectionHoverHandlers } from "./useCanvasConnectionHoverHandlers";
import { useCanvasPanCaptureHandlers } from "./useCanvasPanCaptureHandlers";
import { useCanvasDragStartHandler } from "./useCanvasDragStartHandler";
import { useCanvasDragFeedbackHandler } from "./useCanvasDragFeedbackHandler";
import { useCanvasDragStopHandler } from "./useCanvasDragStopHandler";
import { useCanvasLinkedDropHandlers } from "./useCanvasLinkedDropHandlers";
import { type CanonDiagnosticFocus } from "../../canon/CanonDiagnosticMarker";
import { CanonIssueActionProvider, type CanonIssueActionController } from "../../canon/CanonIssueActions";
import { CanonWorkspace } from "../../canon/CanonWorkspace";
import { resolveCanonOwner } from "../../canon/navigation";
import { type DialogueDocument } from "../../dialogue/contracts";
import { ImpactWorkspace,type ImpactRunOptions } from "../../impact/ImpactWorkspace";
import { projectImpactHighlights } from "../../impact/navigation";
import {
tr
} from "../../localization/i18n";
import { RelationshipInitialHolderControl } from "../../narrative-state/EffectEditor";
import type { NarrativeStateSnapshot } from "../../narrative-state/contracts";
import { type TemporalEffectPresentation,type TemporalStateProjection } from "../../narrative-state/projection";
import type { PlaybackSession } from "../../playback/contracts";
import { type QuestDocument } from "../../quest/contracts";
import { createRuntimeApiClient } from "../../runtime/apiClient";
import type { RuntimeStyleRewriteApprovalResponse } from "../../runtime/apiTypes";
import { useGraphStore } from "../../state/graphStore";
import {
nextTransitionPriority
} from "../../story-flow/authoring";
import { type FlowTransition,type FlowTransitionDraft,type StoryFlowBootstrapDraft,type StoryFlowDeletionImpact,type StoryFlowIntegrityReport,type StoryFlowKind,type StoryFlowSnapshot } from "../../story-flow/contracts";
import {
type ProgressionCandidate,
type ProgressionMigrationReview
} from "../../story-flow/progressionMigration";
import { type StoryDocumentProjection } from "../../story-flow/storyDocument";
import {
type ProjectWorkspacePreference,
type WorkspaceMode
} from "../../story-flow/workspace";
import {
type CanvasSelection,
type DialogueTransitionDraft,
type EdgeDraft,
type FrameDraft,
type Selection as GraphSelection,
type NarrativeEdgeData,
type NarrativeIssue,
type NarrativeNodeData,
type NodeDraft,
type QuestTransitionDraft,
type SceneAnalysisResponse
} from "../../types";

import { AnalysisOperationDialog,SceneAnalysisPanel,buildGraphAnalysisText,sceneImpactCallerKey,scenePatchImpactResources } from "../../app/analysis/sceneAnalysis";
import { DialogueEditorDialog } from "../../app/dialogue/DialogueEditorDialog";
import { EngineTagPicker } from "../../app/engineTags/EngineTagPicker";
import { EngineTagsWorkspace } from "../../app/engineTags/EngineTagsWorkspace";
import { ExportWorkspace } from "../../export/ExportWorkspace";
import { EditEdgeDialog,EditNodeDialog } from "../../app/editors/EditNodeDialog";
import { CanvasZoomControl,EditFlowTransitionDialog,EmptyProjectStart,FlowTransitionPanel,NARRATIVE_NODE_TYPES,RelationshipPanel,STORY_FLOW_EDGE_TYPES,ToolRail,WorkspaceModeControl } from "../../app/graph/GraphCanvasParts";
import { CanvasFitControls } from "../graph/CanvasFitControls";
import { INITIAL_CANVAS_FIT_OPTIONS } from "../graph/canvasFitPadding";
import { FrameDrawPreview,defaultFrameDraft,defaultNodeDraft,frameKindForTool } from "../../app/graph/graphProjection";
import { CreateProjectDialog,DirectoryPickerDialog,OpenProjectDialog,SaveAsDialog } from "../../app/project/ProjectDialogs";
import { CurrentProjectPanel,DeleteEntityDialog,DeleteSelectionDialog,FrameAddDialog } from "../../app/project/ProjectPanels";
import { QuestEditorDialog } from "../../app/quest/QuestEditorDialog";
import { ProjectSettingsDialog } from "../../app/settings/ProjectSettingsDialogs";
import type { AgentMemoryDraftSeed } from "../../components/AgentMemoryDisclosure";
import { DialogShell } from "../../app/shared/DialogShell";
import { AnalysisControl } from "../../app/shell/HeaderControls";
import { StoryDocumentView,TemporalStateOverlayPanel } from "../../app/story/StoryDocumentView";
import { BuildWorldDialog,CallFlowDialog,ConnectionTypeDialog,ContinueFlowDialog,FlowCallBindingsDialog,FlowExitDialog,OutcomeFlowDialog,ProgressionMigrationDialog,SceneFlowBoundaryDialog,StoryFlowDeleteDialog,StoryFlowEditorDialog,StoryFlowEntryDialog } from "../../app/story/StoryFlowDialogs";
import { AnalysisTool,CANVAS_MAX_ZOOM,CANVAS_MIN_ZOOM,CanvasContextMenuState,DEFAULT_FRAME_SIZE,Dialog,FlowTransitionEdit,FrameDrawState,GraphFilterState,ImpactCaller,NarrativeNodeRenderData,OperationDecision,OutcomeDeletionImpact,OutcomeFlowCommand,PendingGraphConnection,PendingProjectAction,RelationshipInspection,SELECT_PAN_BUTTONS,ToolMode,displayNodeKind,impactSeedKeys,projectHistoryTooltip } from "../../app/workspaceShared";
export { buildAnalysisPreviewMaps,buildGraphAnalysisText,buildLocalSceneAnalysisPreview,createLinkedInstanceFromDrop } from "../../app/analysis/sceneAnalysis";
export { DialogueEditorDialog } from "../../app/dialogue/DialogueEditorDialog";
export { EditEdgeDialog } from "../../app/editors/EditNodeDialog";
export { FrameDescriptionControl } from "../../app/graph/GraphNodeContent";
export { applyIssueOverlays,applySelectionHighlights,buildRelationshipInspection,canvasEdgeType,factionMembers,filterGraphForView,filterIssuesForView,getNodeNeighborhood,hideDirectFrameChildEdges,hideSemanticEdges,nodeForWorkspaceFocus,nodePresentationMetrics,projectFrameWorkspace } from "../../app/graph/graphProjection";
export { CurrentProjectPanel,projectTreeEntries } from "../../app/project/ProjectPanels";
export { ProjectStartScreen } from "../../app/project/ProjectStartScreen";
export { ConnectionTypeDialog,FlowCallBindingsDialog,OutcomeFlowDialog,ProgressionMigrationDialog,SceneFlowBoundaryDialog } from "../../app/story/StoryFlowDialogs";
export { composableFlowErrorMessage,mergeAtomicOutcomeFlowResult } from "../../app/story/storyFlowLocal";
export { calculateFrameBounds,displayNodeKind,impactCallerBlockAfterClose,isEditableHistoryTarget,projectHistoryTooltip,withoutDoubleAppliedDescendantMoves } from "../../app/workspaceShared";


import type { SavedConfirmationHandle } from "./SaveStatusIndicator";
import { SessionCloseDialog, SessionSaveControl, SessionSaveIndicator, SessionStorageMigrationDialog } from "./SessionStatusViews";
import { GraphFilterToggle, HiddenWhileGraphFiltersOpen, VisibleGraphFilterBar } from "./GraphFilterVisibility";
import { FlowSummaryToggle, VisibleFlowSummary } from "./FlowSummaryVisibility";
import { CanvasContextMenu } from "./CanvasContextMenu";



import type { Connection,EdgeChange,SnapGrid } from "@xyflow/react";
import type { Dispatch,MutableRefObject,SetStateAction } from "react";
import type { ImpactExperienceProjection } from "../../impact/consequences";
import type { NarrativeProject } from "../../types";



export interface AppWorkspaceViewProps {
  acceptProgressionMigration: (candidate: ProgressionCandidate, command: { condition: string; flowId: string; kind: FlowTransitionDraft["kind"]; preserveRelationship: boolean; }) => Promise<void>;
  activeProject: NarrativeProject;
  activeProjectId: string;
  activeProjectManifest: ProjectManifestV2 | null;
  activeProjectSession: Omit<ProjectSessionState, "save_error" | "save_status"> | null;
  activeSessionId: string | null;
  activeStoryFlow: StoryFlowSnapshot | null;
  addFactionMember: (factionId: string, characterId: string) => { message: string; valid: boolean; };
  addFrameAt: (draft: FrameDraft, position: XYPosition, size: { height: number; width: number; }) => void;
  addLinkedInstance: (canonicalNodeId: string, frameId: string) => { message: string; valid: boolean; };
  addNodeAt: (draft: NodeDraft, position: XYPosition) => void;
  alternatePanGestureRef: MutableRefObject<boolean>;
  applyStyleRewriteApproval: (response: RuntimeStyleRewriteApprovalResponse) => Promise<void>;
  analysisHeaderButtonRef: MutableRefObject<HTMLButtonElement | null>;
  analyzeScene: (title: string, sceneText: string) => Promise<void>;
  archiveStoryFlow: (snapshot: StoryFlowSnapshot) => Promise<void>;
  beginFlowConnection: (sourceNodeId: string, targetNodeId: string) => Promise<void>;
  boundarySceneId: string | null;
  cancelCanonCheck: () => Promise<void>;
  cancelImpactAnalysis: () => Promise<void>;
  cancelImpactResolution: () => Promise<void>;
  canonDiagnosticFocus: CanonDiagnosticFocus | null;
  canonError: string | null;
  canonFocusedOwner: CanonOwnerRef | null;
  canonicalSceneChildren: (sceneNodeId: string) => Node<NarrativeNodeData>[];
  canonIssues: CanonIssueListResponse | null;
  canonMode: CanonRunMode;
  canonNotice: string | null;
  canonOpen: boolean;
  canonOperation: "loading" | "running" | "cancelling" | "reviewing" | null;
  canonRun: CanonCheckRun | null;
  canonSuggestion: CanonFixSuggestion | null;
  canvasEdges: Edge<NarrativeEdgeData>[];
  canvasSelection: CanvasSelection;
  chooseGraphConnection: (connection: PendingGraphConnection) => void;
  chooseStoryFlow: (flowId: string) => void;
  chooseTool: (mode: ToolMode) => void;
  chooseWorkspaceMode: (mode: WorkspaceMode) => void;
  closeFrameWorkspace: () => void;
  closeImpactWorkspace: () => void;
  completeGraphConnection: (intent: "relationship" | "flow") => void;
  completeGroupMove: (previousNodes: Node<NarrativeNodeData>[]) => void;
  completeNodeDrop: (nodeId: string, targetFrameId: string | null, previousNodes: Node<NarrativeNodeData>[]) => { message: string; valid: boolean; };
  compositionDropRef: MutableRefObject<{ frameId: string; message: string; valid: boolean; } | null>;
  compositionNotice: string | null;
  confirmStoryFlowDeletion: () => Promise<void>;
  confirmStoryFlowEntry: () => Promise<void>;
  connectionSourceId: string | null;
  connectionTargetId: string | null;
  continueFrameDraw: (event: ReactMouseEvent<HTMLDivElement>) => void;
  continueStoryFlow: (command: { mode: "existing" | "new"; targetNodeId: string; node: NodeDraft; transition: FlowTransitionDraft; }) => Promise<void>;
  createDialogueTransition: (draft: DialogueTransitionDraft) => void;
  createFlowExit: (key: string, label: string) => Promise<void>;
  createFlowInvocation: (command: { mode: "existing" | "new"; targetFlowId: string; newFlowName: string; label: string; condition: string; priority: number; isDefault: boolean; }) => Promise<void>;
  createQuestTransition: (draft: QuestTransitionDraft) => void;
  createStoryFlow: (draft: { description: string; kind: StoryFlowKind; name: string; }) => Promise<void>;
  createWorldbuildingNode: (draft: NodeDraft) => void;
  decideCanonSuggestion: (decision: "approved" | "rejected") => Promise<void>;
  decideImpactResolution: (alternative: ImpactSolutionAlternative, decision: "approved" | "rejected") => Promise<void>;
  decideSceneOperation: (operationIndex: number, decision: OperationDecision) => Promise<void>;
  deleteCanvasSelection: () => Promise<void>;
  deleteEdge: (edgeId: string) => void;
  deleteFlowInvocation: (invocation: FlowInvocation) => Promise<void>;
  deleteNode: (nodeId: string) => void;
  deleteSceneBoundary: () => Promise<void>;
  deleteSpecializedOutcome: (edgeId: string) => Promise<void>;
  dialogueDraft: DialogueDocument | null;
  dialogueLoadError: string | null;
  dialogueLoading: boolean;
  dragStartNodesRef: MutableRefObject<Node<NarrativeNodeData>[] | null>;
  edgeDefaults: { markerEnd: { type: MarkerType; color: string; }; reconnectable: boolean; style: { stroke: string; strokeWidth: number; }; };
  edges: Edge<NarrativeEdgeData>[];
  editImpactResolution: (alternative: ImpactSolutionAlternative, patch: ProjectPatch) => Promise<void>;
  editStoryNode: (node: Node<NarrativeNodeData>) => void;
  emptyStarterError: string | null;
  emptyStarterLoading: "Scene" | "Event" | null;
  emptyWorkflowNotice: string | null;
  entryCandidateId: string | null;
  filteredFlowTransitionCount: number;
  filteredGraph: { edges: Edge<NarrativeEdgeData>[]; nodes: Node<NarrativeNodeData>[]; };
  filteredNodeCount: number;
  filteredRelationshipCount: number;
  finishFrameDraw: () => void;
  flowActionError: string | null;
  flowAuthoringSourceId: string | null;
  flowAuthoringTargetId: string | null;
  flowDeleteImpact: StoryFlowDeletionImpact | null;
  flowExitSourceId: string | null;
  flowIntegrityReport: StoryFlowIntegrityReport | null;
  flowInvocationSourceId: string | null;
  focusedFrameId: string | null;
  focusNode: (node: { height?: number | null; id: string; position: XYPosition; width?: number | null; }) => void;
  focusSelectedNeighborhood: () => void;
  frameAddMenuId: string | null;
  frameDraw: FrameDrawState | null;
  getActiveGraph: ReturnType<typeof useGraphStore.getState>["getActiveGraph"];
  getIntersectingNodes: ReturnType<typeof useReactFlow>["getIntersectingNodes"];
  graphFilter: GraphFilterState;
  graphWithImpactHighlights: {
    edges: Edge<NarrativeEdgeData>[];
    nodes: Node<NarrativeNodeData>[];
    storyNodes: ReturnType<typeof projectImpactHighlights>["storyNodes"];
  };
  graphWithNavigationOverlays: Edge<NarrativeEdgeData>[];
  groupDragActiveRef: MutableRefObject<boolean>;
  groupDragSelectionRef: MutableRefObject<CanvasSelection | null>;
  historyBusy: boolean;
  historyError: string | null;
  impactBlockedCallerKey: string | null;
  impactCaller: ImpactCaller | null;
  impactError: string | null;
  impactExperiences: ImpactExperienceProjection;
  impactOpen: boolean;
  impactOperation: "cancelling" | "starting" | null;
  impactResolutionError: string | null;
  impactResolutionOperation: "cancelling" | "starting" | "approving" | "rejecting" | "editing" | null;
  impactResolutionProviderConfigured: boolean;
  impactResolutionRun: ImpactResolutionRun | null;
  impactResolutionVerificationPending: boolean;
  impactResourceForEdge: (edge: Edge<NarrativeEdgeData>) => ImpactResourceRef;
  impactResourceForNode: (node: Node<NarrativeNodeData>) => ImpactResourceRef;
  impactResourceLabel: (resource: ImpactResourceRef) => string;
  impactRun: ImpactAnalysisRun | null;
  impactSeeds: ImpactSeed[];
  integrateOutcomeIntoFlow: (command: OutcomeFlowCommand) => Promise<void>;
  lastAnalysisTool: AnalysisTool;
  localIntegrityReport: StoryFlowIntegrityReport | null;
  migrateProjectStorage: (targetMode: "local_sqlite" | "postgresql", targetProfileId: string | null) => Promise<void>;
  narrativeStateSnapshot: NarrativeStateSnapshot | null;
  nodes: Node<NarrativeNodeData>[];
  onConnect: (connection: Connection) => void;
  onEdgesChange: (changes: EdgeChange<Edge<NarrativeEdgeData>>[]) => void;
  onNodesChange: (changes: NodeChange<Node<NarrativeNodeData>>[]) => void;
  openCanonIssueTarget: (owner: CanonOwnerRef, destination: "flow" | "graph" | "source" | "story", issue?: CanonIssueProjection) => void;
  openComposedStorySource: (flowId: string, nodeId?: string) => void;
  openContinueFlow: (sourceNodeId: string, targetNodeId?: string | null) => void;
  openDialogueEditor: (node: Node<NarrativeNodeData>) => Promise<void>;
  openFlowExit: (sourceNodeId: string) => void;
  openFlowInvocation: (sourceNodeId: string) => void;
  openImpactFinding: (finding: ImpactFinding) => void;
  openImpactResolutionChange: (change: ImpactVisualChange) => void;
  openImpactStoryProjection: () => void;
  openImpactWorkspace: (resources?: ImpactResourceRef[], origin?: HTMLElement | null, caller?: ImpactCaller | null) => void;
  openOutcomeFlow: (edge: Edge<NarrativeEdgeData>, returnDialog: "edit-dialogue" | "edit-quest") => void;
  openProgressionMigration: () => Promise<void>;
  openQuestEditor: (node: Node<NarrativeNodeData>) => Promise<void>;
  openStoryNodeInWorkspace: (node: Node<NarrativeNodeData>, mode: "flow" | "relationships") => void;
  openTemporalEffectOwner: (owner: NarrativeEffectOwnerRef) => void;
  outcomeDeletionImpact: (edge: Edge<NarrativeEdgeData>) => OutcomeDeletionImpact;
  outcomeFlowEdge: Edge<NarrativeEdgeData> | null;
  outcomeReturnDialog: "edit-dialogue" | "edit-quest" | null;
  outcomeStoryFlowNames: (edge: Edge<NarrativeEdgeData>) => string[];
  pendingGraphConnection: PendingGraphConnection | null;
  pendingProjectAction: PendingProjectAction | null;
  playbackPlayButtonRef: MutableRefObject<HTMLButtonElement | null>;
  playbackSession: PlaybackSession | null;
  previewStoryFlowDeletion: (snapshot: StoryFlowSnapshot) => Promise<void>;
  progressionLoading: boolean;
  progressionReview: ProgressionMigrationReview | null;
  projectHistory: ProjectHistorySummary | null;
  projectStoryFlows: StoryFlowSnapshot[];
  questDraft: QuestDocument | null;
  questLoadError: string | null;
  questLoading: boolean;
  reconnectEdge: (edgeId: string, connection: Partial<Connection>) => void;
  reconnectFlowTransition: (transition: FlowTransition, sourceNodeId: string, targetNodeId: string) => Promise<void>;
  redoButtonRef: MutableRefObject<HTMLButtonElement | null>;
  rejectProgressionMigration: (candidate: ProgressionCandidate) => Promise<void>;
  relationshipInspection: RelationshipInspection | null;
  removeFactionMember: (factionId: string, characterId: string) => { message: string; valid: boolean; };
  removeFlowTransition: (transition: FlowTransition) => Promise<void>;
  renameStoryFlow: (draft: { description: string; kind: StoryFlowKind; name: string; }) => Promise<void>;
  renderNarrativeEffects: (owner: NarrativeEffectOwnerRef) => JSX.Element;
  reorderFlowTransition: (transition: FlowTransition, direction: -1 | 1) => Promise<void>;
  repairCanonIssue: (issue: CanonIssueProjection) => void;
  requestProjectAction: (action: PendingProjectAction) => Promise<void>;
  resolvePendingProjectAction: (decision: "save" | "discard") => Promise<void>;
  cancelPendingProjectAction: () => Promise<void>;
  returnToPlayback: () => Promise<void>;
  reviewCanonIssue: (issueId: string, status: "open" | "review" | "ignored") => Promise<void>;
  runCanonCheck: (remoteConsent?: boolean, requestedMode?: CanonRunMode) => Promise<void>;
  runImpactAnalysis: (options: ImpactRunOptions) => Promise<void>;
  runImpactResolution: (findingIds: string[], includeRejected?: boolean) => Promise<void>;
  runProjectHistory: (direction: "undo" | "redo") => Promise<void>;
  runtimePersistence: ReturnType<typeof createRuntimeApiClient>;
  savedConfirmationRef: MutableRefObject<SavedConfirmationHandle | null>;
  saveFlowExitBinding: (invocation: FlowInvocation, flowExit: FlowExit, targetNodeId: string) => Promise<void>;
  saveProject: (reason: "manual" | "autosave" | "close") => Promise<boolean>;
  saveProjectAs: (command: { identity: "preserve" | "regenerate"; path: string; replace_existing: boolean; }) => Promise<ProjectSessionSaveAsResponse>;
  saveProjectSettings: (name: string, description: string, settings: ProjectSettings) => Promise<void>;
  saveSceneBoundary: (entryNodeId: string, exitNodeIds: string[]) => Promise<void>;
  sceneAnalysisError: string | null;
  sceneAnalysisLoading: boolean;
  sceneAnalysisOpen: boolean;
  sceneAnalysisResult: SceneAnalysisResponse | null;
  sceneDecisionLoading: boolean;
  sceneOperationDecisions: Record<number, OperationDecision>;
  sceneTextImportEnabled: boolean;
  screenToFlowPosition: (clientPosition: XYPosition, options?: { snapToGrid?: boolean; snapGrid?: SnapGrid; }) => XYPosition;
  selectAnalysisTool: (tool: AnalysisTool, toggle?: boolean) => void;
  selectCanonIssue: (issueId: string | null) => void;
  selectCanvasElement: (type: "edge" | "node", id: string, additive: boolean) => void;
  selectedAnalysisOperation: number | null;
  selectedCanonIssueId: string | null;
  selectedEdge: Edge<NarrativeEdgeData> | null | undefined;
  selectedEdgeIssues: NarrativeIssue[];
  selectedFactionMembers: Node<NarrativeNodeData>[];
  selectedFlowInvocation: FlowInvocation | null;
  selectedFlowTransition: FlowTransition | null;
  selectedImpactSeeds: () => ImpactSeed[];
  selectedNode: Node<NarrativeNodeData> | null | undefined;
  selectedNodeIssues: NarrativeIssue[];
  selectedTemporalEffects: TemporalEffectPresentation[];
  selection: GraphSelection | null;
  selectItem: (selection: GraphSelection | null) => void;
  setCanonFocusedOwner: Dispatch<SetStateAction<CanonOwnerRef | null>>;
  setCanonMode: Dispatch<SetStateAction<CanonRunMode>>;
  setCanonOpen: Dispatch<SetStateAction<boolean>>;
  setCanvasSelection: Dispatch<SetStateAction<CanvasSelection>>;
  setCompositionDrop: Dispatch<SetStateAction<{ frameId: string; message: string; valid: boolean; } | null>>;
  setCompositionNotice: Dispatch<SetStateAction<string | null>>;
  setConnectionSourceId: Dispatch<SetStateAction<string | null>>;
  setConnectionTargetId: Dispatch<SetStateAction<string | null>>;
  setContextMenu: Dispatch<SetStateAction<CanvasContextMenuState | null>>;
  setDialog: Dispatch<SetStateAction<Dialog>>;
  setEntryCandidateId: Dispatch<SetStateAction<string | null>>;
  setFlowActionError: Dispatch<SetStateAction<string | null>>;
  setFrameAddMenuId: Dispatch<SetStateAction<string | null>>;
  setGraphFilter: Dispatch<SetStateAction<GraphFilterState>>;
  setImpactError: Dispatch<SetStateAction<string | null>>;
  setImpactResolutionError: Dispatch<SetStateAction<string | null>>;
  setImpactResolutionRun: Dispatch<SetStateAction<ImpactResolutionRun | null>>;
  setImpactResolutionVerificationPending: Dispatch<SetStateAction<boolean>>;
  setImpactRun: Dispatch<SetStateAction<ImpactAnalysisRun | null>>;
  setOutcomeFlowEdge: Dispatch<SetStateAction<Edge<NarrativeEdgeData> | null>>;
  setPendingGraphConnection: Dispatch<SetStateAction<PendingGraphConnection | null>>;
  setPendingProjectAction: Dispatch<SetStateAction<PendingProjectAction | null>>;
  setSceneAnalysisOpen: Dispatch<SetStateAction<boolean>>;
  setSelectedAnalysisOperation: Dispatch<SetStateAction<number | null>>;
  setSelectedInvocationId: Dispatch<SetStateAction<string | null>>;
  setSelectedTemporalOwner: Dispatch<SetStateAction<NarrativeEffectOwnerRef | null>>;
  setToolMode: Dispatch<SetStateAction<ToolMode>>;
  showEmptyProjectStart: boolean;
  spacePanActiveRef: MutableRefObject<boolean>;
  startEmptyProjectStory: (kind: StoryFlowBootstrapDraft["kind"]) => Promise<void>;
  startFrameDraw: (event: ReactMouseEvent<HTMLDivElement>) => void;
  startPlayback: (flowOverride?: StoryFlowSnapshot) => Promise<void>;
  storyDocument: StoryDocumentProjection;
  suppressPaneClickRef: MutableRefObject<boolean>;
  temporalStateProjection: TemporalStateProjection;
  toolMode: ToolMode;
  totalNodeCount: number;
  undoButtonRef: MutableRefObject<HTMLButtonElement | null>;
  updateDialogueDocument: (nodeId: string, document: DialogueDocument) => void;
  updateEdge: (edgeId: string, draft: EdgeDraft) => void;
  updateNode: (nodeId: string, draft: NodeDraft) => void;
  updateQuestDocument: (nodeId: string, document: QuestDocument) => void;
  updateStoryTransition: (transition: FlowTransition, updates: Partial<FlowTransitionEdit>) => Promise<boolean>;
  updateWorkspacePreference: (update: Partial<ProjectWorkspacePreference>) => void;
  verifyApprovedImpactResolution: () => Promise<void>;
  verifyApprovedImpactResolutionCanon: () => void;
  visibleNodes: Node<NarrativeNodeRenderData>[];
  visibleStoryFlows: StoryFlowSnapshot[];
  workspaceMode: "flow" | "story" | "relationships";
}

/** Renders the workspace surfaces from explicit controller state and commands. */
export function AppWorkspaceView(props: AppWorkspaceViewProps) {
  const { projectRailOpen, setProjectRailOpen } = useProjectRailLayout();
  const dialog = useWorkspaceDialog();
  const {
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
    sceneAnalysisOpen, sceneAnalysisResult, sceneDecisionLoading, sceneOperationDecisions, sceneTextImportEnabled, screenToFlowPosition, selectAnalysisTool,
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
    workspaceMode
  } = props;
  const [agentMemoryDraftSeed, setAgentMemoryDraftSeed] = useState<AgentMemoryDraftSeed | null>(null);
  const toolInteractivity = useExperimentalToolInteractivity(toolMode, STABLE_TOOL_INTERACTION_EXPERIMENT_ENABLED);
  const focusedFrame = nodes.find((node) => node.id === focusedFrameId);
  const clickHandlers = useCanvasClickHandlers({
    toolMode, workspaceMode, nodes, groupDragActiveRef, suppressPaneClickRef,
    selectCanvasElement, selectItem, setSelectedTemporalOwner, setSelectedAnalysisOperation,
    setContextMenu, setCanvasSelection, setToolMode, addNodeAt, addFrameAt, screenToFlowPosition,
    openDialogueEditor, openQuestEditor, setDialog, setSelectedInvocationId, impactResourceForNode, impactResourceForEdge
  });
  const changeHandlers = useCanvasChangeHandlers({
    alternatePanGestureRef, groupDragActiveRef, canvasSelection, setCanvasSelection,
    getActiveGraph, onNodesChange, onEdgesChange
  });
  const connectionHandlers = useCanvasConnectionHandlers({
    workspaceMode, connectionSourceId, connectionTargetId, beginFlowConnection,
    chooseGraphConnection, onConnect, setConnectionSourceId, setConnectionTargetId
  });
  const reconnectHandlers = useCanvasReconnectHandlers({
    activeStoryFlow, connectionTargetId, reconnectFlowTransition, reconnectEdge,
    deleteEdge, setConnectionSourceId, setConnectionTargetId
  });
  const connectionHoverHandlers = useCanvasConnectionHoverHandlers({
    connectionSourceId, connectionTargetId, setConnectionTargetId
  });
  const panCaptureHandlers = useCanvasPanCaptureHandlers({
    spacePanActiveRef, alternatePanGestureRef, suppressPaneClickRef
  });
  const onNodeDragStart = useCanvasDragStartHandler({
    canvasSelection, getActiveGraph, dragStartNodesRef, groupDragActiveRef,
    groupDragSelectionRef, suppressPaneClickRef, compositionDropRef,
    setCompositionDrop, setCanvasSelection, selectItem
  });
  const onNodeDrag = useCanvasDragFeedbackHandler({
    groupDragActiveRef, getActiveGraph, getIntersectingNodes, compositionDropRef, setCompositionDrop
  });
  const onNodeDragStop = useCanvasDragStopHandler({
    getActiveGraph, dragStartNodesRef, groupDragActiveRef, groupDragSelectionRef,
    suppressPaneClickRef, compositionDropRef, completeNodeDrop, completeGroupMove,
    setCompositionDrop, setCompositionNotice, setCanvasSelection
  });
  const linkedDropHandlers = useCanvasLinkedDropHandlers({
    nodes, screenToFlowPosition, addLinkedInstance, setCompositionNotice
  });
  const canonBusy = canonOperation === "reviewing";
  const canonActionIssues = canonIssues?.issues;
  // Rail/modal state must not broadcast unchanged Canon inputs to every consumer.
  const canonActions = useMemo<CanonIssueActionController>(() => ({
    busy: canonBusy,
    error: canonError,
    issues: canonActionIssues ?? [],
    notice: canonNotice,
    onNavigate: (owner, issue) => openCanonIssueTarget(owner, "source", issue),
    onRepair: repairCanonIssue,
    onReview: (issueId, status) => void reviewCanonIssue(issueId, status)
  }), [canonBusy, canonError, canonActionIssues, canonNotice, openCanonIssueTarget, repairCanonIssue, reviewCanonIssue]);

  /** Replaces the current editor with central memory settings and an exact seed. */
  function openAgentMemorySettings(seed: AgentMemoryDraftSeed | null = null) {
    setAgentMemoryDraftSeed(seed);
    setDialog("project-settings");
  }

  /** Returns a registry binding to the authoring surface that owns its stable identity. */
  function navigateEngineTagOwner(owner: EngineTagOwnerV1) {
    const nodeId = owner.node_id ?? owner.dialogue_node_id ?? owner.quest_node_id;
    if (nodeId) {
      const node = nodes.find((candidate) => (candidate.data.canonicalNodeId ?? candidate.id) === nodeId && !candidate.data.isLinkedInstance);
      if (!node) return;
      if (owner.kind.startsWith("dialogue_")) void openDialogueEditor(node);
      else if (owner.kind.startsWith("quest_")) void openQuestEditor(node);
      else {
        setDialog(null);
        chooseWorkspaceMode("relationships");
        selectItem({ type: "node", id: node.id });
        focusNode(node);
      }
      return;
    }
    if (owner.kind === "relationship" && owner.edge_id) {
      setDialog(null);
      chooseWorkspaceMode("relationships");
      selectItem({ type: "edge", id: owner.edge_id });
      return;
    }
    if (owner.kind === "narrative_effect" && owner.effect_id) {
      const binding = narrativeStateSnapshot?.bindings.find((item) => item.effect_id === owner.effect_id);
      if (binding) openTemporalEffectOwner(binding.owner);
      return;
    }
    const flow = visibleStoryFlows.find((candidate) =>
      candidate.flow.id === owner.flow_id
      || candidate.transitions.some((item) => item.id === owner.transition_id)
      || candidate.invocations?.some((item) => item.id === owner.invocation_id)
      || candidate.exits?.some((item) => item.id === owner.exit_id)
    );
    if (!flow) return;
    setDialog(null);
    chooseWorkspaceMode("flow");
    chooseStoryFlow(flow.flow.id);
    if (owner.kind === "flow_transition" && owner.transition_id) {
      selectItem({ type: "edge", id: `story-flow:${owner.transition_id}` });
    } else if (owner.kind === "flow_invocation" && owner.invocation_id) {
      setSelectedInvocationId(owner.invocation_id);
      setDialog("flow-call-bindings");
    }
  }
  return (
    <CanonIssueActionProvider value={canonActions}>
    <main className="h-screen overflow-hidden bg-slate-50 text-slate-900">
      <header className="flex h-14 items-center justify-between border-b border-slate-200 bg-white px-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <button className="icon-button" onClick={() => setProjectRailOpen((value) => !value)} type="button" title={tr("workspace.projects")}>
            <Menu size={18} aria-hidden="true" />
          </button>
          <button className="icon-button" onClick={() => requestProjectAction({ kind: "close" })} type="button" title={tr("projects.close")}>
            <LogOut size={18} aria-hidden="true" />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold" title={activeProject.name}>{activeProject.name}</h1>
            {focusedFrameId ? (
              <div aria-label={tr("workspace.focusedFrame")} className="frame-workspace-banner">
                <span className="truncate" title={focusedFrame?.data.title}>
                  {tr("workspace.frameNamed", { kind: displayNodeKind(focusedFrame?.data.kind ?? "Scene") })}: {focusedFrame?.data.title}
                </span>
              </div>
            ) : <p className="truncate text-xs text-slate-500">
              {workspaceMode === "flow"
                ? `${tr("workspace.members", { count: filteredNodeCount })} / ${tr("workspace.transitions", { count: filteredGraph.edges.length })}`
                : workspaceMode === "story"
                  ? `${tr("workspace.beats", { count: storyDocument.sections.filter((section) => !section.reference).length })} / ${tr("workspace.transitions", { count: activeStoryFlow?.transitions.length ?? 0 })}`
                : `${tr("workspace.nodes", { count: filteredNodeCount })} / ${tr("workspace.relations", { count: filteredRelationshipCount })} / ${tr("workspace.transitions", { count: filteredFlowTransitionCount })}`}
            </p>}
          </div>
          {focusedFrameId ? (
            <span className="tooltip-wrapper" data-tooltip={tr("workspace.returnFullGraph")}>
              <button aria-label={tr("workspace.exitFocusedFrame")} className="icon-button" onClick={closeFrameWorkspace} type="button">
                <X size={17} aria-hidden="true" />
              </button>
            </span>
          ) : null}
          <WorkspaceModeControl mode={workspaceMode} onChange={chooseWorkspaceMode} />
          {workspaceMode === "flow" ? <FlowSummaryToggle /> : null}
          <span className="h-8 w-px bg-slate-200" aria-hidden="true" />
          {playbackSession ? (
            <button
              className="playback-return-button"
              onClick={() => void returnToPlayback()}
              type="button"
            >
              <Play size={15} aria-hidden="true" />
              {tr("workspace.returnPlayback")}
            </button>
          ) : (
            <span className="tooltip-wrapper" data-tooltip={tr("workspace.play", { flow: activeStoryFlow?.flow.name ?? tr("workspace.selectedFlow") })}>
              <button
                aria-label={tr("workspace.play", { flow: activeStoryFlow?.flow.name ?? tr("workspace.selectedFlow") })}
                className="icon-button"
                disabled={!activeStoryFlow}
                onClick={() => void startPlayback()}
                ref={playbackPlayButtonRef}
                type="button"
              >
                <Play size={18} aria-hidden="true" />
              </button>
            </span>
          )}
          {workspaceMode !== "story" ? (
            <>
              <span className="h-8 w-px bg-slate-200" aria-hidden="true" />
              <GraphFilterToggle />
            </>
          ) : null}
          {workspaceMode !== "story" ? (
            <>
              <span className="h-8 w-px bg-slate-200" aria-hidden="true" />
              <button className="icon-button" disabled={selection?.type !== "node"} onClick={focusSelectedNeighborhood} type="button" title={tr("workspace.focusNeighborhood")}>
                <LocateFixed size={16} aria-hidden="true" />
              </button>
            </>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="history-controls" aria-label={tr("history.controls")}>
            <span className="tooltip-wrapper" data-tooltip={projectHistoryTooltip("undo", projectHistory?.next_undo ?? null)}>
              <button
                aria-label={projectHistoryTooltip("undo", projectHistory?.next_undo ?? null)}
                className="icon-button"
                disabled={historyBusy || !projectHistory?.next_undo}
                onClick={() => void runProjectHistory("undo")}
                ref={undoButtonRef}
                type="button"
              >
                <Undo2 size={18} aria-hidden="true" />
              </button>
            </span>
            <span className="tooltip-wrapper" data-tooltip={projectHistoryTooltip("redo", projectHistory?.next_redo ?? null)}>
              <button
                aria-label={projectHistoryTooltip("redo", projectHistory?.next_redo ?? null)}
                className="icon-button"
                disabled={historyBusy || !projectHistory?.next_redo}
                onClick={() => void runProjectHistory("redo")}
                ref={redoButtonRef}
                type="button"
              >
                <Redo2 size={18} aria-hidden="true" />
              </button>
            </span>
          </div>
          <AnalysisControl
            activeTool={sceneAnalysisOpen ? "scene" : impactOpen ? "impact" : canonOpen ? "canon" : null}
            canonIssueCount={canonIssues?.active_count ?? 0}
            canonStatus={canonRun?.status ?? (canonOperation === "loading" ? "loading" : "idle")}
            impactSeedCount={selectedImpactSeeds().length}
            impactStatus={impactOperation ?? impactRun?.status ?? "idle"}
            lastTool={lastAnalysisTool}
            onSelect={selectAnalysisTool}
            primaryButtonRef={analysisHeaderButtonRef}
            sceneTextImportEnabled={sceneTextImportEnabled}
            sceneStatus={sceneAnalysisLoading ? "running" : sceneAnalysisError ? "failed" : sceneAnalysisResult ? "completed" : "idle"}
          />
          <span className="tooltip-wrapper" data-tooltip={tr("engineTags.workspace")}>
            <button
              aria-label={tr("engineTags.workspace")}
              className="icon-button"
              disabled={!activeSessionId}
              onClick={() => setDialog("engine-tags")}
              type="button"
            >
              <Tags size={18} aria-hidden="true" />
            </button>
          </span>
          <span className="tooltip-wrapper" data-tooltip={tr("projects.settings")}>
            <button
              aria-label={tr("projects.settings")}
              className="icon-button"
              disabled={!activeProjectManifest}
              onClick={() => openAgentMemorySettings()}
              type="button"
            >
              <Settings size={18} aria-hidden="true" />
            </button>
          </span>
          <SessionSaveControl
            onSave={() => void saveProject("manual")}
            onSaveAs={() => setDialog("save-as")}
          />
          <span className="tooltip-wrapper" data-tooltip={tr("export.workspace")}>
            <button aria-label={tr("export.workspace")} className="icon-button" disabled={!activeSessionId}
              onClick={() => setDialog("export")} type="button"><FileOutput size={18} aria-hidden="true" /></button>
          </span>
          <HelpLauncher />
        </div>
      </header>

      <div className={`workspace-stage relative h-[calc(100vh-56px)] ${sceneTextImportEnabled && sceneAnalysisOpen ? "scene-analysis-workspace-open" : ""} ${canonOpen ? "canon-workspace-open" : ""} ${impactOpen ? "impact-workspace-open" : ""}`} onMouseDownCapture={startFrameDraw} onMouseMoveCapture={continueFrameDraw} onMouseUpCapture={finishFrameDraw}>
        {projectRailOpen ? (
          <aside className="absolute inset-y-0 left-0 z-20 w-64 overflow-y-auto border-r border-slate-200 bg-white p-3 shadow-sm">
            <div className="mb-3 grid grid-cols-2 gap-2">
              <button className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700" onClick={() => setDialog("open-project")} type="button">
                {tr("common.open")}
              </button>
              <button className="rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white" onClick={() => setDialog("create-project")} type="button">
                {tr("common.create")}
              </button>
            </div>
            <CurrentProjectPanel
              activeFlowId={activeStoryFlow?.flow.id ?? null}
              flows={visibleStoryFlows}
              nodes={nodes}
              onArchiveFlow={(snapshot) => void archiveStoryFlow(snapshot)}
              onCreateFlow={() => { setFlowActionError(null); setDialog("create-flow"); }}
              onDeleteFlow={(snapshot) => void previewStoryFlowDeletion(snapshot)}
              onDragNode={(canonicalNodeId, event) => {
                event.dataTransfer.setData("application/x-stt-canonical-node", canonicalNodeId);
                event.dataTransfer.effectAllowed = "copy";
              }}
              onRenameFlow={(flowId) => {
                chooseStoryFlow(flowId);
                setFlowActionError(null);
                setDialog("rename-flow");
              }}
              onReviewProgression={() => void openProgressionMigration()}
              onSelectFlow={chooseStoryFlow}
              onContinueFlow={openContinueFlow}
              onCallFlow={openFlowInvocation}
              onCreateFlowExit={openFlowExit}
              onSetFlowEntry={(nodeId) => {
                setEntryCandidateId(nodeId);
                setDialog("set-flow-entry");
              }}
              onFocusNode={focusNode}
              project={activeProject}
            />
          </aside>
        ) : null}

        {workspaceMode !== "story" ? <ToolRail leftOffset={projectRailOpen ? 276 : 12} mode={toolMode} onChange={chooseTool} /> : null}
        {workspaceMode !== "story" ? (
          <VisibleGraphFilterBar
            filters={graphFilter}
            leftOffset={projectRailOpen ? 344 : 80}
            onChange={setGraphFilter}
            resultCount={filteredNodeCount}
            totalCount={totalNodeCount}
          />
        ) : null}

        {workspaceMode === "story" ? (
          <StoryDocumentView
            canonFocus={canonDiagnosticFocus}
            document={storyDocument}
            effectProjection={temporalStateProjection}
            flow={activeStoryFlow}
            impactHighlights={graphWithImpactHighlights.storyNodes}
            leftOffset={projectRailOpen ? 256 : 0}
            nodes={nodes}
            onEditNode={editStoryNode}
            onOpenFlow={openComposedStorySource}
            onOpenEffectOwner={openTemporalEffectOwner}
            onOpenNode={openStoryNodeInWorkspace}
            onUpdateNode={(node, title, summary) => updateNode(node.id, {
              title,
              summary,
              kind: node.data.kind,
              tags: node.data.tags,
              requirement: node.data.requirement,
              outcome: node.data.outcome,
              characterRole: node.data.characterRole,
              itemPurpose: node.data.itemPurpose
            })}
            onUpdateTransition={(transition, updates) => void updateStoryTransition(transition, updates)}
          />
        ) : (
        <CanvasNodePresentation workspaceMode={workspaceMode}>
        <CanvasSelectableReactFlow
          selectionExperimentEnabled={TARGET_SELECTABLE_EXPERIMENT_ENABLED && STABLE_TOOL_INTERACTION_EXPERIMENT_ENABLED}
          selectionControlInteractive={toolInteractivity?.interactive}
          selectionScopeKey={`${activeProjectId}:${workspaceMode}:${activeStoryFlow?.flow.id ?? ""}:${focusedFrameId ?? ""}`}
          domVirtualizationSuspended={Boolean(dialog)}
          className={`light-canvas ${toolMode === "pan" ? "pan-canvas" : ""} ${projectRailOpen ? "project-rail-open" : ""} ${workspaceMode === "flow" ? "flow-canvas" : ""}`}
          connectionMode={ConnectionMode.Loose}
          deleteKeyCode={null}
          defaultEdgeOptions={edgeDefaults}
          edgeTypes={STORY_FLOW_EDGE_TYPES}
          edgesReconnectable={STABLE_TOOL_INTERACTION_EXPERIMENT_ENABLED || toolMode !== "pan"}
          edges={graphWithNavigationOverlays}
          elementsSelectable={toolMode === "select"}
          fitView
          fitViewOptions={INITIAL_CANVAS_FIT_OPTIONS}
          maxZoom={CANVAS_MAX_ZOOM}
          minZoom={CANVAS_MIN_ZOOM}
          multiSelectionKeyCode="Shift"
          nodeTypes={NARRATIVE_NODE_TYPES}
          nodes={visibleNodes}
          nodesConnectable={toolInteractivity?.interactive ?? toolMode !== "pan"}
          nodesDraggable={toolInteractivity?.interactive ?? toolMode !== "pan"}
          panActivationKeyCode="Space"
          panOnDrag={toolMode === "pan" ? true : frameKindForTool(toolMode) ? false : toolMode === "select" ? SELECT_PAN_BUTTONS : true}
          selectionMode={SelectionMode.Partial}
          selectionOnDrag={toolMode === "select"}
          onPointerDownCapture={panCaptureHandlers.onPointerDownCapture}
          onKeyDownCapture={STABLE_TOOL_INTERACTION_EXPERIMENT_ENABLED && toolMode === "pan" ? blockHandNodeArrow : undefined}
          onPointerUpCapture={panCaptureHandlers.onPointerUpCapture}
          onConnect={connectionHandlers.onConnect}
          onConnectEnd={connectionHandlers.onConnectEnd}
          onConnectStart={connectionHandlers.onConnectStart}
          onEdgeClick={clickHandlers.onEdgeClick}
          onEdgeContextMenu={clickHandlers.onEdgeContextMenu}
          onEdgeDoubleClick={clickHandlers.onEdgeDoubleClick}
          onEdgesChange={changeHandlers.onEdgesChange}
          onDragOver={linkedDropHandlers.onDragOver}
          onDrop={linkedDropHandlers.onDrop}
          onNodeDoubleClick={clickHandlers.onNodeDoubleClick}
          onNodeClick={clickHandlers.onNodeClick}
          onNodeContextMenu={clickHandlers.onNodeContextMenu}
          onNodeDragStart={onNodeDragStart}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          onNodeMouseEnter={connectionHoverHandlers.onNodeMouseEnter}
          onNodeMouseLeave={connectionHoverHandlers.onNodeMouseLeave}
          onNodesChange={changeHandlers.onNodesChange}
          onMoveStart={panCaptureHandlers.onMoveStart}
          onPaneClick={clickHandlers.onPaneClick}
          onPaneContextMenu={clickHandlers.onPaneContextMenu}
          onReconnect={reconnectHandlers.onReconnect}
          onReconnectEnd={reconnectHandlers.onReconnectEnd}
          onReconnectStart={reconnectHandlers.onReconnectStart}
          reconnectRadius={18}
        >
          <CanvasNodePresentationBridge
            nodes={visibleNodes}
            edges={graphWithNavigationOverlays}
            protectedEdgeIds={[...canvasSelection.edgeIds, selection?.type === "edge" ? selection.id : null]}
            resetKey={activeProjectManifest}
            scope={{ projectId: activeProjectId, workspaceMode, flowId: activeStoryFlow?.flow.id ?? null, focusedFrameId }}
            protectedOwnerIds={[
              ...canvasSelection.nodeIds, selection?.type === "node" ? selection.id : null,
              connectionSourceId, connectionTargetId, frameAddMenuId,
              flowAuthoringSourceId, flowAuthoringTargetId, flowInvocationSourceId, flowExitSourceId
            ]}
          />
          <CanvasEdgeGeometryBridge
            edges={graphWithNavigationOverlays}
            protectedEdgeIds={[...canvasSelection.edgeIds, ...(selection?.type === "edge" ? [selection.id] : [])]}
            resetKey={activeProjectManifest}
            scope={{ projectId: activeProjectId, workspaceMode, flowId: activeStoryFlow?.flow.id ?? null, focusedFrameId }}
          />
          <Background color="#cbd5e1" gap={24} />
          {canvasSelection.nodeIds.length + canvasSelection.edgeIds.length > 0 ? (
            <Panel
              className="impact-selection-action"
              position="top-center"
            >
              {activeSessionId ? <EngineTagPicker
                compact
                label={tr("engineTags.bulkContextual")}
                owners={[
                  ...canvasSelection.nodeIds.map((id) => ({ kind: "node" as const, project_id: activeProjectId, node_id: nodes.find((node) => node.id === id)?.data.canonicalNodeId ?? id })),
                  ...canvasSelection.edgeIds.map((id) => ({ kind: "relationship" as const, project_id: activeProjectId, edge_id: id }))
                ]}
                persistence={runtimePersistence}
                sessionId={activeSessionId}
              /> : null}
              <span className="tooltip-wrapper" data-tooltip={tr("impact.selectionAction")}>
                <button
                  aria-label={tr("impact.selectionAction")}
                  aria-pressed={impactOpen}
                  onClick={(event) => impactOpen ? closeImpactWorkspace() : openImpactWorkspace(undefined, event.currentTarget)}
                  type="button"
                >
                  <ScanSearch size={15} aria-hidden="true" />
                  <span>{canvasSelection.nodeIds.length + canvasSelection.edgeIds.length}</span>
                </button>
              </span>
            </Panel>
          ) : null}
          <CanvasFitControls onInteractiveChange={toolInteractivity?.onInteractiveChange} />
          <CanvasZoomControl />
          <CanvasMiniMap />
          {workspaceMode === "flow" ? (
            <HiddenWhileGraphFiltersOpen>
              <VisibleFlowSummary
                facts={flowIntegrityReport && flowIntegrityReport.flow_id === activeStoryFlow?.flow.id
                  ? flowIntegrityReport.facts
                  : localIntegrityReport?.facts ?? []}
                flow={activeStoryFlow}
                onFocusFact={(nodeId) => {
                  const node = nodes.find((candidate) => (candidate.data.canonicalNodeId ?? candidate.id) === nodeId);
                  if (node) focusNode(node);
                }}
              />
            </HiddenWhileGraphFiltersOpen>
          ) : null}
          {workspaceMode === "relationships" && selectedTemporalEffects.length ? (
            <Panel className="temporal-state-panel" position="top-right">
              <TemporalStateOverlayPanel effects={selectedTemporalEffects} nodes={nodes} onOpenOwner={openTemporalEffectOwner} />
            </Panel>
          ) : null}
        </CanvasSelectableReactFlow>
        </CanvasNodePresentation>
        )}

        {workspaceMode !== "story" && showEmptyProjectStart ? (
          <EmptyProjectStart
            error={emptyStarterError}
            leftOffset={projectRailOpen ? 128 : 0}
            loading={emptyStarterLoading}
            onBuildWorld={() => setDialog("build-world")}
            onCreateEvent={() => void startEmptyProjectStory("Event")}
            onCreateScene={() => void startEmptyProjectStory("Scene")}
          />
        ) : null}
        {frameDraw ? <FrameDrawPreview draw={frameDraw} /> : null}
        {compositionNotice ? <div aria-live="polite" className="composition-notice">{compositionNotice}</div> : null}
        <SessionSaveIndicator key={activeSessionId ?? ""} ref={savedConfirmationRef} />
        {historyError || flowActionError || emptyWorkflowNotice ? (
          <div aria-live="polite" className="flow-action-error">{historyError ?? flowActionError ?? emptyWorkflowNotice}</div>
        ) : null}
        <CanvasContextMenu
          onAnalyze={(resource) => openImpactWorkspace([resource], analysisHeaderButtonRef.current)}
          onCreate={(kind, position) => {
            if (kind === "Scene" || kind === "Location") {
              addFrameAt(defaultFrameDraft(kind), position, DEFAULT_FRAME_SIZE);
            } else {
              addNodeAt(defaultNodeDraft(kind), position);
            }
          }}
        />
        {relationshipInspection ? <RelationshipPanel inspection={relationshipInspection} onFocusNeighborhood={focusSelectedNeighborhood} onFocusNode={focusNode} /> : null}
        {selectedFlowTransition && activeStoryFlow ? (
          <FlowTransitionPanel
            canonFocus={canonDiagnosticFocus}
            flow={activeStoryFlow}
            nodes={nodes}
            onDelete={() => void removeFlowTransition(selectedFlowTransition)}
            onEdit={() => setDialog("edit-flow-transition")}
            onMove={(direction) => void reorderFlowTransition(selectedFlowTransition, direction)}
            transition={selectedFlowTransition}
          />
        ) : null}
        {sceneTextImportEnabled && sceneAnalysisOpen ? (
          <SceneAnalysisPanel
            decisionLoading={sceneDecisionLoading}
            error={sceneAnalysisError}
            loading={sceneAnalysisLoading}
            onAnalyze={analyzeScene}
            onAnalyzePatch={(origin) => {
              if (!sceneAnalysisResult) return;
              const key = sceneImpactCallerKey(sceneAnalysisResult);
              openImpactWorkspace(scenePatchImpactResources(sceneAnalysisResult.patch), origin, {
                key,
                kind: "scene-suggestion",
                label: tr("analysis.patchPreview")
              });
            }}
            onDecideOperation={decideSceneOperation}
            onClose={() => setSceneAnalysisOpen(false)}
            operationDecisions={sceneOperationDecisions}
            patchBlocked={Boolean(sceneAnalysisResult && impactBlockedCallerKey === sceneImpactCallerKey(sceneAnalysisResult))}
            result={sceneAnalysisResult}
            sceneText={buildGraphAnalysisText(nodes, edges)}
            title={`${activeProject.name} graph review`}
          />
        ) : null}
        {canonOpen ? (
          <CanonWorkspace
            canNavigate={(owner) => resolveCanonOwner(owner, nodes, visibleStoryFlows, narrativeStateSnapshot, canvasEdges).found}
            error={canonError}
            issues={canonIssues}
            memoryContentLocale={activeProjectManifest?.settings.content_locale ?? "en"}
            memoryPersistence={activeSessionId ? runtimePersistence : undefined}
            memorySessionId={activeSessionId ?? undefined}
            mode={canonMode}
            notice={canonNotice}
            onCancel={() => void cancelCanonCheck()}
            onClose={() => setCanonOpen(false)}
            onModeChange={setCanonMode}
            onCreateMemory={openAgentMemorySettings}
            onManageMemory={() => openAgentMemorySettings()}
            onNavigate={openCanonIssueTarget}
            onReview={(issueId, status) => void reviewCanonIssue(issueId, status)}
            onRun={(remoteConsent) => void runCanonCheck(remoteConsent)}
            onSelectIssue={selectCanonIssue}
            onRepair={(issueId) => {
              const issue = canonIssues?.issues.find((candidate) => candidate.id === issueId);
              if (issue) repairCanonIssue(issue);
            }}
            onSuggestionDecision={(decision) => void decideCanonSuggestion(decision)}
            onAnalyzeSuggestion={(origin) => {
              if (!canonSuggestion) return;
              openImpactWorkspace([], origin, {
                key: `canon-suggestion:${canonSuggestion.id}`,
                kind: "canon-suggestion",
                label: tr("canon.suggestion.preview"),
                patch: canonSuggestion.patch
              });
            }}
            operation={canonOperation}
            providerConfigured={activeProjectManifest?.settings.canon_check?.agent_mode === "configured"}
            revision={activeProjectSession?.saved_revision ?? 0}
            run={canonRun}
            selectedIssueId={selectedCanonIssueId}
            suggestion={canonSuggestion}
            suggestionBlocked={Boolean(canonSuggestion && impactBlockedCallerKey === `canon-suggestion:${canonSuggestion.id}`)}
          />
        ) : null}
        {impactOpen ? (
          <ImpactWorkspace
            error={impactError}
            memoryContentLocale={activeProjectManifest?.settings.content_locale ?? "en"}
            memoryPersistence={activeSessionId ? runtimePersistence : undefined}
            memorySessionId={activeSessionId ?? undefined}
            onApproveResolution={(alternative) => void decideImpactResolution(alternative, "approved")}
            onCancel={() => void cancelImpactAnalysis()}
            onCancelResolution={() => void cancelImpactResolution()}
            onClear={() => {
              setImpactRun(null);
              setImpactError(null);
              setImpactResolutionRun(null);
              setImpactResolutionError(null);
              setImpactResolutionVerificationPending(false);
            }}
            onClose={closeImpactWorkspace}
            onEditResolution={(alternative, patch) => void editImpactResolution(alternative, patch)}
            onNavigate={openImpactFinding}
            onCreateMemory={openAgentMemorySettings}
            onManageMemory={() => openAgentMemorySettings()}
            onNavigateResolution={openImpactResolutionChange}
            onOpenStory={openImpactStoryProjection}
            onReproducePlayback={openImpactFinding}
            onRejectResolution={(alternative) => void decideImpactResolution(alternative, "rejected")}
            onRun={(options) => void runImpactAnalysis(options)}
            onRunResolution={(findingIds, includeRejected) => void runImpactResolution(findingIds, includeRejected)}
            onVerifyCanonResolution={verifyApprovedImpactResolutionCanon}
            onVerifyImpactResolution={() => void verifyApprovedImpactResolution()}
            onReturn={impactCaller ? closeImpactWorkspace : undefined}
            operation={impactOperation}
            originLabel={impactCaller?.label}
            resourceLabel={impactResourceLabel}
            resolutionError={impactResolutionError}
            resolutionInitiallyExpanded={impactCaller?.kind === "canon-issue"}
            resolutionHistoryRevision={projectHistory?.history_revision ?? 0}
            resolutionOperation={impactResolutionOperation}
            resolutionProviderConfigured={impactResolutionProviderConfigured}
            resolutionRun={impactResolutionRun}
            resolutionVerificationPending={impactResolutionVerificationPending}
            run={impactRun}
            scenarioType={impactCaller?.patch ? "patch" : "selection"}
            seeds={impactSeeds}
            initialIntent={impactCaller?.kind.startsWith("delete-") ? "delete" : "modify"}
            storyFindingCount={impactExperiences.storyFindingIds.size}
          />
        ) : null}
      </div>

      {dialog === "open-project" ? (
        <OpenProjectDialog
          onClose={() => setDialog(null)}
          onOpen={(path) => requestProjectAction({ kind: "open", path })}
        />
      ) : null}
      {dialog === "create-project" ? (
        <CreateProjectDialog
          onClose={() => setDialog(null)}
          onCreate={(request) => requestProjectAction({ kind: "create", request })}
        />
      ) : null}
      {dialog === "save-as" && activeProjectSession ? (
        <SaveAsDialog
          onClose={() => setDialog(null)}
          onOpenCopy={(path) => requestProjectAction({ kind: "open", path })}
          onSave={saveProjectAs}
          projectName={activeProject.name}
          projectPath={activeProjectSession.project_path}
        />
      ) : null}
      {dialog === "project-settings" && activeProjectManifest ? (
        <ProjectSettingsDialog
          activeSessionId={activeSessionId}
          initialAgentMemoryDraft={agentMemoryDraftSeed}
          manifest={activeProjectManifest}
          onClose={() => setDialog(null)}
          onRequestStorageMigration={() => setDialog("storage-migration")}
          onSave={saveProjectSettings}
          projectPath={activeProjectSession?.project_path ?? activeProject.path}
          persistence={runtimePersistence}
        />
      ) : null}
      {dialog === "engine-tags" && activeSessionId ? (
        <EngineTagsWorkspace
          onClose={() => setDialog(null)}
          onNavigateOwner={navigateEngineTagOwner}
          persistence={runtimePersistence}
          projectName={activeProject.name}
          sessionId={activeSessionId}
        />
      ) : null}
      {dialog === "export" && activeSessionId && activeProjectSession ? (
        <ExportWorkspace key={activeSessionId} onClose={() => setDialog(null)} DirectoryPicker={DirectoryPickerDialog}
          persistence={runtimePersistence} projectName={activeProject.name}
          projectPath={activeProjectSession.project_path} sessionId={activeSessionId}
          sourceRevision={projectHistory?.history_revision ?? 0}
          flows={projectStoryFlows.map((snapshot) => snapshot.flow)} />
      ) : null}
      {dialog === "storage-migration" ? (
        <SessionStorageMigrationDialog
          activeSessionId={activeSessionId}
          currentMode={activeProjectManifest?.settings.storage.mode ?? "local_sqlite"}
          currentProfileId={activeProjectManifest?.settings.storage.connection_profile_id ?? null}
          onClose={() => setDialog("project-settings")}
          onMigrate={migrateProjectStorage}
          persistence={runtimePersistence}
        />
      ) : null}
      {dialog === "close-project" && pendingProjectAction ? (
        <SessionCloseDialog
          action={pendingProjectAction}
          onCancel={() => void cancelPendingProjectAction()}
          onResolve={(decision) => void resolvePendingProjectAction(decision)}
        />
      ) : null}
      {dialog === "build-world" ? (
        <BuildWorldDialog
          onClose={() => setDialog(null)}
          onCreate={createWorldbuildingNode}
        />
      ) : null}
      {dialog === "choose-connection" && pendingGraphConnection ? (
        <ConnectionTypeDialog
          activeFlowName={activeStoryFlow?.flow.name ?? null}
          onChoose={completeGraphConnection}
          onClose={() => {
            setPendingGraphConnection(null);
            setDialog(null);
          }}
          sourceTitle={nodes.find((node) => node.id === pendingGraphConnection.source)?.data.title ?? pendingGraphConnection.source}
          targetTitle={nodes.find((node) => node.id === pendingGraphConnection.target)?.data.title ?? pendingGraphConnection.target}
        />
      ) : null}
      {dialog === "create-flow" ? (
        <StoryFlowEditorDialog
          error={flowActionError}
          mode="create"
          onClose={() => setDialog(null)}
          onSave={(draft) => void createStoryFlow(draft)}
        />
      ) : null}
      {dialog === "rename-flow" && activeStoryFlow ? (
        <StoryFlowEditorDialog
          error={flowActionError}
          flow={activeStoryFlow}
          mode="rename"
          onClose={() => setDialog(null)}
          onSave={(draft) => void renameStoryFlow(draft)}
        />
      ) : null}
      {dialog === "delete-flow" && activeStoryFlow && flowDeleteImpact ? (
        <StoryFlowDeleteDialog
          flow={activeStoryFlow}
          impact={flowDeleteImpact}
          onClose={() => setDialog(null)}
          onConfirm={() => void confirmStoryFlowDeletion()}
        />
      ) : null}
      {dialog === "continue-flow" && activeStoryFlow && flowAuthoringSourceId ? (
        <ContinueFlowDialog
          error={flowActionError}
          initialTargetId={flowAuthoringTargetId}
          nodes={nodes.filter((node) => !node.data.isLinkedInstance && (node.data.canonicalNodeId ?? node.id) !== flowAuthoringSourceId)}
          onClose={() => setDialog(null)}
          onSave={(command) => void continueStoryFlow(command)}
          priority={nextTransitionPriority(activeStoryFlow, flowAuthoringSourceId)}
          sourceTitle={nodes.find((node) => (node.data.canonicalNodeId ?? node.id) === flowAuthoringSourceId)?.data.title ?? flowAuthoringSourceId}
          usedPriorities={activeStoryFlow.transitions.filter((item) => item.source_node_id === flowAuthoringSourceId).map((item) => item.priority)}
        />
      ) : null}
      {dialog === "call-flow" && activeStoryFlow && flowInvocationSourceId ? (
        <CallFlowDialog
          error={flowActionError}
          flows={visibleStoryFlows.filter((item) => item.flow.id !== activeStoryFlow.flow.id)}
          onClose={() => setDialog(null)}
          onSave={(command) => void createFlowInvocation(command)}
          priority={nextTransitionPriority(activeStoryFlow, flowInvocationSourceId)}
          sourceTitle={nodes.find((node) => (node.data.canonicalNodeId ?? node.id) === flowInvocationSourceId)?.data.title ?? flowInvocationSourceId}
          usedPriorities={[
            ...activeStoryFlow.transitions.filter((item) => item.source_node_id === flowInvocationSourceId).map((item) => item.priority),
            ...(activeStoryFlow.invocations ?? []).filter((item) => item.source_node_id === flowInvocationSourceId).map((item) => item.priority)
          ]}
        />
      ) : null}
      {dialog === "flow-exit" && activeStoryFlow && flowExitSourceId ? (
        <FlowExitDialog
          error={flowActionError}
          existingKeys={(activeStoryFlow.exits ?? []).map((item) => item.key)}
          nodeTitle={nodes.find((node) => (node.data.canonicalNodeId ?? node.id) === flowExitSourceId)?.data.title ?? flowExitSourceId}
          onClose={() => setDialog(null)}
          onSave={(key, label) => void createFlowExit(key, label)}
        />
      ) : null}
      {dialog === "flow-call-bindings" && activeStoryFlow && selectedFlowInvocation ? (
        <FlowCallBindingsDialog
          bindings={activeStoryFlow.bindings ?? []}
          canonFocus={canonDiagnosticFocus}
          caller={activeStoryFlow}
          exits={projectStoryFlows.find((item) => item.flow.id === selectedFlowInvocation.target_flow_id)?.exits ?? []}
          invocation={selectedFlowInvocation}
          nodes={nodes}
          renderExitEffects={(exit) => renderNarrativeEffects({ owner_version: 1, owner_kind: "flow_exit", owner_id: exit.id })}
          invocationEffects={renderNarrativeEffects({ owner_version: 1, owner_kind: "flow_invocation", owner_id: selectedFlowInvocation.id })}
          onClose={() => { setSelectedInvocationId(null); setDialog(null); }}
          onDelete={() => void deleteFlowInvocation(selectedFlowInvocation)}
          onOpenTarget={() => {
            updateWorkspacePreference({ activeFlowId: selectedFlowInvocation.target_flow_id, mode: "flow" });
            setDialog(null);
          }}
          onSave={(flowExit, targetNodeId) => void saveFlowExitBinding(selectedFlowInvocation, flowExit, targetNodeId)}
          targetFlow={projectStoryFlows.find((item) => item.flow.id === selectedFlowInvocation.target_flow_id) ?? null}
        />
      ) : null}
      {dialog === "set-flow-entry" && activeStoryFlow && entryCandidateId ? (
        <StoryFlowEntryDialog
          currentTitle={nodes.find((node) => (node.data.canonicalNodeId ?? node.id) === activeStoryFlow.flow.entry_node_id)?.data.title ?? "No entry"}
          nextTitle={nodes.find((node) => (node.data.canonicalNodeId ?? node.id) === entryCandidateId)?.data.title ?? entryCandidateId}
          onClose={() => setDialog(null)}
          onConfirm={() => void confirmStoryFlowEntry()}
        />
      ) : null}
      {dialog === "scene-boundary" && activeStoryFlow && boundarySceneId ? (
        <SceneFlowBoundaryDialog
          boundary={activeStoryFlow.scene_boundaries.find((item) => item.scene_node_id === boundarySceneId) ?? null}
          canonFocus={canonDiagnosticFocus}
          children={canonicalSceneChildren(boundarySceneId)}
          flow={activeStoryFlow}
          onClose={() => setDialog(null)}
          onDelete={() => void deleteSceneBoundary()}
          onSave={(entryNodeId, exitNodeIds) => void saveSceneBoundary(entryNodeId, exitNodeIds)}
          sceneTitle={nodes.find((node) => node.id === boundarySceneId)?.data.title ?? boundarySceneId}
        />
      ) : null}
      {dialog === "integrate-outcome" && outcomeFlowEdge ? (
        <OutcomeFlowDialog
          edge={outcomeFlowEdge}
          error={flowActionError}
          flows={visibleStoryFlows}
          onClose={() => {
            setDialog(outcomeReturnDialog);
            setOutcomeFlowEdge(null);
          }}
          onSave={(command) => void integrateOutcomeIntoFlow(command)}
          preferredFlowId={activeStoryFlow?.flow.id ?? null}
        />
      ) : null}
      {dialog === "progression-migration" ? (
        <ProgressionMigrationDialog
          error={flowActionError}
          flows={visibleStoryFlows}
          loading={progressionLoading}
          nodes={nodes.filter((node) => !node.data.isLinkedInstance)}
          onAccept={(candidate, command) => void acceptProgressionMigration(candidate, command)}
          onClose={() => setDialog(null)}
          onReject={(candidate) => void rejectProgressionMigration(candidate)}
          review={progressionReview}
        />
      ) : null}
      {/* Keep editor drafts mounted while Canon hands review to another workspace. */}
      <div
        className="editor-dialog-host"
        hidden={
          (impactOpen && impactCaller?.kind === "canon-issue")
          || (canonOpen && canonSuggestion !== null)
        }
      >
      {dialog === "edit-node" && selectedNode ? (
        <EditNodeDialog
          characters={nodes.filter((node) => node.data.kind === "Character" && !node.data.isLinkedInstance)}
          issues={selectedNodeIssues}
          members={selectedFactionMembers}
          node={selectedNode}
          effects={renderNarrativeEffects({ owner_version: 1, owner_kind: "node_entry", owner_id: selectedNode.data.canonicalNodeId ?? selectedNode.id })}
          onAddMember={(characterId) => addFactionMember(selectedNode.id, characterId)}
          onClose={() => setDialog(null)}
          onRemoveMember={(characterId) => removeFactionMember(selectedNode.id, characterId)}
          projectNodes={nodes.filter((node) => !node.data.isLinkedInstance)}
          styleContext={activeSessionId ? {
            contentLocale: activeProjectManifest?.settings.content_locale ?? "en",
            onCreateMemory: openAgentMemorySettings,
            onManageMemory: () => openAgentMemorySettings(),
            onApproved: applyStyleRewriteApproval,
            persistence: runtimePersistence,
            projectId: activeProjectId,
            providerConfigured: activeProjectManifest?.settings.style_system.agent_mode === "configured",
            sessionId: activeSessionId
          } : undefined}
          onSave={(draft) => {
            updateNode(selectedNode.id, draft);
            setDialog(null);
          }}
          engineTagContext={activeSessionId ? { persistence: runtimePersistence, projectId: activeProjectId, sessionId: activeSessionId } : undefined}
        />
      ) : null}
      {dialog === "edit-dialogue" && selectedNode?.data.kind === "Dialogue" && dialogueDraft ? (
        <DialogueEditorDialog
          canonFocus={canonDiagnosticFocus}
          canonTargetId={canonFocusedOwner?.owner_id ?? null}
          characters={nodes.filter((node) => node.data.kind === "Character" && !node.data.isLinkedInstance)}
          document={dialogueDraft}
          error={dialogueLoadError}
          issues={selectedNodeIssues}
          loading={dialogueLoading}
          node={selectedNode}
          nodes={nodes.filter((node) => !node.data.isLinkedInstance)}
          nodeEffects={renderNarrativeEffects({ owner_version: 1, owner_kind: "node_entry", owner_id: selectedNode.data.canonicalNodeId ?? selectedNode.id })}
          onClose={() => {
            setCanonFocusedOwner(null);
            setDialog(null);
          }}
          onCreateTransition={createDialogueTransition}
          onConfigureStoryFlow={(edge) => openOutcomeFlow(edge, "edit-dialogue")}
          onDeleteTransition={(edgeId) => void deleteSpecializedOutcome(edgeId)}
          outcomeDeletionImpact={outcomeDeletionImpact}
          renderEffects={(owner) => renderNarrativeEffects(owner)}
          onSave={(document) => {
            updateDialogueDocument(selectedNode.id, document);
            setCanonFocusedOwner(null);
            setDialog(null);
          }}
          onSaveNodeText={(summary) => updateNode(selectedNode.id, {
            kind: "Dialogue",
            summary,
            tags: selectedNode.data.tags,
            title: selectedNode.data.title
          })}
          onUpdateTransition={(edgeId, draft) => {
            updateEdge(edgeId, draft);
            selectItem({ type: "node", id: selectedNode.id });
          }}
          storyFlowNames={outcomeStoryFlowNames}
          styleContext={activeSessionId ? {
            contentLocale: activeProjectManifest?.settings.content_locale ?? "en",
            onCreateMemory: openAgentMemorySettings,
            onManageMemory: () => openAgentMemorySettings(),
            onApproved: applyStyleRewriteApproval,
            persistence: runtimePersistence,
            providerConfigured: activeProjectManifest?.settings.style_system.agent_mode === "configured",
            sessionId: activeSessionId
          } : undefined}
          engineTagContext={activeSessionId ? { persistence: runtimePersistence, projectId: activeProjectId, sessionId: activeSessionId } : undefined}
          transitions={edges.filter((edge) => edge.source === (selectedNode.data.canonicalNodeId ?? selectedNode.id) && Boolean(edge.data?.dialogueElementId))}
        />
      ) : null}
      {dialog === "edit-quest" && selectedNode?.data.kind === "Quest" && questDraft ? (
        <QuestEditorDialog
          canonFocus={canonDiagnosticFocus}
          document={questDraft}
          error={questLoadError}
          loading={questLoading}
          node={selectedNode}
          nodes={nodes.filter((node) => !node.data.isLinkedInstance)}
          nodeEffects={renderNarrativeEffects({ owner_version: 1, owner_kind: "node_entry", owner_id: selectedNode.data.canonicalNodeId ?? selectedNode.id })}
          onClose={() => setDialog(null)}
          onCreateTransition={createQuestTransition}
          onConfigureStoryFlow={(edge) => openOutcomeFlow(edge, "edit-quest")}
          onDeleteTransition={(edgeId) => void deleteSpecializedOutcome(edgeId)}
          outcomeDeletionImpact={outcomeDeletionImpact}
          renderEffects={(owner) => renderNarrativeEffects(owner)}
          onSave={(document) => {
            updateQuestDocument(selectedNode.id, document);
            setDialog(null);
          }}
          onSaveNodeText={(summary) => updateNode(selectedNode.id, {
            kind: "Quest",
            summary,
            tags: selectedNode.data.tags,
            title: selectedNode.data.title
          })}
          onUpdateTransition={(edgeId, draft) => {
            updateEdge(edgeId, draft);
            selectItem({ type: "node", id: selectedNode.id });
          }}
          storyFlowNames={outcomeStoryFlowNames}
          styleContext={activeSessionId ? {
            contentLocale: activeProjectManifest?.settings.content_locale ?? "en",
            onCreateMemory: openAgentMemorySettings,
            onManageMemory: () => openAgentMemorySettings(),
            onApproved: applyStyleRewriteApproval,
            persistence: runtimePersistence,
            providerConfigured: activeProjectManifest?.settings.style_system.agent_mode === "configured",
            sessionId: activeSessionId
          } : undefined}
          engineTagContext={activeSessionId ? { persistence: runtimePersistence, projectId: activeProjectId, sessionId: activeSessionId } : undefined}
          transitions={edges.filter((edge) => edge.source === (selectedNode.data.canonicalNodeId ?? selectedNode.id) && Boolean(edge.data?.questBranchId))}
        />
      ) : null}
      {dialog === "edit-edge" && selectedEdge ? (
        <EditEdgeDialog
          edge={selectedEdge}
          initialHolderControl={<RelationshipInitialHolderControl edge={selectedEdge} flows={visibleStoryFlows} persistence={runtimePersistence} projectId={activeProjectId} />}
          issues={selectedEdgeIssues}
          onClose={() => setDialog(null)}
          onSave={(draft) => {
            updateEdge(selectedEdge.id, draft);
            setDialog(null);
          }}
          engineTagContext={activeSessionId ? { persistence: runtimePersistence, projectId: activeProjectId, sessionId: activeSessionId } : undefined}
        />
      ) : null}
      {dialog === "edit-flow-transition" && selectedFlowTransition && activeStoryFlow ? (
        <EditFlowTransitionDialog
          effects={renderNarrativeEffects({ owner_version: 1, owner_kind: "flow_transition", owner_id: selectedFlowTransition.id })}
          flow={activeStoryFlow}
          nodes={nodes}
          onClose={() => setDialog(null)}
          onSave={async (updates) => {
            if (await updateStoryTransition(selectedFlowTransition, updates)) setDialog(null);
          }}
          transition={selectedFlowTransition}
        />
      ) : null}
      </div>
      {selectedAnalysisOperation !== null && sceneAnalysisResult?.patch.operations[selectedAnalysisOperation] ? (
        <AnalysisOperationDialog
          decision={sceneOperationDecisions[selectedAnalysisOperation]}
          loading={sceneDecisionLoading}
          onClose={() => setSelectedAnalysisOperation(null)}
          onDecide={(decision) => decideSceneOperation(selectedAnalysisOperation, decision)}
          operation={sceneAnalysisResult.patch.operations[selectedAnalysisOperation]}
          operationIndex={selectedAnalysisOperation}
        />
      ) : null}
      {frameAddMenuId ? (
        <FrameAddDialog
          frame={nodes.find((node) => node.id === frameAddMenuId)!}
          nodes={nodes}
          onClose={() => setFrameAddMenuId(null)}
          onPick={(canonicalNodeId) => {
            const result = addLinkedInstance(canonicalNodeId, frameAddMenuId);
            setCompositionNotice(result.message);
            if (result.valid) setFrameAddMenuId(null);
          }}
        />
      ) : null}
      {dialog === "delete-selection" && !(impactOpen && impactCaller?.kind === "delete-selection") ? (
        <DeleteSelectionDialog
          edgeLabels={canvasSelection.edgeIds.map((edgeId) => {
            const edge = edges.find((candidate) => candidate.id === edgeId);
            const transition = activeStoryFlow?.transitions.find((candidate) => `story-flow:${candidate.id}` === edgeId);
            return String(edge?.data?.label ?? edge?.label ?? transition?.label ?? transition?.kind ?? edgeId);
          })}
          nodes={nodes.filter((node) => canvasSelection.nodeIds.includes(node.id))}
          deleteBlocked={impactBlockedCallerKey === `delete-selection:${impactSeedKeys(selectedImpactSeeds())}`}
          impactKey={`delete-selection:${impactSeedKeys(selectedImpactSeeds())}`}
          onAnalyze={(origin) => openImpactWorkspace(selectedImpactSeeds().map((seed) => seed.resource), origin, {
            key: `delete-selection:${impactSeedKeys(selectedImpactSeeds())}`,
            kind: "delete-selection",
            label: tr("authoring.deleteSelection")
          })}
          onClose={() => setDialog(null)}
          onDelete={() => void deleteCanvasSelection()}
        />
      ) : null}
      {dialog === "delete-entity" && selectedNode && !(impactOpen && impactCaller?.kind === "delete-entity") ? (
        <DeleteEntityDialog
          edgeCount={edges.filter((edge) => edge.source === (selectedNode.data.canonicalNodeId ?? selectedNode.id) || edge.target === (selectedNode.data.canonicalNodeId ?? selectedNode.id)).length}
          node={selectedNode}
          deleteBlocked={impactBlockedCallerKey === `delete-entity:${selectedNode.id}`}
          impactKey={`delete-entity:${selectedNode.id}`}
          onAnalyze={(origin) => openImpactWorkspace([impactResourceForNode(selectedNode)], origin, {
            key: `delete-entity:${selectedNode.id}`,
            kind: "delete-entity",
            label: tr("authoring.deleteNamed", { name: selectedNode.data.title })
          })}
          onClose={() => setDialog(null)}
          onDelete={() => { deleteNode(selectedNode.id); setDialog(null); }}
          placementCount={nodes.filter((node) => (node.data.canonicalNodeId ?? node.id) === (selectedNode.data.canonicalNodeId ?? selectedNode.id)).length}
        />
      ) : null}
    </main>
    </CanonIssueActionProvider>
  );
}

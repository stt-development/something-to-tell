/* Shared runtime DTO and domain persistence contracts. */
import type { CanonProviderModelsResponse, CanonProviderProfileCreate, CanonProviderProfileDeleteResponse, CanonProviderProfileUpdate, CanonProviderProfilesResponse } from "@something-to-tell/contracts/canon-agent";
import type { CanonCheckRun, CanonFixSuggestionDecision, CanonFixSuggestionDecisionResponse, CanonIssueImpactRequest, CanonIssueListResponse, CanonIssueProjection, CanonIssueStatusChange, CanonIssueSuggestionRequest, CanonIssueSuggestionResponse, CanonRunStart } from "@something-to-tell/contracts/canon-check";
import type { FlowExit, FlowExitBinding, FlowInvocation } from "@something-to-tell/contracts/composable-story-flow";
import type { ImpactAnalysisRequest, ImpactAnalysisResponse } from "@something-to-tell/contracts/impact-analysis";
import type { ImpactResolutionContextPackage, ImpactResolutionDecisionResponse, ImpactResolutionDraftEdit, ImpactResolutionRequest, ImpactResolutionResponse, ImpactResolutionReviewCommand } from "@something-to-tell/contracts/impact-resolution";
import type { ProjectHistoryMutationResponse, ProjectHistorySummary } from "@something-to-tell/contracts/project-history";
import type {
  AgentMemoryCatalogV1,
  AgentMemoryCandidateAcceptanceResponseV1,
  AgentMemoryCandidateAcceptanceV1,
  AgentMemoryCandidateRequestV1,
  AgentMemoryCandidateRetryV1,
  AgentMemoryCandidateReviewV1,
  AgentMemoryCandidateRunV1,
  AgentMemoryDeletionImpactV1,
  AgentMemoryMutationCommandV1,
  AgentMemoryMutationResponseV1,
  AgentMemoryScopeV1
} from "@something-to-tell/contracts/agent-memory";
import { type ProjectManifestV2 } from "@something-to-tell/contracts/project-manifest";
import type { EngineTagIntegrityReportV1, EngineTagMutationCommandV1, EngineTagMutationResponseV1, EngineTagProjectionV1 } from "@something-to-tell/contracts/engine-tags";
import type { ExportPlanRequestV1, ExportPlanV1, ExportWriteRequestV1, ExportWriteResultV1 } from "@something-to-tell/contracts/export";
import type { ProjectCatalogResponse, ProjectDirectoryListingResponse, ProjectSessionCreate, ProjectSessionExit, ProjectSessionOpen, ProjectSessionResponse, ProjectSessionSave, ProjectSessionSaveAs, ProjectSessionSaveAsResponse, ProjectSessionSettingsUpdate, ProjectSessionState } from "@something-to-tell/contracts/project-session";
import type { StorageMigrationRequest, StorageMigrationResponse, StorageProfileCreateRequest, StorageProfileSummary, StorageProfileTestResponse, StorageProfilesResponse } from "@something-to-tell/contracts/storage";
import { type Edge, type Node } from "@xyflow/react";
import type { ProjectCompositionSnapshot, VisualPlacement } from "../composition/contracts";
import type { DialogueDocument } from "../dialogue/contracts";
import type { PlaybackChooseCommand, PlaybackPreparation, PlaybackPrepareCommand, PlaybackRestartCommand, PlaybackRevisionCommand, PlaybackSession, PlaybackStartCommand, PlaybackTypedEffect } from "../playback/contracts";
import type { QuestDocument } from "../quest/contracts";
import type { FlowTransition, FlowTransitionDraft, StoryFlow, StoryFlowBootstrapDraft, StoryFlowDeletionImpact, StoryFlowIntegrityReport, StoryFlowKind, StoryFlowSnapshot } from "../story-flow/contracts";
import type { ProgressionDecision, ProgressionMigrationReview } from "../story-flow/progressionMigration";
import { type DialogueTransitionDraft, type NarrativeEdgeData, type NarrativeIssue, type NarrativeNodeData, type NarrativeProject, type NodeDraft, type ProjectDraft, type QuestTransitionDraft, type SceneAnalysisResponse } from "../types";
export interface RuntimeProject {
  id: string;
  name: string;
  path: string;
  format_version: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}
export interface RuntimeNode {
  id: string;
  project_id: string;
  type: string;
  title: string;
  summary: string;
  body: string;
  status: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}
export interface RuntimeEdge {
  id: string;
  project_id: string;
  source_node_id: string;
  target_node_id: string;
  type: string;
  label: string;
  condition: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}
export interface RuntimeIssue {
  id: string;
  project_id: string;
  title: string;
  node_id: string | null;
  edge_id: string | null;
  description: string;
  severity: string;
  status: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}
export interface RuntimeSuggestion {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: string;
  patch: Record<string, unknown>;
  created_by: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}
export interface RuntimeGraphSnapshot {
  activeProjectId: string;
  activeSessionId?: string | null;
  projectSession?: ProjectSessionState | null;
  autosave?: {
    enabled: boolean;
    interval_seconds: number;
  } | null;
  manifest?: ProjectManifestV2 | null;
  edges: Edge<NarrativeEdgeData>[];
  issues: NarrativeIssue[];
  nodes: Node<NarrativeNodeData>[];
  playbackEffectsByFlow?: Record<string, PlaybackTypedEffect[]>;
  projects: NarrativeProject[];
  storyFlows?: StoryFlowSnapshot[];
}
export interface RuntimeDialogueTransitionResult {
  edge: Edge<NarrativeEdgeData>;
  targetNode: Node<NarrativeNodeData>;
}
export type RuntimeQuestTransitionResult = RuntimeDialogueTransitionResult;
export interface RuntimeGraphPersistence {
  loadProjectSessionSnapshot: (sessionId: string) => Promise<RuntimeGraphSnapshot>;
  createProject: (draft: ProjectDraft) => Promise<NarrativeProject>;
  createNode: (projectId: string, node: Node<NarrativeNodeData>) => Promise<Node<NarrativeNodeData>>;
  createFrame: (projectId: string, node: Node<NarrativeNodeData>) => Promise<Node<NarrativeNodeData>>;
  updatePlacement: (projectId: string, node: Node<NarrativeNodeData>) => Promise<VisualPlacement>;
  updatePlacements: (projectId: string, nodes: Node<NarrativeNodeData>[]) => Promise<ProjectCompositionSnapshot>;
  createLinkedPlacement: (projectId: string, canonicalNodeId: string, containerNodeId: string, position: {
    x: number;
    y: number;
  }, size: {
    height: number;
    width: number;
  }) => Promise<VisualPlacement>;
  removePlacement: (placementId: string) => Promise<ProjectCompositionSnapshot>;
  deleteEntity: (canonicalNodeId: string) => Promise<void>;
  updateNode: (projectId: string, node: Node<NarrativeNodeData>) => Promise<Node<NarrativeNodeData>>;
  deleteNode: (nodeId: string) => Promise<void>;
  createEdge: (projectId: string, edge: Edge<NarrativeEdgeData>) => Promise<Edge<NarrativeEdgeData>>;
  updateEdge: (projectId: string, edge: Edge<NarrativeEdgeData>) => Promise<Edge<NarrativeEdgeData>>;
  deleteEdge: (edgeId: string) => Promise<void>;
  createFactionMembership: (factionId: string, characterId: string) => Promise<Edge<NarrativeEdgeData>>;
  removeFactionMembership: (factionId: string, characterId: string) => Promise<void>;
  loadDialogueDocument: (nodeId: string) => Promise<DialogueDocument>;
  updateDialogueDocument: (nodeId: string, document: DialogueDocument) => Promise<DialogueDocument>;
  createDialogueTransition: (projectId: string, draft: DialogueTransitionDraft, edge: Edge<NarrativeEdgeData>, newTarget?: Node<NarrativeNodeData>) => Promise<RuntimeDialogueTransitionResult>;
  updateDialogueTransition: (edge: Edge<NarrativeEdgeData>) => Promise<RuntimeDialogueTransitionResult>;
  loadQuestDocument: (nodeId: string) => Promise<QuestDocument>;
  updateQuestDocument: (nodeId: string, document: QuestDocument) => Promise<QuestDocument>;
  createQuestTransition: (projectId: string, draft: QuestTransitionDraft, edge: Edge<NarrativeEdgeData>, newTarget?: Node<NarrativeNodeData>) => Promise<RuntimeQuestTransitionResult>;
  updateQuestTransition: (edge: Edge<NarrativeEdgeData>) => Promise<RuntimeQuestTransitionResult>;
  analyzeScene: (projectId: string, title: string, sceneText: string) => Promise<SceneAnalysisResponse>;
  approveSuggestion: (suggestionId: string) => Promise<RuntimeSuggestion>;
  rejectSuggestion: (suggestionId: string) => Promise<RuntimeSuggestion>;
  approveSuggestionOperation: (suggestionId: string, operationIndex: number) => Promise<RuntimeSuggestion>;
  rejectSuggestionOperation: (suggestionId: string, operationIndex: number) => Promise<RuntimeSuggestion>;
}
export type RuntimeProjectSessionResponse = ProjectSessionResponse<DialogueDocument, QuestDocument>;
export interface RuntimeProjectSessionPersistence {
  listProjectCatalog: (directory?: string) => Promise<ProjectCatalogResponse>;
  listProjectDirectories: (directory?: string) => Promise<ProjectDirectoryListingResponse>;
  createProjectSession: (command: ProjectSessionCreate) => Promise<RuntimeProjectSessionResponse>;
  openProjectSession: (command: ProjectSessionOpen) => Promise<RuntimeProjectSessionResponse>;
  inspectProjectSession: (sessionId: string) => Promise<RuntimeProjectSessionResponse>;
  saveProjectSession: (sessionId: string, command: ProjectSessionSave) => Promise<RuntimeProjectSessionResponse>;
  saveProjectSessionAs: (sessionId: string, command: ProjectSessionSaveAs) => Promise<ProjectSessionSaveAsResponse>;
  updateProjectSettings: (sessionId: string, command: ProjectSessionSettingsUpdate) => Promise<RuntimeProjectSessionResponse>;
  discardProjectSession: (sessionId: string) => Promise<RuntimeProjectSessionResponse>;
  closeProjectSession: (sessionId: string) => Promise<RuntimeProjectSessionResponse>;
  exitProjectSession: (sessionId: string, command: ProjectSessionExit) => Promise<ProjectSessionState>;
  inspectProjectHistory: (sessionId: string) => Promise<ProjectHistorySummary>;
  undoProjectHistory: (sessionId: string, expectedHistoryRevision: number) => Promise<ProjectHistoryMutationResponse<DialogueDocument, QuestDocument>>;
  redoProjectHistory: (sessionId: string, expectedHistoryRevision: number) => Promise<ProjectHistoryMutationResponse<DialogueDocument, QuestDocument>>;
  listStorageProfiles: (sessionId: string) => Promise<StorageProfilesResponse>;
  createStorageProfile: (command: StorageProfileCreateRequest) => Promise<StorageProfileSummary>;
  testStorageProfile: (sessionId: string, profileId: string) => Promise<StorageProfileTestResponse>;
  migrateStorage: (command: StorageMigrationRequest) => Promise<StorageMigrationResponse<DialogueDocument, QuestDocument>>;
}
export interface RuntimeExportPersistence {
  createExportPlan: (sessionId: string, command: ExportPlanRequestV1) => Promise<ExportPlanV1>;
  writeExportArtifact: (sessionId: string, command: ExportWriteRequestV1) => Promise<ExportWriteResultV1>;
}
export interface RuntimeCanonPersistence {
  listCanonProviderProfiles: (sessionId?: string | null) => Promise<CanonProviderProfilesResponse>;
  createCanonProviderProfile: (command: CanonProviderProfileCreate) => Promise<CanonProviderModelsResponse>;
  updateCanonProviderProfile: (profileId: string, command: CanonProviderProfileUpdate) => Promise<CanonProviderModelsResponse>;
  deleteCanonProviderProfile: (sessionId: string | null | undefined, profileId: string) => Promise<CanonProviderProfileDeleteResponse>;
  listCanonProviderModels: (sessionId: string | null | undefined, profileId: string) => Promise<CanonProviderModelsResponse>;
  startCanonRun: (command: CanonRunStart) => Promise<CanonCheckRun>;
  inspectCanonRun: (runId: string) => Promise<CanonCheckRun>;
  cancelCanonRun: (runId: string) => Promise<CanonCheckRun>;
  listCanonIssues: (projectId: string) => Promise<CanonIssueListResponse>;
  changeCanonIssueStatus: (issueId: string, command: CanonIssueStatusChange) => Promise<CanonIssueProjection>;
  requestCanonIssueSuggestion: (issueId: string, command: CanonIssueSuggestionRequest) => Promise<CanonIssueSuggestionResponse>;
  startCanonIssueImpact: (issueId: string, command: CanonIssueImpactRequest) => Promise<ImpactAnalysisResponse>;
  approveCanonFixSuggestion: (suggestionId: string, command: CanonFixSuggestionDecision) => Promise<CanonFixSuggestionDecisionResponse<DialogueDocument, QuestDocument>>;
  rejectCanonFixSuggestion: (suggestionId: string, command: CanonFixSuggestionDecision) => Promise<CanonFixSuggestionDecisionResponse<DialogueDocument, QuestDocument>>;
}
/** Read-only process-local Impact Analysis lifecycle for one open session. */
export interface RuntimeImpactPersistence {
  startImpactRun: (sessionId: string, command: ImpactAnalysisRequest) => Promise<ImpactAnalysisResponse>;
  inspectImpactRun: (sessionId: string, runId: string) => Promise<ImpactAnalysisResponse>;
  cancelImpactRun: (sessionId: string, runId: string) => Promise<ImpactAnalysisResponse>;
  buildImpactResolutionContext: (sessionId: string, runId: string, command: ImpactResolutionRequest) => Promise<ImpactResolutionContextPackage>;
  startImpactResolutionRun: (sessionId: string, command: ImpactResolutionRequest) => Promise<ImpactResolutionResponse>;
  inspectImpactResolutionRun: (sessionId: string, runId: string) => Promise<ImpactResolutionResponse>;
  cancelImpactResolutionRun: (sessionId: string, runId: string) => Promise<ImpactResolutionResponse>;
  editImpactResolutionAlternative: (sessionId: string, runId: string, command: ImpactResolutionDraftEdit) => Promise<ImpactResolutionResponse>;
  approveImpactResolutionAlternative: (sessionId: string, runId: string, command: ImpactResolutionReviewCommand) => Promise<ImpactResolutionDecisionResponse>;
  rejectImpactResolutionAlternative: (sessionId: string, runId: string, command: ImpactResolutionReviewCommand) => Promise<ImpactResolutionDecisionResponse>;
}
export interface RuntimeStoryFlowPersistence {
  listStoryFlowSnapshots: (projectId: string) => Promise<StoryFlowSnapshot[]>;
  createStoryFlow: (projectId: string, draft: {
    name: string;
    description: string;
    kind: StoryFlowKind;
  }) => Promise<StoryFlowSnapshot>;
  updateStoryFlow: (snapshot: StoryFlowSnapshot, draft: {
    name: string;
    description: string;
    kind: StoryFlowKind;
  }) => Promise<StoryFlowSnapshot>;
  archiveStoryFlow: (flow: StoryFlow) => Promise<StoryFlow>;
  getStoryFlowDeletionImpact: (flowId: string) => Promise<StoryFlowDeletionImpact>;
  deleteStoryFlow: (flowId: string) => Promise<void>;
  createFlowInvocation: (projectId: string, sourceFlowId: string, sourceNodeId: string, targetFlowId: string, draft: {
    label: string;
    condition: string;
    priority: number;
    isDefault: boolean;
  }) => Promise<FlowInvocation>;
  updateFlowInvocation: (projectId: string, invocationId: string, sourceFlowId: string, sourceNodeId: string, targetFlowId: string, draft: {
    label: string;
    condition: string;
    priority: number;
    isDefault: boolean;
  }) => Promise<FlowInvocation>;
  createFlowExit: (projectId: string, flowId: string, sourceNodeId: string, key: string, label: string) => Promise<FlowExit>;
  createFlowExitBinding: (projectId: string, invocationId: string, exitId: string, targetNodeId: string) => Promise<FlowExitBinding>;
  updateFlowExitBinding: (projectId: string, bindingId: string, invocationId: string, exitId: string, targetNodeId: string) => Promise<FlowExitBinding>;
  deleteFlowInvocation: (projectId: string, invocationId: string) => Promise<void>;
  deleteFlowExit: (projectId: string, exitId: string) => Promise<void>;
  createOutcomeSideFlow: (projectId: string, edgeId: string, sourceFlowId: string, draft: {
    name: string;
    description: string;
    label: string;
    condition: string;
    priority: number;
    isDefault: boolean;
  }) => Promise<{
    edge: Edge<NarrativeEdgeData>;
    invocation: FlowInvocation;
    sourceFlow: StoryFlowSnapshot;
    targetFlow: StoryFlowSnapshot;
  }>;
  bootstrapStoryFlow: (projectId: string, draft: StoryFlowBootstrapDraft) => Promise<{
    node: Node<NarrativeNodeData>;
    snapshot: StoryFlowSnapshot;
  }>;
  continueStoryFlowExisting: (snapshot: StoryFlowSnapshot, sourceNodeId: string, targetNodeId: string, transition: FlowTransitionDraft) => Promise<StoryFlowSnapshot>;
  continueStoryFlowNew: (snapshot: StoryFlowSnapshot, sourceNodeId: string, node: NodeDraft, transition: FlowTransitionDraft) => Promise<{
    node: Node<NarrativeNodeData>;
    snapshot: StoryFlowSnapshot;
  }>;
  setStoryFlowEntry: (snapshot: StoryFlowSnapshot, nodeId: string) => Promise<StoryFlowSnapshot>;
  addStoryFlowMembership: (snapshot: StoryFlowSnapshot, nodeId: string) => Promise<StoryFlowSnapshot>;
  setStoryFlowSceneBoundary: (snapshot: StoryFlowSnapshot, sceneNodeId: string, entryNodeId: string, exitNodeIds: string[]) => Promise<StoryFlowSnapshot>;
  deleteStoryFlowSceneBoundary: (snapshot: StoryFlowSnapshot, sceneNodeId: string) => Promise<void>;
  reorderStoryFlowTransitions: (snapshot: StoryFlowSnapshot, sourceNodeId: string, transitionIds: string[]) => Promise<StoryFlowSnapshot>;
  updateStoryFlowTransition: (snapshot: StoryFlowSnapshot, transition: FlowTransition, endpoints: {
    sourceNodeId: string;
    targetNodeId: string;
  }) => Promise<FlowTransition>;
  deleteStoryFlowTransition: (snapshot: StoryFlowSnapshot, transitionId: string) => Promise<void>;
  getStoryFlowIntegrity: (flowId: string) => Promise<StoryFlowIntegrityReport>;
  reviewProgressionMigrations: (projectId: string) => Promise<ProgressionMigrationReview>;
  rejectProgressionMigration: (projectId: string, fingerprint: string) => Promise<ProgressionDecision>;
  acceptProgressionMigration: (projectId: string, fingerprint: string, flowId: string, draft: {
    preserveRelationship: boolean;
    kind: FlowTransitionDraft["kind"];
    label: string;
    condition: string;
  }) => Promise<{
    decision: ProgressionDecision;
    snapshot: StoryFlowSnapshot;
  }>;
}
export interface RuntimePlaybackPersistence {
  preparePlayback: (command: PlaybackPrepareCommand) => Promise<PlaybackPreparation>;
  startPlayback: (command: PlaybackStartCommand) => Promise<PlaybackSession>;
  inspectPlayback: (sessionId: string, sourceRevision: string) => Promise<PlaybackSession>;
  choosePlayback: (sessionId: string, command: PlaybackChooseCommand) => Promise<PlaybackSession>;
  backPlayback: (sessionId: string, command: PlaybackRevisionCommand) => Promise<PlaybackSession>;
  restartPlayback: (sessionId: string, command: PlaybackRestartCommand) => Promise<PlaybackSession>;
  closePlayback: (sessionId: string) => Promise<void>;
}
import type { EffectiveStyleResolutionV1, SceneStyleAssignmentV1, StyleCatalogV1, StyleContextRefV1, StyleProfileDeletionImpactV1, StyleProfileV1 } from "@something-to-tell/contracts/style-system";
import type { StyleRewriteApprovalV1, StyleRewriteRequestV1, StyleRewriteRetryV1, StyleRewriteRunV1 } from "@something-to-tell/contracts/style-rewrite";
export type RuntimeProviderPersistence = Pick<RuntimeCanonPersistence, "listCanonProviderProfiles" | "createCanonProviderProfile" | "updateCanonProviderProfile" | "deleteCanonProviderProfile" | "listCanonProviderModels">;
export type RuntimeAnalysisPersistence = RuntimeImpactPersistence & Pick<RuntimeCanonPersistence, "startCanonRun" | "inspectCanonRun" | "cancelCanonRun" | "listCanonIssues" | "changeCanonIssueStatus" | "requestCanonIssueSuggestion" | "startCanonIssueImpact" | "approveCanonFixSuggestion" | "rejectCanonFixSuggestion"> & Pick<RuntimeGraphPersistence, "analyzeScene" | "approveSuggestion" | "rejectSuggestion" | "approveSuggestionOperation" | "rejectSuggestionOperation">;
export type RuntimeGraphAuthoringPersistence = Omit<RuntimeGraphPersistence, "loadProjectSessionSnapshot" | "analyzeScene" | "approveSuggestion" | "rejectSuggestion" | "approveSuggestionOperation" | "rejectSuggestionOperation">;
export type RuntimeProjectClientPersistence = RuntimeProjectSessionPersistence & Pick<RuntimeGraphPersistence, "loadProjectSessionSnapshot">;
export interface RuntimeGraphLoaderPersistence {
  loadGraphSnapshot: (projectId?: string) => Promise<RuntimeGraphSnapshot>;
}
/** Reads project-owned style records through the same session authority. */
export interface RuntimeStylePersistence {
  loadStyleCatalog: (sessionId: string) => Promise<StyleCatalogV1>;
  createStyleProfile: (profile: StyleProfileV1) => Promise<StyleProfileV1>;
  updateStyleProfile: (profile: StyleProfileV1) => Promise<StyleProfileV1>;
  inspectStyleProfileDeletionImpact: (profileId: string, projectId: string, defaultStyleProfileId: string | null) => Promise<StyleProfileDeletionImpactV1>;
  deleteStyleProfile: (profileId: string, command: { project_id: string; default_style_profile_id: string | null; replacement_profile_id: string | null; impact_reviewed: boolean }) => Promise<void>;
  upsertSceneStyleAssignment: (assignment: SceneStyleAssignmentV1) => Promise<SceneStyleAssignmentV1>;
  clearSceneStyleAssignment: (sceneNodeId: string, projectId: string) => Promise<void>;
  resolveEffectiveStyle: (sessionId: string, targetNodeId: string, context?: StyleContextRefV1 | null) => Promise<EffectiveStyleResolutionV1>;
  startStyleRewrite: (request: StyleRewriteRequestV1) => Promise<StyleRewriteRunV1>;
  inspectStyleRewrite: (sessionId: string, runId: string) => Promise<StyleRewriteRunV1>;
  cancelStyleRewrite: (sessionId: string, runId: string) => Promise<StyleRewriteRunV1>;
  retryStyleRewrite: (sessionId: string, runId: string, request: StyleRewriteRetryV1) => Promise<StyleRewriteRunV1>;
  approveStyleRewrite: (sessionId: string, runId: string, command: StyleRewriteApprovalV1) => Promise<RuntimeStyleRewriteApprovalResponse>;
}

export interface RuntimeStyleRewriteApprovalResponse {
  response_version: 1;
  result: {
    project: RuntimeProjectSessionResponse;
    history: ProjectHistorySummary;
  };
  run: StyleRewriteRunV1;
  canon_check_recommended: true;
}

export interface AgentMemoryOwnerOption {
  /** Carries a complete typed scope so forms never ask authors for raw ids. */
  scope: AgentMemoryScopeV1;
  label: string;
  detail: string;
  search_text: string;
}

export interface AgentMemoryWorkspaceSnapshot {
  catalog: AgentMemoryCatalogV1;
  source_checksum: string;
  history_revision: number;
  owners: AgentMemoryOwnerOption[];
}

export interface RuntimeAgentMemoryPersistence {
  loadAgentMemoryWorkspace: (sessionId: string) => Promise<AgentMemoryWorkspaceSnapshot>;
  applyAgentMemoryCommand: (command: AgentMemoryMutationCommandV1) => Promise<AgentMemoryMutationResponseV1>;
  inspectAgentMemoryDeletionImpact: (sessionId: string, memoryId: string) => Promise<AgentMemoryDeletionImpactV1>;
  resolveAgentMemory: (
    request: import("@something-to-tell/contracts/agent-memory").AgentMemoryResolutionRequestV1
  ) => Promise<import("@something-to-tell/contracts/agent-memory").AgentMemoryResolutionV1>;
  startAgentMemoryCandidate: (request: AgentMemoryCandidateRequestV1) => Promise<AgentMemoryCandidateRunV1>;
  inspectAgentMemoryCandidate: (sessionId: string, runId: string) => Promise<AgentMemoryCandidateRunV1>;
  cancelAgentMemoryCandidate: (sessionId: string, runId: string) => Promise<AgentMemoryCandidateRunV1>;
  retryAgentMemoryCandidate: (sessionId: string, runId: string, request: AgentMemoryCandidateRetryV1) => Promise<AgentMemoryCandidateRunV1>;
  rejectAgentMemoryCandidate: (sessionId: string, runId: string, review: AgentMemoryCandidateReviewV1) => Promise<AgentMemoryCandidateRunV1>;
  acceptAgentMemoryCandidate: (sessionId: string, runId: string, acceptance: AgentMemoryCandidateAcceptanceV1) => Promise<AgentMemoryCandidateAcceptanceResponseV1>;
}

export interface RuntimeEngineTagPersistence {
  loadEngineTagRegistry: (sessionId: string) => Promise<EngineTagMutationResponseV1>;
  inspectEngineTagIntegrity: (sessionId: string) => Promise<EngineTagIntegrityReportV1>;
  previewEngineTagRegistry: (sessionId: string, target: "generic" | "unreal" | "unity" | "ink" | "yarn_spinner") => Promise<EngineTagProjectionV1>;
  applyEngineTagCommand: (command: EngineTagMutationCommandV1) => Promise<EngineTagMutationResponseV1>;
}

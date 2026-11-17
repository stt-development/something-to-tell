import type { ProjectSettings } from "@something-to-tell/contracts/project-manifest";
import type { ImpactPropagation } from "@something-to-tell/contracts/impact-analysis";
import type { DialogueDocument } from "./dialogue/contracts";
import type { QuestDocument } from "./quest/contracts";

// These UI contracts are temporary frontend-owned shapes until shared runtime
// contracts are generated in `packages/contracts`.
export type ProjectStatus = "draft" | "open" | "archived";

// Keep this list as the shared source of truth for authored graph node kinds.
export const NARRATIVE_NODE_KINDS = [
  "Character",
  "Quest",
  "Scene",
  "Lore",
  "Location",
  "Dialogue",
  "Faction",
  "Item",
  "Event",
  "Condition",
  "Consequence"
] as const;

export type NarrativeNodeKind = (typeof NARRATIVE_NODE_KINDS)[number];

// Edge types capture relationship semantics while labels remain editable display text.
export const NARRATIVE_EDGE_TYPES = [
  "appears_in",
  "located_in",
  "belongs_to",
  "owns",
  "allied_with",
  "opposes",
  "requires",
  "unlocks",
  "causes",
  "reveals",
  "mentions",
  "contradicts",
  "depends_on",
  "changes",
  "leads_to"
] as const;

export type NarrativeEdgeType = (typeof NARRATIVE_EDGE_TYPES)[number];
export type SemanticRelationshipType = "contains" | "member_of";
export type NarrativeRelationshipType = NarrativeEdgeType | SemanticRelationshipType;

export const SCENE_ANALYSIS_PATCH_OPERATIONS = ["create_node", "update_node", "create_edge", "update_edge"] as const;

export type SceneAnalysisPatchOperationKind = (typeof SCENE_ANALYSIS_PATCH_OPERATIONS)[number];

export interface NarrativeProject {
  id: string;
  name: string;
  description: string;
  path: string;
  status: ProjectStatus;
  updatedAt: string;
}

/** Transient Phase 5 presentation; runtime findings remain the source of truth. */
export interface ImpactCanvasHighlight {
  findingId: string | null;
  preview: string;
  propagation: ImpactPropagation | null;
  role: "seed" | "direct" | "transitive";
}

export interface NarrativeNodeData extends Record<string, unknown> {
  title: string;
  label: string;
  kind: NarrativeNodeKind;
  summary: string;
  tags: string[];
  /** Dialogue aggregate owned by the dedicated dialogue runtime boundary. */
  dialogueDocument?: DialogueDocument;
  /** Quest aggregate owned by the dedicated Quest runtime boundary. */
  questDocument?: QuestDocument;
  issueCount?: number;
  issueSeverity?: NarrativeIssue["severity"];
  /** Marks Scene and Location nodes rendered as spatial composition frames. */
  isFrame?: boolean;
  /** Root visual placement persisted atomically with a composition frame. */
  rootPlacementId?: string;
  /** Placement identity and scope are visual concerns, not canonical node content. */
  placementId?: string;
  containerNodeId?: string;
  /** All visual instances point back to one edge-addressable canonical node. */
  canonicalNodeId?: string;
  isLinkedInstance?: boolean;
  /** Collapse is placement-specific and must not change canonical frame data. */
  presentationState?: "expanded" | "collapsed";
  /** Restores exact frame geometry after rendering a compact placement card. */
  expandedFrameSize?: { width: number; height: number };
  /** Condition-specific authoring fields, lazily initialized from generic content. */
  requirement?: { expression?: string; predicate: string; subject: string };
  /** Consequence-specific authoring fields naming affected canonical graph targets. */
  outcome?: { effect: string; targetNodeIds: string[] };
  /** Character narrative role is authored independently from free-form tags. */
  characterRole?: string;
  /** Item purpose describes narrative use without assigning semantics to tag order. */
  itemPurpose?: string;
  /** Selected Canon target presentation is transient and never persisted. */
  canonTarget?: boolean;
  canonIssuePreview?: string;
  canonIssueSeverity?: "critical" | "warning" | "info";
  canonIssueStatus?: "open" | "review" | "ignored" | "resolved";
  impactHighlight?: ImpactCanvasHighlight;
  /** Read-only Flow portal context; never persisted as canonical node metadata. */
  callContext?: string;
}

export interface NarrativeEdgeData extends Record<string, unknown> {
  analysisOperationIndex?: number;
  analysisPreview?: string;
  label: string;
  relationshipType?: NarrativeRelationshipType;
  /** Semantic relationships remain traversable in state while normal canvas projection hides them. */
  canvasVisibility?: "hidden";
  /** Stable Dialogue element or option that owns an external transition. */
  dialogueElementId?: string;
  /** Stable Quest stage and branch that own an external transition. */
  questStageId?: string;
  questBranchId?: string;
  /** Specialized outcome reference to one runtime-owned Story Flow invocation. */
  outcomeFlowComposition?: {
    invocationId: string;
    sourceFlowId: string;
    targetFlowId: string;
  };
  issueCount?: number;
  issueSeverity?: NarrativeIssue["severity"];
  /** Selected Canon target presentation is transient and never persisted. */
  canonTarget?: boolean;
  canonIssuePreview?: string;
  canonIssueSeverity?: "critical" | "warning" | "info";
  canonIssueStatus?: "open" | "review" | "ignored" | "resolved";
  impactHighlight?: ImpactCanvasHighlight;
  /** Read-only selected-step state edge; never serialized with semantic relationships. */
  temporalStateOverlay?: { effectId: string };
  /** Dedicated Story Flow order rendered independently from relationship edges. */
  flowTransition?: {
    flowId: string;
    transitionId: string;
    kind: "next" | "branch" | "optional" | "return";
    priority: number;
    isDefault: boolean;
    condition: string;
  };
  /** Cross-flow call route; it is never a semantic relationship. */
  flowInvocation?: {
    invocationId: string;
    sourceFlowId: string;
    targetFlowId: string;
    priority: number;
    isDefault: boolean;
    condition: string;
    invalid: boolean;
  };
  /** Vertical label lane assigned only for the current Flow projection. */
  flowRouteLabelOffset?: number;
  /** Normalized longitudinal lane for routes whose endpoints are shared by other edges. */
  flowRouteLabelLane?: number;
  /** Reciprocal return route rendered as an arc above its endpoint nodes. */
  flowRouteArc?: boolean;
  /** Flow-owned Scene entry/exit routing is distinct from canonical graph edges. */
  sceneBoundary?: {
    boundaryId: string;
    flowId: string;
    sceneNodeId: string;
    entryNodeId: string;
    exitNodeIds: string[];
  };
}

export interface NarrativeIssue {
  id: string;
  projectId: string;
  nodeId?: string | null;
  edgeId?: string | null;
  title: string;
  /** Runtime localization parameters retained for Canon-backed issue keys. */
  titleParameters?: Record<string, unknown>;
  description: string;
  /** Runtime localization parameters retained for recommendation keys. */
  descriptionParameters?: Record<string, unknown>;
  /** Nested Dialogue owners retained from analysis metadata for branch-local review. */
  dialogueOwnerIds?: string[];
  severity: "critical" | "warning" | "info";
  status: "open" | "review" | "ignored" | "resolved";
}

export type Selection =
  | { type: "node"; id: string }
  | { type: "edge"; id: string }
  | { type: "project"; id: string };

/** Frontend-owned transient canvas set; canonical project documents never persist UI selection. */
export interface CanvasSelection {
  edgeIds: string[];
  nodeIds: string[];
}

/** Creates a stable de-duplicated selection set for React Flow and keyboard commands. */
export function createCanvasSelection(nodeIds: string[] = [], edgeIds: string[] = []): CanvasSelection {
  return { edgeIds: [...new Set(edgeIds)], nodeIds: [...new Set(nodeIds)] };
}

export interface ProjectDraft {
  name: string;
  description: string;
  path?: string;
  settings: ProjectSettings;
}

export interface NodeDraft {
  title: string;
  kind: NarrativeNodeData["kind"];
  summary: string;
  tags: string[];
  requirement?: NarrativeNodeData["requirement"];
  outcome?: NarrativeNodeData["outcome"];
  characterRole?: string;
  itemPurpose?: string;
}

export interface FrameDraft extends NodeDraft {
  kind: "Scene" | "Location";
}

export interface EdgeDraft {
  source: string;
  sourceHandle?: string | null;
  target: string;
  targetHandle?: string | null;
  label: string;
  relationshipType?: NarrativeEdgeType;
  /** Undefined preserves the association; null removes it after reviewed deletion. */
  outcomeFlowComposition?: NarrativeEdgeData["outcomeFlowComposition"] | null;
}

export interface DialogueTransitionDraft {
  dialogueNodeId: string;
  originId: string;
  targetNodeId?: string;
  newTarget?: NodeDraft;
  label: string;
  relationshipType: NarrativeEdgeType;
  document: DialogueDocument;
}

export interface QuestTransitionDraft {
  questNodeId: string;
  stageId: string;
  branchId: string;
  targetNodeId?: string;
  newTarget?: NodeDraft;
  label: string;
  relationshipType: NarrativeEdgeType;
  document: QuestDocument;
}

export interface SceneAnalysisRequest {
  project_id: string;
  scene_text: string;
  title: string;
  provider: "deterministic";
  metadata: Record<string, unknown>;
}

export interface EvidenceSpan {
  text: string;
  start?: number | null;
  end?: number | null;
}

export interface ExtractedFact {
  id: string;
  kind: "node" | "edge";
  title: string;
  summary: string;
  evidence: EvidenceSpan;
  metadata: Record<string, unknown>;
}

export interface PatchEndpointRef {
  node_id?: string | null;
  client_id?: string | null;
}

export interface PatchNodeCreate {
  kind: NarrativeNodeKind;
  title: string;
  summary: string;
  body: string;
  status: string;
  metadata: Record<string, unknown>;
}

export interface PatchNodeUpdate {
  title?: string | null;
  summary?: string | null;
  body?: string | null;
  status?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface PatchEdgeCreate {
  source: PatchEndpointRef;
  target: PatchEndpointRef;
  relationship_type: NarrativeEdgeType;
  label: string;
  condition: string;
  metadata: Record<string, unknown>;
}

export interface PatchEdgeUpdate {
  relationship_type?: NarrativeEdgeType | null;
  label?: string | null;
  condition?: string | null;
  metadata?: Record<string, unknown> | null;
}

export type GraphPatchOperation =
  | { op: "create_node"; client_id: string; node: PatchNodeCreate }
  | { op: "update_node"; node_id: string; updates: PatchNodeUpdate }
  | { op: "create_edge"; client_id: string; edge: PatchEdgeCreate }
  | { op: "update_edge"; edge_id: string; updates: PatchEdgeUpdate };

export interface GraphPatch {
  title: string;
  description: string;
  operations: GraphPatchOperation[];
  metadata: Record<string, unknown>;
}

export interface SceneAnalysisResponse {
  project_id: string;
  suggestion_id?: string | null;
  provider: "deterministic";
  extracted_facts: ExtractedFact[];
  patch: GraphPatch;
  warnings: string[];
}

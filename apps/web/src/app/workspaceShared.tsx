import type {
ImpactAnalysisRun,
ImpactFinding,
ImpactResourceRef,
ImpactSeed
} from "@something-to-tell/contracts/impact-analysis";
import type { ProjectHistoryCommandRef } from "@something-to-tell/contracts/project-history";
import type { ProjectPatch } from "@something-to-tell/contracts/project-patch";
import type {
StorageProfileCreateRequest
} from "@something-to-tell/contracts/storage";
import {
type Edge,
type Node,
type NodeChange,
type XYPosition
} from "@xyflow/react";
import {
BookOpen,
Calendar,
CircleHelp,
FileText,
Flag,
GitBranch,
MapPin,
MessageSquare,
Package,
Sparkles,
User,
type LucideIcon
} from "lucide-react";
import { type DialogueCanvasMetrics } from "../dialogue/presentation";
import { firstHop } from "../impact/navigation";
import {
i18next,
localizeRuntimeText,
tr
} from "../localization/i18n";
import { type QuestCanvasMetrics } from "../quest/presentation";
import { type FlowTransition,type FlowTransitionDraft } from "../story-flow/contracts";
import {
type WorkspaceMode
} from "../story-flow/workspace";
import {
NARRATIVE_EDGE_TYPES,
NARRATIVE_NODE_KINDS,
type CanvasSelection,
type NarrativeEdgeData,
type NarrativeEdgeType,
type NarrativeIssue,
type NarrativeNodeData,
type NarrativeRelationshipType,
type ProjectDraft
} from "../types";


export const DEFAULT_WORKSPACE = "~/.narrative";
export const NODE_CONTEXT_MENU_HEIGHT = 416;
export const NODE_KINDS: NarrativeNodeData["kind"][] = [...NARRATIVE_NODE_KINDS];
export const EDGE_TYPES: NarrativeEdgeType[] = [...NARRATIVE_EDGE_TYPES];
export const NODE_COLORS: Record<NarrativeNodeData["kind"], string> = {
  Character: "#0f766e",
  Condition: "#9333ea",
  Consequence: "#be123c",
  Dialogue: "#0891b2",
  Event: "#ca8a04",
  Faction: "#4f46e5",
  Item: "#16a34a",
  Location: "#0369a1",
  Lore: "#7c3aed",
  Quest: "#c2410c",
  Scene: "#2563eb"
};
export const NODE_META: Record<NarrativeNodeData["kind"], { color: string; Icon: LucideIcon }> = {
  Character: { color: NODE_COLORS.Character, Icon: User },
  Condition: { color: NODE_COLORS.Condition, Icon: CircleHelp },
  Consequence: { color: NODE_COLORS.Consequence, Icon: Sparkles },
  Dialogue: { color: NODE_COLORS.Dialogue, Icon: MessageSquare },
  Event: { color: NODE_COLORS.Event, Icon: Calendar },
  Faction: { color: NODE_COLORS.Faction, Icon: Flag },
  Item: { color: NODE_COLORS.Item, Icon: Package },
  Location: { color: NODE_COLORS.Location, Icon: MapPin },
  Lore: { color: NODE_COLORS.Lore, Icon: BookOpen },
  Quest: { color: NODE_COLORS.Quest, Icon: GitBranch },
  Scene: { color: NODE_COLORS.Scene, Icon: FileText }
};

/** Maps canonical kinds to author-facing semantic role names. */
export function displayNodeKind(kind: NarrativeNodeData["kind"]) {
  return tr(`node.${kind.toLowerCase()}` as keyof typeof import("../localization/catalogs").enCatalog);
}

/** Protects native browser undo in every control that can own an authoring draft. */
export function isEditableHistoryTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    && Boolean(target.closest("input, textarea, select, [contenteditable=true], [contenteditable='']"));
}

/** Resolves runtime-owned command metadata through the active project locale. */
export function projectHistoryTooltip(
  direction: "undo" | "redo",
  command: ProjectHistoryCommandRef | null
): string {
  if (!command) return tr(direction === "undo" ? "history.undoEmpty" : "history.redoEmpty");
  const label = i18next.t(command.label_key, command.label_parameters);
  return tr(direction === "undo" ? "history.undo" : "history.redo", { command: label });
}
export const ISSUE_SEVERITIES: NarrativeIssue["severity"][] = ["critical", "warning", "info"];
export const ISSUE_STATUSES: NarrativeIssue["status"][] = ["open", "review", "ignored", "resolved"];
export const ISSUE_COLORS: Record<NarrativeIssue["severity"], string> = {
  critical: "#dc2626",
  warning: "#d97706",
  info: "#0284c7"
};

export type Dialog = "open-project" | "create-project" | "save-as" | "export" | "project-settings" | "engine-tags" | "storage-migration" | "close-project" | "create-flow" | "rename-flow" | "delete-flow" | "build-world" | "choose-connection" | "continue-flow" | "call-flow" | "flow-exit" | "flow-call-bindings" | "set-flow-entry" | "scene-boundary" | "integrate-outcome" | "progression-migration" | "edit-node" | "edit-dialogue" | "edit-quest" | "edit-edge" | "edit-flow-transition" | "delete-entity" | "delete-selection" | null;

export type ImpactCaller = {
  key: string;
  kind: "canon-issue" | "canon-suggestion" | "delete-entity" | "delete-selection" | "scene-suggestion";
  label: string;
  patch?: ProjectPatch;
};

/** Keeps a caller blocked after stale review and releases only that caller after a fresh completion. */
export function impactCallerBlockAfterClose(
  current: string | null,
  callerKey: string,
  status: ImpactAnalysisRun["status"] | null
): string | null {
  if (status === "stale") return callerKey;
  if (status === "completed" && current === callerKey) return null;
  return current;
}

export const CANON_RULE_IDS = [
  "condition.unresolved-path",
  "flow.return-mapping",
  "integrity.error-fact",
  "outcome.required-reachability",
  "outcome.specialized-ownership",
  "ownership.custody-disagreement",
  "relationship.exclusive-conflict"
] as const;

export type FlowTransitionEdit = Pick<FlowTransition, "condition" | "is_default" | "kind" | "label" | "source_node_id" | "target_node_id">;

export type OutcomeFlowCommand =
  | { condition: string; kind: FlowTransitionDraft["kind"]; mode: "direct"; sourceFlowId: string }
  | { condition: string; isDefault: boolean; label: string; mode: "existing"; priority: number; sourceFlowId: string; targetFlowId: string }
  | { condition: string; isDefault: boolean; label: string; mode: "new"; newFlowName: string; priority: number; sourceFlowId: string };

export type OutcomeDeletionImpact = {
  callCount: number;
  flowNames: string[];
  returnCount: number;
  transitionCount: number;
};

export type PendingProjectAction =
  | { kind: "close"; nativeRequestId?: number }
  | { kind: "open"; path: string }
  | { kind: "create"; request: ProjectCreationRequest };
export type StorageProfileDraft = Omit<StorageProfileCreateRequest, "session_id">;
export type ProjectCreationRequest = {
  draft: ProjectDraft;
  storageProfile: StorageProfileDraft | null;
  initialStyle: import("./settings/StyleProfileManager").StyleProfileDraft | null;
};
export type FrameToolMode = "scene-frame" | "location-frame";
export type ToolMode = "select" | "pan" | NarrativeNodeData["kind"] | FrameToolMode;
export type AnalysisTool = "scene" | "impact" | "canon";
export type FrameKind = "Scene" | "Location";
export type PendingGraphConnection = {
  source: string;
  sourceHandle: string | null;
  target: string;
  targetHandle: string | null;
};

export const DEFAULT_FRAME_SIZE = { width: 520, height: 360 };
export const MIN_FRAME_SIZE = { width: 320, height: 220 };
export const FRAME_DRAG_THRESHOLD = 8;
export const SELECT_PAN_BUTTONS = [1];
export const CANVAS_MIN_ZOOM = 0.01;
export const CANVAS_MAX_ZOOM = 10;
export const SAVED_CONFIRMATION_MS = 3_000;

export interface FrameDrawState {
  currentFlow: XYPosition;
  currentScreen: XYPosition;
  kind: FrameKind;
  startFlow: XYPosition;
  startScreen: XYPosition;
}

export interface CanvasContextMenuState {
  flowX?: number;
  flowY?: number;
  impactResource?: ImpactResourceRef;
  x: number;
  y: number;
}

export function calculateFrameBounds(start: XYPosition, end: XYPosition) {
  return {
    position: { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y) },
    size: {
      width: Math.max(MIN_FRAME_SIZE.width, Math.abs(end.x - start.x)),
      height: Math.max(MIN_FRAME_SIZE.height, Math.abs(end.y - start.y))
    }
  };
}

/** Removes React Flow's duplicate relative delta when a selected ancestor already carries its selected descendant. */
export function withoutDoubleAppliedDescendantMoves(
  changes: NodeChange<Node<NarrativeNodeData>>[],
  nodes: Node<NarrativeNodeData>[],
  selectedNodeIds: string[]
) {
  if (selectedNodeIds.length < 2) return changes;
  const selected = new Set(selectedNodeIds);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return changes.filter((change) => {
    if (change.type !== "position" || !selected.has(change.id)) return true;
    let parentId = byId.get(change.id)?.parentId;
    while (parentId) {
      if (selected.has(parentId)) return false;
      parentId = byId.get(parentId)?.parentId;
    }
    return true;
  });
}

export function sameCanvasSelection(left: CanvasSelection, right: CanvasSelection) {
  return left.nodeIds.length === right.nodeIds.length
    && left.edgeIds.length === right.edgeIds.length
    && left.nodeIds.every((id, index) => right.nodeIds[index] === id)
    && left.edgeIds.every((id, index) => right.edgeIds[index] === id);
}

export function impactResourceKey(resource: ImpactResourceRef): string {
  return `${resource.owner_type}:${resource.owner_id}:${resource.context_type ?? ""}:${resource.context_id ?? ""}`;
}

export function impactSeedKeys(seeds: ImpactSeed[]): string {
  return seeds.map((seed) => impactResourceKey(seed.resource)).sort().join("|");
}

/** Localizes the first dependency hop used by compact canvas and Story markers. */
export function impactFindingPreview(finding: ImpactFinding): string {
  const dependency = firstHop(finding);
  const key = dependency?.message_key ?? finding.message_key;
  const parameters = dependency?.message_parameters ?? finding.message_parameters;
  return localizeRuntimeText(key, parameters, key.split(".").at(-1)?.replaceAll("_", " ") ?? key);
}

export interface GraphFilterState {
  issueSeverities: NarrativeIssue["severity"][];
  issueStatuses: NarrativeIssue["status"][];
  kinds: NarrativeNodeData["kind"][];
  query: string;
}

export interface RelationshipInspection {
  edge?: {
    id: string;
    label: string;
    source: Node<NarrativeNodeData> | null;
    target: Node<NarrativeNodeData> | null;
    type: NarrativeRelationshipType;
    dialogueElementId?: string;
  };
  incoming: Array<{ edgeId: string; label: string; node: Node<NarrativeNodeData> }>;
  itemTitle: string;
  outgoing: Array<{ edgeId: string; label: string; node: Node<NarrativeNodeData> }>;
  type: "node" | "edge";
}

export function displayRelationshipType(type: NarrativeRelationshipType) {
  return tr(`relationship.${type}` as keyof typeof import("../localization/catalogs").enCatalog);
}

export type NarrativeNodeRenderData = NarrativeNodeData & {
  analysisOperationIndexes?: number[];
  analysisPreview?: string;
  isConnectionSource?: boolean;
  isConnectionTarget?: boolean;
  issuePreview?: string;
  onOpenAnalysis?: (operationIndex: number) => void;
  dialogueMetrics?: DialogueCanvasMetrics;
  questMetrics?: QuestCanvasMetrics;
  compositionDropState?: { message: string; valid: boolean };
  onFitContent?: () => void;
  onAddLinked?: () => void;
  onFocusFrame?: () => void;
  onToggleCollapse?: () => void;
  frameContentCounts?: FrameContentCounts;
  factionMembers?: string[];
  outcomeTargets?: string[];
  presentationMetrics?: NodePresentationMetrics;
  onResizeEnd?: () => void;
  onResizeStart?: () => void;
  workspaceMode?: WorkspaceMode;
  flowRole?: { branch: boolean; ending: boolean; entry: boolean; unreachable: boolean };
  activeFlowName?: string;
  flowMembership?: boolean;
  onAddToFlow?: () => void;
  onContinueFlow?: () => void;
  onCallFlow?: () => void;
  onCreateFlowExit?: () => void;
  flowCalls?: Array<{ id: string; label: string; onOpen: () => void }>;
  flowExits?: Array<{ id: string; key: string; label: string }>;
  onConfigureSceneBoundary?: () => void;
  onSetFlowEntry?: () => void;
  sceneBoundarySummary?: { entry: string; exits: number };
};

export interface NodePresentationMetrics {
  incoming: number;
  instances: number;
  outgoing: number;
}

export interface FrameContentCounts {
  tooltip: string;
  total: number;
}

export interface AnalysisPreviewMaps {
  edges: Map<string, string>;
  edgeOperations: Map<string, number[]>;
  nodes: Map<string, string>;
  nodeOperations: Map<string, number[]>;
  previewEdges: Array<Edge<NarrativeEdgeData>>;
}

export const WORKSPACE_PREFERENCES_KEY = "stt.workspace.preferences.v1";

/** Produces the canonical project bundle path used by create and Save As dialogs. */
export function projectFolder(parentDirectory: string, name: string) {
  const folderName = name.trim().replace(/[^a-zA-Z0-9_-]+/g, "") || "Untitled";
  const separator = parentDirectory.includes("\\") && !parentDirectory.includes("/") ? "\\" : "/";
  return `${parentDirectory.replace(/[\\/]+$/g, "")}${separator}${folderName}.narrative`;
}

/** Derives a picker-friendly parent from either local path separator style. */
export function projectParentDirectory(projectPath: string) {
  const lastSeparator = Math.max(projectPath.lastIndexOf("/"), projectPath.lastIndexOf("\\"));
  return lastSeparator > 0 ? projectPath.slice(0, lastSeparator) : DEFAULT_WORKSPACE;
}

export type OperationDecision = "approved" | "rejected";

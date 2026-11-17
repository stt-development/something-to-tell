import type { ProjectManifestV2 } from "./projectManifest";
import type { SceneStyleAssignmentV1, StyleProfileV1 } from "./styleSystem";
import type { AgentMemoryEntryV1 } from "./agentMemory";
import type {
  EngineTagBindingV1,
  EngineTagDefinitionV1,
  LegacyEngineTagRecordV1
} from "./engineTags";

/**
 * Shared TypeScript projection of the runtime-owned ProjectDocument schema.
 * Python remains the validation and checksum authority; specialized document
 * types are supplied by each consumer to avoid duplicate Dialogue/Quest owners.
 */

export const PROJECT_DOCUMENT_VERSION = 5 as const;

export interface PersistedRecord {
  id: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectOwnedRecord extends PersistedRecord {
  project_id: string;
}

export interface ProjectNodeRecord extends ProjectOwnedRecord {
  type: string;
  title: string;
  summary: string;
  body: string;
  status: string;
  metadata: Record<string, unknown>;
}

export interface ProjectEdgeRecord extends ProjectOwnedRecord {
  source_node_id: string;
  target_node_id: string;
  type: string;
  label: string;
  condition: string;
  metadata: Record<string, unknown>;
}

export interface ProjectIssueRecord extends ProjectOwnedRecord {
  title: string;
  node_id: string | null;
  edge_id: string | null;
  description: string;
  severity: string;
  status: string;
  metadata: Record<string, unknown>;
}

export interface ProjectSuggestionRecord extends ProjectOwnedRecord {
  title: string;
  description: string;
  status: string;
  patch: Record<string, unknown>;
  created_by: string;
  metadata: Record<string, unknown>;
}

export interface ProjectEngineTagRecord extends ProjectOwnedRecord {
  target_type: string;
  target_id: string;
  engine: string;
  key: string;
  value: string;
  metadata: Record<string, unknown>;
}

export interface ProjectPlacementRecord extends ProjectOwnedRecord {
  canonical_node_id: string;
  scope_key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  container_node_id: string | null;
  is_primary: boolean;
  presentation_state: string;
  metadata: Record<string, unknown>;
}

export interface ProjectStoryFlowRecord extends ProjectOwnedRecord {
  name: string;
  normalized_name: string;
  description: string;
  kind: string;
  status: string;
  entry_node_id: string | null;
  metadata: Record<string, unknown>;
}

export interface ProjectStoryFlowNodeRecord extends ProjectOwnedRecord {
  flow_id: string;
  node_id: string;
  presentation_order: number;
  metadata: Record<string, unknown>;
}

export interface ProjectFlowTransitionRecord extends ProjectOwnedRecord {
  flow_id: string;
  source_node_id: string;
  target_node_id: string;
  priority: number;
  kind: string;
  label: string;
  condition: string;
  is_default: boolean;
  metadata: Record<string, unknown>;
}

export interface ProjectSceneFlowBoundaryRecord extends ProjectOwnedRecord {
  flow_id: string;
  scene_node_id: string;
  entry_node_id: string;
  exit_node_ids: string[];
  metadata: Record<string, unknown>;
}

export interface ProjectFlowInvocationRecord extends ProjectOwnedRecord {
  source_flow_id: string;
  source_node_id: string;
  target_flow_id: string;
  label: string;
  condition: string;
  priority: number;
  is_default: boolean;
}

export interface ProjectFlowExitRecord extends ProjectOwnedRecord {
  flow_id: string;
  key: string;
  label: string;
  source_node_id: string;
}

export interface ProjectFlowExitBindingRecord extends ProjectOwnedRecord {
  invocation_id: string;
  exit_id: string;
  target_node_id: string;
}

/** Durable root state remains separate from transient Playback state. */
export interface ProjectFlowInitialStateRecord extends ProjectOwnedRecord {
  state_version: 1;
  flow_id: string;
  flags: Record<string, boolean>;
  item_custody: Array<{
    custody_version: 1;
    item_node_id: string;
    holder: { holder_version: 1; kind: string; node_id?: string };
  }>;
  quest_statuses: Record<string, "inactive" | "active" | "completed" | "failed">;
}

/** Versioned reusable effect payload mirrored from the runtime authority. */
export interface ProjectNarrativeEffectRecord extends ProjectOwnedRecord {
  effect_version: 1;
  operation: string;
  payload: Record<string, unknown>;
  repeat_policy: string;
  explanation: string;
}

/** Flattened storage record for one stable temporal-owner binding. */
export interface ProjectNarrativeEffectBindingRecord extends ProjectOwnedRecord {
  binding_version: 1;
  effect_id: string;
  owner_kind: string;
  owner_id: string;
  context_node_id: string | null;
  application_order: number;
}

export interface OwnedSpecializedDocument<TDocument> {
  node_id: string;
  document: TDocument;
}

export interface ProjectDocument<TDialogueDocument, TQuestDocument> {
  document_version: typeof PROJECT_DOCUMENT_VERSION;
  checksum: string;
  manifest: ProjectManifestV2;
  project_metadata: Record<string, unknown>;
  nodes: ProjectNodeRecord[];
  edges: ProjectEdgeRecord[];
  issues: ProjectIssueRecord[];
  suggestions: ProjectSuggestionRecord[];
  engine_tags: ProjectEngineTagRecord[];
  /** Optional while v5 snapshots are read; new runtime documents populate these collections. */
  engine_tag_definitions?: EngineTagDefinitionV1[];
  engine_tag_bindings?: EngineTagBindingV1[];
  legacy_engine_tags?: LegacyEngineTagRecordV1[];
  placements: ProjectPlacementRecord[];
  dialogues: OwnedSpecializedDocument<TDialogueDocument>[];
  quests: OwnedSpecializedDocument<TQuestDocument>[];
  story_flows: ProjectStoryFlowRecord[];
  story_flow_nodes: ProjectStoryFlowNodeRecord[];
  flow_transitions: ProjectFlowTransitionRecord[];
  scene_flow_boundaries: ProjectSceneFlowBoundaryRecord[];
  flow_invocations: ProjectFlowInvocationRecord[];
  flow_exits: ProjectFlowExitRecord[];
  flow_exit_bindings: ProjectFlowExitBindingRecord[];
  flow_initial_states: ProjectFlowInitialStateRecord[];
  narrative_effects: ProjectNarrativeEffectRecord[];
  narrative_effect_bindings: ProjectNarrativeEffectBindingRecord[];
  style_profiles: StyleProfileV1[];
  scene_style_assignments: SceneStyleAssignmentV1[];
  agent_memories: AgentMemoryEntryV1[];
}

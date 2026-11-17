import type { ProjectManifestV2 } from "./projectManifest";

/**
 * Shared mirror of services/runtime/stt_runtime/schemas/project_patch.py.
 * Python owns validation and checksum application; keep this documented adapter
 * synchronized until contract generation replaces the handwritten projection.
 */
export const PROJECT_PATCH_VERSION = 1 as const;
export const PROJECT_RECORD_COLLECTIONS = [
  "nodes",
  "edges",
  "issues",
  "suggestions",
  "engine_tags",
  "engine_tag_definitions",
  "engine_tag_bindings",
  "legacy_engine_tags",
  "placements",
  "dialogues",
  "quests",
  "story_flows",
  "story_flow_nodes",
  "flow_transitions",
  "scene_flow_boundaries",
  "flow_invocations",
  "flow_exits",
  "flow_exit_bindings",
  "flow_initial_states",
  "narrative_effects",
  "narrative_effect_bindings",
  "style_profiles",
  "scene_style_assignments",
  "agent_memories"
] as const;

export type ProjectRecordCollection = (typeof PROJECT_RECORD_COLLECTIONS)[number];

export interface PutProjectRecordOperation {
  op: "put_record";
  collection: ProjectRecordCollection;
  record_id: string;
  record: Record<string, unknown>;
}

export interface RemoveProjectRecordOperation {
  op: "remove_record";
  collection: ProjectRecordCollection;
  record_id: string;
}

export interface ReplaceProjectMetadataOperation {
  op: "replace_project_metadata";
  value: Record<string, unknown>;
}

export interface ReplaceManifestOperation {
  op: "replace_manifest";
  manifest: ProjectManifestV2;
}

export type ProjectPatchOperation =
  | PutProjectRecordOperation
  | RemoveProjectRecordOperation
  | ReplaceProjectMetadataOperation
  | ReplaceManifestOperation;

export interface ProjectPatch {
  patch_version: typeof PROJECT_PATCH_VERSION;
  patch_id: string;
  project_id: string;
  source_checksum: string;
  target_checksum: string;
  operations: ProjectPatchOperation[];
}

/** Mirrors the runtime's stable owner key rule for typed collection adapters. */
export function projectPatchRecordId(
  collection: ProjectRecordCollection,
  record: Record<string, unknown>
): string {
  const key = collection === "dialogues" || collection === "quests" ? "node_id" : "id";
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${collection} record requires a non-empty ${key}`);
  }
  return value;
}

/** Produces the deterministic operation target used by history reconciliation. */
export function projectPatchOperationTarget(operation: ProjectPatchOperation): string {
  if (operation.op === "replace_manifest") return "0:manifest";
  if (operation.op === "replace_project_metadata") return "1:project_metadata";
  const collectionIndex = PROJECT_RECORD_COLLECTIONS.indexOf(operation.collection);
  return `${String(collectionIndex + 2).padStart(2, "0")}:${operation.collection}:${operation.record_id}`;
}

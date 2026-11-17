/** Versioned wire and pipeline contracts for deterministic Phase 8 exports. */

import type {
  EngineTagOwnerV1,
  EngineTagProjectionDiagnosticV1,
  EngineTagProjectionEntryV1,
  EngineTagProjectionOmissionV1,
  EngineTagProjectionTargetV1
} from "./engineTags";

export const EXPORT_CONTRACT_VERSION = 1 as const;
export const EXPORT_FORMATS = ["json", "yaml", "yarn_spinner", "ink"] as const;
export const EXPORT_SCOPES = ["whole_project", "story_flows"] as const;
export const EXPORT_MAX_SELECTED_FLOWS = 128 as const;
export const EXPORT_MAX_PREVIEW_BYTES = 262_144 as const;
export const EXPORT_MAX_DIAGNOSTICS = 2_000 as const;
export const EXPORT_MAX_RECORDS = 100_000 as const;
export const EXPORT_MAX_OUTPUT_BYTES = 52_428_800 as const;
export const EXPORT_MAX_NAME_LENGTH = 160 as const;
export const EXPORT_MAX_PATH_LENGTH = 4_096 as const;
export const EXPORT_MAX_TEXT_LENGTH = 1_048_576 as const;

export type ExportFormatV1 = (typeof EXPORT_FORMATS)[number];
export type ExportScopeV1 = (typeof EXPORT_SCOPES)[number];
export type ExportDiagnosticSeverityV1 = "error" | "warning" | "info";
export type ExportErrorCodeV1 =
  | "export_contract_invalid" | "export_limit_exceeded" | "export_source_stale"
  | "export_plan_stale" | "export_scope_invalid" | "export_path_invalid"
  | "export_destination_conflict" | "export_projection_unsafe"
  | "export_permission_denied" | "export_write_failed" | "export_format_unsupported";
export type ExportJsonValue = null | boolean | number | string | ExportJsonValue[] | {
  [key: string]: ExportJsonValue;
};

export interface ExportOptionsV1 {
  options_version: typeof EXPORT_CONTRACT_VERSION;
  format: ExportFormatV1;
  scope: ExportScopeV1;
  story_flow_ids: string[];
  engine_tag_target: EngineTagProjectionTargetV1;
  preview_max_bytes: number;
}

export interface ExportPlanRequestV1 {
  request_version: typeof EXPORT_CONTRACT_VERSION;
  options: ExportOptionsV1;
}

export interface ExportSourceIdentityV1 {
  identity_version: typeof EXPORT_CONTRACT_VERSION;
  project_id: string;
  project_name: string;
  content_locale: string;
  document_version: number;
  source_checksum: string;
}

export type ExportOwnerKindV1 =
  | "project" | "node" | "relationship" | "dialogue" | "dialogue_element"
  | "dialogue_option" | "quest" | "quest_stage" | "quest_branch" | "story_flow"
  | "flow_transition" | "flow_invocation" | "flow_exit" | "narrative_effect";

export interface ExportOwnerV1 {
  owner_version: typeof EXPORT_CONTRACT_VERSION;
  kind: ExportOwnerKindV1;
  id: string;
  context_id: string | null;
}

export interface ExportDiagnosticV1 {
  diagnostic_version: typeof EXPORT_CONTRACT_VERSION;
  code: `export.${string}`;
  severity: ExportDiagnosticSeverityV1;
  message_key: `export.${string}`;
  owner: ExportOwnerV1 | null;
  parameters: Record<string, ExportJsonValue>;
}

export interface ExportInventoryV1 {
  inventory_version: typeof EXPORT_CONTRACT_VERSION;
  node_count: number;
  relationship_count: number;
  dialogue_count: number;
  quest_count: number;
  story_flow_count: number;
  flow_membership_count: number;
  flow_transition_count: number;
  scene_boundary_count: number;
  flow_invocation_count: number;
  flow_exit_count: number;
  flow_exit_binding_count: number;
  initial_state_count: number;
  narrative_effect_count: number;
  narrative_effect_binding_count: number;
  engine_tag_count: number;
  diagnostic_count: number;
  record_count: number;
  resolved_story_flow_ids: string[];
}

export interface ExportPreviewV1 {
  preview_version: typeof EXPORT_CONTRACT_VERSION;
  media_type: "application/json" | "application/yaml" | "text/x-yarnspinner" | "text/x-ink";
  text: string;
  preview_bytes: number;
  total_bytes: number;
  truncated: boolean;
}

/** Unknown portable metadata survives only under validated x-* keys. */
export interface ExportPortableExtensionsV1 {
  extension_version: typeof EXPORT_CONTRACT_VERSION;
  values: Record<`x-${string}`, ExportJsonValue>;
}

export interface ExportManifestV1 {
  schema_version: typeof EXPORT_CONTRACT_VERSION;
  kind: "narrative_export";
  source: ExportSourceIdentityV1;
  scope: ExportScopeV1;
  story_flow_ids: string[];
  engine_tag_target: EngineTagProjectionTargetV1;
}

export interface ExportProjectV1 {
  project_version: typeof EXPORT_CONTRACT_VERSION;
  id: string;
  name: string;
  description: string;
  content_locale: string;
  extensions: ExportPortableExtensionsV1;
}

export interface ExportNodeV1 {
  node_version: typeof EXPORT_CONTRACT_VERSION;
  id: string;
  type: string;
  title: string;
  summary: string;
  body: string;
  status: string;
  tags: string[];
  container_node_ids: string[];
  attributes: {
    attributes_version: 1;
    character_role: string | null;
    item_purpose: string | null;
    requirement: { subject: string; predicate: string; expression: string } | null;
    outcome: { effect: string; target_node_ids: string[] } | null;
  };
  extensions: ExportPortableExtensionsV1;
}

export interface ExportRelationshipV1 {
  relationship_version: typeof EXPORT_CONTRACT_VERSION;
  id: string;
  source_node_id: string;
  target_node_id: string;
  type: string;
  label: string;
  condition: string;
  extensions: ExportPortableExtensionsV1;
}

export interface ExportDialogueLineV1 {
  id: string;
  kind: "line";
  speaker_node_id: string;
  text: string;
  next_element_id: string | null;
}

export interface ExportDialogueOptionV1 {
  id: string;
  text: string;
  condition: string;
  next_element_id: string | null;
}

export interface ExportDialogueChoiceV1 {
  id: string;
  kind: "choice";
  prompt: string;
  options: ExportDialogueOptionV1[];
}

export interface ExportDialogueV1 {
  aggregate_version: typeof EXPORT_CONTRACT_VERSION;
  node_id: string;
  document: {
    dialogue_version: 1;
    entry_element_id: string | null;
    participants: string[];
    elements: Array<ExportDialogueLineV1 | ExportDialogueChoiceV1>;
  };
}

export interface ExportQuestV1 {
  aggregate_version: typeof EXPORT_CONTRACT_VERSION;
  node_id: string;
  document: {
    quest_version: 1;
    objective: string;
    quest_giver_node_id: string | null;
    entry_stage_id: string | null;
    prerequisite_node_ids: string[];
    reward_node_ids: string[];
    stages: Array<{
      id: string;
      title: string;
      description: string;
      branches: Array<{ id: string; label: string; condition: string; target_stage_id: string | null }>;
    }>;
  };
}

export interface ExportStoryFlowDefinitionV1 {
  id: string;
  name: string;
  description: string;
  kind: string;
  status: string;
  entry_node_id: string | null;
}

export interface ExportStoryFlowMembershipV1 {
  id: string;
  flow_id: string;
  node_id: string;
  presentation_order: number;
}

export interface ExportFlowTransitionV1 {
  id: string;
  flow_id: string;
  source_node_id: string;
  target_node_id: string;
  priority: number;
  kind: string;
  label: string;
  condition: string;
  is_default: boolean;
  dialogue_element_id: string | null;
  quest_branch_id: string | null;
}

export interface ExportSceneFlowBoundaryV1 {
  id: string;
  flow_id: string;
  scene_node_id: string;
  entry_node_id: string;
  exit_node_ids: string[];
}

export interface ExportFlowInvocationV1 {
  id: string;
  source_flow_id: string;
  source_node_id: string;
  target_flow_id: string;
  label: string;
  condition: string;
  priority: number;
  is_default: boolean;
}

export interface ExportFlowExitV1 {
  id: string;
  flow_id: string;
  key: string;
  label: string;
  source_node_id: string;
}

export interface ExportFlowExitBindingV1 {
  id: string;
  invocation_id: string;
  exit_id: string;
  target_node_id: string;
}

export interface ExportStoryFlowsV1 {
  story_flows_version: typeof EXPORT_CONTRACT_VERSION;
  definitions: ExportStoryFlowDefinitionV1[];
  memberships: ExportStoryFlowMembershipV1[];
  transitions: ExportFlowTransitionV1[];
  scene_boundaries: ExportSceneFlowBoundaryV1[];
  invocations: ExportFlowInvocationV1[];
  exits: ExportFlowExitV1[];
  exit_bindings: ExportFlowExitBindingV1[];
}

export interface ExportStateHolderV1 {
  holder_version: 1;
  kind: "character" | "location" | "faction" | "player" | "party" | "unowned";
  node_id: string | null;
}

export interface ExportFlowInitialStateV1 {
  state_version: 1;
  id: string;
  flow_id: string;
  flags: Record<string, boolean>;
  item_custody: Array<{ custody_version: 1; item_node_id: string; holder: ExportStateHolderV1 }>;
  quest_statuses: Record<string, "inactive" | "active" | "completed" | "failed">;
}

interface ExportNarrativeEffectBaseV1 {
  effect_version: 1;
  id: string;
  repeat_policy: "once" | "per_visit";
  explanation: string;
}

export type ExportNarrativeEffectV1 = ExportNarrativeEffectBaseV1 & (
  | { operation: "transfer_item"; payload: {
    item_node_id: string; from_holder: ExportStateHolderV1; to_holder: ExportStateHolderV1;
  } }
  | { operation: "set_flag" | "clear_flag"; payload: { flag: string } }
  | { operation: "set_quest_status"; payload: {
    quest_node_id: string; status: "inactive" | "active" | "completed" | "failed";
  } }
  | { operation: "record_dialogue_choice"; payload: {
    dialogue_node_id: string; choice_id: string;
  } }
);

export interface ExportNarrativeEffectBindingV1 {
  binding_version: 1;
  id: string;
  effect_id: string;
  owner_kind: "node_entry" | "flow_transition" | "dialogue_element" | "dialogue_option" |
    "quest_branch" | "quest_outcome" | "flow_invocation" | "flow_exit";
  owner_id: string;
  context_node_id: string | null;
  application_order: number;
}

export interface ExportNarrativeStateV1 {
  narrative_state_version: typeof EXPORT_CONTRACT_VERSION;
  initial_states: ExportFlowInitialStateV1[];
  effects: ExportNarrativeEffectV1[];
  bindings: ExportNarrativeEffectBindingV1[];
}

export interface ExportEngineTagsV1 {
  engine_tags_version: typeof EXPORT_CONTRACT_VERSION;
  project_id: string;
  source_checksum: string;
  target: EngineTagProjectionTargetV1;
  entries: EngineTagProjectionEntryV1[];
  omitted: EngineTagProjectionOmissionV1[];
  diagnostics: EngineTagProjectionDiagnosticV1[];
}

/** Explicit allowlist: no ProjectDocument, placement, provider, or storage fields are inherited. */
export interface ExportProjectionV1 {
  projection_version: typeof EXPORT_CONTRACT_VERSION;
  manifest: ExportManifestV1;
  project: ExportProjectV1;
  nodes: ExportNodeV1[];
  relationships: ExportRelationshipV1[];
  dialogues: ExportDialogueV1[];
  quests: ExportQuestV1[];
  story_flows: ExportStoryFlowsV1;
  narrative_state: ExportNarrativeStateV1;
  engine_tags: ExportEngineTagsV1;
  diagnostics: ExportDiagnosticV1[];
}

export type ExecutableConditionNodeV1 =
  | { condition_version: 1; kind: "literal"; value_type: "boolean" | "number" | "string" | "null";
      value: boolean | number | string | null }
  | { condition_version: 1; kind: "state"; path: string[] }
  | { condition_version: 1; kind: "unary"; operator: "not"; operand: ExecutableConditionNodeV1 }
  | { condition_version: 1; kind: "binary";
      operator: "and" | "or" | "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "in" | "not_in";
      left: ExecutableConditionNodeV1; right: ExecutableConditionNodeV1 };

export interface ExecutableSpeakerV1 {
  speaker_version: 1; node_id: string; symbol: string; display_name: string;
}

export interface ExecutableLineV1 {
  line_version: 1; id: string; symbol: string; speaker_symbol: string | null;
  text: string; next_symbol: string | null; operation_ids: string[];
}

export interface ExecutableChoiceOptionV1 {
  option_version: 1; id: string; symbol: string; text: string;
  condition: ExecutableConditionNodeV1 | null; next_symbol: string | null;
  operation_ids: string[];
}

export interface ExecutableChoiceV1 {
  choice_version: 1; id: string; symbol: string; prompt: string;
  operation_ids: string[]; options: ExecutableChoiceOptionV1[];
}

export interface ExecutableDialogueV1 {
  dialogue_version: 1; node_id: string; symbol: string; entry_symbol: string | null;
  lines: ExecutableLineV1[]; choices: ExecutableChoiceV1[];
}

export interface ExecutableQuestBranchV1 {
  branch_version: 1; id: string; symbol: string; label: string;
  condition: ExecutableConditionNodeV1 | null; target_stage_symbol: string | null;
  operation_ids: string[];
}

export interface ExecutableQuestStageV1 {
  stage_version: 1; id: string; symbol: string; title: string; description: string;
  branches: ExecutableQuestBranchV1[];
}

export interface ExecutableQuestV1 {
  quest_version: 1; node_id: string; symbol: string; objective: string;
  entry_stage_symbol: string | null; stages: ExecutableQuestStageV1[];
}

export interface ExecutableReturnBindingV1 {
  binding_version: 1; exit_symbol: string; target_step_symbol: string;
}

export interface ExecutableRouteV1 {
  route_version: 1; id: string; symbol: string; kind: "jump" | "call";
  label: string; priority: number; is_default: boolean;
  condition: ExecutableConditionNodeV1 | null; target_symbol: string;
  return_bindings: ExecutableReturnBindingV1[]; operation_ids: string[];
  dialogue_element_id: string | null; quest_branch_id: string | null;
}

export interface ExecutableReturnV1 {
  return_version: 1; id: string; symbol: string; key: string; label: string;
  source_step_symbol: string; operation_ids: string[];
}

export interface ExecutableStepV1 {
  step_version: 1; node_id: string; symbol: string; node_kind: string;
  title: string; text: string; dialogue_symbol: string | null; quest_symbol: string | null;
  operation_ids: string[]; routes: ExecutableRouteV1[];
}

export interface ExecutableFlowV1 {
  flow_version: 1; id: string; symbol: string; name: string; is_root: boolean;
  entry_step_symbol: string; steps: ExecutableStepV1[]; returns: ExecutableReturnV1[];
}

export interface ExecutableOperationV1 {
  operation_version: 1; id: string; symbol: string; effect_id: string;
  execution: "native" | "host";
  host_binding_id: string | null;
  owner_kind: "node_entry" | "flow_transition" | "dialogue_element" | "dialogue_option" |
    "quest_branch" | "quest_outcome" | "flow_invocation" | "flow_exit";
  owner_id: string;
  context_node_id: string | null; application_order: number; effect: ExportNarrativeEffectV1;
}

export interface ExecutableHostBindingV1 {
  binding_version: 1; id: string; namespace: string; name: string; operation: string;
  parameter_names: string[]; result_type: "void";
}

export interface ExecutableSourceMapEntryV1 {
  source_map_version: 1; symbol: string; owner: ExportOwnerV1;
}

export interface ExecutableNarrativeProjectionV1 {
  executable_version: 1;
  source: ExportSourceIdentityV1;
  speakers: ExecutableSpeakerV1[];
  flows: ExecutableFlowV1[];
  dialogues: ExecutableDialogueV1[];
  quests: ExecutableQuestV1[];
  initial_states: ExportFlowInitialStateV1[];
  operations: ExecutableOperationV1[];
  host_bindings: ExecutableHostBindingV1[];
  source_map: ExecutableSourceMapEntryV1[];
  diagnostics: ExportDiagnosticV1[];
}

export interface ExportProjectionBuildV1 {
  build_version: typeof EXPORT_CONTRACT_VERSION;
  projection: ExportProjectionV1;
  inventory: ExportInventoryV1;
}

export interface ExportPlanV1 {
  plan_version: typeof EXPORT_CONTRACT_VERSION;
  options: ExportOptionsV1;
  source: ExportSourceIdentityV1;
  inventory: ExportInventoryV1;
  diagnostics: ExportDiagnosticV1[];
  preview: ExportPreviewV1;
  suggested_filename: string;
  plan_fingerprint: string;
  can_write: boolean;
}

export interface ExportWriteRequestV1 {
  request_version: typeof EXPORT_CONTRACT_VERSION;
  options: ExportOptionsV1;
  expected_source_checksum: string;
  expected_plan_fingerprint: string;
  destination_directory: string | null;
  overwrite: boolean;
}

export interface ExportArtifactV1 {
  artifact_version: typeof EXPORT_CONTRACT_VERSION;
  format: ExportFormatV1;
  filename: string;
  installed_path: string;
  artifact_checksum: string;
  source_checksum: string;
  bytes_written: number;
}

export interface ExportWriteResultV1 {
  result_version: typeof EXPORT_CONTRACT_VERSION;
  artifact: ExportArtifactV1;
}

export interface ExportErrorV1 {
  error_version: typeof EXPORT_CONTRACT_VERSION;
  code: ExportErrorCodeV1;
  message_key: `export.error.${string}`;
  parameters: Record<string, ExportJsonValue>;
}

export class ExportContractError extends Error {
  constructor(public readonly code: ExportErrorCodeV1) {
    super(code);
    this.name = "ExportContractError";
  }
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const EXTENSION_KEY_PATTERN = /^x-[a-z][a-z0-9_.-]{0,126}$/;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SECRET_PATTERNS = [
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}\b/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~-]{20,}\b/i
];
const FORBIDDEN_EXTENSION_KEYS = new Set([
  "api_key", "apikey", "credential", "credentials", "database_url", "destination",
  "password", "path", "provider", "secret", "storage", "token"
]);

function assertIdentifier(value: string): void {
  if (!ID_PATTERN.test(value.trim()) || value.includes("..")) {
    throw new ExportContractError("export_contract_invalid");
  }
}

function inspectPortableValue(value: ExportJsonValue, depth = 0): void {
  if (depth > 16) throw new ExportContractError("export_limit_exceeded");
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new ExportContractError("export_contract_invalid");
  }
  if (typeof value === "string" && CONTROL_PATTERN.test(value)) {
    throw new ExportContractError("export_projection_unsafe");
  }
  if (typeof value === "string" && SECRET_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new ExportContractError("export_projection_unsafe");
  }
  if (Array.isArray(value)) {
    value.forEach((item) => inspectPortableValue(item, depth + 1));
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_EXTENSION_KEYS.has(key.toLowerCase().replaceAll("-", "_"))) {
        throw new ExportContractError("export_projection_unsafe");
      }
      inspectPortableValue(item, depth + 1);
    }
  }
}

/** Validate transient options before sending them to the runtime authority. */
export function validateExportOptions(options: ExportOptionsV1): void {
  if (options.options_version !== EXPORT_CONTRACT_VERSION ||
      !EXPORT_FORMATS.includes(options.format) || !EXPORT_SCOPES.includes(options.scope) ||
      options.story_flow_ids.length > EXPORT_MAX_SELECTED_FLOWS ||
      options.preview_max_bytes < 1 || options.preview_max_bytes > EXPORT_MAX_PREVIEW_BYTES) {
    throw new ExportContractError("export_limit_exceeded");
  }
  options.story_flow_ids.forEach(assertIdentifier);
  if (new Set(options.story_flow_ids).size !== options.story_flow_ids.length ||
      (options.scope === "whole_project" && options.story_flow_ids.length > 0)) {
    throw new ExportContractError("export_scope_invalid");
  }
  const target = options.format === "ink" ? "ink" :
    options.format === "yarn_spinner" ? "yarn_spinner" : null;
  if (target !== null && options.engine_tag_target !== target) {
    throw new ExportContractError("export_scope_invalid");
  }
}

/** Validate unknown x-* metadata without interpreting it as narrative data. */
export function validatePortableExtensions(extensions: ExportPortableExtensionsV1): void {
  if (extensions.extension_version !== EXPORT_CONTRACT_VERSION || Object.keys(extensions.values).length > 64) {
    throw new ExportContractError("export_limit_exceeded");
  }
  for (const [key, value] of Object.entries(extensions.values)) {
    if (!EXTENSION_KEY_PATTERN.test(key)) {
      throw new ExportContractError("export_projection_unsafe");
    }
    inspectPortableValue(value);
  }
}

/** Adapt an Engine Tag owner only where UI diagnostics need its stable identity. */
export function exportOwnerFromEngineTag(owner: EngineTagOwnerV1): ExportOwnerV1 {
  const id = owner.node_id ?? owner.edge_id ?? owner.line_id ?? owner.choice_id ??
    owner.option_id ?? owner.stage_id ?? owner.branch_id ?? owner.flow_id ??
    owner.transition_id ?? owner.invocation_id ?? owner.exit_id ?? owner.effect_id ?? owner.project_id;
  return { owner_version: 1, kind: owner.kind === "relationship" ? "relationship" :
    owner.kind === "dialogue_line" || owner.kind === "dialogue_choice" ? "dialogue_element" :
    owner.kind === "dialogue_option" ? "dialogue_option" :
    owner.kind === "quest_stage" ? "quest_stage" : owner.kind === "quest_branch" ? "quest_branch" :
    owner.kind, id, context_id: owner.dialogue_node_id ?? owner.quest_node_id ?? null };
}

/** Versioned authoring boundary for stable engine tags. Persistence is added in P7-002. */

export const ENGINE_TAG_VERSION = 1 as const;
export const ENGINE_TAG_DOCUMENT_VERSION = 6 as const;
export const ENGINE_TAG_TARGETS = ["unreal", "unity", "ink", "yarn_spinner"] as const;
/** Authoring targets; legacy Unity/Unreal wire variants remain portable. */
export const ENGINE_TAG_AUTHORING_TARGETS_V1 = ["ink", "yarn_spinner"] as const;
export const ENGINE_TAG_STATUSES = ["active", "archived"] as const;
export const ENGINE_TAG_MAX_KEY_LENGTH = 160 as const;
export const ENGINE_TAG_MAX_DEFINITIONS = 2_000 as const;
export const ENGINE_TAG_MAX_TEXT_LENGTH = 2_000 as const;

export type EngineTagTargetV1 = (typeof ENGINE_TAG_TARGETS)[number];
export type EngineTagStatusV1 = (typeof ENGINE_TAG_STATUSES)[number];
export type EngineTagOwnerKindV1 =
  | "project" | "node" | "relationship" | "dialogue_line" | "dialogue_choice"
  | "dialogue_option" | "quest_stage" | "quest_branch" | "story_flow"
  | "flow_transition" | "flow_invocation" | "flow_exit" | "narrative_effect";

export interface EngineTagOwnerV1 {
  kind: EngineTagOwnerKindV1;
  project_id: string;
  node_id?: string;
  edge_id?: string;
  dialogue_node_id?: string;
  line_id?: string;
  choice_id?: string;
  option_id?: string;
  quest_node_id?: string;
  stage_id?: string;
  branch_id?: string;
  flow_id?: string;
  transition_id?: string;
  invocation_id?: string;
  exit_id?: string;
  effect_id?: string;
}

/** Stable semantic identity ignores transport-level nulls added to optional owner fields. */
export function engineTagOwnerKey(owner: EngineTagOwnerV1): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(owner)
      .filter(([, value]) => value !== null && value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
  ));
}

export interface EngineTagTargetAliasV1 {
  tag_version: typeof ENGINE_TAG_VERSION;
  target: EngineTagTargetV1;
  external_identifier: string;
}

export interface EngineTagDefinitionV1 {
  tag_version: typeof ENGINE_TAG_VERSION;
  id: string;
  project_id: string;
  key: string;
  normalized_key: string;
  description: string;
  status: EngineTagStatusV1;
  aliases: EngineTagTargetAliasV1[];
  created_at: string;
  updated_at: string;
}

export interface EngineTagBindingV1 {
  tag_version: typeof ENGINE_TAG_VERSION;
  id: string;
  project_id: string;
  definition_id: string;
  owner: EngineTagOwnerV1;
  value: string;
  created_at: string;
  updated_at: string;
}

/** The old generic row is quarantined byte-for-byte until an explicit review converts it. */
export interface LegacyEngineTagRecordV1 {
  id: string;
  project_id: string;
  created_at: string;
  updated_at: string;
  target_type: string;
  target_id: string;
  engine: string;
  key: string;
  value: string;
  metadata: Record<string, unknown>;
}

export interface EngineTagProjectExtensionV6 {
  document_version: typeof ENGINE_TAG_DOCUMENT_VERSION;
  engine_tag_definitions: EngineTagDefinitionV1[];
  engine_tag_bindings: EngineTagBindingV1[];
  legacy_engine_tags: LegacyEngineTagRecordV1[];
}

export interface EngineTagSuggestionRequestV1 {
  request_version: typeof ENGINE_TAG_VERSION;
  project_id: string;
  owner: EngineTagOwnerV1;
  label: string;
  existing_keys: string[];
}

export interface EngineTagSuggestionV1 {
  suggestion_version: typeof ENGINE_TAG_VERSION;
  key: string;
  normalized_key: string;
  collision_resolved: boolean;
}

export interface EngineTagPreviewV1 {
  preview_version: typeof ENGINE_TAG_VERSION;
  project_id: string;
  definitions: EngineTagDefinitionV1[];
  bindings: EngineTagBindingV1[];
  legacy_count: number;
  read_only: true;
}

export interface EngineTagCatalogV1 {
  catalog_version: typeof ENGINE_TAG_VERSION;
  project_id: string;
  definitions: EngineTagDefinitionV1[];
  bindings: EngineTagBindingV1[];
  legacy_count: number;
}

export interface EngineTagImpactV1 {
  impact_version: typeof ENGINE_TAG_VERSION;
  definition_id: string;
  affected_owner_count: number;
  affected_targets: EngineTagTargetV1[];
  requires_review: true;
}

export type EngineTagApiResponseV1 =
  | { response_version: typeof ENGINE_TAG_VERSION; kind: "catalog"; catalog: EngineTagCatalogV1 }
  | { response_version: typeof ENGINE_TAG_VERSION; kind: "suggestion"; suggestion: EngineTagSuggestionV1 }
  | { response_version: typeof ENGINE_TAG_VERSION; kind: "preview"; preview: EngineTagPreviewV1 }
  | { response_version: typeof ENGINE_TAG_VERSION; kind: "impact"; impact: EngineTagImpactV1 }
  | { response_version: typeof ENGINE_TAG_VERSION; kind: "diagnostic"; diagnostic: EngineTagDiagnosticV1 };

export type EngineTagMutationActionV1 =
  | "create_definition" | "create_and_bind" | "update_definition" | "rename_definition"
  | "archive_definition" | "restore_definition" | "bind" | "unbind"
  | "set_alias" | "remove_alias" | "merge" | "delete_definition" | "convert_legacy"
  | "batch_bind" | "batch_unbind";

export interface EngineTagMutationCommandV1 {
  command_version: typeof ENGINE_TAG_VERSION;
  command_id: string;
  action: EngineTagMutationActionV1;
  definition_id?: string;
  target_definition_id?: string;
  key?: string;
  description?: string;
  alias?: EngineTagTargetAliasV1;
  owner?: EngineTagOwnerV1;
  owners?: EngineTagOwnerV1[];
  value?: string;
  legacy_id?: string;
  expected_source_checksum: string;
  expected_history_revision: number;
  reviewed_impact_fingerprint?: string;
}

export interface EngineTagMutationResponseV1 {
  response_version: typeof ENGINE_TAG_VERSION;
  catalog: EngineTagCatalogV1;
  source_checksum: string;
  history_revision: number;
  impact_fingerprint?: string;
}

export type EngineTagProjectionTargetV1 = "generic" | EngineTagTargetV1;

export interface EngineTagProjectionRequestV1 {
  target: EngineTagProjectionTargetV1;
}

export interface EngineTagProjectionEntryV1 {
  definition_id: string;
  normalized_key: string;
  owner: EngineTagOwnerV1;
  identifier: string;
}

export interface EngineTagProjectionOmissionV1 {
  definition_id?: string;
  binding_id?: string;
  owner?: EngineTagOwnerV1;
  code: "archived_definition" | "missing_target_alias" | "duplicate_target_alias" |
    "target_identifier_invalid" | "missing_owner" | "legacy_quarantine" | "out_of_scope";
  details: Record<string, string>;
}

export interface EngineTagProjectionDiagnosticV1 {
  code: "target_collision" | "legacy_quarantine" | "missing_owner";
  message_key: `engine_tags.projection.${string}`;
  details: Record<string, string>;
}

export interface EngineTagProjectionV1 {
  projection_version: typeof ENGINE_TAG_VERSION;
  project_id: string;
  source_checksum: string;
  target: EngineTagProjectionTargetV1;
  entries: EngineTagProjectionEntryV1[];
  omitted: EngineTagProjectionOmissionV1[];
  diagnostics: EngineTagProjectionDiagnosticV1[];
}

export interface EngineTagIntegrityFindingV1 {
  finding_version: typeof ENGINE_TAG_VERSION;
  code: "missing_owner" | "duplicate_normalized_key" | "duplicate_alias" | "archived_binding" | "legacy_unreviewed" | "target_incompatibility";
  severity: "error" | "warning" | "info";
  message_key: `engine_tags.integrity.${string}`;
  definition_id: string | null;
  binding_id: string | null;
  owner: EngineTagOwnerV1 | null;
  details: Record<string, string>;
}

export interface EngineTagIntegrityReportV1 {
  report_version: typeof ENGINE_TAG_VERSION;
  project_id: string;
  source_checksum: string;
  findings: EngineTagIntegrityFindingV1[];
  error_count: number;
  warning_count: number;
  info_count: number;
}

export interface EngineTagDiagnosticV1 {
  diagnostic_version: typeof ENGINE_TAG_VERSION;
  code: EngineTagErrorCode;
  message_key: `engine_tags.${string}`;
  owner: EngineTagOwnerV1 | null;
  definition_id: string | null;
  details: Record<string, string>;
}

export type EngineTagErrorCode =
  | "engine_tag_key_invalid" | "engine_tag_key_collision" | "engine_tag_owner_invalid"
  | "engine_tag_alias_invalid" | "engine_tag_limit_exceeded" | "engine_tag_version_unsupported"
  | "engine_tag_identity_stale" | "engine_tag_secret_forbidden" | "engine_tag_control_forbidden"
  | "engine_tag_path_forbidden";

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const PATH_PATTERN = /(?:^|[\\/])\.?(?:\.?[\\/])/;
const CYRILLIC: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "i",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "h", ц: "c", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya"
};

export class EngineTagContractError extends Error {
  constructor(public readonly code: EngineTagErrorCode, detail = code) {
    super(detail);
    this.name = "EngineTagContractError";
  }
}

export function normalizeEngineTagKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!KEY_PATTERN.test(value.trim()) || normalized.length > ENGINE_TAG_MAX_KEY_LENGTH) {
    throw new EngineTagContractError("engine_tag_key_invalid");
  }
  return normalized;
}

export function assertUniqueEngineTagKeys(definitions: readonly EngineTagDefinitionV1[]): void {
  if (definitions.length > ENGINE_TAG_MAX_DEFINITIONS) {
    throw new EngineTagContractError("engine_tag_limit_exceeded");
  }
  const keys = new Set<string>();
  for (const definition of definitions) {
    const key = normalizeEngineTagKey(definition.key);
    if (keys.has(key)) throw new EngineTagContractError("engine_tag_key_collision");
    keys.add(key);
  }
}

function transliterate(value: string): string {
  return [...value].map((character) => CYRILLIC[character.toLowerCase()] ?? character).join("");
}

function segment(value: string): string {
  const words = transliterate(value).replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const result = words.map((word) => (word[0] ?? "").toUpperCase() + word.slice(1)).join("").replace(/^[^A-Za-z]+/, "");
  return result || "Unnamed";
}

const OWNER_ROOT: Record<EngineTagOwnerKindV1, string> = {
  project: "Project", node: "Node", relationship: "Relationship", dialogue_line: "DialogueLine",
  dialogue_choice: "DialogueChoice", dialogue_option: "DialogueOption", quest_stage: "QuestStage",
  quest_branch: "QuestBranch", story_flow: "StoryFlow", flow_transition: "FlowTransition",
  flow_invocation: "FlowInvocation", flow_exit: "FlowExit", narrative_effect: "NarrativeEffect"
};

export function suggestEngineTagKey(request: EngineTagSuggestionRequestV1): EngineTagSuggestionV1 {
  const root = `${OWNER_ROOT[request.owner.kind]}.`;
  const base = `${root}${segment(request.label).slice(0, ENGINE_TAG_MAX_KEY_LENGTH - root.length)}`;
  const used = new Set(request.existing_keys.map(normalizeEngineTagKey));
  let key = base;
  let suffix = 2;
  while (used.has(normalizeEngineTagKey(key))) {
    const ending = `_${suffix++}`;
    key = `${base.slice(0, ENGINE_TAG_MAX_KEY_LENGTH - ending.length)}${ending}`;
  }
  return { suggestion_version: ENGINE_TAG_VERSION, key, normalized_key: normalizeEngineTagKey(key), collision_resolved: key !== base };
}

export function migrateLegacyEngineTagsV5ToV6(rows: readonly LegacyEngineTagRecordV1[]): EngineTagProjectExtensionV6 {
  // JSON cloning makes the no-mutation guarantee explicit and preserves unknown metadata values.
  const legacy_engine_tags = rows.map((row) => JSON.parse(JSON.stringify(row)) as LegacyEngineTagRecordV1);
  return { document_version: ENGINE_TAG_DOCUMENT_VERSION, engine_tag_definitions: [], engine_tag_bindings: [], legacy_engine_tags };
}

export function validateEngineTagAlias(alias: EngineTagTargetAliasV1): void {
  if (!ENGINE_TAG_TARGETS.includes(alias.target) || !alias.external_identifier.trim() ||
      alias.external_identifier.length > 240 || CONTROL_PATTERN.test(alias.external_identifier) ||
      PATH_PATTERN.test(alias.external_identifier)) {
    throw new EngineTagContractError("engine_tag_alias_invalid");
  }
}

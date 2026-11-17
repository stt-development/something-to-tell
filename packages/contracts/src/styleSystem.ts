/**
 * Shared mirror of the runtime-owned portable Style System contracts.
 * Python remains authoritative; these assertions protect browser boundaries.
 */

export const STYLE_PROFILE_VERSION = 1 as const;
export const STYLE_PROFILE_TRAITS_VERSION = 1 as const;
export const SCENE_STYLE_ASSIGNMENT_VERSION = 1 as const;
export const STYLE_CATALOG_VERSION = 1 as const;
export const STYLE_SYSTEM_SETTINGS_VERSION = 1 as const;
export const STYLE_PROFILE_FILE_VERSION = 1 as const;
export const STYLE_DELETION_IMPACT_VERSION = 1 as const;
export const STYLE_RESOLUTION_VERSION = 1 as const;
export const STYLE_CONTEXT_VERSION = 1 as const;

export const STYLE_PROFILE_MAX_NAME_CHARACTERS = 120 as const;
export const STYLE_PROFILE_MAX_DESCRIPTION_CHARACTERS = 1_000 as const;
export const STYLE_PROFILE_MAX_GUIDANCE_CHARACTERS = 12_000 as const;
export const STYLE_PROFILE_MAX_EXAMPLES = 12 as const;
export const STYLE_PROFILE_MAX_EXAMPLE_CHARACTERS = 2_000 as const;
export const STYLE_PROFILE_MAX_TRAITS_PER_GROUP = 12 as const;
export const STYLE_PROFILE_MAX_TRAIT_CHARACTERS = 120 as const;

export type StyleAgentMode = "disabled" | "configured";
export type StyleContentPolicy = "never" | "explicit_consent";
export type StyleContractErrorCode =
  | "style_profile_invalid"
  | "style_profile_duplicate"
  | "style_profile_oversized"
  | "style_profile_not_found"
  | "style_profile_in_use"
  | "style_profile_import_collision"
  | "style_profile_import_invalid"
  | "style_profile_export_failed"
  | "style_project_not_found"
  | "style_profile_secret_forbidden"
  | "style_scene_assignment_duplicate"
  | "style_scene_invalid"
  | "style_resolution_invalid";
export type StyleResolutionStatus =
  | "resolved"
  | "unconfigured"
  | "context_required"
  | "unavailable";
export type StyleResolutionSource = "scene_override" | "project_default" | "unconfigured";

export interface StyleProfileTraitsV1 {
  traits_version: typeof STYLE_PROFILE_TRAITS_VERSION;
  tone: string[];
  rhythm: string[];
  pacing: string[];
  vocabulary: string[];
  dramatic_intensity: string | null;
}

export interface StyleProfileV1 {
  style_profile_version: typeof STYLE_PROFILE_VERSION;
  id: string;
  project_id: string;
  name: string;
  description: string;
  guidance: string;
  traits: StyleProfileTraitsV1;
  positive_examples: string[];
  created_at: string;
  updated_at: string;
}

export interface SceneStyleAssignmentV1 {
  assignment_version: typeof SCENE_STYLE_ASSIGNMENT_VERSION;
  id: string;
  project_id: string;
  scene_node_id: string;
  style_profile_id: string;
  created_at: string;
  updated_at: string;
}

export interface StyleSystemSettingsV1 {
  style_system_version: typeof STYLE_SYSTEM_SETTINGS_VERSION;
  default_style_profile_id: string | null;
  agent_mode: StyleAgentMode;
  content_policy: StyleContentPolicy;
  [extension: string]: unknown;
}

export interface StyleCatalogV1 {
  catalog_version: typeof STYLE_CATALOG_VERSION;
  project_id: string;
  default_style_profile_id: string | null;
  profiles: StyleProfileV1[];
  scene_assignments: SceneStyleAssignmentV1[];
}

export interface StyleProfileFileV1 {
  file_version: typeof STYLE_PROFILE_FILE_VERSION;
  id: string;
  name: string;
  description: string;
  guidance: string;
  traits: StyleProfileTraitsV1;
  positive_examples: string[];
}

export interface StyleProfileDeletionImpactV1 {
  impact_version: typeof STYLE_DELETION_IMPACT_VERSION;
  profile_id: string;
  uses_project_default: boolean;
  scene_node_ids: string[];
}

export interface StyleContextRefV1 {
  context_version: typeof STYLE_CONTEXT_VERSION;
  scene_node_id: string;
  placement_id?: string | null;
}

export interface StyleSceneContextV1 {
  scene_node_id: string;
  scene_title: string;
}

export interface EffectiveStyleProfileV1 {
  id: string;
  name: string;
  description: string;
}

export interface StyleResolutionRequestV1 {
  request_version: typeof STYLE_RESOLUTION_VERSION;
  session_id: string;
  target_node_id: string;
  context: StyleContextRefV1 | null;
}

export interface EffectiveStyleResolutionV1 {
  resolution_version: typeof STYLE_RESOLUTION_VERSION;
  target_node_id: string;
  status: StyleResolutionStatus;
  source: StyleResolutionSource | null;
  scene_context: StyleSceneContextV1 | null;
  candidate_contexts: StyleSceneContextV1[];
  style_profile_id: string | null;
  profile: EffectiveStyleProfileV1 | null;
  unavailable_reason: "style_profile_missing" | null;
}

export class StyleContractError extends Error {
  /** Stable code is suitable for EN/RU localization without parsing prose. */
  constructor(public readonly code: StyleContractErrorCode) {
    super(code);
    this.name = "StyleContractError";
  }
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SECRET_PATTERNS = [
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}\b/i,
  /\bAIza[A-Za-z0-9_-]{20,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~-]{20,}\b/i
];

export function createDefaultStyleSystemSettings(): StyleSystemSettingsV1 {
  return {
    style_system_version: STYLE_SYSTEM_SETTINGS_VERSION,
    default_style_profile_id: null,
    agent_mode: "disabled",
    content_policy: "never"
  };
}

/** Validates the portable policy while preserving unknown future settings fields. */
export function assertStyleSystemSettings(
  value: unknown
): asserts value is StyleSystemSettingsV1 {
  if (!isRecord(value) || value.style_system_version !== STYLE_SYSTEM_SETTINGS_VERSION) {
    fail("style_profile_invalid");
  }
  if (value.default_style_profile_id !== null) {
    assertId(value.default_style_profile_id, "style_profile_invalid");
  }
  const disabled = value.agent_mode === "disabled" && value.content_policy === "never";
  const configured = value.agent_mode === "configured" && value.content_policy === "explicit_consent";
  if (!disabled && !configured) fail("style_profile_invalid");
}

/** Validates the resolver response before browser code presents inheritance. */
export function assertEffectiveStyleResolution(
  value: unknown
): asserts value is EffectiveStyleResolutionV1 {
  const allowed = new Set([
    "resolution_version", "target_node_id", "status", "source", "scene_context",
    "candidate_contexts", "style_profile_id", "profile", "unavailable_reason"
  ]);
  if (
    !isRecord(value)
    || value.resolution_version !== STYLE_RESOLUTION_VERSION
    || Object.keys(value).some((key) => !allowed.has(key))
  ) {
    fail("style_resolution_invalid");
  }
  assertId(value.target_node_id, "style_resolution_invalid");
  if (!Array.isArray(value.candidate_contexts)) fail("style_resolution_invalid");
  value.candidate_contexts.forEach(assertStyleSceneContext);
  if (value.scene_context !== null) assertStyleSceneContext(value.scene_context);
  if (value.style_profile_id !== null) assertId(value.style_profile_id, "style_resolution_invalid");
  if (value.profile !== null) assertEffectiveProfile(value.profile);
  const candidateIds = value.candidate_contexts.map((item) => item.scene_node_id);
  if (new Set(candidateIds).size !== candidateIds.length) fail("style_resolution_invalid");
  if (
    value.scene_context !== null
    && !candidateIds.includes(value.scene_context.scene_node_id)
  ) fail("style_resolution_invalid");

  const resolved = value.status === "resolved"
    && (value.source === "scene_override" || value.source === "project_default")
    && value.style_profile_id !== null
    && value.profile !== null
    && value.profile.id === value.style_profile_id
    && value.unavailable_reason === null;
  const unconfigured = value.status === "unconfigured"
    && value.source === "unconfigured"
    && value.style_profile_id === null
    && value.profile === null
    && value.unavailable_reason === null;
  const contextRequired = value.status === "context_required"
    && value.source === null
    && value.scene_context === null
    && value.candidate_contexts.length >= 2
    && value.style_profile_id === null
    && value.profile === null
    && value.unavailable_reason === null;
  const unavailable = value.status === "unavailable"
    && (value.source === "scene_override" || value.source === "project_default")
    && value.style_profile_id !== null
    && value.profile === null
    && value.unavailable_reason === "style_profile_missing";
  if (!resolved && !unconfigured && !contextRequired && !unavailable) {
    fail("style_resolution_invalid");
  }
}

/** Validates one strict profile before it crosses the frontend/runtime boundary. */
export function assertStyleProfile(value: unknown): asserts value is StyleProfileV1 {
  if (!isRecord(value) || value.style_profile_version !== STYLE_PROFILE_VERSION) {
    fail("style_profile_invalid");
  }
  const allowed = new Set([
    "style_profile_version", "id", "project_id", "name", "description", "guidance",
    "traits", "positive_examples", "created_at", "updated_at"
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) fail("style_profile_invalid");
  assertId(value.id, "style_profile_invalid");
  assertId(value.project_id, "style_profile_invalid");
  const strings = [
    assertText(value.name, STYLE_PROFILE_MAX_NAME_CHARACTERS),
    assertText(value.description, STYLE_PROFILE_MAX_DESCRIPTION_CHARACTERS, true),
    assertText(value.guidance, STYLE_PROFILE_MAX_GUIDANCE_CHARACTERS)
  ];
  const traits = assertTraits(value.traits);
  strings.push(...traits);
  if (!Array.isArray(value.positive_examples) || value.positive_examples.length > STYLE_PROFILE_MAX_EXAMPLES) {
    fail("style_profile_oversized");
  }
  const examples = value.positive_examples.map((item) =>
    assertText(item, STYLE_PROFILE_MAX_EXAMPLE_CHARACTERS)
  );
  assertUnique(examples, "style_profile_invalid");
  strings.push(...examples);
  assertTimestampOrder(value.created_at, value.updated_at, "style_profile_invalid");
  if (strings.some((text) => SECRET_PATTERNS.some((pattern) => pattern.test(text)))) {
    fail("style_profile_secret_forbidden");
  }
}

/** Validates assignments and every profile reference without storage assumptions. */
export function assertStyleCatalog(value: unknown): asserts value is StyleCatalogV1 {
  if (!isRecord(value) || value.catalog_version !== STYLE_CATALOG_VERSION) {
    fail("style_profile_invalid");
  }
  const allowed = new Set([
    "catalog_version", "project_id", "default_style_profile_id", "profiles",
    "scene_assignments"
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) fail("style_profile_invalid");
  assertId(value.project_id, "style_profile_invalid");
  if (!Array.isArray(value.profiles) || !Array.isArray(value.scene_assignments)) {
    fail("style_profile_invalid");
  }
  value.profiles.forEach(assertStyleProfile);
  const profileIds = value.profiles.map((profile) => profile.id);
  assertUnique(profileIds, "style_profile_duplicate");
  if (value.profiles.some((profile) => profile.project_id !== value.project_id)) {
    fail("style_profile_invalid");
  }
  value.scene_assignments.forEach((assignment) => assertSceneAssignment(assignment));
  const assignmentIds = value.scene_assignments.map((assignment) => assignment.id);
  const sceneIds = value.scene_assignments.map((assignment) => assignment.scene_node_id);
  assertUnique(assignmentIds, "style_scene_assignment_duplicate");
  assertUnique(sceneIds, "style_scene_assignment_duplicate");
  if (value.scene_assignments.some((assignment) => assignment.project_id !== value.project_id)) {
    fail("style_scene_invalid");
  }
  if (value.default_style_profile_id !== null) {
    assertId(value.default_style_profile_id, "style_profile_invalid");
  }
  const references = [
    ...(value.default_style_profile_id === null ? [] : [value.default_style_profile_id]),
    ...value.scene_assignments.map((assignment) => assignment.style_profile_id)
  ];
  if (references.some((reference) => !profileIds.includes(reference))) {
    fail("style_profile_not_found");
  }
}

function assertSceneAssignment(value: unknown): asserts value is SceneStyleAssignmentV1 {
  if (!isRecord(value) || value.assignment_version !== SCENE_STYLE_ASSIGNMENT_VERSION) {
    fail("style_scene_invalid");
  }
  const allowed = new Set([
    "assignment_version", "id", "project_id", "scene_node_id", "style_profile_id",
    "created_at", "updated_at"
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) fail("style_scene_invalid");
  [value.id, value.project_id, value.scene_node_id, value.style_profile_id]
    .forEach((item) => assertId(item, "style_scene_invalid"));
  assertTimestampOrder(value.created_at, value.updated_at, "style_scene_invalid");
}

function assertStyleSceneContext(value: unknown): asserts value is StyleSceneContextV1 {
  if (
    !isRecord(value)
    || Object.keys(value).some((key) => !["scene_node_id", "scene_title"].includes(key))
  ) fail("style_resolution_invalid");
  assertId(value.scene_node_id, "style_resolution_invalid");
  assertText(value.scene_title, 255);
}

function assertEffectiveProfile(value: unknown): asserts value is EffectiveStyleProfileV1 {
  if (
    !isRecord(value)
    || Object.keys(value).some((key) => !["id", "name", "description"].includes(key))
  ) fail("style_resolution_invalid");
  assertId(value.id, "style_resolution_invalid");
  assertText(value.name, STYLE_PROFILE_MAX_NAME_CHARACTERS);
  assertText(value.description, STYLE_PROFILE_MAX_DESCRIPTION_CHARACTERS, true);
}

function assertTraits(value: unknown): string[] {
  if (!isRecord(value) || value.traits_version !== STYLE_PROFILE_TRAITS_VERSION) {
    fail("style_profile_invalid");
  }
  const allowed = new Set([
    "traits_version", "tone", "rhythm", "pacing", "vocabulary", "dramatic_intensity"
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) fail("style_profile_invalid");
  const result: string[] = [];
  for (const key of ["tone", "rhythm", "pacing", "vocabulary"] as const) {
    const group = value[key];
    if (!Array.isArray(group) || group.length > STYLE_PROFILE_MAX_TRAITS_PER_GROUP) {
      fail("style_profile_oversized");
    }
    const strings = group.map((item) => assertText(item, STYLE_PROFILE_MAX_TRAIT_CHARACTERS));
    assertUnique(strings, "style_profile_invalid");
    result.push(...strings);
  }
  if (value.dramatic_intensity !== null) {
    result.push(assertText(value.dramatic_intensity, STYLE_PROFILE_MAX_TRAIT_CHARACTERS));
  }
  return result;
}

function assertText(value: unknown, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string") fail("style_profile_invalid");
  const normalized = value.trim();
  if (!allowEmpty && normalized.length === 0) fail("style_profile_invalid");
  if (normalized.length > maximum) fail("style_profile_oversized");
  return normalized;
}

function assertId(value: unknown, code: StyleContractErrorCode): asserts value is string {
  if (typeof value !== "string" || !ID_PATTERN.test(value.trim())) fail(code);
}

function assertTimestampOrder(created: unknown, updated: unknown, code: StyleContractErrorCode): void {
  if (typeof created !== "string" || typeof updated !== "string") fail(code);
  const timezone = /(?:Z|[+-]\d{2}:\d{2})$/;
  if (!timezone.test(created) || !timezone.test(updated)) fail(code);
  const createdTime = Date.parse(created);
  const updatedTime = Date.parse(updated);
  if (!Number.isFinite(createdTime) || !Number.isFinite(updatedTime) || updatedTime < createdTime) {
    fail(code);
  }
}

function assertUnique(values: string[], code: StyleContractErrorCode): void {
  const folded = values.map((value) => value.toLocaleLowerCase("en-US"));
  if (new Set(folded).size !== folded.length) fail(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: StyleContractErrorCode): never {
  throw new StyleContractError(code);
}

/** Browser mirror of runtime-owned, process-local Style Rewriter runs. */

import type { ProjectPatch } from "./projectPatch";

export const STYLE_REWRITE_VERSION = 1 as const;

export type StyleRewriteTargetV1 =
  | { kind: "node_text"; node_id: string }
  | {
      kind: "dialogue_field";
      node_id: string;
      field_kind: "line_text" | "choice_prompt" | "option_text";
      element_id: string;
      option_id: string | null;
    }
  | {
      kind: "quest_field";
      node_id: string;
      field_kind: "objective" | "stage_description";
      stage_id: string | null;
    };

export interface StyleRewriteRequestV1 {
  request_version: typeof STYLE_REWRITE_VERSION;
  session_id: string;
  target: StyleRewriteTargetV1;
  style_context: {
    context_version: 1;
    scene_node_id: string;
    placement_id: string | null;
  } | null;
  observed_source_checksum: string;
  expected_history_revision: number;
  additional_instructions: string;
  content_consent: true;
}

export interface StyleRewriteRetryV1 {
  retry_version: typeof STYLE_REWRITE_VERSION;
  observed_source_checksum: string;
  expected_history_revision: number;
  additional_instructions: string;
  content_consent: true;
}

export interface StyleRecommendationV1 {
  recommendation_version: typeof STYLE_REWRITE_VERSION;
  id: string;
  source_text: string;
  rewritten_text: string;
  explanation: string;
  applied_traits: string[];
  factual_risks: string[];
  protected_value_results: Array<{
    kind: "name" | "state_reference" | "quantity" | "quoted_term";
    value: string;
    preserved: boolean;
  }>;
  provider_disclosure: {
    provider: "openai" | "google_gemini" | "anthropic";
    provider_profile_id: string;
    model_id: string;
    content_locale: "en" | "ru";
  };
  patch: ProjectPatch | null;
  diff: Array<{ kind: "equal" | "delete" | "insert"; text: string }>;
  validation_status: "pending" | "valid" | "blocked";
  validation_diagnostics: Array<{
    code: string;
    message_key: string;
    blocking: boolean;
    parameters: Record<string, unknown>;
  }>;
}

export interface StyleRewriteApprovalV1 {
  approval_version: typeof STYLE_REWRITE_VERSION;
  recommendation_id: string;
  source_checksum: string;
  expected_history_revision: number;
}

export interface StyleRewriteRunV1 {
  run_version: typeof STYLE_REWRITE_VERSION;
  id: string;
  project_id: string;
  request: StyleRewriteRequestV1;
  style_profile_id: string;
  style_profile_name: string;
  source_checksum: string;
  source_text_checksum: string;
  history_revision: number;
  predecessor_run_id: string | null;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "stale";
  progress: number;
  recommendation: StyleRecommendationV1 | null;
  error_code: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface StyleRewriteResponseV1 {
  response_version: typeof STYLE_REWRITE_VERSION;
  run: StyleRewriteRunV1;
}

/** Validate the approval envelope while project/history retain their owner contracts. */
export function assertStyleRewriteApprovalResponse(value: unknown): void {
  if (
    !record(value)
    || !exact(value, ["response_version", "result", "run", "canon_check_recommended"])
    || value.response_version !== 1
    || value.canon_check_recommended !== true
    || !record(value.result)
    || !exact(value.result, ["project", "history"])
    || !record(value.result.project)
    || !record(value.result.history)
  ) fail();
  assertStyleRewriteResponse({ response_version: 1, run: value.run });
}

/** Reject malformed provider-run responses before UI code can trust them. */
export function assertStyleRewriteResponse(value: unknown): asserts value is StyleRewriteResponseV1 {
  if (!record(value) || !exact(value, ["response_version", "run"]) || value.response_version !== 1 || !record(value.run)) fail();
  const run = value.run;
  const statuses = ["queued", "running", "completed", "failed", "cancelled", "stale"];
  if (
    !exact(run, [
      "run_version", "id", "project_id", "request", "style_profile_id",
      "style_profile_name", "source_checksum", "source_text_checksum",
      "history_revision", "predecessor_run_id", "status", "progress",
      "recommendation", "error_code", "started_at", "completed_at"
    ])
    || run.run_version !== 1
    || typeof run.id !== "string"
    || typeof run.project_id !== "string"
    || !record(run.request)
    || typeof run.style_profile_id !== "string"
    || typeof run.style_profile_name !== "string"
    || !checksum(run.source_checksum)
    || !checksum(run.source_text_checksum)
    || !Number.isInteger(run.history_revision)
    || !statuses.includes(String(run.status))
    || typeof run.progress !== "number"
    || run.progress < 0
    || run.progress > 100
  ) fail();
  assertRequest(run.request);
  if (run.predecessor_run_id !== null && typeof run.predecessor_run_id !== "string") fail();
  if (run.error_code !== null && typeof run.error_code !== "string") fail();
  if (typeof run.started_at !== "string" || (run.completed_at !== null && typeof run.completed_at !== "string")) fail();
  if (run.recommendation !== null) assertRecommendation(run.recommendation);
  const terminal = ["completed", "failed", "cancelled", "stale"].includes(String(run.status));
  if (terminal !== (run.completed_at !== null) || terminal !== (run.progress === 100)) fail();
  if (run.status === "completed" && (run.recommendation === null || run.error_code !== null)) fail();
  if (["failed", "cancelled"].includes(String(run.status)) && (run.recommendation !== null || run.error_code === null)) fail();
}

function assertRequest(value: unknown): asserts value is StyleRewriteRequestV1 {
  if (
    !record(value)
    || !exact(value, [
      "request_version", "session_id", "target", "style_context",
      "observed_source_checksum", "expected_history_revision",
      "additional_instructions", "content_consent"
    ])
    || value.request_version !== 1
    || typeof value.session_id !== "string"
    || !record(value.target)
    || !checksum(value.observed_source_checksum)
    || !Number.isInteger(value.expected_history_revision)
    || typeof value.additional_instructions !== "string"
    || value.content_consent !== true
  ) fail();
  const target = value.target;
  if (target.kind === "node_text") {
    if (!exact(target, ["kind", "node_id"]) || typeof target.node_id !== "string") fail();
  } else if (target.kind === "dialogue_field") {
    if (
      !exact(target, ["kind", "node_id", "field_kind", "element_id", "option_id"])
      || typeof target.node_id !== "string"
      || typeof target.element_id !== "string"
      || !["line_text", "choice_prompt", "option_text"].includes(String(target.field_kind))
      || (target.option_id !== null && typeof target.option_id !== "string")
    ) fail();
    if ((target.field_kind === "option_text") !== (target.option_id !== null)) fail();
  } else fail();
  if (value.style_context !== null) {
    if (
      !record(value.style_context)
      || !exact(value.style_context, ["context_version", "scene_node_id", "placement_id"])
      || value.style_context.context_version !== 1
      || typeof value.style_context.scene_node_id !== "string"
      || (value.style_context.placement_id !== null && typeof value.style_context.placement_id !== "string")
    ) fail();
  }
}

function assertRecommendation(value: unknown): asserts value is StyleRecommendationV1 {
  if (
    !record(value)
    || !exact(value, [
      "recommendation_version", "id", "source_text", "rewritten_text",
      "explanation", "applied_traits", "factual_risks", "protected_value_results",
      "provider_disclosure", "patch", "diff", "validation_status",
      "validation_diagnostics"
    ])
    || value.recommendation_version !== 1
    || typeof value.id !== "string"
    || typeof value.source_text !== "string"
    || typeof value.rewritten_text !== "string"
    || !value.rewritten_text
    || typeof value.explanation !== "string"
    || !Array.isArray(value.applied_traits)
    || !Array.isArray(value.factual_risks)
    || !Array.isArray(value.protected_value_results)
    || !Array.isArray(value.diff)
    || !Array.isArray(value.validation_diagnostics)
    || !record(value.provider_disclosure)
    || !["pending", "valid", "blocked"].includes(String(value.validation_status))
  ) fail();
  if (value.patch !== null) assertTextPatch(value.patch);
  if (value.protected_value_results.some((item) =>
    !record(item)
    || !["name", "state_reference", "quantity", "quoted_term"].includes(String(item.kind))
    || typeof item.value !== "string"
    || typeof item.preserved !== "boolean"
  )) fail();
  if (value.diff.some((item) =>
    !record(item)
    || !["equal", "delete", "insert"].includes(String(item.kind))
    || typeof item.text !== "string"
  )) fail();
  if (value.validation_diagnostics.some((item) =>
    !record(item)
    || typeof item.code !== "string"
    || typeof item.message_key !== "string"
    || typeof item.blocking !== "boolean"
    || !record(item.parameters)
  )) fail();
  if (
    value.applied_traits.some((item) => typeof item !== "string" || item.length > 200)
    || value.factual_risks.some((item) => typeof item !== "string" || item.length > 1_000)
  ) fail();
  const disclosure = value.provider_disclosure;
  if (
    !exact(disclosure, ["provider", "provider_profile_id", "model_id", "content_locale"])
    || !["openai", "google_gemini", "anthropic"].includes(String(disclosure.provider))
    || typeof disclosure.provider_profile_id !== "string"
    || typeof disclosure.model_id !== "string"
    || !["en", "ru"].includes(String(disclosure.content_locale))
  ) fail();
  const blocking = value.validation_diagnostics.some((item) => item.blocking === true);
  if (value.validation_status === "valid" && (value.patch === null || blocking)) fail();
  if (value.validation_status === "blocked" && (value.patch !== null || !blocking)) fail();
  if (value.validation_status === "pending" && value.patch !== null) fail();
}

function assertTextPatch(value: unknown): asserts value is ProjectPatch {
  if (
    !record(value)
    || value.patch_version !== 1
    || typeof value.patch_id !== "string"
    || typeof value.project_id !== "string"
    || !checksum(value.source_checksum)
    || !checksum(value.target_checksum)
    || !Array.isArray(value.operations)
    || value.operations.length !== 1
  ) fail();
  const operation = value.operations[0];
  if (
    !record(operation)
    || operation.op !== "put_record"
    || !["nodes", "dialogues"].includes(String(operation.collection))
    || typeof operation.record_id !== "string"
    || !record(operation.record)
  ) fail();
}

function checksum(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function fail(): never {
  throw new Error("style_rewrite_response_invalid");
}

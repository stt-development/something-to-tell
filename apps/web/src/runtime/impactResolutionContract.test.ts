import {
  IMPACT_RESOLUTION_ALTERNATIVE_VERSION,
  IMPACT_RESOLUTION_COMPARISON_VERSION,
  IMPACT_RESOLUTION_CONTEXT_VERSION,
  IMPACT_RESOLUTION_DECISION_VERSION,
  IMPACT_RESOLUTION_DEFAULT_ALTERNATIVES,
  IMPACT_RESOLUTION_DIAGNOSTIC_VERSION,
  IMPACT_RESOLUTION_EXPLANATION_VERSION,
  IMPACT_RESOLUTION_LIMITS_VERSION,
  IMPACT_RESOLUTION_MAX_ALTERNATIVES,
  IMPACT_RESOLUTION_MAX_CONTEXT_CHARACTERS,
  IMPACT_RESOLUTION_MAX_CONTEXT_RESOURCES,
  IMPACT_RESOLUTION_MAX_FINDINGS,
  IMPACT_RESOLUTION_MAX_PATCH_OPERATIONS,
  IMPACT_RESOLUTION_MAX_VISUAL_CHANGES,
  IMPACT_RESOLUTION_REQUEST_VERSION,
  IMPACT_RESOLUTION_RESPONSE_VERSION,
  IMPACT_RESOLUTION_RUN_VERSION,
  IMPACT_RESOLUTION_VALIDATION_VERSION,
  IMPACT_RESOLUTION_VISUAL_CHANGE_VERSION,
  IMPACT_RESOLUTION_VISUAL_PROJECTION_VERSION,
  orderImpactVisualChanges,
  type ImpactResolutionErrorCode,
  type ImpactResolutionRequest,
  type ImpactResolutionResponse,
  type ImpactResolutionRun,
  type ImpactVisualChange
} from "@something-to-tell/contracts/impact-resolution";
import { describe, expect, it } from "vitest";

const owner = (ownerId: string) => ({
  owner_type: "node",
  owner_id: ownerId,
  context_type: null,
  context_id: null
});

const visualChange = (kind: ImpactVisualChange["kind"], id: string): ImpactVisualChange => ({
  visual_change_version: IMPACT_RESOLUTION_VISUAL_CHANGE_VERSION,
  id,
  kind,
  surface: "graph",
  before_resource: kind === "add" ? null : owner(id),
  after_resource: kind === "remove" ? null : owner(id),
  field_changes: [],
  before_placement: null,
  after_placement: null
});

describe("shared Impact Resolution contract", () => {
  it("mirrors every runtime-owned version and hard limit", () => {
    expect({
      limits: IMPACT_RESOLUTION_LIMITS_VERSION,
      request: IMPACT_RESOLUTION_REQUEST_VERSION,
      context: IMPACT_RESOLUTION_CONTEXT_VERSION,
      explanation: IMPACT_RESOLUTION_EXPLANATION_VERSION,
      alternative: IMPACT_RESOLUTION_ALTERNATIVE_VERSION,
      validation: IMPACT_RESOLUTION_VALIDATION_VERSION,
      comparison: IMPACT_RESOLUTION_COMPARISON_VERSION,
      diagnostic: IMPACT_RESOLUTION_DIAGNOSTIC_VERSION,
      run: IMPACT_RESOLUTION_RUN_VERSION,
      response: IMPACT_RESOLUTION_RESPONSE_VERSION,
      visualChange: IMPACT_RESOLUTION_VISUAL_CHANGE_VERSION,
      visualProjection: IMPACT_RESOLUTION_VISUAL_PROJECTION_VERSION,
      decision: IMPACT_RESOLUTION_DECISION_VERSION
    }).toEqual({
      limits: 1, request: 1, context: 1, explanation: 1, alternative: 1,
      validation: 1, comparison: 1, diagnostic: 1, run: 1, response: 1,
      visualChange: 1, visualProjection: 1, decision: 1
    });
    expect([
      IMPACT_RESOLUTION_DEFAULT_ALTERNATIVES,
      IMPACT_RESOLUTION_MAX_ALTERNATIVES,
      IMPACT_RESOLUTION_MAX_FINDINGS,
      IMPACT_RESOLUTION_MAX_CONTEXT_RESOURCES,
      IMPACT_RESOLUTION_MAX_CONTEXT_CHARACTERS,
      IMPACT_RESOLUTION_MAX_PATCH_OPERATIONS,
      IMPACT_RESOLUTION_MAX_VISUAL_CHANGES
    ]).toEqual([3, 3, 50, 200, 120_000, 200, 500]);
  });

  it("types one immutable request and process-local response", () => {
    const request = {
      request_version: IMPACT_RESOLUTION_REQUEST_VERSION,
      impact_run_id: "impact-run",
      finding_ids: ["a".repeat(64)],
      source_checksum: "b".repeat(64),
      provider_source: "project_default",
      provider_profile_id: null,
      model_id: "provider-model",
      content_consent: true,
      requested_alternative_count: 3,
      limits: {
        limits_version: IMPACT_RESOLUTION_LIMITS_VERSION,
        max_findings: 50,
        max_context_resources: 200,
        max_context_characters: 120_000,
        max_patch_operations: 200,
        max_visual_changes: 500
      }
    } satisfies ImpactResolutionRequest;
    const run = {
      run_version: IMPACT_RESOLUTION_RUN_VERSION,
      id: "resolution-run",
      project_id: "project",
      saved_revision: 4,
      history_revision: 2,
      source_checksum: request.source_checksum,
      request,
      status: "running",
      explanation: null,
      alternatives: [],
      visual_projections: [],
      diagnostics: [],
      started_at: "2026-08-29T10:00:00Z",
      completed_at: null
    } satisfies ImpactResolutionRun;
    const response = {
      response_version: IMPACT_RESOLUTION_RESPONSE_VERSION,
      run
    } satisfies ImpactResolutionResponse;

    expect(response.run.request.content_consent).toBe(true);
  });

  it("orders validated visual changes without mutating runtime output", () => {
    const changes = [visualChange("move", "d".repeat(64)), visualChange("add", "a".repeat(64))];
    const before = structuredClone(changes);

    expect(orderImpactVisualChanges(changes).map((item) => item.kind)).toEqual(["add", "move"]);
    expect(changes).toEqual(before);
  });

  it("keeps every validation and operational failure code closed", () => {
    const codes: ImpactResolutionErrorCode[] = [
      "impact_resolution_limit_invalid",
      "impact_resolution_consent_required",
      "impact_resolution_provider_invalid",
      "impact_resolution_owner_invalid",
      "impact_resolution_finding_invalid",
      "impact_resolution_patch_invalid",
      "impact_resolution_patch_stale",
      "impact_resolution_operation_unsupported",
      "impact_resolution_response_invalid",
      "impact_resolution_visual_diff_invalid",
      "impact_resolution_run_stale",
      "impact_resolution_run_cancelled",
      "impact_resolution_run_failed"
    ];

    expect(codes).toHaveLength(13);
  });
});

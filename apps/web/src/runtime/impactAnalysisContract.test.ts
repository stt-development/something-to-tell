import {
  IMPACT_DEFAULT_DEPTH,
  IMPACT_DEFAULT_PATHS_PER_TARGET,
  IMPACT_DEFAULT_TARGETS,
  IMPACT_DEPENDENCY_VERSION,
  IMPACT_DIAGNOSTIC_VERSION,
  IMPACT_FINDING_VERSION,
  IMPACT_INPUT_VERSION,
  IMPACT_LIMITS_VERSION,
  IMPACT_PATH_VERSION,
  IMPACT_REQUEST_VERSION,
  IMPACT_RESPONSE_VERSION,
  IMPACT_RUN_VERSION,
  IMPACT_SCENARIO_VERSION,
  IMPACT_SEED_VERSION,
  IMPACT_SUMMARY_VERSION,
  orderImpactFindings,
  type ImpactAnalysisInput,
  type ImpactAnalysisRequest,
  type ImpactAnalysisResponse,
  type ImpactAnalysisRun,
  type ImpactErrorCode,
  type ImpactFinding,
  type ImpactResourceRef
} from "@something-to-tell/contracts/impact-analysis";
import { describe, expect, it } from "vitest";

const resource = (ownerId: string): ImpactResourceRef => ({
  owner_type: "node",
  owner_id: ownerId,
  context_type: null,
  context_id: null
});

const finding = (
  id: string,
  targetId: string,
  propagation: ImpactFinding["propagation"],
  messageKey: string
): ImpactFinding => {
  const seed = resource("source");
  const target = resource(targetId);
  return {
    finding_version: IMPACT_FINDING_VERSION,
    id,
    seeds: [{ seed_version: IMPACT_SEED_VERSION, resource: seed }],
    target,
    domain: "flow",
    direction: "downstream",
    impact_type: "execution",
    propagation,
    distance: 1,
    message_key: messageKey,
    message_parameters: {},
    paths: [{
      path_version: IMPACT_PATH_VERSION,
      direction: "downstream",
      propagation,
      resources: [seed, target],
      dependencies: [{
        dependency_version: IMPACT_DEPENDENCY_VERSION,
        source: seed,
        target,
        domain: "flow",
        kind: "flow.sequence",
        propagation,
        message_key: `${messageKey}.dependency`,
        message_parameters: {},
        evidence: []
      }]
    }]
  };
};

describe("shared Impact Analysis contract", () => {
  it("mirrors every runtime-owned Phase 5 contract version and default limit", () => {
    expect({
      dependency: IMPACT_DEPENDENCY_VERSION,
      seed: IMPACT_SEED_VERSION,
      scenario: IMPACT_SCENARIO_VERSION,
      path: IMPACT_PATH_VERSION,
      finding: IMPACT_FINDING_VERSION,
      summary: IMPACT_SUMMARY_VERSION,
      diagnostic: IMPACT_DIAGNOSTIC_VERSION,
      limits: IMPACT_LIMITS_VERSION,
      request: IMPACT_REQUEST_VERSION,
      run: IMPACT_RUN_VERSION,
      response: IMPACT_RESPONSE_VERSION,
      input: IMPACT_INPUT_VERSION
    }).toEqual({
      dependency: 1,
      seed: 1,
      scenario: 1,
      path: 1,
      finding: 1,
      summary: 1,
      diagnostic: 1,
      limits: 1,
      request: 1,
      run: 1,
      response: 1,
      input: 1
    });
    expect([IMPACT_DEFAULT_DEPTH, IMPACT_DEFAULT_PATHS_PER_TARGET, IMPACT_DEFAULT_TARGETS])
      .toEqual([3, 3, 500]);
  });

  it("types selection, patch, run, response, and immutable-input envelopes", () => {
    const selection = {
      request_version: IMPACT_REQUEST_VERSION,
      observed_saved_revision: 4,
      expected_history_revision: 2,
      source_checksum: "a".repeat(64),
      scenario: {
        scenario_version: IMPACT_SCENARIO_VERSION,
        type: "selection",
        intent: "delete",
        seeds: [{ seed_version: IMPACT_SEED_VERSION, resource: resource("source") }]
      },
      direction: "both",
      domains: ["graph", "flow", "canon"],
      limits: {
        limits_version: IMPACT_LIMITS_VERSION,
        max_depth: 3,
        max_paths_per_target: 3,
        max_targets: 500
      }
    } satisfies ImpactAnalysisRequest;
    const patch = {
      ...selection,
      scenario: {
        scenario_version: IMPACT_SCENARIO_VERSION,
        type: "patch",
        patch: {
          patch_version: 1,
          patch_id: "preview",
          project_id: "project",
          source_checksum: "a".repeat(64),
          target_checksum: "b".repeat(64),
          operations: []
        }
      }
    } satisfies ImpactAnalysisRequest;
    const run = {
      run_version: IMPACT_RUN_VERSION,
      id: "run-1",
      project_id: "project",
      saved_revision: 4,
      history_revision: 2,
      source_checksum: "a".repeat(64),
      status: "running",
      request: selection,
      findings: [],
      summary: {
        summary_version: IMPACT_SUMMARY_VERSION,
        finding_count: 0,
        direct_count: 0,
        transitive_count: 0,
        propagation: { required: 0, conditional: 0, contextual: 0 },
        truncated: false,
        omitted_count: 0
      },
      diagnostics: [],
      started_at: "2026-08-25T10:00:00Z",
      completed_at: null
    } satisfies ImpactAnalysisRun;
    const response = {
      response_version: IMPACT_RESPONSE_VERSION,
      run
    } satisfies ImpactAnalysisResponse;
    const input = {
      input_version: IMPACT_INPUT_VERSION,
      project_id: "project",
      saved_revision: 4,
      history_revision: 2,
      source_checksum: "a".repeat(64),
      document: { document_version: 3 },
      request: patch
    } satisfies ImpactAnalysisInput<{ document_version: number }>;

    expect(response.run.request.scenario.type).toBe("selection");
    expect(input.request.scenario.type).toBe("patch");
  });

  it("orders validated findings without localized text or input mutation", () => {
    const contextual = finding("b".repeat(64), "b", "contextual", "impact.finding.russian");
    const required = finding("a".repeat(64), "a", "required", "impact.finding.english");
    const values = [contextual, required];
    const before = structuredClone(values);

    const ordered = orderImpactFindings(values);

    expect(ordered.map((item) => item.propagation)).toEqual(["required", "contextual"]);
    expect(values).toEqual(before);
    expect(orderImpactFindings([
      { ...required, message_key: "impact.finding.changed" },
      required
    ]).map((item) => item.id)).toEqual([required.id, required.id]);
  });

  it("keeps validation and operational failure codes as a closed union", () => {
    const codes: ImpactErrorCode[] = [
      "impact_direction_invalid",
      "impact_domain_invalid",
      "impact_propagation_invalid",
      "impact_depth_invalid",
      "impact_path_limit_invalid",
      "impact_target_limit_invalid",
      "impact_seed_not_found",
      "impact_patch_invalid",
      "impact_patch_stale",
      "impact_run_stale",
      "impact_run_cancelled",
      "impact_run_failed",
      "impact_result_limit_reached"
    ];

    expect(codes).toHaveLength(13);
  });
});

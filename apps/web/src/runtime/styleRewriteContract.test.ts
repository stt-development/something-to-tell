import { describe, expect, it } from "vitest";
import {
  assertStyleRewriteResponse,
  type StyleRewriteResponseV1
} from "@something-to-tell/contracts/style-rewrite";

/** Browser contract fixtures keep text-only patch invariants visible to review UI. */
function response(): StyleRewriteResponseV1 {
  return {
    response_version: 1,
    run: {
      run_version: 1,
      id: "run-one",
      project_id: "project-one",
      request: {
        request_version: 1,
        session_id: "session-one",
        target: { kind: "node_text", node_id: "node-one" },
        style_context: null,
        observed_source_checksum: "a".repeat(64),
        expected_history_revision: 2,
        additional_instructions: "",
        content_consent: true
      },
      style_profile_id: "style-one",
      style_profile_name: "Noir",
      source_checksum: "a".repeat(64),
      source_text_checksum: "b".repeat(64),
      history_revision: 2,
      predecessor_run_id: null,
      status: "completed",
      progress: 100,
      recommendation: {
        recommendation_version: 1,
        id: "recommendation-one",
        source_text: "Mara waited.",
        rewritten_text: "Mara waited in silence.",
        explanation: "Adds restrained atmosphere.",
        applied_traits: ["restrained"],
        factual_risks: [],
        protected_value_results: [
          { kind: "name", value: "Mara", preserved: true }
        ],
        provider_disclosure: {
          provider: "openai",
          provider_profile_id: "provider-one",
          model_id: "model-one",
          content_locale: "en"
        },
        patch: {
          patch_version: 1,
          patch_id: "patch-one",
          project_id: "project-one",
          source_checksum: "a".repeat(64),
          target_checksum: "c".repeat(64),
          operations: [
            { op: "put_record", collection: "nodes", record_id: "node-one", record: {} }
          ]
        },
        diff: [
          { kind: "equal", text: "Mara waited" },
          { kind: "insert", text: " in silence" },
          { kind: "equal", text: "." }
        ],
        validation_status: "valid",
        validation_diagnostics: []
      },
      error_code: null,
      started_at: "2026-09-07T10:00:00Z",
      completed_at: "2026-09-07T10:00:01Z"
    }
  };
}

describe("style rewrite review contract", () => {
  it("accepts one runtime-validated node or Dialogue record patch", () => {
    expect(() => assertStyleRewriteResponse(response())).not.toThrow();
  });

  it("rejects multiple or unrelated patch operations", () => {
    const invalid = response();
    invalid.run.recommendation!.patch!.operations.push({
      op: "put_record",
      collection: "nodes",
      record_id: "node-other",
      record: {}
    });
    expect(() => assertStyleRewriteResponse(invalid)).toThrow(
      "style_rewrite_response_invalid"
    );
  });

  it("rejects blocked recommendations that still expose a patch", () => {
    const invalid = response();
    invalid.run.recommendation!.validation_status = "blocked";
    invalid.run.recommendation!.validation_diagnostics = [{
      code: "style_rewrite_no_op",
      message_key: "style.validation.style_rewrite_no_op",
      blocking: true,
      parameters: {}
    }];
    expect(() => assertStyleRewriteResponse(invalid)).toThrow(
      "style_rewrite_response_invalid"
    );
  });
});

import {
  STYLE_PROFILE_MAX_GUIDANCE_CHARACTERS,
  STYLE_PROFILE_FILE_VERSION,
  StyleContractError,
  assertEffectiveStyleResolution,
  assertStyleCatalog,
  assertStyleProfile,
  assertStyleSystemSettings,
  createDefaultStyleSystemSettings,
  type StyleProfileFileV1,
  type StyleProfileV1
} from "@something-to-tell/contracts/style-system";
import { describe, expect, it } from "vitest";

const now = "2026-09-04T10:00:00+00:00";

function profile(overrides: Partial<StyleProfileV1> = {}): StyleProfileV1 {
  return {
    style_profile_version: 1,
    id: "style-noir",
    project_id: "project-aurora",
    name: "Harbor noir",
    description: "Restrained harbor narration.",
    guidance: "Use concrete sensory details and short declarative sentences.",
    traits: {
      traits_version: 1,
      tone: ["restrained", "suspicious"],
      rhythm: ["short sentences"],
      pacing: ["deliberate"],
      vocabulary: ["concrete maritime language"],
      dramatic_intensity: "controlled"
    },
    positive_examples: ["Rain traced the ledger's salt-stiffened spine."],
    created_at: now,
    updated_at: now,
    ...overrides
  };
}

function expectCode(action: () => void, code: StyleContractError["code"]): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(StyleContractError);
    expect((error as StyleContractError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe("shared Style System contracts", () => {
  it("exposes disabled portable settings without a selected style", () => {
    const settings = createDefaultStyleSystemSettings();
    expect(settings).toEqual({
      style_system_version: 1,
      default_style_profile_id: null,
      agent_mode: "disabled",
      content_policy: "never"
    });
    expect(() => assertStyleSystemSettings(settings)).not.toThrow();
    expectCode(() => assertStyleSystemSettings({
      ...settings,
      content_policy: "explicit_consent"
    }), "style_profile_invalid");
  });

  it("accepts the same bounded profile shape as the runtime", () => {
    const candidate: unknown = profile();
    assertStyleProfile(candidate);
    expect(candidate.traits.tone).toEqual(["restrained", "suspicious"]);
  });

  it("keeps file interchange project-neutral", () => {
    const portable = {
      file_version: STYLE_PROFILE_FILE_VERSION,
      id: "style-noir",
      name: "Harbor noir",
      description: "",
      guidance: "Use concrete prose.",
      traits: profile().traits,
      positive_examples: []
    } satisfies StyleProfileFileV1;

    expect(portable).not.toHaveProperty("project_id");
    expect(portable).not.toHaveProperty("provider_profile_id");
  });

  it("uses stable codes for oversized and secret-shaped values", () => {
    expectCode(
      () => assertStyleProfile(profile({ guidance: "x".repeat(STYLE_PROFILE_MAX_GUIDANCE_CHARACTERS + 1) })),
      "style_profile_oversized"
    );
    expectCode(
      () => assertStyleProfile(profile({ guidance: "Use sk-ant-abcdefghijklmnopqrstuv" })),
      "style_profile_secret_forbidden"
    );
  });

  it("rejects duplicate profiles, duplicate Scene assignments, and missing references", () => {
    const assignment = {
      assignment_version: 1 as const,
      id: "scene-style-docks",
      project_id: "project-aurora",
      scene_node_id: "scene-docks",
      style_profile_id: "style-noir",
      created_at: now,
      updated_at: now
    };
    expectCode(() => assertStyleCatalog({
      catalog_version: 1,
      project_id: "project-aurora",
      default_style_profile_id: "style-noir",
      profiles: [profile(), profile()],
      scene_assignments: []
    }), "style_profile_duplicate");
    expectCode(() => assertStyleCatalog({
      catalog_version: 1,
      project_id: "project-aurora",
      default_style_profile_id: "style-noir",
      profiles: [profile()],
      scene_assignments: [assignment, { ...assignment, id: "scene-style-copy" }]
    }), "style_scene_assignment_duplicate");
    expectCode(() => assertStyleCatalog({
      catalog_version: 1,
      project_id: "project-aurora",
      default_style_profile_id: "style-missing",
      profiles: [profile()],
      scene_assignments: []
    }), "style_profile_not_found");
  });

  it("validates resolved, ambiguous, and repairable Style decisions", () => {
    expect(() => assertEffectiveStyleResolution({
      resolution_version: 1,
      target_node_id: "node-docks",
      status: "resolved",
      source: "scene_override",
      scene_context: { scene_node_id: "scene-docks", scene_title: "Docks" },
      candidate_contexts: [{ scene_node_id: "scene-docks", scene_title: "Docks" }],
      style_profile_id: "style-noir",
      profile: { id: "style-noir", name: "Harbor noir", description: "" },
      unavailable_reason: null
    })).not.toThrow();
    expect(() => assertEffectiveStyleResolution({
      resolution_version: 1,
      target_node_id: "node-shared",
      status: "context_required",
      source: null,
      scene_context: null,
      candidate_contexts: [
        { scene_node_id: "scene-a", scene_title: "Alpha" },
        { scene_node_id: "scene-b", scene_title: "Beta" }
      ],
      style_profile_id: null,
      profile: null,
      unavailable_reason: null
    })).not.toThrow();
    expect(() => assertEffectiveStyleResolution({
      resolution_version: 1,
      target_node_id: "node-docks",
      status: "unavailable",
      source: "scene_override",
      scene_context: { scene_node_id: "scene-docks", scene_title: "Docks" },
      candidate_contexts: [{ scene_node_id: "scene-docks", scene_title: "Docks" }],
      style_profile_id: "style-deleted",
      profile: null,
      unavailable_reason: "style_profile_missing"
    })).not.toThrow();
  });

  it("rejects contradictory effective Style decisions", () => {
    expectCode(() => assertEffectiveStyleResolution({
      resolution_version: 1,
      target_node_id: "node-docks",
      status: "resolved",
      source: "unconfigured",
      scene_context: null,
      candidate_contexts: [],
      style_profile_id: null,
      profile: null,
      unavailable_reason: null
    }), "style_resolution_invalid");
  });
});

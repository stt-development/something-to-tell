import {
  EXPORT_CONTRACT_VERSION,
  EXPORT_FORMATS,
  EXPORT_MAX_DIAGNOSTICS,
  EXPORT_MAX_NAME_LENGTH,
  EXPORT_MAX_OUTPUT_BYTES,
  EXPORT_MAX_PATH_LENGTH,
  EXPORT_MAX_PREVIEW_BYTES,
  EXPORT_MAX_RECORDS,
  EXPORT_MAX_SELECTED_FLOWS,
  EXPORT_MAX_TEXT_LENGTH,
  EXPORT_SCOPES,
  ExportContractError,
  exportOwnerFromEngineTag,
  validateExportOptions,
  validatePortableExtensions,
  type ExportOptionsV1,
  type ExportPortableExtensionsV1,
  type ExportProjectionV1,
  type ExecutableNarrativeProjectionV1
} from "@something-to-tell/contracts/export";
import { describe, expect, it } from "vitest";

const options = (changes: Partial<ExportOptionsV1> = {}): ExportOptionsV1 => ({
  options_version: 1,
  format: "json",
  scope: "whole_project",
  story_flow_ids: [],
  engine_tag_target: "generic",
  preview_max_bytes: 65_536,
  ...changes
});

describe("export contracts", () => {
  it("keeps version, variants, and limits synchronized with the runtime", () => {
    expect(EXPORT_CONTRACT_VERSION).toBe(1);
    expect(EXPORT_FORMATS).toEqual(["json", "yaml", "yarn_spinner", "ink"]);
    expect(EXPORT_SCOPES).toEqual(["whole_project", "story_flows"]);
    expect([
      EXPORT_MAX_SELECTED_FLOWS,
      EXPORT_MAX_PREVIEW_BYTES,
      EXPORT_MAX_DIAGNOSTICS,
      EXPORT_MAX_RECORDS,
      EXPORT_MAX_OUTPUT_BYTES,
      EXPORT_MAX_NAME_LENGTH,
      EXPORT_MAX_PATH_LENGTH,
      EXPORT_MAX_TEXT_LENGTH
    ]).toEqual([128, 262_144, 2_000, 100_000, 52_428_800, 160, 4_096, 1_048_576]);
  });

  it("validates scope, ids, target compatibility, and preview limits", () => {
    expect(() => validateExportOptions(options())).not.toThrow();
    expect(() => validateExportOptions(options({ scope: "story_flows" }))).not.toThrow();
    expect(() => validateExportOptions(options({ engine_tag_target: "unreal" }))).not.toThrow();
    expect(() => validateExportOptions(options({
      format: "ink",
      scope: "story_flows",
      story_flow_ids: ["flow-main"],
      engine_tag_target: "ink"
    }))).not.toThrow();

    for (const invalid of [
      options({ story_flow_ids: ["flow-main"] }),
      options({ scope: "story_flows", story_flow_ids: ["../flow"] }),
      options({ format: "ink" }),
      options({ preview_max_bytes: EXPORT_MAX_PREVIEW_BYTES + 1 })
    ]) {
      expect(() => validateExportOptions(invalid)).toThrowError(ExportContractError);
    }
  });

  it("preserves safe x-* metadata and rejects machine or non-finite values", () => {
    const safe: ExportPortableExtensionsV1 = {
      extension_version: 1,
      values: { "x-studio-note": "Русский\nEnglish", "x-score": 1.5 }
    };
    expect(() => validatePortableExtensions(safe)).not.toThrow();

    const unsafe = [
      { extension_version: 1, values: { note: "not namespaced" } },
      { extension_version: 1, values: { "x-config": { storage: "postgres" } } },
      { extension_version: 1, values: { "x-secret": "sk-proj-1234567890abcdef" } },
      { extension_version: 1, values: { "x-score": Number.NaN } }
    ] as unknown as ExportPortableExtensionsV1[];
    unsafe.forEach((value) => {
      expect(() => validatePortableExtensions(value)).toThrowError(ExportContractError);
    });
  });

  it("defines a projection without internal project state", () => {
    const projection = {
      projection_version: 1,
      manifest: {
        schema_version: 1,
        kind: "narrative_export",
        source: {
          identity_version: 1,
          project_id: "project-aurora",
          project_name: "Project Aurora",
          content_locale: "ru",
          document_version: 6,
          source_checksum: "a".repeat(64)
        },
        scope: "whole_project",
        story_flow_ids: [],
        engine_tag_target: "generic"
      },
      project: {
        project_version: 1,
        id: "project-aurora",
        name: "Project Aurora",
        description: "Русский\nEnglish",
        content_locale: "ru",
        extensions: { extension_version: 1, values: { "x-note": "kept" } }
      },
      nodes: [], relationships: [], dialogues: [], quests: [],
      story_flows: {
        story_flows_version: 1, definitions: [], memberships: [], transitions: [],
        scene_boundaries: [], invocations: [], exits: [], exit_bindings: []
      },
      narrative_state: { narrative_state_version: 1, initial_states: [], effects: [], bindings: [] },
      engine_tags: {
        engine_tags_version: 1,
        project_id: "project-aurora",
        source_checksum: "a".repeat(64),
        target: "generic",
        entries: [],
        omitted: [],
        diagnostics: []
      },
      diagnostics: []
    } satisfies ExportProjectionV1;
    expect(Object.keys(projection)).not.toContain("placements");
    expect(Object.keys(projection)).not.toContain("storage");
    expect(projection.project.extensions.values["x-note"]).toBe("kept");
  });

  it("maps Engine Tag owners into navigable export diagnostics", () => {
    expect(exportOwnerFromEngineTag({
      kind: "dialogue_option",
      project_id: "project",
      dialogue_node_id: "dialogue",
      option_id: "option-1"
    })).toEqual({
      owner_version: 1,
      kind: "dialogue_option",
      id: "option-1",
      context_id: "dialogue"
    });
  });

  it("mirrors the target-neutral executable projection without semantic edges", () => {
    const executable = {
      executable_version: 1,
      source: {
        identity_version: 1,
        project_id: "project",
        project_name: "Project",
        content_locale: "en",
        document_version: 6,
        source_checksum: "a".repeat(64)
      },
      speakers: [], flows: [], dialogues: [], quests: [], initial_states: [],
      operations: [], host_bindings: [], source_map: [], diagnostics: []
    } satisfies ExecutableNarrativeProjectionV1;

    expect(Object.keys(executable)).not.toContain("relationships");
    expect(Object.keys(executable)).not.toContain("placements");
  });
});

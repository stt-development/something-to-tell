import {
  DEFAULT_AUTOSAVE_INTERVAL_SECONDS,
  AGENT_PROVIDERS_VERSION,
  IMPACT_RESOLVER_SETTINGS_VERSION,
  CANON_CHECK_SETTINGS_VERSION,
  PROJECT_FORMAT_VERSION,
  PROJECT_SETTINGS_VERSION,
  STORAGE_MODES,
  SUPPORTED_PROJECT_LOCALES,
  AGENT_IDS,
  agentProviderProfileImpact,
  createDefaultProjectSettings,
  assertPortableProjectSettings,
  effectiveAgentProviderProfile,
  normalizeProjectSettings,
  withAgentProviderAssignment,
  withDefaultAgentProvider,
  withoutAgentProviderProfile,
  type ProjectManifestV2
} from "@something-to-tell/contracts/project-manifest";
import { STYLE_SYSTEM_SETTINGS_VERSION } from "@something-to-tell/contracts/style-system";
import { describe, expect, it } from "vitest";

describe("shared project manifest contract", () => {
  it("exposes the runtime-owned v2 constants and defaults", () => {
    expect(PROJECT_FORMAT_VERSION).toBe(2);
    expect(PROJECT_SETTINGS_VERSION).toBe(5);
    expect(AGENT_IDS).toEqual(["canon_checker", "impact_resolver", "style_rewriter"]);
    expect(SUPPORTED_PROJECT_LOCALES).toEqual(["en", "ru"]);
    expect(STORAGE_MODES).toEqual(["local_sqlite", "postgresql"]);
    expect(createDefaultProjectSettings()).toEqual({
      ui_locale: "en",
      content_locale: "en",
      autosave: {
        enabled: true,
        interval_seconds: DEFAULT_AUTOSAVE_INTERVAL_SECONDS
      },
      storage: {
        mode: "local_sqlite",
        connection_profile_id: null
      },
      canon_check: {
        canon_check_version: CANON_CHECK_SETTINGS_VERSION,
        deterministic_enabled: true,
        enabled_rules: {},
        severity_overrides: {},
        agent_mode: "disabled",
        content_policy: "never",
        model_preference: null,
        provider_profile_id: null
      },
      agent_providers: {
        agent_providers_version: AGENT_PROVIDERS_VERSION,
        default_provider_profile_id: null,
        agents: {
          canon_checker: {
            provider_source: "project_default",
            provider_profile_override_id: null,
            model_id: null
          },
          impact_resolver: {
            provider_source: "project_default",
            provider_profile_override_id: null,
            model_id: null
          },
          style_rewriter: {
            provider_source: "project_default",
            provider_profile_override_id: null,
            model_id: null
          }
        }
      },
      impact_resolver: {
        impact_resolver_version: IMPACT_RESOLVER_SETTINGS_VERSION,
        agent_mode: "disabled",
        content_policy: "never"
      },
      style_system: {
        style_system_version: STYLE_SYSTEM_SETTINGS_VERSION,
        default_style_profile_id: null,
        agent_mode: "disabled",
        content_policy: "never"
      }
    });
  });

  it("returns independent nested defaults", () => {
    const first = createDefaultProjectSettings();
    const second = createDefaultProjectSettings();

    first.autosave.enabled = false;
    first.canon_check.enabled_rules["flow.rule"] = false;
    first.agent_providers.agents.impact_resolver.model_id = "impact-model";

    expect(second.autosave.enabled).toBe(true);
    expect(second.canon_check.enabled_rules).toEqual({});
    expect(second.agent_providers.agents.impact_resolver.model_id).toBeNull();
  });

  it("resolves default and override profiles while preserving independent models", () => {
    let settings = withDefaultAgentProvider(createDefaultProjectSettings(), "shared-openai");
    settings = withAgentProviderAssignment(settings, "canon_checker", {
      provider_source: "project_default",
      provider_profile_override_id: null,
      model_id: "canon-model"
    });
    settings = withAgentProviderAssignment(settings, "impact_resolver", {
      provider_source: "override",
      provider_profile_override_id: "impact-anthropic",
      model_id: "impact-model"
    });
    settings = withAgentProviderAssignment(settings, "style_rewriter", {
      provider_source: "override",
      provider_profile_override_id: "style-anthropic",
      model_id: "style-model"
    });

    expect(effectiveAgentProviderProfile(settings, "canon_checker")).toBe("shared-openai");
    expect(effectiveAgentProviderProfile(settings, "impact_resolver")).toBe("impact-anthropic");
    expect(effectiveAgentProviderProfile(settings, "style_rewriter")).toBe("style-anthropic");
    expect(settings.canon_check).toMatchObject({
      provider_profile_id: "shared-openai",
      model_preference: "canon-model"
    });
    expect(settings.agent_providers.agents.impact_resolver.model_id).toBe("impact-model");
    expect(settings.agent_providers.agents.style_rewriter.model_id).toBe("style-model");
  });

  it("normalizes settings saved before the shared agent namespace", () => {
    const legacy = createDefaultProjectSettings();
    legacy.canon_check.provider_profile_id = "legacy-profile";
    legacy.canon_check.model_preference = "legacy-model";
    delete (legacy as Partial<typeof legacy>).agent_providers;
    delete (legacy as Partial<typeof legacy>).impact_resolver;
    delete (legacy as Partial<typeof legacy>).style_system;

    const normalized = normalizeProjectSettings(legacy);

    expect(normalized.agent_providers.default_provider_profile_id).toBe("legacy-profile");
    expect(normalized.agent_providers.agents.canon_checker.model_id).toBe("legacy-model");
    expect(normalized.impact_resolver.agent_mode).toBe("disabled");
    expect(normalized.style_system.default_style_profile_id).toBeNull();
    expect(normalized.agent_providers.agents.style_rewriter).toMatchObject({
      provider_source: "project_default",
      model_id: null
    });
  });

  it("migrates v4 settings and reports profile deletion impact across three agents", () => {
    const legacy = createDefaultProjectSettings();
    delete (legacy.agent_providers.agents as Partial<typeof legacy.agent_providers.agents>)
      .style_rewriter;
    const normalized = normalizeProjectSettings(legacy);
    let configured = withDefaultAgentProvider(normalized, "shared-openai");
    configured = withAgentProviderAssignment(configured, "canon_checker", {
      provider_source: "project_default",
      provider_profile_override_id: null,
      model_id: "canon-model"
    });
    configured = withAgentProviderAssignment(configured, "style_rewriter", {
      provider_source: "override",
      provider_profile_override_id: "style-anthropic",
      model_id: "style-model"
    });
    configured.style_system = {
      ...configured.style_system,
      agent_mode: "configured",
      content_policy: "explicit_consent"
    };

    expect(agentProviderProfileImpact(configured, "shared-openai")).toEqual([
      "canon_checker",
      "impact_resolver"
    ]);
    expect(agentProviderProfileImpact(configured, "style-anthropic")).toEqual(["style_rewriter"]);

    const removed = withoutAgentProviderProfile(configured, "style-anthropic");
    expect(removed.style_system).toMatchObject({ agent_mode: "disabled", content_policy: "never" });
    expect(removed.agent_providers.agents.style_rewriter).toEqual({
      provider_source: "project_default",
      provider_profile_override_id: null,
      model_id: null
    });
    expect(removed.agent_providers.agents.canon_checker.model_id).toBe("canon-model");
  });

  it("rejects secret-shaped fields at any settings depth", () => {
    const settings = createDefaultProjectSettings();
    settings.canon_check.provider_extension = {
      nested: { "access-token": "must-not-leave-browser" }
    };

    expect(() => assertPortableProjectSettings(settings)).toThrow(
      "Project settings must not contain secret field: access-token"
    );
  });

  it("types the complete portable manifest shape", () => {
    const manifest = {
      format_version: PROJECT_FORMAT_VERSION,
      project_id: "project-1",
      name: "Citadel Branch",
      description: "A branching citadel story.",
      created_at: "2026-07-28T00:00:00+00:00",
      updated_at: "2026-07-28T00:00:00+00:00",
      saved_revision: 0,
      settings_version: PROJECT_SETTINGS_VERSION,
      settings: createDefaultProjectSettings(),
      asset_paths: ["assets/citadel/map.png"]
    } satisfies ProjectManifestV2;

    expect(manifest.settings.storage.mode).toBe("local_sqlite");
  });
});

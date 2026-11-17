/**
 * Shared TypeScript mirror of the runtime-owned Pydantic contract in
 * services/runtime/stt_runtime/project_format/manifest.py.
 *
 * Runtime validation remains authoritative until schema generation replaces
 * this documented mirror. Keep constants and fields synchronized with ADR 0009.
 */

import {
  assertStyleSystemSettings,
  createDefaultStyleSystemSettings,
  type StyleSystemSettingsV1
} from "./styleSystem";

export const PROJECT_FORMAT_VERSION = 2 as const;
export const PROJECT_SETTINGS_VERSION = 5 as const;
export const CANON_CHECK_SETTINGS_VERSION = 1 as const;
export const AGENT_PROVIDERS_VERSION = 1 as const;
export const IMPACT_RESOLVER_SETTINGS_VERSION = 1 as const;
export const DEFAULT_AUTOSAVE_INTERVAL_SECONDS = 300 as const;
export const SUPPORTED_PROJECT_LOCALES = ["en", "ru"] as const;
export const STORAGE_MODES = ["local_sqlite", "postgresql"] as const;
export const CANON_AGENT_MODES = ["disabled", "configured"] as const;
export const CANON_CONTENT_POLICIES = ["never", "evidence_only"] as const;
export const CANON_SEVERITIES = ["info", "warning", "critical"] as const;
export const AGENT_PROVIDER_SOURCES = ["project_default", "override"] as const;
export const AGENT_IDS = ["canon_checker", "impact_resolver", "style_rewriter"] as const;

export type ProjectLocale = (typeof SUPPORTED_PROJECT_LOCALES)[number];
export type StorageMode = (typeof STORAGE_MODES)[number];
export type CanonAgentMode = (typeof CANON_AGENT_MODES)[number];
export type CanonContentPolicy = (typeof CANON_CONTENT_POLICIES)[number];
export type CanonSeverity = (typeof CANON_SEVERITIES)[number];
export type AgentProviderSource = (typeof AGENT_PROVIDER_SOURCES)[number];
export type AgentId = (typeof AGENT_IDS)[number];

export interface AutosaveSettings {
  enabled: boolean;
  interval_seconds: number;
  [extension: string]: unknown;
}

export interface StorageSettings {
  mode: StorageMode;
  connection_profile_id: string | null;
  [extension: string]: unknown;
}

export interface CanonCheckSettings {
  canon_check_version: typeof CANON_CHECK_SETTINGS_VERSION;
  deterministic_enabled: boolean;
  enabled_rules: Record<string, boolean>;
  severity_overrides: Record<string, CanonSeverity>;
  agent_mode: CanonAgentMode;
  content_policy: CanonContentPolicy;
  model_preference: string | null;
  provider_profile_id: string | null;
  [extension: string]: unknown;
}

export interface AgentProviderAssignment {
  provider_source: AgentProviderSource;
  provider_profile_override_id: string | null;
  model_id: string | null;
  [extension: string]: unknown;
}

export interface AgentProviderAssignments {
  canon_checker: AgentProviderAssignment;
  impact_resolver: AgentProviderAssignment;
  style_rewriter: AgentProviderAssignment;
  [agent: string]: AgentProviderAssignment | unknown;
}

export interface AgentProvidersSettings {
  agent_providers_version: typeof AGENT_PROVIDERS_VERSION;
  default_provider_profile_id: string | null;
  agents: AgentProviderAssignments;
  [extension: string]: unknown;
}

export interface ImpactResolverSettings {
  impact_resolver_version: typeof IMPACT_RESOLVER_SETTINGS_VERSION;
  agent_mode: "disabled" | "configured";
  content_policy: "never" | "bounded_evidence";
  [extension: string]: unknown;
}

export interface ProjectSettings {
  ui_locale: ProjectLocale;
  content_locale: ProjectLocale;
  autosave: AutosaveSettings;
  storage: StorageSettings;
  canon_check: CanonCheckSettings;
  agent_providers: AgentProvidersSettings;
  impact_resolver: ImpactResolverSettings;
  style_system: StyleSystemSettingsV1;
  [extension: string]: unknown;
}

export interface ProjectManifestV2 {
  format_version: typeof PROJECT_FORMAT_VERSION;
  project_id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  saved_revision: number;
  settings_version: typeof PROJECT_SETTINGS_VERSION;
  settings: ProjectSettings;
  asset_paths: string[];
  [extension: string]: unknown;
}

export function createDefaultProjectSettings(): ProjectSettings {
  return {
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
    style_system: createDefaultStyleSystemSettings()
  };
}

/** Fills additive settings namespaces for cached clients and legacy test hosts. */
export function normalizeProjectSettings(settings: ProjectSettings): ProjectSettings {
  const defaults = createDefaultProjectSettings();
  const legacy = settings as ProjectSettings & {
    agent_providers?: AgentProvidersSettings;
    impact_resolver?: ImpactResolverSettings;
    style_system?: StyleSystemSettingsV1;
  };
  const providerDefaults = defaults.agent_providers;
  const providers = legacy.agent_providers;
  const agents = providers?.agents;
  return {
    ...settings,
    agent_providers: {
      ...providerDefaults,
      ...providers,
      default_provider_profile_id: providers
        ? providers.default_provider_profile_id
        : settings.canon_check.provider_profile_id,
      agents: {
        ...providerDefaults.agents,
        ...agents,
        canon_checker: agents?.canon_checker ?? {
          ...providerDefaults.agents.canon_checker,
          model_id: settings.canon_check.model_preference
        },
        impact_resolver: agents?.impact_resolver ?? providerDefaults.agents.impact_resolver,
        style_rewriter: agents?.style_rewriter ?? providerDefaults.agents.style_rewriter
      }
    },
    impact_resolver: legacy.impact_resolver ?? defaults.impact_resolver,
    style_system: legacy.style_system ?? defaults.style_system
  };
}

/** Lists agents whose effective provider points at one machine-local profile. */
export function agentProviderProfileImpact(
  settings: ProjectSettings,
  profileId: string
): AgentId[] {
  return AGENT_IDS.filter((agent) => effectiveAgentProviderProfile(settings, agent) === profileId);
}

/** Clears a deleted profile and disables only agents that depended on it. */
export function withoutAgentProviderProfile(
  settings: ProjectSettings,
  profileId: string
): ProjectSettings {
  const affected = new Set(agentProviderProfileImpact(settings, profileId));
  let next = settings.agent_providers.default_provider_profile_id === profileId
    ? withDefaultAgentProvider(settings, null)
    : settings;
  for (const agent of affected) {
    const assignment = next.agent_providers.agents[agent];
    next = withAgentProviderAssignment(next, agent, {
      provider_source: assignment.provider_source === "override"
        ? "project_default"
        : assignment.provider_source,
      provider_profile_override_id: null,
      model_id: null
    });
  }
  return {
    ...next,
    canon_check: affected.has("canon_checker")
      ? { ...next.canon_check, agent_mode: "disabled", content_policy: "never" }
      : next.canon_check,
    impact_resolver: affected.has("impact_resolver")
      ? { ...next.impact_resolver, agent_mode: "disabled", content_policy: "never" }
      : next.impact_resolver,
    style_system: affected.has("style_rewriter")
      ? { ...next.style_system, agent_mode: "disabled", content_policy: "never" }
      : next.style_system
  };
}

/** Resolves one opaque profile reference without consulting machine credentials. */
export function effectiveAgentProviderProfile(
  settings: ProjectSettings,
  agent: AgentId
): string | null {
  const assignment = settings.agent_providers.agents[agent];
  return assignment.provider_source === "override"
    ? assignment.provider_profile_override_id
    : settings.agent_providers.default_provider_profile_id;
}

/** Updates an assignment and keeps legacy Canon coordinator fields projected. */
export function withAgentProviderAssignment(
  settings: ProjectSettings,
  agent: AgentId,
  assignment: AgentProviderAssignment
): ProjectSettings {
  const next: ProjectSettings = {
    ...settings,
    agent_providers: {
      ...settings.agent_providers,
      agents: { ...settings.agent_providers.agents, [agent]: assignment }
    }
  };
  if (agent !== "canon_checker") return next;
  return {
    ...next,
    canon_check: {
      ...next.canon_check,
      provider_profile_id: effectiveAgentProviderProfile(next, "canon_checker"),
      model_preference: assignment.model_id
    }
  };
}

/** Changes the shared default and updates only the inheriting Canon projection. */
export function withDefaultAgentProvider(
  settings: ProjectSettings,
  profileId: string | null
): ProjectSettings {
  const next: ProjectSettings = {
    ...settings,
    agent_providers: {
      ...settings.agent_providers,
      default_provider_profile_id: profileId
    }
  };
  const canon = next.agent_providers.agents.canon_checker;
  return canon.provider_source === "project_default"
    ? {
        ...next,
        canon_check: {
          ...next.canon_check,
          provider_profile_id: profileId,
          model_preference: canon.model_id
        }
      }
    : next;
}

const SECRET_KEYS = new Set([
  "access_token", "api_key", "credential", "credentials", "password",
  "private_key", "refresh_token", "secret", "token"
]);
const SECRET_SUFFIXES = [
  "_api_key", "_credentials", "_password", "_private_key", "_secret", "_token"
];

/** Prevents browser persistence from sending secret-shaped project settings. */
export function assertPortableProjectSettings(value: unknown): asserts value is ProjectSettings {
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    Object.entries(candidate).forEach(([key, child]) => {
      const normalized = key.trim().toLowerCase().replaceAll("-", "_");
      if (SECRET_KEYS.has(normalized) || SECRET_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
        throw new Error(`Project settings must not contain secret field: ${key}`);
      }
      visit(child);
    });
  };
  visit(value);
  if (!value || typeof value !== "object" || !("style_system" in value)) {
    throw new Error("Project settings must contain style_system");
  }
  assertStyleSystemSettings(value.style_system);
}

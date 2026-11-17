import i18next, { type TOptions } from "i18next";
import { initReactI18next } from "react-i18next";
import type { ProjectLocale } from "@something-to-tell/contracts/project-manifest";
import { enCatalog, ruCatalog } from "./catalogs";

export const BOOT_LOCALE_KEY = "stt.ui_locale.v1";

/** Initializes catalogs synchronously so labels are correct on the first paint. */
void i18next.use(initReactI18next).init({
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  lng: readBootLocale(),
  resources: {
    en: { translation: enCatalog },
    ru: { translation: ruCatalog }
  },
  returnNull: false
});

/** Reads only a supported application locale from machine-local preferences. */
export function readBootLocale(): ProjectLocale {
  try {
    return globalThis.localStorage?.getItem(BOOT_LOCALE_KEY) === "ru" ? "ru" : "en";
  } catch {
    return "en";
  }
}

/** Persists the no-project locale and immediately updates subscribed React UI. */
export async function setBootLocale(locale: ProjectLocale): Promise<void> {
  try {
    globalThis.localStorage?.setItem(BOOT_LOCALE_KEY, locale);
  } catch {
    // Restricted browser storage must not prevent an in-memory locale change.
  }
  await i18next.changeLanguage(locale);
}

/** Applies a project override without changing the remembered boot locale. */
export async function applyProjectLocale(locale: ProjectLocale | null): Promise<void> {
  await i18next.changeLanguage(locale ?? readBootLocale());
}

/** Keeps call sites concise while retaining i18next interpolation and fallback. */
export function tr(key: keyof typeof enCatalog, options?: TOptions): string {
  return i18next.t(key, options);
}

/**
 * Localizes stable runtime message keys and their enum-like parameters while
 * keeping authored free text unchanged. Unresolved placeholders are replaced
 * defensively for process-local results created by older runtime versions.
 */
export function localizeRuntimeText(
  key: string,
  parameters: Record<string, unknown> = {},
  fallback = key
): string {
  if (!i18next.exists(key)) return fallback;
  const normalized = { ...parameters };
  for (const [parameter, value] of Object.entries(parameters)) {
    if (!parameter.endsWith("_key") || typeof value !== "string" || !i18next.exists(value)) continue;
    normalized[parameter.slice(0, -4)] = i18next.t(value);
  }
  if (typeof normalized.role === "string") {
    const roleKey = `impact.role.${normalized.role}`;
    if (i18next.exists(roleKey)) normalized.role = i18next.t(roleKey);
  } else if (key === "impact.dependency.containmentContext") {
    normalized.role = i18next.t("impact.role.resource");
  }
  const translated = i18next.t(key, normalized);
  return translated.replace(/\{\{\s*[^{}]+\s*}}/g, i18next.t("common.unknownValue"));
}

/** Formats dates with the effective UI locale instead of the authored language. */
export function formatUiDate(value: string | Date): string {
  return new Intl.DateTimeFormat(i18next.language === "ru" ? "ru-RU" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

/** Converts stable runtime codes to UI text without localizing transport contracts. */
export function localizeRuntimeError(
  error: unknown,
  fallback: keyof typeof enCatalog = "errors.runtimeRequestFailed"
): string {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return error instanceof Error ? error.message : tr(fallback);
  }
  const keys: Record<string, keyof typeof enCatalog> = {
    project_directory_invalid: "errors.projectDirectoryInvalid",
    project_locked: "errors.projectLocked",
    project_open_failed: "errors.projectOpenFailed",
    project_recovery_required: "errors.projectRecoveryRequired",
    project_save_failed: "errors.projectSaveFailed",
    project_settings_save_failed: "errors.projectSettingsFailed",
    storage_migration_failed: "errors.storageMigrationFailed",
    storage_migration_identity_conflict: "errors.storageMigrationIdentityConflict",
    storage_profile_schema_mismatch: "errors.storageSchemaUpgradeRequired",
    storage_profile_schema_migration_failed: "errors.databaseUpgradeFailed",
    project_database_migration_failed: "errors.databaseUpgradeFailed",
    storage_profile_unavailable: "errors.storageProfileUnavailable",
    remote_project_busy: "errors.remoteProjectBusy",
    remote_writer_lost: "errors.remoteWriterLost",
    remote_storage_generation_mismatch: "errors.remoteWriterLost",
    remote_storage_unavailable: "errors.remoteStorageUnavailable",
    remote_storage_timeout: "errors.remoteStorageTimeout",
    remote_schema_busy: "errors.remoteSchemaBusy",
    remote_project_not_provisioned: "errors.remoteProjectNotProvisioned",
    remote_storage_version_unsupported: "errors.remoteVersionUnsupported",
    remote_writer_epoch_exhausted: "errors.remoteWriterLost",
    remote_contract_invalid: "errors.remoteContractInvalid",
    remote_project_scope_mismatch: "errors.remoteScopeMismatch",
    remote_storage_protocol_unsupported: "errors.remoteProtocolUnsupported",
    remote_revision_stale: "errors.remoteRevisionStale",
    remote_generation_mismatch: "errors.remoteGenerationMismatch",
    remote_command_reused: "errors.remoteCommandReused",
    remote_commit_unknown: "errors.remoteCommitUnknown",
    remote_local_publication_required: "errors.remoteLocalPublicationRequired",
    remote_storage_binding_required: "errors.remoteBindingRequired",
    remote_tls_failed: "errors.remoteTlsFailed",
    remote_auth_failed: "errors.remoteAuthFailed",
    remote_admin_required: "errors.remoteAdminRequired",
    remote_schema_plan_stale: "errors.remoteSchemaPlanStale",
    remote_schema_plan_limit: "errors.remoteSchemaPlanLimit",
    remote_schema_backup_required: "errors.remoteSchemaBackupRequired",
    remote_schema_future: "errors.remoteSchemaFuture",
    remote_schema_unknown: "errors.remoteSchemaUnknown",
    remote_schema_partial: "errors.remoteSchemaPartial",
    remote_server_version_unsupported: "errors.remoteVersionUnsupported",
    remote_revision_exhausted: "errors.remoteRevisionExhausted",
    canon_project_dirty: "canon.error.canon_project_dirty",
    canon_revision_stale: "canon.error.canon_revision_stale",
    canon_run_stale: "canon.error.canon_run_stale",
    canon_run_not_found: "canon.error.canon_run_not_found",
    canon_run_in_progress: "canon.error.canon_run_in_progress",
    canon_run_cancelled: "canon.error.canon_run_cancelled",
    canon_provider_disabled: "canon.error.canon_provider_disabled",
    canon_provider_profile_unavailable: "canon.error.canon_provider_profile_unavailable",
    canon_provider_consent_required: "canon.error.canon_provider_consent_required",
    canon_provider_credentials_invalid: "canon.error.canon_provider_credentials_invalid",
    canon_provider_credentials_required: "canon.error.canon_provider_credentials_required",
    canon_provider_unavailable: "canon.error.canon_provider_unavailable",
    canon_provider_request_invalid: "canon.error.canon_provider_request_invalid",
    canon_provider_rate_limited: "canon.error.canon_provider_rate_limited",
    canon_provider_response_invalid: "canon.error.canon_provider_response_invalid",
    canon_provider_models_empty: "canon.error.canon_provider_models_empty",
    canon_suggestion_not_found: "canon.error.canon_suggestion_not_found",
    canon_suggestion_stale: "canon.error.canon_suggestion_stale",
    canon_repair_capability_stale: "canon.error.canon_repair_capability_stale",
    canon_repair_capability_unavailable: "canon.error.canon_repair_capability_unavailable",
    canon_suggestion_already_decided: "canon.error.canon_suggestion_already_decided",
    canon_suggestion_invalid: "canon.error.canon_suggestion_invalid",
    canon_rule_unknown: "canon.error.canon_rule_unknown",
    canon_rule_severity_unsupported: "canon.error.canon_rule_severity_unsupported",
    canon_issue_not_found: "canon.error.canon_issue_not_found",
    canon_project_not_open: "canon.error.canon_project_not_open",
    canon_reconciliation_failed: "canon.error.canon_reconciliation_failed",
    impact_direction_invalid: "impact.error.impact_direction_invalid",
    impact_domain_invalid: "impact.error.impact_domain_invalid",
    impact_propagation_invalid: "impact.error.impact_propagation_invalid",
    impact_depth_invalid: "impact.error.impact_depth_invalid",
    impact_path_limit_invalid: "impact.error.impact_path_limit_invalid",
    impact_target_limit_invalid: "impact.error.impact_target_limit_invalid",
    impact_seed_not_found: "impact.error.impact_seed_not_found",
    impact_patch_invalid: "impact.error.impact_patch_invalid",
    impact_patch_stale: "impact.error.impact_patch_stale",
    impact_run_stale: "impact.error.impact_run_stale",
    impact_run_cancelled: "impact.error.impact_run_cancelled",
    impact_run_failed: "impact.error.impact_run_failed",
    impact_result_limit_reached: "impact.error.impact_result_limit_reached",
    impact_resolution_limit_invalid: "impactResolution.error.impact_resolution_limit_invalid",
    impact_resolution_consent_required: "impactResolution.error.impact_resolution_consent_required",
    impact_resolution_provider_invalid: "impactResolution.error.impact_resolution_provider_invalid",
    impact_resolution_provider_unavailable: "impactResolution.error.impact_resolution_provider_unavailable",
    impact_resolution_provider_timeout: "impactResolution.error.impact_resolution_provider_timeout",
    impact_resolution_model_incompatible: "impactResolution.error.impact_resolution_model_incompatible",
    impact_resolution_run_not_found: "impactResolution.error.impact_resolution_run_not_found",
    impact_resolution_run_capacity_reached: "impactResolution.error.impact_resolution_run_capacity_reached",
    impact_resolution_owner_invalid: "impactResolution.error.impact_resolution_owner_invalid",
    impact_resolution_finding_invalid: "impactResolution.error.impact_resolution_finding_invalid",
    impact_resolution_patch_invalid: "impactResolution.error.impact_resolution_patch_invalid",
    impact_resolution_patch_stale: "impactResolution.error.impact_resolution_patch_stale",
    impact_resolution_operation_unsupported: "impactResolution.error.impact_resolution_operation_unsupported",
    impact_resolution_response_invalid: "impactResolution.error.impact_resolution_response_invalid",
    impact_resolution_visual_diff_invalid: "impactResolution.error.impact_resolution_visual_diff_invalid",
    impact_resolution_run_stale: "impactResolution.error.impact_resolution_run_stale",
    impact_resolution_run_cancelled: "impactResolution.error.impact_resolution_run_cancelled",
    impact_resolution_run_failed: "impactResolution.error.impact_resolution_run_failed",
    style_profile_invalid: "style.error.style_profile_invalid",
    style_profile_duplicate: "style.error.style_profile_duplicate",
    style_profile_oversized: "style.error.style_profile_oversized",
    style_profile_not_found: "style.error.style_profile_not_found",
    style_profile_in_use: "style.error.style_profile_in_use",
    style_profile_import_collision: "style.error.style_profile_import_collision",
    style_profile_import_invalid: "style.error.style_profile_import_invalid",
    style_profile_export_failed: "style.error.style_profile_export_failed",
    style_project_not_found: "style.error.style_project_not_found",
    style_profile_secret_forbidden: "style.error.style_profile_secret_forbidden",
    style_scene_assignment_duplicate: "style.error.style_scene_assignment_duplicate",
    style_scene_invalid: "style.error.style_scene_invalid",
    agent_memory_invalid: "agentMemory.error.agent_memory_invalid",
    agent_memory_version_unsupported: "agentMemory.error.agent_memory_version_unsupported",
    agent_memory_agent_unsupported: "agentMemory.error.agent_memory_agent_unsupported",
    agent_memory_locale_unsupported: "agentMemory.error.agent_memory_locale_unsupported",
    agent_memory_scope_invalid: "agentMemory.error.agent_memory_scope_invalid",
    agent_memory_duplicate: "agentMemory.error.agent_memory_duplicate",
    agent_memory_supersession_cycle: "agentMemory.error.agent_memory_supersession_cycle",
    agent_memory_secret_forbidden: "agentMemory.error.agent_memory_secret_forbidden",
    agent_memory_control_payload_forbidden: "agentMemory.error.agent_memory_control_payload_forbidden",
    agent_memory_injection_forbidden: "agentMemory.error.agent_memory_injection_forbidden",
    agent_memory_oversized: "agentMemory.error.agent_memory_oversized",
    agent_memory_resolution_stale: "agentMemory.error.agent_memory_resolution_stale",
    agent_memory_resolution_target_missing: "agentMemory.error.agent_memory_resolution_target_missing",
    agent_memory_resolution_context_required: "agentMemory.error.agent_memory_resolution_context_required",
    agent_memory_resolution_context_invalid: "agentMemory.error.agent_memory_resolution_context_invalid",
    agent_memory_not_found: "agentMemory.error.agent_memory_not_found",
    agent_memory_delete_review_required: "agentMemory.error.agent_memory_delete_review_required",
    agent_memory_delete_impact_stale: "agentMemory.error.agent_memory_delete_impact_stale",
    agent_memory_candidate_stale: "agentMemory.error.agent_memory_candidate_stale",
    agent_memory_candidate_provider_invalid: "agentMemory.error.agent_memory_candidate_provider_invalid",
    agent_memory_candidate_provider_unavailable: "agentMemory.error.agent_memory_candidate_provider_unavailable",
    agent_memory_candidate_provider_timeout: "agentMemory.error.agent_memory_candidate_provider_timeout",
    agent_memory_candidate_response_invalid: "agentMemory.error.agent_memory_candidate_response_invalid",
    agent_memory_candidate_run_capacity_reached: "agentMemory.error.agent_memory_candidate_run_capacity_reached",
    agent_memory_candidate_run_failed: "agentMemory.error.agent_memory_candidate_run_failed",
    agent_memory_candidate_run_active: "agentMemory.error.agent_memory_candidate_run_active",
    agent_memory_candidate_run_cancelled: "agentMemory.error.agent_memory_candidate_run_cancelled",
    agent_memory_candidate_run_not_found: "agentMemory.error.agent_memory_candidate_run_not_found",
    agent_memory_candidate_invalid: "agentMemory.error.agent_memory_candidate_invalid",
    agent_memory_supersedes_missing: "agentMemory.error.agent_memory_supersedes_missing",
    agent_memory_supersedes_invalid: "agentMemory.error.agent_memory_supersedes_invalid",
    engine_tag_key_invalid: "engineTags.error.engine_tag_key_invalid",
    engine_tag_key_collision: "engineTags.error.engine_tag_key_collision",
    engine_tag_owner_invalid: "engineTags.error.engine_tag_owner_invalid",
    engine_tag_alias_invalid: "engineTags.error.engine_tag_alias_invalid",
    engine_tag_limit_exceeded: "engineTags.error.engine_tag_limit_exceeded",
    engine_tag_version_unsupported: "engineTags.error.engine_tag_version_unsupported",
    engine_tag_identity_stale: "engineTags.error.engine_tag_identity_stale",
    engine_tag_secret_forbidden: "engineTags.error.engine_tag_secret_forbidden",
    engine_tag_control_forbidden: "engineTags.error.engine_tag_control_forbidden",
    engine_tag_path_forbidden: "engineTags.error.engine_tag_path_forbidden",
    narrative_state_revision_stale: "narrativeState.error.narrative_state_revision_stale",
    narrative_state_project_not_found: "narrativeState.error.narrative_state_project_not_found",
    narrative_state_record_not_found: "narrativeState.error.narrative_state_record_not_found",
    narrative_state_project_mismatch: "narrativeState.error.narrative_state_project_mismatch",
    narrative_state_reference_invalid: "narrativeState.error.narrative_state_reference_invalid",
    narrative_state_owner_missing: "narrativeState.error.narrative_state_owner_missing",
    narrative_state_conflict: "narrativeState.error.narrative_state_conflict",
    narrative_state_batch_invalid: "narrativeState.error.narrative_state_batch_invalid",
    narrative_state_delete_requires_review: "narrativeState.error.narrative_state_delete_requires_review",
    narrative_state_relationship_invalid: "narrativeState.error.narrative_state_relationship_invalid",
    narrative_state_relationship_review_required: "narrativeState.error.narrative_state_relationship_review_required",
    history_revision_stale: "history.error.history_revision_stale",
    history_document_stale: "history.error.history_document_stale",
    history_undo_empty: "history.error.history_undo_empty",
    history_redo_empty: "history.error.history_redo_empty",
    history_command_duplicate: "history.error.history_command_duplicate",
    history_record_invalid: "history.error.history_record_invalid",
    history_apply_failed: "history.error.history_apply_failed"
  };
  const parameters = "parameters" in error && error.parameters && typeof error.parameters === "object"
    ? error.parameters as Record<string, unknown>
    : {};
  return tr(keys[String(error.code)] ?? fallback, parameters);
}

export { i18next };

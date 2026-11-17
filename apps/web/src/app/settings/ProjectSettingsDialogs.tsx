import type {
CanonIssueSeverity
} from "@something-to-tell/contracts/canon-check";
import {
normalizeProjectSettings,
type ProjectManifestV2,
type ProjectSettings
} from "@something-to-tell/contracts/project-manifest";
import type {
StorageProfileSummary,
StorageProfileTestResponse
} from "@something-to-tell/contracts/storage";
import {
Database,
Plus,
ShieldCheck,
} from "lucide-react";
import { useEffect,useState } from "react";
import {
formatUiDate,
i18next,
localizeRuntimeError,
tr
} from "../../localization/i18n";
import { createRuntimeApiClient,type RuntimeAgentMemoryPersistence,type RuntimeCanonPersistence,type RuntimeStylePersistence } from "../../runtime/apiClient";

import { DialogShell,LabeledInput } from "../shared/DialogShell";
import { CANON_RULE_IDS } from "../workspaceShared";
import { StorageProfileDialog } from "./StorageProfileDialog";
import { SchemaAdministrationDialog } from "./SchemaAdministrationDialog";
export { StorageProfileDialog } from "./StorageProfileDialog";
import { AgentProviderSettings } from "./AgentProviderSettings";
import { AgentMemoryManager } from "./AgentMemoryManager";
import type { AgentMemoryDraftSeed } from "../../components/AgentMemoryDisclosure";
import { StyleProfileManager } from "./StyleProfileManager";
import { CanvasRenderingExperimentControl } from "./CanvasRenderingExperimentControl";

export function ProjectSettingsFields({
  activeSessionId,
  agentPersistence,
  onChange,
  onConfigureStorage,
  onRequestStorageMigration,
  onUseLocalStorage,
  storageDraftLabel,
  settings
}: {
  activeSessionId?: string | null;
  agentPersistence?: RuntimeCanonPersistence;
  onChange: (settings: ProjectSettings) => void;
  onConfigureStorage?: () => void;
  onRequestStorageMigration?: () => void;
  onUseLocalStorage?: () => void;
  storageDraftLabel?: string | null;
  settings: ProjectSettings;
}) {
  const storageValue = storageDraftLabel ? "postgresql" : settings.storage.mode;
  return (
    <fieldset className="space-y-3 border-t border-slate-200 pt-3">
      <legend className="pr-2 text-sm font-semibold text-slate-700">{tr("projects.behavior")}</legend>
      <div className="grid grid-cols-2 gap-3">
        <label className="block text-sm font-semibold text-slate-700">
          {tr("projects.interfaceLanguage")}
          <select
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            onChange={(event) => onChange({ ...settings, ui_locale: event.target.value as "en" | "ru" })}
            value={settings.ui_locale}
          >
            <option value="en">{tr("locale.english")}</option>
            <option value="ru">{tr("locale.russian")}</option>
          </select>
        </label>
        <label className="block text-sm font-semibold text-slate-700">
          {tr("projects.contentLanguage")}
          <select
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            onChange={(event) => onChange({ ...settings, content_locale: event.target.value as "en" | "ru" })}
            value={settings.content_locale}
          >
            <option value="en">{tr("locale.english")}</option>
            <option value="ru">{tr("locale.russian")}</option>
          </select>
        </label>
      </div>
      <div className="flex items-end gap-3">
        <label className="flex min-h-10 flex-1 items-center gap-2 text-sm font-semibold text-slate-700">
          <input
            checked={settings.autosave.enabled}
            onChange={(event) => onChange({
              ...settings,
              autosave: { ...settings.autosave, enabled: event.target.checked }
            })}
            type="checkbox"
          />
          {tr("projects.autosave")}
        </label>
        <label className="block w-40 text-sm font-semibold text-slate-700">
          {tr("projects.intervalMinutes")}
          <input
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            disabled={!settings.autosave.enabled}
            min={1}
            onChange={(event) => onChange({
              ...settings,
              autosave: {
                ...settings.autosave,
                interval_seconds: Math.max(60, Number(event.target.value || 1) * 60)
              }
            })}
            type="number"
            value={settings.autosave.interval_seconds / 60}
          />
        </label>
      </div>
      <label className="block text-sm font-semibold text-slate-700">
        {tr("projects.storage")}
        <select
          className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
          onChange={(event) => {
            if (event.target.value === "configure") {
              (onConfigureStorage ?? onRequestStorageMigration)?.();
            } else if (event.target.value === "local_sqlite" && storageValue !== "local_sqlite") {
              if (onUseLocalStorage) onUseLocalStorage();
              else onRequestStorageMigration?.();
            }
          }}
          value={storageValue}
        >
          <option value="local_sqlite">{tr("storage.local")}</option>
          {storageDraftLabel ? (
            <option value="postgresql">{tr("storage.postgresql")} · {storageDraftLabel}</option>
          ) : settings.storage.mode === "postgresql" ? (
            <option value="postgresql">{tr("storage.postgresql")} · {settings.storage.connection_profile_id}</option>
          ) : null}
          <option value="configure">{tr("storage.configure")}</option>
        </select>
      </label>
      {agentPersistence ? (
        <div className="space-y-3 border-t border-slate-200 pt-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-700">{tr("agents.defaultProvider")}</h3>
            <p className="mt-1 text-xs text-slate-500">{tr("agents.defaultProviderDescription")}</p>
          </div>
          <AgentProviderSettings
            activeSessionId={activeSessionId}
            agentId={null}
            onChange={onChange}
            persistence={agentPersistence}
            settings={settings}
          />
        </div>
      ) : null}
      <div className="space-y-3 border-t border-slate-200 pt-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-700">{tr("canon.settingsTitle")}</h3>
          <p className="mt-1 text-xs text-slate-500">{tr("canon.settingsDescription")}</p>
        </div>
        <label className="flex min-h-10 items-center gap-2 text-sm font-semibold text-slate-700">
          <input
            checked={settings.canon_check.deterministic_enabled}
            onChange={(event) => onChange({
              ...settings,
              canon_check: { ...settings.canon_check, deterministic_enabled: event.target.checked }
            })}
            type="checkbox"
          />
          {tr("canon.deterministicChecks")}
        </label>
        <details className="canon-rule-settings">
          <summary>{tr("canon.ruleSettings")}</summary>
          <div>
            {CANON_RULE_IDS.map((ruleId) => (
              <div className="canon-rule-setting" key={ruleId}>
                <label>
                  <input
                    checked={settings.canon_check.enabled_rules[ruleId] !== false}
                    onChange={(event) => onChange({
                      ...settings,
                      canon_check: {
                        ...settings.canon_check,
                        enabled_rules: {
                          ...settings.canon_check.enabled_rules,
                          [ruleId]: event.target.checked
                        }
                      }
                    })}
                    type="checkbox"
                  />
                  <span>{i18next.t(`canon.rule.${ruleId}`)}</span>
                </label>
                <select
                  aria-label={tr("canon.ruleSeverity", { rule: i18next.t(`canon.rule.${ruleId}`) })}
                  onChange={(event) => {
                    const next = { ...settings.canon_check.severity_overrides };
                    if (event.target.value === "default") delete next[ruleId];
                    else next[ruleId] = event.target.value as CanonIssueSeverity;
                    onChange({
                      ...settings,
                      canon_check: { ...settings.canon_check, severity_overrides: next }
                    });
                  }}
                  value={settings.canon_check.severity_overrides[ruleId] ?? "default"}
                >
                  <option value="default">{tr("canon.defaultSeverity")}</option>
                  <option value="info">{tr("canon.severityInfo")}</option>
                  <option value="warning">{tr("canon.severityWarning")}</option>
                  <option value="critical">{tr("canon.severityCritical")}</option>
                </select>
              </div>
            ))}
          </div>
        </details>
        <label className="block text-sm font-semibold text-slate-700">
          {tr("canon.agentMode")}
          <select
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
            onChange={(event) => {
              const configured = event.target.value === "configured";
              onChange({
                ...settings,
                canon_check: {
                  ...settings.canon_check,
                  agent_mode: configured ? "configured" : "disabled",
                  content_policy: configured ? "evidence_only" : "never"
                }
              });
            }}
            value={settings.canon_check.agent_mode}
          >
            <option value="disabled">{tr("canon.agentDisabled")}</option>
            <option disabled={!agentPersistence} value="configured">
              {tr("canon.agentConfigured")}
            </option>
          </select>
        </label>
        {settings.canon_check.agent_mode === "configured" ? (
          agentPersistence ? (
            <AgentProviderSettings
              activeSessionId={activeSessionId}
              agentId="canon_checker"
              onChange={onChange}
              persistence={agentPersistence}
              settings={settings}
            />
          ) : (
            <p className="text-xs text-slate-500">{tr("canon.configureAfterCreate")}</p>
          )
        ) : null}
        <p className="text-xs text-slate-500">
          {settings.canon_check.agent_mode === "configured"
            ? tr("canon.evidenceOnlyPolicy")
            : tr("canon.remoteDisabledPolicy")}
        </p>
      </div>
      <div className="space-y-3 border-t border-slate-200 pt-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-700">{tr("impactResolution.settingsTitle")}</h3>
          <p className="mt-1 text-xs text-slate-500">{tr("impactResolution.settingsDescription")}</p>
        </div>
        <label className="block text-sm font-semibold text-slate-700">
          {tr("impactResolution.agentMode")}
          <select
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
            onChange={(event) => {
              const configured = event.target.value === "configured";
              onChange({
                ...settings,
                impact_resolver: {
                  ...settings.impact_resolver,
                  agent_mode: configured ? "configured" : "disabled",
                  content_policy: configured ? "bounded_evidence" : "never"
                }
              });
            }}
            value={settings.impact_resolver.agent_mode}
          >
            <option value="disabled">{tr("canon.agentDisabled")}</option>
            <option disabled={!agentPersistence} value="configured">
              {tr("canon.agentConfigured")}
            </option>
          </select>
        </label>
        {settings.impact_resolver.agent_mode === "configured" ? (
          agentPersistence ? (
            <AgentProviderSettings
              activeSessionId={activeSessionId}
              agentId="impact_resolver"
              onChange={onChange}
              persistence={agentPersistence}
              settings={settings}
            />
          ) : (
            <p className="text-xs text-slate-500">{tr("canon.configureAfterCreate")}</p>
          )
        ) : null}
        <p className="text-xs text-slate-500">
          {settings.impact_resolver.agent_mode === "configured"
            ? tr("impactResolution.boundedEvidencePolicy")
            : tr("impactResolution.remoteDisabledPolicy")}
        </p>
      </div>
      <div className="space-y-3 border-t border-slate-200 pt-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-700">{tr("style.rewriterSettingsTitle")}</h3>
          <p className="mt-1 text-xs text-slate-500">{tr("style.rewriterSettingsDescription")}</p>
        </div>
        <label className="block text-sm font-semibold text-slate-700">
          {tr("style.rewriterAgentMode")}
          <select
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
            onChange={(event) => {
              const configured = event.target.value === "configured";
              onChange({
                ...settings,
                style_system: {
                  ...settings.style_system,
                  agent_mode: configured ? "configured" : "disabled",
                  content_policy: configured ? "explicit_consent" : "never"
                }
              });
            }}
            value={settings.style_system.agent_mode}
          >
            <option value="disabled">{tr("canon.agentDisabled")}</option>
            <option disabled={!agentPersistence} value="configured">
              {tr("canon.agentConfigured")}
            </option>
          </select>
        </label>
        {settings.style_system.agent_mode === "configured" ? (
          agentPersistence ? (
            <AgentProviderSettings
              activeSessionId={activeSessionId}
              agentId="style_rewriter"
              onChange={onChange}
              persistence={agentPersistence}
              settings={settings}
            />
          ) : (
            <p className="text-xs text-slate-500">{tr("canon.configureAfterCreate")}</p>
          )
        ) : null}
        <p className="text-xs text-slate-500">
          {settings.style_system.agent_mode === "configured"
            ? tr("style.explicitConsentPolicy")
            : tr("style.remoteDisabledPolicy")}
        </p>
      </div>
    </fieldset>
  );
}

/** Keeps manifest drafts isolated until the runtime confirms publication. */
export function ProjectSettingsDialog({
  activeSessionId,
  initialAgentMemoryDraft,
  manifest,
  onClose,
  onRequestStorageMigration,
  onSave,
  projectPath,
  persistence
}: {
  activeSessionId: string | null;
  initialAgentMemoryDraft?: AgentMemoryDraftSeed | null;
  manifest: ProjectManifestV2;
  onClose: () => void;
  onRequestStorageMigration: () => void;
  onSave: (name: string, description: string, settings: ProjectSettings) => Promise<void>;
  projectPath: string;
  persistence: RuntimeCanonPersistence & RuntimeStylePersistence & RuntimeAgentMemoryPersistence;
}) {
  const [name, setName] = useState(manifest.name);
  const [description, setDescription] = useState(manifest.description);
  const [settings, setSettings] = useState<ProjectSettings>(() => normalizeProjectSettings(manifest.settings));
  const [schemaOpen, setSchemaOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <><DialogShell hidden={schemaOpen} onClose={onClose} title={tr("projects.settings")}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim() || busy) return;
          setBusy(true);
          setError(null);
          void onSave(name.trim(), description.trim(), settings)
            .catch((caught) => setError(localizeRuntimeError(caught, "projects.settingsFailed")))
            .finally(() => setBusy(false));
        }}
      >
        <LabeledInput label={tr("common.name")} onChange={setName} value={name} />
        <label className="block text-sm font-semibold text-slate-700">
          {tr("common.description")}
          <textarea className="mt-1 min-h-24 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" onChange={(event) => setDescription(event.target.value)} value={description} />
        </label>
        <CanvasRenderingExperimentControl />
        <button className="inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-3 py-2 text-sm font-semibold" onClick={() => setSchemaOpen(true)} type="button">
          <Database size={16} aria-hidden="true" />{tr("storageAdmin.title")}
        </button>
        <ProjectSettingsFields
          activeSessionId={activeSessionId}
          agentPersistence={persistence}
          onChange={setSettings}
          onRequestStorageMigration={onRequestStorageMigration}
          settings={settings}
        />
        {activeSessionId ? (
          <StyleProfileManager
            activeSessionId={activeSessionId}
            contentLocale={settings.content_locale}
            defaultStyleProfileId={settings.style_system.default_style_profile_id}
            onDefaultChange={(profileId) => setSettings((current) => ({
              ...current,
              style_system: { ...current.style_system, default_style_profile_id: profileId }
            }))}
            persistence={persistence}
            projectId={manifest.project_id}
          />
        ) : null}
        {activeSessionId ? (
          <AgentMemoryManager
            activeSessionId={activeSessionId}
            contentLocale={settings.content_locale}
            initialDraft={initialAgentMemoryDraft}
            persistence={persistence}
            projectId={manifest.project_id}
          />
        ) : null}
        <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 border-t border-slate-200 pt-3 text-xs">
          <dt className="font-semibold text-slate-600">{tr("projects.projectId")}</dt>
          <dd className="truncate text-slate-700" title={manifest.project_id}>{manifest.project_id}</dd>
          <dt className="font-semibold text-slate-600">{tr("projects.created")}</dt>
          <dd className="text-slate-700">{formatUiDate(manifest.created_at)}</dd>
          <dt className="font-semibold text-slate-600">{tr("projects.folderLabel")}</dt>
          <dd className="truncate text-slate-700" title={projectPath}>{projectPath}</dd>
        </dl>
        <div className="flex items-center justify-end gap-3">
          <button className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={busy || !name.trim()} type="submit">
            {busy ? tr("common.saving") : tr("projects.saveSettings")}
          </button>
        </div>
        {error ? <p className="text-sm text-red-700" role="alert">{error}</p> : null}
      </form>
    </DialogShell>
    {schemaOpen ? <SchemaAdministrationDialog activeSessionId={activeSessionId}
      onClose={() => setSchemaOpen(false)} projectPath={projectPath}
      remoteProjectOpen={manifest.settings.storage.mode === "postgresql"} /> : null}</>
  );
}

/** Drives one explicit copy-and-verify authority switch without credentials. */
export function StorageMigrationDialog({
  activeSessionId,
  currentMode,
  currentProfileId,
  isClean,
  onClose,
  onMigrate,
  persistence
}: {
  activeSessionId: string | null;
  currentMode: "local_sqlite" | "postgresql";
  currentProfileId: string | null;
  isClean: boolean;
  onClose: () => void;
  onMigrate: (mode: "local_sqlite" | "postgresql", profileId: string | null) => Promise<void>;
  persistence: ReturnType<typeof createRuntimeApiClient>;
}) {
  const targetMode = currentMode === "local_sqlite" ? "postgresql" : "local_sqlite";
  const [profiles, setProfiles] = useState<StorageProfileSummary[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [testResult, setTestResult] = useState<StorageProfileTestResponse | null>(null);
  const [loadingProfiles, setLoadingProfiles] = useState(targetMode === "postgresql");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingProfile, setAddingProfile] = useState(false);

  useEffect(() => {
    if (targetMode !== "postgresql") return;
    if (!activeSessionId) return;
    void persistence.listStorageProfiles(activeSessionId)
      .then((response) => {
        setProfiles(response.profiles);
        setSelectedProfileId(response.profiles[0]?.profile_id ?? "");
      })
      .catch((caught) => {
        setError(localizeRuntimeError(caught, "storage.profilesFailed"));
      })
      .finally(() => setLoadingProfiles(false));
  }, [activeSessionId, persistence, targetMode]);

  const selectedProfile = profiles.find((profile) => profile.profile_id === selectedProfileId);
  const profileVerified = targetMode === "local_sqlite"
    || testResult?.profile.profile_id === selectedProfileId;

  async function testProfile() {
    if (!selectedProfileId || busy) return;
    setBusy(true);
    setError(null);
    setTestResult(null);
    try {
      if (!activeSessionId) throw new Error("No active project session");
      setTestResult(await persistence.testStorageProfile(activeSessionId, selectedProfileId));
    } catch (caught) {
      setError(localizeRuntimeError(caught, "storage.testingFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function migrate() {
    if (!isClean || !profileVerified || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onMigrate(
        targetMode,
        targetMode === "postgresql" ? selectedProfileId : null
      );
    } catch (caught) {
      setError(localizeRuntimeError(caught, "errors.storageMigrationFailed"));
      setBusy(false);
    }
  }

  if (addingProfile && activeSessionId) {
    return (
      <StorageProfileDialog
        onClose={() => setAddingProfile(false)}
        onSubmit={async (draft) => {
          const profile = await persistence.createStorageProfile({
            ...draft,
            session_id: activeSessionId
          });
          setProfiles((current) => [...current, profile]);
          setSelectedProfileId(profile.profile_id);
          setTestResult(null);
          setAddingProfile(false);
        }}
      />
    );
  }

  return (
    <DialogShell onClose={onClose} title={tr("storage.migration")}>
      <div className="space-y-4">
        <div className="flex items-center gap-3 border-b border-slate-200 pb-4">
          <Database className="text-slate-600" size={22} aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold text-slate-900">
              {currentMode === "local_sqlite" ? tr("storage.local") : `${tr("storage.postgresql")}${currentProfileId ? ` · ${currentProfileId}` : ""}`}
              {" → "}
              {targetMode === "postgresql" ? tr("storage.postgresql") : tr("storage.local")}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {tr("storage.sourcePreserved")}
            </p>
          </div>
        </div>

        {targetMode === "postgresql" ? (
          <>
            <label className="block text-sm font-semibold text-slate-700">
              {tr("storage.profile")}
              <select
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                disabled={loadingProfiles || busy}
                onChange={(event) => {
                  setSelectedProfileId(event.target.value);
                  setTestResult(null);
                }}
                value={selectedProfileId}
              >
                {profiles.map((profile) => (
                  <option key={profile.profile_id} value={profile.profile_id}>
                    {profile.label} · TLS {profile.tls_policy}
                  </option>
                ))}
              </select>
            </label>
            {!loadingProfiles && profiles.length === 0 ? (
              <p className="text-sm text-slate-600">
                {tr("storage.noProfiles")}
              </p>
            ) : null}
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-slate-500">
                {selectedProfile
                  ? tr("storage.opaqueProfile", { id: selectedProfile.profile_id })
                  : tr("storage.selectProfile")}
              </p>
              <button
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold disabled:opacity-50"
                disabled={!selectedProfileId || busy}
                onClick={() => void testProfile()}
                type="button"
              >
                {tr("storage.test")}
              </button>
            </div>
            <button
              className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold"
              onClick={() => setAddingProfile(true)}
              type="button"
            >
              <Plus size={16} aria-hidden="true" />
              {tr("storage.addConnection")}
            </button>
            {testResult ? (
              <p className="inline-flex items-center gap-2 text-sm font-semibold text-emerald-700" role="status">
                <ShieldCheck size={16} aria-hidden="true" />
                {tr("storage.connected", {
                  tls: testResult.tls_active ? tr("storage.tlsActive") : tr("storage.tlsInactive"),
                  schema: testResult.schema_status === "empty"
                    ? tr("storage.schemaEmpty")
                    : tr("storage.schemaVersion", { revision: testResult.schema_revision })
                })}
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-slate-600">
            {tr("storage.copyLocal")}
          </p>
        )}

        {!isClean ? (
          <p className="text-sm text-amber-700" role="alert">
            {tr("storage.saveFirst")}
          </p>
        ) : null}
        {error ? <p className="text-sm text-red-700" role="alert">{error}</p> : null}
        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <button className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold" disabled={busy} onClick={onClose} type="button">
            {tr("common.cancel")}
          </button>
          <button
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={!isClean || !profileVerified || (targetMode === "postgresql" && !selectedProfileId) || busy}
            onClick={() => void migrate()}
            type="button"
          >
            {busy
              ? tr("storage.migrating")
              : tr("storage.migrateTo", {
                  target: targetMode === "postgresql" ? tr("storage.postgresql") : tr("storage.local")
                })}
          </button>
        </div>
      </div>
    </DialogShell>
  );
}

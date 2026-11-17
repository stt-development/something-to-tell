import type {
  CanonProvider,
  CanonProviderModel,
  CanonProviderProfileSummary
} from "@something-to-tell/contracts/canon-agent";
import {
  agentProviderProfileImpact,
  effectiveAgentProviderProfile,
  withoutAgentProviderProfile,
  withAgentProviderAssignment,
  withDefaultAgentProvider,
  type AgentId,
  type ProjectSettings
} from "@something-to-tell/contracts/project-manifest";
import { Pencil,Plus,Trash2,X } from "lucide-react";
import { useEffect,useRef,useState } from "react";
import { localizeRuntimeError,tr } from "../../localization/i18n";
import type { RuntimeCanonPersistence } from "../../runtime/apiClient";

/** Manages one view onto the shared machine provider registry without retaining secrets. */
export function AgentProviderSettings({
  activeSessionId,
  agentId,
  onChange,
  persistence,
  settings
}: {
  activeSessionId?: string | null;
  agentId: AgentId | null;
  onChange: (settings: ProjectSettings) => void;
  persistence: RuntimeCanonPersistence;
  settings: ProjectSettings;
}) {
  const [profiles, setProfiles] = useState<CanonProviderProfileSummary[]>([]);
  const [models, setModels] = useState<CanonProviderModel[]>([]);
  const [formMode, setFormMode] = useState<"add" | "edit" | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const providerFormRef = useRef<HTMLDivElement | null>(null);
  const assignment = agentId ? settings.agent_providers.agents[agentId] : null;
  const profileId = agentId
    ? effectiveAgentProviderProfile(settings, agentId)
    : settings.agent_providers.default_provider_profile_id;
  const selectedProfile = profiles.find((profile) => profile.profile_id === profileId) ?? null;
  const compatibleModels = models.filter((model) => (
    model.capabilities.includes("text_generation")
    && model.capabilities.includes("structured_output")
  ));
  const storedModelId = agentId ? settings.agent_providers.agents[agentId].model_id : null;
  const storedModelUnavailable = Boolean(
    storedModelId && !compatibleModels.some((model) => model.id === storedModelId)
  );
  const impactedAgents = selectedProfile
    ? agentProviderProfileImpact(settings, selectedProfile.profile_id)
    : [];

  useEffect(() => {
    let active = true;
    setBusy(true);
    persistence.listCanonProviderProfiles(activeSessionId)
      .then((response) => {
        if (active) setProfiles(response.profiles ?? []);
      })
      .catch((caught) => {
        if (active) setError(localizeRuntimeError(caught));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => { active = false; };
  }, [activeSessionId, persistence]);

  useEffect(() => {
    let active = true;
    if (!agentId || !profileId) {
      setModels([]);
      return () => { active = false; };
    }
    setBusy(true);
    setError(null);
    setModels([]);
    persistence.listCanonProviderModels(activeSessionId, profileId)
      .then((response) => {
        if (active) setModels(response.models ?? []);
      })
      .catch((caught) => {
        if (active) setError(localizeRuntimeError(caught));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => { active = false; };
  }, [activeSessionId, agentId, persistence, profileId]);

  function selectProfile(nextProfileId: string) {
    if (!agentId) {
      onChange(withDefaultAgentProvider(settings, nextProfileId || null));
      return;
    }
    onChange(withAgentProviderAssignment(settings, agentId, {
      ...settings.agent_providers.agents[agentId],
      provider_source: "override",
      provider_profile_override_id: nextProfileId || null
    }));
  }

  async function saveProfile(container: HTMLDivElement) {
    const label = container.querySelector<HTMLInputElement>('input[name="label"]')?.value ?? "";
    const provider = container.querySelector<HTMLSelectElement>('select[name="provider"]')?.value ?? "openai";
    const apiKey = container.querySelector<HTMLInputElement>('input[name="api_key"]')?.value ?? "";
    if (!label.trim() || (formMode === "add" && apiKey.trim().length < 8)) return;
    setBusy(true);
    setError(null);
    try {
      const command = {
        session_id: activeSessionId ?? null,
        label,
        provider: provider as CanonProvider,
        api_key: apiKey.trim() || null
      };
      const response = formMode === "edit" && selectedProfile
        ? await persistence.updateCanonProviderProfile(selectedProfile.profile_id, command)
        : await persistence.createCanonProviderProfile({ ...command, api_key: apiKey });
      setProfiles((current) => [
        ...current.filter((profile) => profile.profile_id !== response.profile.profile_id),
        response.profile
      ].sort((left, right) => left.label.localeCompare(right.label)));
      setModels(response.models);
      setFormMode(null);
      selectProfile(response.profile.profile_id);
      container.querySelectorAll<HTMLInputElement>("input").forEach((input) => { input.value = ""; });
    } catch (caught) {
      setError(localizeRuntimeError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelectedProfile() {
    if (!selectedProfile) return;
    setBusy(true);
    setError(null);
    try {
      await persistence.deleteCanonProviderProfile(activeSessionId, selectedProfile.profile_id);
      setProfiles((current) => current.filter((profile) => profile.profile_id !== selectedProfile.profile_id));
      setModels([]);
      setConfirmingDelete(false);
      setFormMode(null);
      onChange(withoutAgentProviderProfile(settings, selectedProfile.profile_id));
    } catch (caught) {
      setError(localizeRuntimeError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="canon-agent-settings"
      aria-label={tr(agentId ? `agents.${agentId}.settings` : "agents.defaultProviderSettings")}
    >
      {agentId ? (
        <label className="block text-sm font-semibold text-slate-700">
          {tr("agents.providerSource")}
          <select
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
            onChange={(event) => onChange(withAgentProviderAssignment(settings, agentId, {
              ...settings.agent_providers.agents[agentId],
              provider_source: event.target.value as "project_default" | "override",
              provider_profile_override_id: null
            }))}
            value={assignment?.provider_source ?? "project_default"}
          >
            <option value="project_default">{tr("agents.useProjectDefault")}</option>
            <option value="override">{tr("agents.useCustomProfile")}</option>
          </select>
        </label>
      ) : null}
      <div className="canon-provider-selector">
        <label className="block text-sm font-semibold text-slate-700">
          {tr(agentId ? `agents.${agentId}.providerProfile` : "agents.defaultProviderProfile")}
          <select
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
            onChange={(event) => selectProfile(event.target.value)}
            disabled={busy || Boolean(agentId && assignment?.provider_source === "project_default")}
            value={profileId ?? ""}
          >
            <option value="">{tr("canon.selectProviderProfile")}</option>
            {profiles.map((profile) => (
              <option key={profile.profile_id} value={profile.profile_id}>
                {profile.label} · {tr(`canon.provider.${profile.provider}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="canon-profile-management" aria-label={tr("canon.profileManagement")}>
        {selectedProfile ? (
          <div className="canon-profile-summary">
            <strong>{selectedProfile.label}</strong>
            <span>{tr(`canon.provider.${selectedProfile.provider}`)}</span>
          </div>
        ) : (
          <p>{tr("canon.noProviderProfile")}</p>
        )}
        <div className="canon-profile-actions">
          <button disabled={busy} onClick={() => { setConfirmingDelete(false); setFormMode("add"); }} type="button">
            <Plus size={14} aria-hidden="true" />{tr(agentId ? "canon.addProviderProfile" : "agents.addDefaultProvider")}
          </button>
          <button disabled={busy || !selectedProfile} onClick={() => { setConfirmingDelete(false); setFormMode("edit"); }} type="button">
            <Pencil size={14} aria-hidden="true" />{tr("canon.editProviderProfile")}
          </button>
          <button className="danger" disabled={busy || !selectedProfile} onClick={() => { setFormMode(null); setConfirmingDelete(true); }} type="button">
            <Trash2 size={14} aria-hidden="true" />{tr("canon.deleteProviderProfile")}
          </button>
        </div>
      </div>
      {confirmingDelete && selectedProfile ? (
        <div className="canon-profile-delete-confirmation" role="alert">
          <p>{tr("canon.deleteProviderProfileConfirmation", { name: selectedProfile.label })}</p>
          {impactedAgents.length > 0 ? (
            <p>{tr("agents.deleteProviderImpact", {
              agents: impactedAgents.map((agent) => tr(`agents.${agent}.name`)).join(", ")
            })}</p>
          ) : null}
          <div>
            <button disabled={busy} onClick={() => setConfirmingDelete(false)} type="button">{tr("common.cancel")}</button>
            <button className="danger" disabled={busy} onClick={() => void deleteSelectedProfile()} type="button">{tr("common.delete")}</button>
          </div>
        </div>
      ) : null}
      {formMode ? (
        <div className="canon-provider-form" ref={providerFormRef}>
          <div className="canon-provider-form-heading">
            <strong>{tr(formMode === "add" ? "canon.addProviderProfile" : "canon.editProviderProfile")}</strong>
            <button aria-label={tr("common.close")} className="icon-button" onClick={() => setFormMode(null)} type="button"><X size={14} aria-hidden="true" /></button>
          </div>
          <label>{tr("common.name")}<input defaultValue={formMode === "edit" ? selectedProfile?.label : ""} name="label" required /></label>
          <label>
            {tr("canon.provider")}
            <select defaultValue={formMode === "edit" ? selectedProfile?.provider : "openai"} name="provider">
              <option value="openai">{tr("canon.provider.openai")}</option>
              <option value="google_gemini">{tr("canon.provider.google_gemini")}</option>
              <option value="anthropic">{tr("canon.provider.anthropic")}</option>
            </select>
          </label>
          <label className="canon-provider-key">
            {tr("canon.apiKey")}
            <input aria-label={tr("canon.apiKey")} autoComplete="off" minLength={8} name="api_key" required={formMode === "add"} type="password" />
            {formMode === "edit" ? <span>{tr("canon.keepExistingApiKey")}</span> : null}
          </label>
          <button
            disabled={busy}
            onClick={() => providerFormRef.current && void saveProfile(providerFormRef.current)}
            type="button"
          >
            {busy ? tr("canon.loading") : tr(formMode === "add" ? "canon.connectProvider" : "canon.saveProviderProfile")}
          </button>
        </div>
      ) : null}
      {agentId ? (
        <label className="block text-sm font-semibold text-slate-700">
          {tr(`agents.${agentId}.model`)}
          <select
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
            disabled={!profileId || busy}
            onChange={(event) => onChange(withAgentProviderAssignment(settings, agentId, {
              ...settings.agent_providers.agents[agentId],
              model_id: event.target.value || null
            }))}
            value={storedModelId ?? ""}
          >
            <option value="">{busy ? tr("canon.loading") : tr("canon.selectModel")}</option>
            {storedModelUnavailable ? (
              <option value={storedModelId ?? ""}>{tr("agents.modelUnavailable", { model: storedModelId })}</option>
            ) : null}
            {compatibleModels.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
          </select>
        </label>
      ) : null}
      {error ? <p className="text-sm text-red-700" role="alert">{error}</p> : null}
    </section>
  );
}

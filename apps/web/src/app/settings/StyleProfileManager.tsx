import type {
  StyleProfileDeletionImpactV1,
  StyleProfileTraitsV1,
  StyleProfileV1
} from "@something-to-tell/contracts/style-system";
import { Copy, Plus, Save, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { localizeRuntimeError, tr } from "../../localization/i18n";
import type { RuntimeStylePersistence } from "../../runtime/apiTypes";
import {
  stylePresetDraft,
  stylePresets,
  type StyleContentLocale,
  type StyleProfileDraft
} from "./stylePresets";

export type { StyleProfileDraft } from "./stylePresets";

const EMPTY_TRAITS: StyleProfileTraitsV1 = {
  traits_version: 1,
  tone: [],
  rhythm: [],
  pacing: [],
  vocabulary: [],
  dramatic_intensity: null
};

export function emptyStyleProfileDraft(): StyleProfileDraft {
  return { name: "", description: "", guidance: "", traits: EMPTY_TRAITS, positive_examples: [] };
}

/** Edits only authored style content; identity and timestamps remain runtime-facing metadata. */
export function StyleProfileFields({
  autoFocus = false,
  contentLocale,
  draft,
  onChange
}: {
  autoFocus?: boolean;
  contentLocale: StyleContentLocale;
  draft: StyleProfileDraft;
  onChange: (draft: StyleProfileDraft) => void;
}) {
  const presets = stylePresets(contentLocale);

  function setTrait(key: keyof Omit<StyleProfileTraitsV1, "traits_version" | "dramatic_intensity">, value: string) {
    onChange({
      ...draft,
      traits: { ...draft.traits, [key]: splitCommaList(value) }
    });
  }
  return (
    <div className="grid gap-3">
      <label className="style-profile-field">
        {tr("style.basePreset")}
        <select
          aria-describedby="style-base-preset-hint"
          onChange={(event) => {
            const preset = stylePresetDraft(event.target.value, contentLocale);
            if (preset) onChange(preset);
          }}
          value=""
        >
          <option value="">{tr("style.chooseBasePreset")}</option>
          {presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.draft.name}</option>)}
        </select>
        <span className="text-xs font-normal text-slate-500" id="style-base-preset-hint">{tr("style.basePresetHint")}</span>
      </label>
      <label className="style-profile-field">
        {tr("common.name")}
        <input autoFocus={autoFocus} onChange={(event) => onChange({ ...draft, name: event.target.value })} value={draft.name} />
      </label>
      <label className="style-profile-field">
        {tr("common.description")}
        <textarea className="min-h-16" onChange={(event) => onChange({ ...draft, description: event.target.value })} value={draft.description} />
      </label>
      <label className="style-profile-field">
        {tr("style.guidance")}
        <textarea className="min-h-24" onChange={(event) => onChange({ ...draft, guidance: event.target.value })} value={draft.guidance} />
      </label>
      <fieldset className="grid grid-cols-2 gap-2 rounded-md border border-slate-200 p-3">
        <legend className="px-1 text-xs font-semibold text-slate-600">{tr("style.constraints")}</legend>
        {(["tone", "rhythm", "pacing", "vocabulary"] as const).map((trait) => (
          <label className="style-profile-field" key={trait}>
            {tr(`style.${trait}`)}
            <input onChange={(event) => setTrait(trait, event.target.value)} value={draft.traits[trait].join(", ")} />
          </label>
        ))}
        <label className="style-profile-field col-span-2">
          {tr("style.dramaticIntensity")}
          <input
            onChange={(event) => onChange({
              ...draft,
              traits: { ...draft.traits, dramatic_intensity: event.target.value.trim() || null }
            })}
            value={draft.traits.dramatic_intensity ?? ""}
          />
        </label>
      </fieldset>
      <label className="style-profile-field">
        {tr("style.examples")}
        <textarea
          className="min-h-20"
          onChange={(event) => onChange({ ...draft, positive_examples: splitExamples(event.target.value) })}
          placeholder={tr("style.examplesHint")}
          value={draft.positive_examples.join("\n\n")}
        />
      </label>
    </div>
  );
}

/** Owns project profile drafts and makes every destructive reference change explicit. */
export function StyleProfileManager({
  activeSessionId,
  contentLocale,
  defaultStyleProfileId,
  onDefaultChange,
  persistence,
  projectId
}: {
  activeSessionId: string;
  contentLocale: StyleContentLocale;
  defaultStyleProfileId: string | null;
  onDefaultChange: (profileId: string | null) => void;
  persistence: RuntimeStylePersistence;
  projectId: string;
}) {
  const [profiles, setProfiles] = useState<StyleProfileV1[]>([]);
  const [persistedDefaultId, setPersistedDefaultId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<StyleProfileDraft | null>(null);
  const [baseline, setBaseline] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [impact, setImpact] = useState<StyleProfileDeletionImpactV1 | null>(null);
  const [replacementId, setReplacementId] = useState("");
  const selected = profiles.find((profile) => profile.id === selectedId) ?? null;
  const dirty = draft !== null && JSON.stringify(draft) !== baseline;
  const missingDefault = Boolean(defaultStyleProfileId && !profiles.some((profile) => profile.id === defaultStyleProfileId));

  async function reload(preferredId?: string | null) {
    const catalog = await persistence.loadStyleCatalog(activeSessionId);
    setProfiles(catalog.profiles);
    setPersistedDefaultId(catalog.default_style_profile_id);
    const nextId = preferredId ?? selectedId ?? catalog.default_style_profile_id ?? catalog.profiles[0]?.id ?? null;
    selectProfile(nextId, catalog.profiles, true);
  }

  useEffect(() => {
    setBusy(true);
    void reload().catch((caught) => setError(localizeRuntimeError(caught))).finally(() => setBusy(false));
  }, [activeSessionId]);

  function selectProfile(id: string | null, source = profiles, force = false) {
    if (!force && dirty && !window.confirm(tr("style.discardUnsaved"))) return;
    const profile = source.find((item) => item.id === id) ?? null;
    setSelectedId(profile?.id ?? null);
    setDraft(profile ? profileDraft(profile) : null);
    setBaseline(profile ? JSON.stringify(profileDraft(profile)) : "");
    setCreating(false);
    setImpact(null);
  }

  async function saveDraft() {
    if (!draft || !draft.name.trim() || !draft.guidance.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const now = new Date().toISOString();
      const profile: StyleProfileV1 = {
        style_profile_version: 1,
        id: selected?.id ?? crypto.randomUUID(),
        project_id: projectId,
        ...normalizedDraft(draft),
        created_at: selected?.created_at ?? now,
        updated_at: now
      };
      const saved = selected
        ? await persistence.updateStyleProfile(profile)
        : await persistence.createStyleProfile(profile);
      await reload(saved.id);
    } catch (caught) {
      setError(localizeRuntimeError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function duplicateSelected() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const now = new Date().toISOString();
      const duplicate = await persistence.createStyleProfile({
        ...selected,
        id: crypto.randomUUID(),
        name: tr("style.copyName", { name: selected.name }),
        created_at: now,
        updated_at: now
      });
      await reload(duplicate.id);
    } catch (caught) {
      setError(localizeRuntimeError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function reviewDeletion() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      setImpact(await persistence.inspectStyleProfileDeletionImpact(
        selected.id,
        projectId,
        persistedDefaultId
      ));
    } catch (caught) {
      setError(localizeRuntimeError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDeletion() {
    if (!selected || !impact) return;
    setBusy(true);
    setError(null);
    try {
      await persistence.deleteStyleProfile(selected.id, {
        project_id: projectId,
        default_style_profile_id: persistedDefaultId,
        replacement_profile_id: replacementId || null,
        impact_reviewed: true
      });
      if (impact.uses_project_default) onDefaultChange(replacementId || null);
      await reload(null);
      setImpact(null);
    } catch (caught) {
      setError(localizeRuntimeError(caught));
    } finally {
      setBusy(false);
    }
  }

  const profileOptions = useMemo(
    () => profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>),
    [profiles]
  );
  return (
    <section className="space-y-3 border-t border-slate-200 pt-3" aria-label={tr("style.management") }>
      <div>
        <h3 className="text-sm font-semibold text-slate-800">{tr("style.management")}</h3>
        <p className="text-xs text-slate-500">{tr("style.managementDescription")}</p>
      </div>
      <label className="style-profile-field">
        {tr("style.projectDefault")}
        <select onChange={(event) => onDefaultChange(event.target.value || null)} value={defaultStyleProfileId ?? ""}>
          <option value="">{tr("style.noDefault")}</option>
          {profileOptions}
        </select>
      </label>
      {missingDefault ? <p className="text-xs font-medium text-red-700" role="alert">{tr("style.missingDefault")}</p> : null}
      <div className="grid grid-cols-[minmax(9rem,0.7fr)_minmax(18rem,1.3fr)] gap-3">
        <div className="min-w-0 rounded-md border border-slate-200 p-2">
          <div className="mb-2 flex items-center justify-between">
            <strong className="text-xs text-slate-600">{tr("style.profiles")}</strong>
            <button aria-label={tr("style.createProfile")} className="icon-button" data-tooltip={tr("style.createProfile")} onClick={() => {
              if (dirty && !window.confirm(tr("style.discardUnsaved"))) return;
              setSelectedId(null);
              setDraft(emptyStyleProfileDraft());
              setBaseline(JSON.stringify(emptyStyleProfileDraft()));
              setCreating(true);
              setImpact(null);
            }} type="button"><Plus size={15} aria-hidden="true" /></button>
          </div>
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {profiles.map((profile) => (
              <button
                className={`w-full truncate rounded px-2 py-1.5 text-left text-sm ${selectedId === profile.id ? "bg-sky-50 font-semibold text-sky-900" : "hover:bg-slate-50"}`}
                key={profile.id}
                onClick={() => selectProfile(profile.id)}
                type="button"
              >{profile.name}</button>
            ))}
            {!profiles.length && !creating ? <p className="px-2 py-4 text-center text-xs text-slate-500">{tr("style.noProfiles")}</p> : null}
          </div>
        </div>
        <div className="min-w-0">
          {draft ? (
            <div onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                event.preventDefault();
                void saveDraft();
              }
            }}>
              <StyleProfileFields autoFocus={creating} contentLocale={contentLocale} draft={draft} onChange={setDraft} />
              <div className="mt-3 flex items-center gap-2">
                <button className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={busy || !draft.name.trim() || !draft.guidance.trim()} onClick={() => void saveDraft()} type="button"><Save size={15} aria-hidden="true" />{tr("common.save")}</button>
                {selected ? <button aria-label={tr("style.duplicateProfile")} className="icon-button" data-tooltip={tr("style.duplicateProfile")} disabled={busy} onClick={() => void duplicateSelected()} type="button"><Copy size={15} aria-hidden="true" /></button> : null}
                {selected ? <button aria-label={tr("style.deleteProfile")} className="icon-button text-red-700" data-tooltip={tr("style.deleteProfile")} disabled={busy} onClick={() => void reviewDeletion()} type="button"><Trash2 size={15} aria-hidden="true" /></button> : null}
                {dirty ? <span className="text-xs font-medium text-amber-700">{tr("style.unsaved")}</span> : null}
              </div>
            </div>
          ) : <p className="py-12 text-center text-sm text-slate-500">{tr("style.selectProfile")}</p>}
        </div>
      </div>
      {impact ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <strong>{tr("style.deleteImpactTitle")}</strong>
              <p className="mt-1 text-xs text-slate-700">{impact.uses_project_default
                ? tr("style.deleteDefaultImpact", { count: impact.scene_node_ids.length })
                : tr("style.deleteSceneImpact", { count: impact.scene_node_ids.length })}</p>
            </div>
            <button aria-label={tr("common.cancel")} className="icon-button" data-tooltip={tr("common.cancel")} onClick={() => setImpact(null)} type="button"><X size={15} aria-hidden="true" /></button>
          </div>
          <div className="mt-3 flex items-end gap-2">
              <label className="style-profile-field flex-1">{tr("style.assignmentReplacement")}
                <select onChange={(event) => setReplacementId(event.target.value)} value={replacementId}>
                  <option value="">{tr("style.clearToInheritance")}</option>
                  {profiles.filter((profile) => profile.id !== selectedId).map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                </select>
              </label>
              <button className="rounded-md bg-red-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={busy} onClick={() => void confirmDeletion()} type="button">{tr("common.delete")}</button>
          </div>
        </div>
      ) : null}
      {busy ? <p className="text-xs text-slate-500" aria-live="polite">{tr("common.saving")}</p> : null}
      {error ? <p className="text-sm text-red-700" role="alert">{error}</p> : null}
    </section>
  );
}

function profileDraft(profile: StyleProfileV1): StyleProfileDraft {
  return {
    name: profile.name,
    description: profile.description,
    guidance: profile.guidance,
    traits: profile.traits,
    positive_examples: profile.positive_examples
  };
}

function normalizedDraft(draft: StyleProfileDraft): StyleProfileDraft {
  return {
    ...draft,
    name: draft.name.trim(),
    description: draft.description.trim(),
    guidance: draft.guidance.trim(),
    positive_examples: draft.positive_examples.map((example) => example.trim()).filter(Boolean)
  };
}

function splitCommaList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function splitExamples(value: string): string[] {
  return value.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
}

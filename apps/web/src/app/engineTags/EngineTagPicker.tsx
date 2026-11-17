/** Contextual Engine Tag authoring shared by node, relationship, and nested editors. */
import { Check, ChevronDown, Link2, LoaderCircle, Pencil, Plus, Save, Search, Tags, Unlink, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  engineTagOwnerKey,
  suggestEngineTagKey,
  type EngineTagDefinitionV1,
  type EngineTagMutationCommandV1,
  type EngineTagMutationResponseV1,
  type EngineTagOwnerV1
} from "@something-to-tell/contracts/engine-tags";
import { localizeRuntimeError, tr } from "../../localization/i18n";
import type { RuntimeEngineTagPersistence } from "../../runtime/apiTypes";

export interface EngineTagPickerProps {
  compact?: boolean;
  label?: string;
  owners: EngineTagOwnerV1[];
  persistence: RuntimeEngineTagPersistence;
  sessionId: string;
  suggestionDescription?: string;
  suggestionLabel?: string;
}

function commandId(action: string): string {
  return `context-${action}-${Date.now()}`;
}

/** Provides explicit assignment feedback and local definition authoring without leaving the entity editor. */
export function EngineTagPicker({
  compact = false, label = tr("engineTags.contextual"), owners, persistence, sessionId,
  suggestionDescription = "", suggestionLabel = "Unnamed"
}: EngineTagPickerProps) {
  const [snapshot, setSnapshot] = useState<EngineTagMutationResponseV1 | null>(null);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftKey, setDraftKey] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void persistence.loadEngineTagRegistry(sessionId).then((value) => {
      if (!cancelled) setSnapshot(value);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(localizeRuntimeError(reason));
    });
    return () => { cancelled = true; };
  }, [persistence, sessionId]);

  const ownerKeys = useMemo(() => new Set(owners.map(engineTagOwnerKey)), [owners]);
  const bindingCounts = useMemo(() => {
    const counts = new Map<string, Set<string>>();
    for (const binding of snapshot?.catalog.bindings ?? []) {
      const ownerKey = engineTagOwnerKey(binding.owner);
      if (!ownerKeys.has(ownerKey)) continue;
      const boundOwners = counts.get(binding.definition_id) ?? new Set<string>();
      boundOwners.add(ownerKey);
      counts.set(binding.definition_id, boundOwners);
    }
    return new Map([...counts].map(([definitionId, boundOwners]) => [definitionId, boundOwners.size]));
  }, [ownerKeys, snapshot]);
  const activeDefinitions = useMemo(() => (snapshot?.catalog.definitions ?? []).filter(
    (definition) => definition.status === "active"
  ), [snapshot]);
  const assignedDefinitions = useMemo(() => activeDefinitions.filter(
    (definition) => (bindingCounts.get(definition.id) ?? 0) > 0
  ), [activeDefinitions, bindingCounts]);
  const availableDefinitions = useMemo(() => activeDefinitions.filter((definition) => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return (bindingCounts.get(definition.id) ?? 0) < owners.length
      && `${definition.key} ${definition.description}`.toLocaleLowerCase().includes(normalizedQuery);
  }), [activeDefinitions, bindingCounts, owners.length, query]);

  function bindingCount(definitionId: string): number {
    return bindingCounts.get(definitionId) ?? 0;
  }

  async function apply(command: Omit<EngineTagMutationCommandV1, "command_version" | "command_id" | "expected_source_checksum" | "expected_history_revision">) {
    if (!snapshot) return;
    const updated = await persistence.applyEngineTagCommand({
      command_version: 1,
      command_id: commandId(command.action),
      ...command,
      expected_source_checksum: snapshot.source_checksum,
      expected_history_revision: snapshot.history_revision
    });
    setSnapshot(updated);
  }

  async function toggle(definition: EngineTagDefinitionV1) {
    if (!snapshot || owners.length === 0) return;
    const count = bindingCount(definition.id);
    const removing = count === owners.length;
    const changedOwners = removing
      ? owners
      : owners.filter((owner) => !snapshot.catalog.bindings.some((binding) =>
          binding.definition_id === definition.id && engineTagOwnerKey(binding.owner) === engineTagOwnerKey(owner)));
    const action = removing
      ? changedOwners.length === 1 ? "unbind" : "batch_unbind"
      : changedOwners.length === 1 ? "bind" : "batch_bind";
    setBusyId(definition.id);
    setError(null);
    setNotice(null);
    try {
      await apply({
        action,
        definition_id: definition.id,
        owner: changedOwners.length === 1 ? changedOwners[0]! : undefined,
        owners: changedOwners.length > 1 ? changedOwners : undefined
      });
      setNotice(tr(removing ? "engineTags.unassignedNotice" : "engineTags.assignedNotice", { key: definition.key }));
      if (!removing) {
        setCatalogOpen(false);
        setQuery("");
      }
    } catch (reason) {
      setError(localizeRuntimeError(reason));
    } finally {
      setBusyId(null);
    }
  }

  function beginCreate() {
    if (!snapshot || owners.length === 0) return;
    // Suggestions are deterministic, editable, and never persisted until the author confirms them.
    const suggestion = suggestEngineTagKey({
      request_version: 1,
      project_id: owners[0]!.project_id,
      owner: owners[0]!,
      label: suggestionLabel,
      existing_keys: snapshot.catalog.definitions.map((definition) => definition.key)
    });
    setCreating(true);
    setEditingId(null);
    setDraftKey(suggestion.key);
    setDraftDescription(suggestionDescription);
    setError(null);
    setNotice(null);
  }

  function beginEdit(definition: EngineTagDefinitionV1) {
    setCreating(false);
    setEditingId(definition.id);
    setDraftKey(definition.key);
    setDraftDescription(definition.description);
    setError(null);
    setNotice(null);
  }

  function cancelEditor() {
    setCreating(false);
    setEditingId(null);
    setDraftKey("");
    setDraftDescription("");
  }

  async function saveEditor() {
    if (!snapshot || !draftKey.trim() || owners.length === 0) return;
    const identity = editingId ?? "new";
    setBusyId(identity);
    setError(null);
    setNotice(null);
    try {
      if (editingId) {
        await apply({ action: "rename_definition", definition_id: editingId, key: draftKey.trim(), description: draftDescription.trim() });
        setNotice(tr("engineTags.updatedNotice", { key: draftKey.trim() }));
      } else {
        await apply({
          action: "create_and_bind",
          key: draftKey.trim(),
          description: draftDescription.trim(),
          owner: owners.length === 1 ? owners[0]! : undefined,
          owners: owners.length > 1 ? owners : undefined
        });
        setNotice(tr("engineTags.createdNotice", { key: draftKey.trim() }));
      }
      if (!editingId) {
        setCatalogOpen(false);
        setQuery("");
      }
      cancelEditor();
    } catch (reason) {
      setError(localizeRuntimeError(reason));
    } finally {
      setBusyId(null);
    }
  }

  function definitionOption(definition: EngineTagDefinitionV1) {
    const count = bindingCount(definition.id);
    const isBound = count === owners.length;
    const isPartial = count > 0 && !isBound;
    const actionLabel = isBound ? tr("engineTags.unassign") : tr("engineTags.assign");
    return <div className={`engine-tag-picker-option ${isBound ? "is-bound" : ""} ${isPartial ? "is-partial" : ""}`} key={definition.id}>
      <span><strong>{definition.key}</strong><small>{definition.description || tr("engineTags.noDescription")}</small>{isPartial ? <small>{tr("engineTags.partiallyAssigned", { count, total: owners.length })}</small> : null}</span>
      <button aria-label={tr("engineTags.editNamed", { key: definition.key })} className="engine-tag-picker-icon" disabled={busyId !== null} onClick={() => beginEdit(definition)} title={tr("common.edit")} type="button"><Pencil size={13} aria-hidden="true" /></button>
      <button aria-label={`${actionLabel}: ${definition.key}`} className="engine-tag-picker-assignment" disabled={busyId !== null} onClick={() => void toggle(definition)} title={`${actionLabel}: ${definition.key}`} type="button">{busyId === definition.id ? <LoaderCircle className="animate-spin" size={13} aria-hidden="true" /> : isBound ? <Unlink size={13} aria-hidden="true" /> : <Link2 size={13} aria-hidden="true" />}<span>{actionLabel}</span></button>
    </div>;
  }

  return (
    <details className={`engine-tag-picker${compact ? " engine-tag-picker-compact" : ""}`}>
      {/* Native disclosure keeps keyboard activation and the existing editor owner. */}
      <summary className={`engine-tag-picker-title${compact ? " tooltip-wrapper" : ""}`}
        aria-label={compact ? label : undefined} data-tooltip={compact ? label : undefined}
        role={compact ? "button" : undefined}>
        {compact ? <><Tags size={15} aria-hidden="true" /><span>{owners.length}</span></>
          : <><span><Link2 size={15} aria-hidden="true" />{label}</span><span><small>{tr("engineTags.assignedCount", { count: assignedDefinitions.length })}</small><ChevronDown className="engine-tag-picker-chevron" size={14} aria-hidden="true" /></span></>}
      </summary>
      <div className="engine-tag-picker-content" aria-label={label}>
        {error ? <p className="engine-tag-picker-error" role="alert">{error}</p> : null}
        {notice ? <p className="engine-tag-picker-notice" role="status"><Check size={13} aria-hidden="true" />{notice}</p> : null}
        {!owners.length ? <p className="engine-tag-picker-empty">{tr("engineTags.noOwners")}</p> : null}
        {snapshot && owners.length ? <>
          {assignedDefinitions.length ? <div className="engine-tag-picker-options">{assignedDefinitions.map(definitionOption)}</div> : <p className="engine-tag-picker-empty">{tr("engineTags.noAssigned")}</p>}
          <button aria-expanded={catalogOpen} className="engine-tag-picker-add" disabled={busyId !== null} onClick={() => setCatalogOpen((open) => !open)} type="button"><Plus size={14} aria-hidden="true" />{tr("engineTags.addTag")}</button>
        </> : !snapshot ? <p className="engine-tag-picker-empty"><LoaderCircle className="animate-spin" size={14} aria-hidden="true" />{tr("engineTags.loading")}</p> : null}
        {catalogOpen ? <div className="engine-tag-picker-catalog">
          <div className="engine-tag-picker-tools">
            <label className="engine-tag-picker-search"><Search size={14} aria-hidden="true" /><input aria-label={tr("engineTags.search")} autoFocus onChange={(event) => setQuery(event.target.value)} placeholder={tr("engineTags.searchPlaceholder")} value={query} /></label>
            <button aria-label={tr("engineTags.autoCreate")} className="engine-tag-picker-create" disabled={!snapshot || !owners.length || busyId !== null} onClick={beginCreate} title={tr("engineTags.autoCreateHint")} type="button"><Plus size={14} aria-hidden="true" />{tr("engineTags.newTag")}</button>
          </div>
          {availableDefinitions.length ? <div className="engine-tag-picker-options">{availableDefinitions.map(definitionOption)}</div> : <p className="engine-tag-picker-empty">{tr("engineTags.noAvailable")}</p>}
        </div> : null}
        {creating || editingId ? <div className="engine-tag-picker-editor">
          <label>{tr("engineTags.key")}<input autoFocus onChange={(event) => setDraftKey(event.target.value)} value={draftKey} /></label>
          <label>{tr("engineTags.description")}<textarea onChange={(event) => setDraftDescription(event.target.value)} rows={2} value={draftDescription} /></label>
          {creating ? <small>{tr("engineTags.generatedFromMetadata")}</small> : null}
          <div className="engine-tag-picker-editor-actions">
            <button aria-label={tr("common.save")} className="engine-tag-picker-icon" disabled={!draftKey.trim() || busyId !== null} onClick={() => void saveEditor()} title={tr("common.save")} type="button">{busyId ? <LoaderCircle className="animate-spin" size={14} aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}</button>
            <button aria-label={tr("common.cancel")} className="engine-tag-picker-icon" disabled={busyId !== null} onClick={cancelEditor} title={tr("common.cancel")} type="button"><X size={14} aria-hidden="true" /></button>
          </div>
        </div> : null}
      </div>
    </details>
  );
}

/** Dedicated registry workspace for reviewed Engine Tag definitions and projections. */
import {
  Archive,
  Check,
  ChevronRight,
  FileSearch,
  Info,
  Link2,
  LoaderCircle,
  LocateFixed,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  Tags
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ENGINE_TAG_AUTHORING_TARGETS_V1 } from "@something-to-tell/contracts/engine-tags";
import type {
  EngineTagDefinitionV1,
  EngineTagIntegrityReportV1,
  EngineTagMutationCommandV1,
  EngineTagMutationResponseV1,
  EngineTagOwnerKindV1,
  EngineTagOwnerV1,
  EngineTagProjectionOmissionV1,
  EngineTagProjectionTargetV1,
  EngineTagProjectionV1
} from "@something-to-tell/contracts/engine-tags";
import { localizeRuntimeError, tr } from "../../localization/i18n";
import type { RuntimeEngineTagPersistence } from "../../runtime/apiTypes";
import { DialogShell } from "../shared/DialogShell";

export interface EngineTagsWorkspaceProps {
  persistence: RuntimeEngineTagPersistence;
  projectName: string;
  sessionId: string;
  onClose: () => void;
  onNavigateOwner?: (owner: EngineTagOwnerV1) => void;
}

const TARGETS: EngineTagProjectionTargetV1[] = ["generic", ...ENGINE_TAG_AUTHORING_TARGETS_V1];
const ALIAS_TARGETS = ENGINE_TAG_AUTHORING_TARGETS_V1;

function targetLabel(target: EngineTagProjectionTargetV1): string {
  return tr(`engineTags.target.${target}` as keyof typeof import("../../localization/catalogs").enCatalog);
}

function ownerLabel(owner: EngineTagOwnerKindV1): string {
  return tr(`engineTags.owner.${owner}` as keyof typeof import("../../localization/catalogs").enCatalog);
}

function omissionLabel(code: EngineTagProjectionOmissionV1["code"]): string {
  return tr(`engineTags.omission.${code}` as keyof typeof import("../../localization/catalogs").enCatalog);
}

function diagnosticLabel(messageKey: string): string {
  const suffix = messageKey.split(".").at(-1) ?? messageKey;
  return tr(`engineTags.projection.${suffix}` as keyof typeof import("../../localization/catalogs").enCatalog);
}

function integrityLabel(messageKey: string): string {
  return tr(messageKey.replace("engine_tags.", "engineTags.") as keyof typeof import("../../localization/catalogs").enCatalog);
}

function ownerIdentity(owner: EngineTagOwnerV1): string {
  return Object.entries(owner)
    .filter(([key, value]) => !["kind", "project_id"].includes(key) && typeof value === "string" && value)
    .map(([, value]) => value)
    .join("/");
}

/** Keeps mutation construction in one place so every write carries current optimistic identity. */
function commandFor(
  snapshot: EngineTagMutationResponseV1,
  action: EngineTagMutationCommandV1["action"],
  payload: Omit<EngineTagMutationCommandV1, "command_version" | "command_id" | "action" | "expected_source_checksum" | "expected_history_revision">
): EngineTagMutationCommandV1 {
  return {
    command_version: 1,
    command_id: `ui-${action}-${Date.now()}`,
    action,
    expected_source_checksum: snapshot.source_checksum,
    expected_history_revision: snapshot.history_revision,
    ...payload
  };
}

export function EngineTagsWorkspace({ persistence, projectName, sessionId, onClose, onNavigateOwner }: EngineTagsWorkspaceProps) {
  const [snapshot, setSnapshot] = useState<EngineTagMutationResponseV1 | null>(null);
  const [projection, setProjection] = useState<EngineTagProjectionV1 | null>(null);
  const [integrity, setIntegrity] = useState<EngineTagIntegrityReportV1 | null>(null);
  const [target, setTarget] = useState<EngineTagProjectionTargetV1>("generic");
  const [aliasTarget, setAliasTarget] = useState<Exclude<EngineTagProjectionTargetV1, "generic">>("ink");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "archived">("all");
  const [key, setKey] = useState("");
  const [description, setDescription] = useState("");
  const [alias, setAlias] = useState("");
  const [busy, setBusy] = useState<"loading" | "saving" | "previewing" | null>("loading");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void persistence.loadEngineTagRegistry(sessionId)
      .then((loaded) => {
        if (cancelled) return;
        setSnapshot(loaded);
        setSelectedId(loaded.catalog.definitions[0]?.id ?? null);
        return persistence.inspectEngineTagIntegrity(sessionId);
      })
      .then((report) => { if (!cancelled && report) setIntegrity(report); })
      .catch((reason: unknown) => { if (!cancelled) setError(localizeRuntimeError(reason)); })
      .finally(() => { if (!cancelled) setBusy(null); });
    return () => { cancelled = true; };
  }, [persistence, sessionId]);

  const definitions = snapshot?.catalog.definitions ?? [];
  const filteredDefinitions = useMemo(() => definitions.filter((definition) => {
    const text = `${definition.key} ${definition.description}`.toLocaleLowerCase();
    return (status === "all" || definition.status === status) && text.includes(query.trim().toLocaleLowerCase());
  }), [definitions, query, status]);
  const definitionGroups = useMemo(() => {
    const groups = new Map<string, EngineTagDefinitionV1[]>();
    [...filteredDefinitions].sort((left, right) => left.key.localeCompare(right.key)).forEach((definition) => {
      const root = definition.key.split(".")[0] ?? definition.key;
      groups.set(root, [...(groups.get(root) ?? []), definition]);
    });
    return [...groups.entries()];
  }, [filteredDefinitions]);
  const selected = definitions.find((definition) => definition.id === selectedId) ?? null;
  const selectedBindings = snapshot?.catalog.bindings.filter((binding) => binding.definition_id === selected?.id) ?? [];

  useEffect(() => {
    if (!selected) {
      setKey("");
      setDescription("");
      setAlias("");
      return;
    }
    setKey(selected.key);
    setDescription(selected.description);
    setAlias(selected.aliases.find((item) => item.target === aliasTarget)?.external_identifier ?? "");
  }, [aliasTarget, selected]);

  async function refreshProjection(nextTarget: EngineTagProjectionTargetV1 = target) {
    setBusy("previewing");
    try {
      setProjection(await persistence.previewEngineTagRegistry(sessionId, nextTarget));
    } catch (reason) {
      setError(localizeRuntimeError(reason));
    } finally {
      setBusy(null);
    }
  }

  async function refreshIntegrity() {
    setBusy("previewing");
    setError(null);
    try {
      setIntegrity(await persistence.inspectEngineTagIntegrity(sessionId));
    } catch (reason) {
      setError(localizeRuntimeError(reason));
    } finally {
      setBusy(null);
    }
  }

  async function apply(action: EngineTagMutationCommandV1["action"], payload: Parameters<typeof commandFor>[2]) {
    if (!snapshot) return;
    setBusy("saving");
    setError(null);
    setNotice(null);
    try {
      const updated = await persistence.applyEngineTagCommand(commandFor(snapshot, action, payload));
      setSnapshot(updated);
      setNotice(tr("engineTags.saved"));
      if (action === "create_definition") {
        setSelectedId(updated.catalog.definitions.find((definition) => definition.normalized_key === key.trim().toLocaleLowerCase())?.id ?? null);
        setCreating(false);
      }
      await refreshProjection(target);
    } catch (reason) {
      setError(localizeRuntimeError(reason));
    } finally {
      setBusy(null);
    }
  }

  function selectDefinition(definition: EngineTagDefinitionV1) {
    setCreating(false);
    setSelectedId(definition.id);
    setNotice(null);
  }

  function startCreating() {
    setCreating(true);
    setSelectedId(null);
    setKey("");
    setDescription("");
    setAlias("");
    setError(null);
    setNotice(null);
  }

  const busyLabel = busy === "loading" ? tr("engineTags.loading") : busy === "previewing" ? tr("engineTags.previewing") : tr("engineTags.saving");
  return (
    <DialogShell onClose={onClose} title={tr("engineTags.workspace")} wide>
      <div className="engine-tags-workspace" data-testid="engine-tags-workspace">
        <header className="engine-tags-header">
          <div>
            <span className="engine-tags-eyebrow"><Tags size={15} aria-hidden="true" />{tr("engineTags.registry")}</span>
            <h2>{projectName}</h2>
          </div>
        </header>
        {error ? <p className="engine-tags-feedback engine-tags-error" role="alert">{error}</p> : null}
        {notice ? <p className="engine-tags-feedback" role="status"><Check size={15} aria-hidden="true" />{notice}</p> : null}
        <details className="engine-tags-integrity">
          <summary className="engine-tags-integrity-title"><div><h3>{tr("engineTags.integrity")}</h3>{integrity ? <p>{tr("engineTags.integrityCounts", { errors: integrity.error_count, warnings: integrity.warning_count, info: integrity.info_count })}</p> : <p>{tr("engineTags.loading")}</p>}</div><ChevronRight size={16} aria-hidden="true" /></summary>
          <div className="engine-tags-integrity-body"><button className="engine-tags-action-button" disabled={busy !== null} onClick={() => void refreshIntegrity()} type="button"><ShieldCheck size={15} aria-hidden="true" />{tr("engineTags.integrityRefresh")}</button>{integrity?.findings.length ? <div className="engine-tags-integrity-findings">{integrity.findings.slice(0, 12).map((finding) => <button className={`engine-tags-integrity-finding severity-${finding.severity}`} key={`${finding.code}-${finding.definition_id ?? "none"}-${finding.binding_id ?? "none"}-${JSON.stringify(finding.details)}`} onClick={() => finding.definition_id && setSelectedId(finding.definition_id)} type="button"><strong>{integrityLabel(finding.message_key)}</strong><small>{finding.definition_id ?? finding.binding_id ?? finding.details.target ?? ""}</small></button>)}</div> : <p className="engine-tags-integrity-clean">{tr("engineTags.integrityCounts", { errors: 0, warnings: 0, info: 0 })}</p>}</div>
        </details>
        <div className="engine-tags-toolbar">
          <label className="engine-tags-search"><span>{tr("engineTags.search")}</span><input onChange={(event) => setQuery(event.target.value)} placeholder={tr("engineTags.searchPlaceholder")} value={query} /></label>
          <label><span>{tr("engineTags.status")}</span><select onChange={(event) => setStatus(event.target.value as typeof status)} value={status}><option value="all">{tr("engineTags.allStatuses")}</option><option value="active">{tr("engineTags.active")}</option><option value="archived">{tr("engineTags.archived")}</option></select></label>
          <button className="engine-tags-command engine-tags-command-secondary" onClick={startCreating} type="button"><Plus size={15} aria-hidden="true" />{tr("engineTags.create")}</button>
        </div>
        <div className="engine-tags-layout">
          <nav aria-label={tr("engineTags.definitions")} className="engine-tags-list">
            {busy === "loading" ? <p className="engine-tags-empty"><LoaderCircle className="animate-spin" size={16} aria-hidden="true" />{busyLabel}</p> : null}
            {!busy && filteredDefinitions.length === 0 ? <p className="engine-tags-empty">{tr("engineTags.empty")}</p> : null}
            {definitionGroups.map(([root, group]) => <section className="engine-tags-group" key={root}><h3>{root}<span>{group.length}</span></h3>{group.map((definition) => (
              <button className={`engine-tags-list-item ${definition.id === selected?.id ? "is-selected" : ""}`} key={definition.id} onClick={() => selectDefinition(definition)} style={{ paddingLeft: `${8 + Math.min(definition.key.split(".").length - 1, 4) * 8}px` }} type="button">
                <span><strong>{definition.key}</strong><small>{definition.description || tr("engineTags.noDescription")}</small></span>
                <span className={`engine-tags-status status-${definition.status}`}>{tr(`engineTags.${definition.status}` as "engineTags.active" | "engineTags.archived")}</span>
                <ChevronRight size={15} aria-hidden="true" />
              </button>
            ))}</section>)}
          </nav>
          <section aria-label={tr("engineTags.editor")} className="engine-tags-editor">
            {selected || creating ? (
              <>
                <div className="engine-tags-editor-title"><div><span className="engine-tags-eyebrow">{tr("engineTags.definition")}</span><h3 className="engine-tags-definition-key" title={creating ? tr("engineTags.newDefinition") : selected!.key}>{creating ? tr("engineTags.newDefinition") : selected!.key}</h3></div>{selected ? <span className={`engine-tags-status status-${selected.status}`}>{tr(`engineTags.${selected.status}` as "engineTags.active" | "engineTags.archived")}</span> : null}</div>
                <label><span>{tr("engineTags.key")}</span><input onChange={(event) => setKey(event.target.value)} value={key} /></label>
                <label><span>{tr("engineTags.description")}</span><textarea onChange={(event) => setDescription(event.target.value)} rows={4} value={description} /></label>
                <div className="engine-tags-editor-actions"><button className="engine-tags-command engine-tags-command-primary" disabled={busy !== null || !key.trim()} onClick={() => void apply(creating ? "create_definition" : "rename_definition", creating ? { key, description } : { definition_id: selected!.id, key, description })} type="button"><Save size={15} aria-hidden="true" />{creating ? tr("engineTags.create") : tr("engineTags.saveDefinition")}</button>{selected ? <button className="engine-tags-command engine-tags-command-secondary" disabled={busy !== null} onClick={() => void apply(selected.status === "active" ? "archive_definition" : "restore_definition", { definition_id: selected.id })} type="button">{selected.status === "active" ? <Archive size={15} aria-hidden="true" /> : <RotateCcw size={15} aria-hidden="true" />}{selected.status === "active" ? tr("engineTags.archive") : tr("engineTags.restore")}</button> : null}</div>
                {selected ? <><div className="engine-tags-alias"><h4>{tr("engineTags.targetAliases")}<span aria-label={tr("engineTags.targetAliasesHint")} className="tooltip-wrapper engine-tags-info" data-tooltip={tr("engineTags.targetAliasesHint")} tabIndex={0}><Info size={13} aria-hidden="true" /></span></h4><div className="engine-tags-alias-row"><select aria-label={tr("engineTags.aliasTarget")} onChange={(event) => setAliasTarget(event.target.value as typeof aliasTarget)} value={aliasTarget}>{ALIAS_TARGETS.map((item) => <option key={item} value={item}>{targetLabel(item)}</option>)}</select><input aria-label={tr("engineTags.externalIdentifier")} onChange={(event) => setAlias(event.target.value)} placeholder={tr("engineTags.externalIdentifier")} value={alias} /><span className="tooltip-wrapper" data-tooltip={tr("engineTags.saveAlias")}><button aria-label={tr("engineTags.saveAlias")} className="icon-button" disabled={busy !== null || !alias.trim()} onClick={() => void apply("set_alias", { definition_id: selected.id, alias: { tag_version: 1, target: aliasTarget, external_identifier: alias } })} type="button"><Save size={16} aria-hidden="true" /></button></span></div></div><div className="engine-tags-bindings"><h4><Link2 size={15} aria-hidden="true" />{tr("engineTags.bindings")} <span>{selectedBindings.length}</span></h4>{selectedBindings.length ? selectedBindings.map((binding) => <div className="engine-tags-binding" key={binding.id}><span>{ownerLabel(binding.owner.kind)}</span><code>{ownerIdentity(binding.owner)}</code>{onNavigateOwner ? <span className="tooltip-wrapper" data-tooltip={tr("engineTags.openOwner")}><button aria-label={tr("engineTags.openOwner")} className="engine-tags-owner-link" onClick={() => onNavigateOwner(binding.owner)} type="button"><LocateFixed size={14} aria-hidden="true" /></button></span> : null}</div>) : <p>{tr("engineTags.noBindings")}</p>}</div></> : null}
              </>
            ) : <p className="engine-tags-empty">{tr("engineTags.selectDefinition")}</p>}
          </section>
          <aside aria-label={tr("engineTags.preview")} className="engine-tags-preview"><div className="engine-tags-preview-title"><h3><FileSearch size={16} aria-hidden="true" />{tr("engineTags.preview")}<span aria-label={tr("engineTags.previewHint")} className="tooltip-wrapper engine-tags-info" data-tooltip={tr("engineTags.previewHint")} tabIndex={0}><Info size={13} aria-hidden="true" /></span></h3><select aria-label={tr("engineTags.previewTarget")} onChange={(event) => { const value = event.target.value as EngineTagProjectionTargetV1; setTarget(value); setProjection(null); }} value={target}>{TARGETS.map((item) => <option key={item} value={item}>{targetLabel(item)}</option>)}</select></div><button className="engine-tags-action-button" disabled={busy !== null || !snapshot} onClick={() => void refreshProjection()} type="button"><RefreshCw size={15} aria-hidden="true" />{busy === "previewing" ? busyLabel : tr("engineTags.refreshPreview")}</button>{projection ? <><p className="engine-tags-preview-count">{tr("engineTags.previewEntries", { count: projection.entries.length })}</p>{projection.diagnostics.map((diagnostic) => <p className="engine-tags-diagnostic" key={`${diagnostic.code}-${JSON.stringify(diagnostic.details)}`}>{diagnosticLabel(diagnostic.message_key)}</p>)}{projection.omitted.slice(0, 8).map((item) => <p className="engine-tags-omission" key={`${item.definition_id ?? item.binding_id}-${item.code}`}>{omissionLabel(item.code)}</p>)}</> : <p>{tr("engineTags.previewHint")}</p>}</aside>
        </div>
      </div>
    </DialogShell>
  );
}

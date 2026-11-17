/** Central project settings surface for reviewed, durable Agent Memory. */

import type {
  AgentMemoryAgentId,
  AgentMemoryDeletionImpactV1,
  AgentMemoryEntryV1,
  AgentMemoryLocale,
  AgentMemoryMutationCommandV1,
  AgentMemoryScopeV1,
  AgentMemoryStatus
} from "@something-to-tell/contracts/agent-memory";
import { Archive, Bot, Copy, Plus, RotateCcw, Save, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { i18next, localizeRuntimeError, tr } from "../../localization/i18n";
import type {
  AgentMemoryOwnerOption,
  AgentMemoryWorkspaceSnapshot,
  RuntimeAgentMemoryPersistence
} from "../../runtime/apiTypes";
import type { AgentMemoryDraftSeed } from "../../components/AgentMemoryDisclosure";
import { AgentMemoryCandidateReview } from "./AgentMemoryCandidateReview";

const AGENTS: AgentMemoryAgentId[] = ["canon_checker", "impact_resolver", "style_rewriter"];
const SCOPE_KINDS: AgentMemoryScopeV1["kind"][] = [
  "project", "scene", "node", "dialogue_field", "story_flow"
];

interface MemoryDraft {
  agent_id: AgentMemoryAgentId;
  scope: AgentMemoryScopeV1;
  content_locale: AgentMemoryLocale;
  title: string;
  instruction: string;
  rationale: string;
}

interface MemoryFilters {
  agent: "all" | AgentMemoryAgentId;
  scope: "all" | AgentMemoryScopeV1["kind"];
  locale: "all" | AgentMemoryLocale;
  status: "all" | AgentMemoryStatus;
  text: string;
}

const EMPTY_FILTERS: MemoryFilters = {
  agent: "all",
  scope: "all",
  locale: "all",
  status: "all",
  text: ""
};

/** Keeps manual memory commands separate from provider-generated candidate review. */
export function AgentMemoryManager({
  activeSessionId,
  contentLocale,
  initialDraft,
  persistence,
  projectId
}: {
  activeSessionId: string;
  contentLocale: AgentMemoryLocale;
  initialDraft?: AgentMemoryDraftSeed | null;
  persistence: RuntimeAgentMemoryPersistence;
  projectId: string;
}) {
  const [snapshot, setSnapshot] = useState<AgentMemoryWorkspaceSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<MemoryDraft | null>(null);
  const [baseline, setBaseline] = useState("");
  const [filters, setFilters] = useState<MemoryFilters>(EMPTY_FILTERS);
  const [ownerSearch, setOwnerSearch] = useState("");
  const [copyTarget, setCopyTarget] = useState<AgentMemoryAgentId>("impact_resolver");
  const [deletionImpact, setDeletionImpact] = useState<AgentMemoryDeletionImpactV1 | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidateOpen, setCandidateOpen] = useState(false);
  const appliedSeedRef = useRef<string | null>(null);
  const candidateButtonRef = useRef<HTMLButtonElement | null>(null);
  const entries = snapshot?.catalog.entries ?? [];
  const selected = entries.find((entry) => entry.id === selectedId) ?? null;
  const dirty = draft !== null && JSON.stringify(draft) !== baseline;

  async function reload(preferredId?: string | null) {
    const next = await persistence.loadAgentMemoryWorkspace(activeSessionId);
    setSnapshot(next);
    const nextId = preferredId === undefined
      ? selectedId ?? next.catalog.entries[0]?.id ?? null
      : preferredId;
    selectEntry(nextId, next, true);
    return next;
  }

  useEffect(() => {
    setBusy(true);
    void reload()
      .then((next) => {
        if (!initialDraft) return;
        const key = JSON.stringify(initialDraft);
        if (appliedSeedRef.current === key) return;
        appliedSeedRef.current = key;
        startCreate(initialDraft);
      })
      .catch((caught) => setError(localizeRuntimeError(caught)))
      .finally(() => setBusy(false));
  }, [activeSessionId]);

  function selectEntry(
    id: string | null,
    source = snapshot,
    force = false
  ) {
    if (!force && dirty && !window.confirm(tr("agentMemory.discardDraft"))) return;
    const entry = source?.catalog.entries.find((item) => item.id === id) ?? null;
    const nextDraft = entry ? entryDraft(entry) : null;
    setSelectedId(entry?.id ?? null);
    setDraft(nextDraft);
    setBaseline(nextDraft ? JSON.stringify(nextDraft) : "");
    setDeletionImpact(null);
    setCandidateOpen(false);
    setOwnerSearch("");
    if (entry) setCopyTarget(AGENTS.find((agent) => agent !== entry.agent_id) ?? "canon_checker");
  }

  function startCreate(seed?: AgentMemoryDraftSeed) {
    if (dirty && !window.confirm(tr("agentMemory.discardDraft"))) return;
    const next = seed ? {
      ...emptyDraft(seed.content_locale),
      agent_id: seed.agent_id,
      scope: seed.scope
    } : emptyDraft(contentLocale);
    setSelectedId(null);
    setDraft(next);
    setBaseline(JSON.stringify(next));
    setDeletionImpact(null);
    setCandidateOpen(false);
    setOwnerSearch("");
  }

  async function execute(
    action: AgentMemoryMutationCommandV1["action"],
    entry: AgentMemoryEntryV1 | null,
    impactFingerprint: string | null = null,
    preferredId: string | null | undefined = selectedId
  ) {
    if (!snapshot) return;
    setBusy(true);
    setError(null);
    try {
      await persistence.applyAgentMemoryCommand({
        command_version: 1,
        command_id: crypto.randomUUID(),
        action,
        memory_id: entry?.id ?? selectedId ?? "missing-memory",
        entry: action === "create" || action === "update" ? entry : null,
        expected_source_checksum: snapshot.source_checksum,
        expected_history_revision: snapshot.history_revision,
        reviewed_impact_fingerprint: impactFingerprint
      });
      await reload(preferredId);
    } catch (caught) {
      setError(localizeRuntimeError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft() {
    if (!draft || !draft.title.trim() || !draft.instruction.trim()) return;
    const now = new Date().toISOString();
    const entry: AgentMemoryEntryV1 = {
      memory_version: 1,
      id: selected?.id ?? crypto.randomUUID(),
      project_id: projectId,
      agent_id: draft.agent_id,
      namespace: draft.agent_id,
      scope: draft.scope,
      content_locale: draft.content_locale,
      title: draft.title.trim(),
      instruction: draft.instruction.trim(),
      rationale: draft.rationale.trim() || null,
      status: selected?.status ?? "active",
      supersedes_id: selected?.supersedes_id ?? null,
      created_at: selected?.created_at ?? now,
      updated_at: now
    };
    await execute(selected ? "update" : "create", entry, null, entry.id);
  }

  async function copyToAgent() {
    if (!selected || copyTarget === selected.agent_id) return;
    const now = new Date().toISOString();
    const copy: AgentMemoryEntryV1 = {
      ...selected,
      id: crypto.randomUUID(),
      agent_id: copyTarget,
      namespace: copyTarget,
      title: tr("agentMemory.copyTitle", { title: selected.title }),
      status: "active",
      supersedes_id: null,
      created_at: now,
      updated_at: now
    };
    await execute("create", copy, null, copy.id);
  }

  async function reviewDeletion() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      setDeletionImpact(await persistence.inspectAgentMemoryDeletionImpact(
        activeSessionId,
        selected.id
      ));
    } catch (caught) {
      setError(localizeRuntimeError(caught));
    } finally {
      setBusy(false);
    }
  }

  const visibleEntries = useMemo(
    () => entries.filter((entry) => matchesFilters(entry, filters)),
    [entries, filters]
  );
  const ownerOptions = useMemo(
    () => filteredOwners(snapshot?.owners ?? [], draft?.scope.kind ?? "project", ownerSearch),
    [draft?.scope.kind, ownerSearch, snapshot?.owners]
  );
  const conflictIds = useMemo(() => potentialConflictIds(entries), [entries]);

  return (
    <section aria-label={tr("agentMemory.management")} className="space-y-3 border-t border-slate-200 pt-3">
      <div>
        <h3 className="text-sm font-semibold text-slate-800">{tr("agentMemory.management")}</h3>
        <p className="text-xs text-slate-500">{tr("agentMemory.managementDescription")}</p>
      </div>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
        <FilterSelect label={tr("agentMemory.filterAgent")} onChange={(agent) => setFilters({ ...filters, agent: agent as MemoryFilters["agent"] })} value={filters.agent} values={["all", ...AGENTS]} />
        <FilterSelect label={tr("agentMemory.filterScope")} onChange={(scope) => setFilters({ ...filters, scope: scope as MemoryFilters["scope"] })} value={filters.scope} values={["all", ...SCOPE_KINDS]} />
        <FilterSelect label={tr("agentMemory.filterLocale")} onChange={(locale) => setFilters({ ...filters, locale: locale as MemoryFilters["locale"] })} value={filters.locale} values={["all", "en", "ru"]} />
        <FilterSelect label={tr("agentMemory.filterStatus")} onChange={(status) => setFilters({ ...filters, status: status as MemoryFilters["status"] })} value={filters.status} values={["all", "active", "archived"]} />
        <label className="style-profile-field col-span-2 lg:col-span-1">{tr("common.search")}
          <input onChange={(event) => setFilters({ ...filters, text: event.target.value })} value={filters.text} />
        </label>
      </div>
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(13rem,0.75fr)_minmax(20rem,1.25fr)]">
        <div className="min-w-0 rounded-md border border-slate-200 p-2">
          <div className="mb-2 flex items-center justify-between">
            <strong className="text-xs text-slate-600">{tr("agentMemory.entries", { count: visibleEntries.length })}</strong>
            <button aria-label={tr("agentMemory.create")} className="icon-button" data-tooltip={tr("agentMemory.create")} onClick={() => startCreate()} type="button"><Plus aria-hidden="true" size={15} /></button>
          </div>
          <div className="max-h-80 space-y-1 overflow-y-auto">
            {visibleEntries.map((entry) => {
              const missingOwner = !hasOwner(snapshot?.owners ?? [], entry.scope);
              return (
                <button
                  className={`w-full rounded px-2 py-2 text-left ${selectedId === entry.id ? "bg-sky-50 text-sky-950" : "hover:bg-slate-50"}`}
                  key={entry.id}
                  onClick={() => selectEntry(entry.id)}
                  type="button"
                >
                  <span className="block truncate text-sm font-semibold">{entry.title}</span>
                  <span className="mt-0.5 flex flex-wrap gap-1 text-[11px] text-slate-500">
                    <span>{tr(`agentMemory.agent.${entry.agent_id}`)}</span>
                    <span>· {tr(`agentMemory.scope.${entry.scope.kind}`)}</span>
                    <span>· {entry.content_locale.toUpperCase()}</span>
                    {entry.status === "archived" ? <Badge text={tr("agentMemory.archived")} tone="neutral" /> : null}
                    {missingOwner ? <Badge text={tr("agentMemory.missingOwner")} tone="danger" /> : null}
                    {conflictIds.has(entry.id) ? <Badge text={tr("agentMemory.conflict")} tone="danger" /> : null}
                    {entry.supersedes_id ? <Badge text={tr("agentMemory.supersedes")} tone="info" /> : null}
                  </span>
                </button>
              );
            })}
            {!visibleEntries.length ? <p className="px-2 py-8 text-center text-xs text-slate-500">{tr(entries.length ? "agentMemory.noMatches" : "agentMemory.empty")}</p> : null}
          </div>
        </div>
        <div className="min-w-0">
          {draft ? (
            <div className="space-y-3" onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                event.preventDefault();
                void saveDraft();
              } else if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
                // Project Settings owns the outer form; a field Enter must not submit it.
                event.preventDefault();
              }
            }}>
              <MemoryFields allOwners={snapshot?.owners ?? []} draft={draft} onChange={setDraft} onOwnerSearch={setOwnerSearch} ownerOptions={ownerOptions} ownerSearch={ownerSearch} />
              <div className="flex flex-wrap items-center gap-2">
                <button className={`inline-flex items-center gap-2 rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50 ${dirty ? "animate-pulse" : ""}`} disabled={busy || !draft.title.trim() || !draft.instruction.trim()} onClick={() => void saveDraft()} type="button"><Save aria-hidden="true" size={15} />{tr("common.save")}</button>
                <button aria-label={tr("agentMemory.suggestCandidate")} className="icon-button" data-tooltip={tr("agentMemory.suggestCandidate")} disabled={busy} onClick={() => setCandidateOpen(true)} ref={candidateButtonRef} type="button"><Bot aria-hidden="true" size={15} /></button>
                {selected ? (
                  <>
                    <select aria-label={tr("agentMemory.copyTarget")} className="rounded-md border border-slate-300 bg-white px-2 py-2 text-sm" onChange={(event) => setCopyTarget(event.target.value as AgentMemoryAgentId)} value={copyTarget}>
                      {AGENTS.filter((agent) => agent !== selected.agent_id).map((agent) => <option key={agent} value={agent}>{tr(`agentMemory.agent.${agent}`)}</option>)}
                    </select>
                    <button aria-label={tr("agentMemory.copyToAgent")} className="icon-button" data-tooltip={tr("agentMemory.copyToAgent")} disabled={busy} onClick={() => void copyToAgent()} type="button"><Copy aria-hidden="true" size={15} /></button>
                    <button aria-label={tr(selected.status === "active" ? "agentMemory.archive" : "agentMemory.restore")} className="icon-button" data-tooltip={tr(selected.status === "active" ? "agentMemory.archive" : "agentMemory.restore")} disabled={busy} onClick={() => void execute(selected.status === "active" ? "archive" : "restore", selected)} type="button">{selected.status === "active" ? <Archive aria-hidden="true" size={15} /> : <RotateCcw aria-hidden="true" size={15} />}</button>
                    <button aria-label={tr("agentMemory.delete")} className="icon-button text-red-700" data-tooltip={tr("agentMemory.delete")} disabled={busy} onClick={() => void reviewDeletion()} type="button"><Trash2 aria-hidden="true" size={15} /></button>
                  </>
                ) : null}
              </div>
              {candidateOpen && snapshot ? <AgentMemoryCandidateReview
                activeSessionId={activeSessionId}
                historyRevision={snapshot.history_revision}
                identity={{ agent_id: draft.agent_id, content_locale: draft.content_locale, scope: draft.scope }}
                onAccepted={async () => { await reload(null); }}
                onClose={() => {
                  setCandidateOpen(false);
                  window.requestAnimationFrame(() => candidateButtonRef.current?.focus());
                }}
                persistence={persistence}
                projectId={projectId}
                sourceChecksum={snapshot.source_checksum}
                supersedesId={selected && sameIdentity(selected, draft) ? selected.id : null}
              /> : null}
            </div>
          ) : <p className="py-12 text-center text-sm text-slate-500">{tr("agentMemory.selectEntry")}</p>}
        </div>
      </div>
      {deletionImpact && selected ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm" role="alertdialog" aria-label={tr("agentMemory.deleteReviewTitle")}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <strong>{tr("agentMemory.deleteReviewTitle")}</strong>
              <p className="mt-1 text-xs text-slate-700">{tr("agentMemory.deleteReviewDescription", { count: deletionImpact.direct_successor_ids.length })}</p>
              {deletionImpact.direct_successor_ids.length ? <p className="mt-1 text-xs text-slate-600">{tr("agentMemory.rebaseSuccessors", { titles: successorTitles(entries, deletionImpact).join(", ") })}</p> : null}
            </div>
            <button aria-label={tr("common.cancel")} className="icon-button" data-tooltip={tr("common.cancel")} onClick={() => setDeletionImpact(null)} type="button"><X aria-hidden="true" size={15} /></button>
          </div>
          <button className="mt-3 rounded-md bg-red-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={busy} onClick={() => void execute("delete", selected, deletionImpact.impact_fingerprint, null)} type="button">{tr("common.delete")}</button>
        </div>
      ) : null}
      {busy ? <p aria-live="polite" className="text-xs text-slate-500">{tr("agentMemory.busy")}</p> : null}
      {error ? <p className="text-sm text-red-700" role="alert">{error}</p> : null}
    </section>
  );
}

function MemoryFields({
  allOwners,
  draft,
  onChange,
  onOwnerSearch,
  ownerOptions,
  ownerSearch
}: {
  allOwners: AgentMemoryOwnerOption[];
  draft: MemoryDraft;
  onChange: (draft: MemoryDraft) => void;
  onOwnerSearch: (value: string) => void;
  ownerOptions: AgentMemoryOwnerOption[];
  ownerSearch: string;
}) {
  const selectedOwner = ownerOptions.find((option) => scopeKey(option.scope) === scopeKey(draft.scope));
  return (
    <div className="grid grid-cols-2 gap-3">
      <label className="style-profile-field">{tr("agentMemory.agentLabel")}
        <select onChange={(event) => onChange({ ...draft, agent_id: event.target.value as AgentMemoryAgentId })} value={draft.agent_id}>{AGENTS.map((agent) => <option key={agent} value={agent}>{tr(`agentMemory.agent.${agent}`)}</option>)}</select>
      </label>
      <label className="style-profile-field">{tr("agentMemory.locale")}
        <select onChange={(event) => onChange({ ...draft, content_locale: event.target.value as AgentMemoryLocale })} value={draft.content_locale}><option value="en">{tr("locale.english")}</option><option value="ru">{tr("locale.russian")}</option></select>
      </label>
      <label className="style-profile-field">{tr("agentMemory.scopeLabel")}
        <select onChange={(event) => {
          const kind = event.target.value as AgentMemoryScopeV1["kind"];
          const first = filteredOwners(allOwners, kind, "")[0];
          if (first) onChange({ ...draft, scope: first.scope });
        }} value={draft.scope.kind}>{SCOPE_KINDS.map((kind) => <option key={kind} value={kind}>{tr(`agentMemory.scope.${kind}`)}</option>)}</select>
      </label>
      {draft.scope.kind !== "project" ? <label className="style-profile-field">{tr("agentMemory.ownerSearch")}<input onChange={(event) => onOwnerSearch(event.target.value)} value={ownerSearch} /></label> : <div />}
      {draft.scope.kind !== "project" ? <label className="style-profile-field col-span-2">{tr("agentMemory.owner")}
        <select onChange={(event) => {
          const option = ownerOptions.find((item) => scopeKey(item.scope) === event.target.value);
          if (option) onChange({ ...draft, scope: option.scope });
        }} value={selectedOwner ? scopeKey(selectedOwner.scope) : scopeKey(draft.scope)}>
          {!selectedOwner ? <option value={scopeKey(draft.scope)}>{tr("agentMemory.missingOwner")}</option> : null}
          {ownerOptions.map((option) => <option key={scopeKey(option.scope)} value={scopeKey(option.scope)}>{option.label}</option>)}
        </select>
      </label> : null}
      <label className="style-profile-field col-span-2">{tr("agentMemory.title")}<input autoFocus onChange={(event) => onChange({ ...draft, title: event.target.value })} value={draft.title} /></label>
      <label className="style-profile-field col-span-2">{tr("agentMemory.instruction")}<textarea className="min-h-24" onChange={(event) => onChange({ ...draft, instruction: event.target.value })} value={draft.instruction} /></label>
      <label className="style-profile-field col-span-2">{tr("agentMemory.rationale")}<textarea className="min-h-16" onChange={(event) => onChange({ ...draft, rationale: event.target.value })} value={draft.rationale} /></label>
    </div>
  );
}

function FilterSelect({ label, onChange, value, values }: { label: string; onChange: (value: string) => void; value: string; values: string[] }) {
  return <label className="style-profile-field">{label}<select onChange={(event) => onChange(event.target.value)} value={value}>{values.map((item) => <option key={item} value={item}>{item === "all" ? tr("agentMemory.all") : i18next.t(`agentMemory.value.${item}`)}</option>)}</select></label>;
}

function Badge({ text, tone }: { text: string; tone: "danger" | "info" | "neutral" }) {
  const colors = tone === "danger" ? "bg-red-100 text-red-700" : tone === "info" ? "bg-sky-100 text-sky-700" : "bg-slate-100 text-slate-600";
  return <span className={`rounded px-1 ${colors}`}>{text}</span>;
}

function emptyDraft(locale: AgentMemoryLocale): MemoryDraft {
  return {
    agent_id: "canon_checker",
    scope: { scope_version: 1, kind: "project" },
    content_locale: locale,
    title: "",
    instruction: "",
    rationale: ""
  };
}

function entryDraft(entry: AgentMemoryEntryV1): MemoryDraft {
  return {
    agent_id: entry.agent_id,
    scope: entry.scope,
    content_locale: entry.content_locale,
    title: entry.title,
    instruction: entry.instruction,
    rationale: entry.rationale ?? ""
  };
}

function sameIdentity(entry: AgentMemoryEntryV1, draft: MemoryDraft): boolean {
  return entry.agent_id === draft.agent_id
    && entry.content_locale === draft.content_locale
    && scopeKey(entry.scope) === scopeKey(draft.scope);
}

function matchesFilters(entry: AgentMemoryEntryV1, filters: MemoryFilters): boolean {
  const text = filters.text.trim().toLocaleLowerCase();
  return (filters.agent === "all" || entry.agent_id === filters.agent)
    && (filters.scope === "all" || entry.scope.kind === filters.scope)
    && (filters.locale === "all" || entry.content_locale === filters.locale)
    && (filters.status === "all" || entry.status === filters.status)
    && (!text || `${entry.title} ${entry.instruction} ${entry.rationale ?? ""}`.toLocaleLowerCase().includes(text));
}

function filteredOwners(
  owners: AgentMemoryOwnerOption[],
  kind: AgentMemoryScopeV1["kind"],
  search: string
): AgentMemoryOwnerOption[] {
  const query = search.trim().toLocaleLowerCase();
  return owners.filter((option) => option.scope.kind === kind && (!query || option.search_text.includes(query)));
}

function scopeKey(scope: AgentMemoryScopeV1): string {
  return JSON.stringify(scope);
}

function hasOwner(owners: AgentMemoryOwnerOption[], scope: AgentMemoryScopeV1): boolean {
  return owners.some((option) => scopeKey(option.scope) === scopeKey(scope));
}

function potentialConflictIds(entries: AgentMemoryEntryV1[]): Set<string> {
  const conflicts = new Set<string>();
  for (const entry of entries) {
    if (entry.status !== "active") continue;
    for (const other of entries) {
      if (other.id === entry.id || other.status !== "active") continue;
      const canOverlap = entry.scope.kind === "project" || other.scope.kind === "project" || scopeKey(entry.scope) === scopeKey(other.scope);
      if (canOverlap && entry.agent_id === other.agent_id && entry.content_locale === other.content_locale && entry.title.trim().toLocaleLowerCase() === other.title.trim().toLocaleLowerCase() && entry.instruction.trim().toLocaleLowerCase() !== other.instruction.trim().toLocaleLowerCase()) {
        conflicts.add(entry.id);
        conflicts.add(other.id);
      }
    }
  }
  return conflicts;
}

function successorTitles(entries: AgentMemoryEntryV1[], impact: AgentMemoryDeletionImpactV1): string[] {
  return impact.direct_successor_ids.map((id) => entries.find((entry) => entry.id === id)?.title ?? id);
}

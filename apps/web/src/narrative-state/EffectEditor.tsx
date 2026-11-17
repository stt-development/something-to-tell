import type { NarrativeEffectDefinition, NarrativeEffectOwnerRef, StateHolderRef } from "@something-to-tell/contracts/narrative-state";
import type { Node } from "@xyflow/react";
import { ArrowDown, ArrowUp, ChevronDown, GitCompareArrows, Pencil, Plus, Save, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CanonDiagnosticMarker, canonFocusMatches, type CanonDiagnosticFocus } from "../canon/CanonDiagnosticMarker";
import { localizeRuntimeError, tr } from "../localization/i18n";
import type { StoryFlowSnapshot } from "../story-flow/contracts";
import type { NarrativeEdgeData, NarrativeNodeData } from "../types";
import type { RuntimeNarrativeStatePersistence, NarrativeStateSnapshot } from "./contracts";
import {
  domainDraftFromEffect,
  effectFromDomainDraft,
  effectsForOwner,
  moveEffectBinding,
  type DomainEffectAction,
  type DomainEffectDraft
} from "./editor";

interface SelectOption {
  id: string;
  label: string;
  detail?: string;
}

/** Searchable keyboard selector shared by Item, holder, Quest, and Dialogue controls. */
export function SearchableEntitySelect({ label, onChange, options, value }: {
  label: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  value: string;
}) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const filtered = options.filter((option) => `${option.label} ${option.detail ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selected = options.find((option) => option.id === value);

  function close() {
    setOpen(false);
    setQuery("");
    queueMicrotask(() => buttonRef.current?.focus());
  }

  function choose(id: string) {
    onChange(id);
    close();
  }

  return (
    <div className="relative">
      <span className="mb-1 block text-xs font-semibold text-slate-600">{label}</span>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex h-10 w-full items-center justify-between gap-2 rounded-md border border-slate-300 bg-white px-3 text-left text-sm"
        onClick={() => setOpen((current) => !current)}
        ref={buttonRef}
        type="button"
      >
        <span className="truncate">{selected?.label ?? tr("narrativeState.selectEntity")}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {open ? (
        <div className="absolute z-[120] mt-1 w-full rounded-md border border-slate-300 bg-white p-2 shadow-xl">
          <input
            aria-label={tr("narrativeState.searchEntities")}
            autoFocus
            className="h-9 w-full rounded border border-slate-300 px-2 text-sm"
            onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
            onKeyDown={(event) => {
              if (event.key === "Escape") close();
              if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((index) => Math.min(filtered.length - 1, index + 1)); }
              if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((index) => Math.max(0, index - 1)); }
              if (event.key === "Enter" && filtered[activeIndex]) { event.preventDefault(); choose(filtered[activeIndex]!.id); }
            }}
            placeholder={tr("common.search")}
            role="combobox"
            value={query}
          />
          <div className="mt-1 max-h-44 overflow-y-auto" role="listbox">
            {filtered.map((option, index) => (
              <button
                aria-selected={option.id === value}
                className={`block w-full rounded px-2 py-1.5 text-left text-sm ${index === activeIndex ? "bg-slate-100" : ""}`}
                key={option.id}
                onClick={() => choose(option.id)}
                onMouseEnter={() => setActiveIndex(index)}
                role="option"
                type="button"
              >
                <strong className="block font-medium text-slate-800">{option.label}</strong>
                {option.detail ? <small className="block truncate text-slate-500">{option.detail}</small> : null}
              </button>
            ))}
            {!filtered.length ? <p className="px-2 py-3 text-center text-xs text-slate-500">{tr("narrativeState.noEntities")}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Collapsible domain editor; raw effect payloads never become the authoring surface. */
export function NarrativeEffectEditor({ canonFocus, nodes, onSnapshot, owner, persistence, projectId }: {
  canonFocus?: CanonDiagnosticFocus | null;
  nodes: Node<NarrativeNodeData>[];
  onSnapshot?: (snapshot: NarrativeStateSnapshot) => void;
  owner: NarrativeEffectOwnerRef;
  persistence: RuntimeNarrativeStatePersistence;
  projectId: string;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const canonicalNodes = useMemo(() => nodes.filter((node) => !node.data.isLinkedInstance), [nodes]);
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<NarrativeStateSnapshot | null>(null);
  const [draft, setDraft] = useState(() => emptyDraft(canonicalNodes, owner));
  const [editingEffectId, setEditingEffectId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const focusedOwnerId = canonFocus?.owner.owner_id ?? null;
  const rows = snapshot ? effectsForOwner(owner, snapshot.bindings, snapshot.effects) : [];

  useEffect(() => {
    if (focusedOwnerId) setOpen(true);
  }, [focusedOwnerId]);

  async function reload() {
    const loaded = await persistence.getNarrativeStateSnapshot(projectId);
    setSnapshot(loaded);
    onSnapshot?.(loaded);
  }

  useEffect(() => {
    if (!open) return;
    setError(null);
    void reload().catch((caught) => setError(localizeRuntimeError(caught, "narrativeState.loadFailed")));
  }, [open, projectId]);

  function close() {
    setOpen(false);
    setEditingEffectId(null);
    queueMicrotask(() => triggerRef.current?.focus());
  }

  async function saveEffect() {
    if (!validDraft(draft) || busy) return;
    setBusy(true);
    setError(null);
    const effectId = editingEffectId ?? `effect-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
    const effect = effectFromDomainDraft(draft, projectId, effectId);
    try {
      if (editingEffectId) {
        await persistence.updateNarrativeEffect(projectId, effect);
      } else {
        await persistence.createNarrativeEffect(projectId, effect);
        try {
          await persistence.createNarrativeEffectBinding(projectId, effect.id, owner, rows.length);
        } catch (caught) {
          // A failed attachment must not leave a hidden unbound definition behind.
          await persistence.deleteNarrativeEffect(projectId, effect.id, true).catch(() => undefined);
          throw caught;
        }
      }
      await reload();
      setDraft(emptyDraft(canonicalNodes, owner));
      setEditingEffectId(null);
    } catch (caught) {
      setError(localizeRuntimeError(caught, "narrativeState.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function removeEffect(bindingId: string, effectId: string) {
    if (!snapshot || busy) return;
    setBusy(true);
    setError(null);
    try {
      const shared = snapshot.bindings.filter((binding) => binding.effect_id === effectId).length > 1;
      await persistence.deleteNarrativeEffectBinding(projectId, bindingId);
      const remaining = rows.filter((row) => row.binding.id !== bindingId).map((row) => row.binding);
      if (remaining.length) {
        // Deletion closes the owner-local order gap before another effect can be appended.
        await persistence.reorderNarrativeEffectBindings(projectId, owner, remaining.map((binding, application_order) => ({
          binding_id: binding.id,
          application_order
        })));
      }
      if (!shared) await persistence.deleteNarrativeEffect(projectId, effectId, true);
      await reload();
    } catch (caught) {
      setError(localizeRuntimeError(caught, "narrativeState.deleteFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function move(bindingId: string, direction: -1 | 1) {
    if (!snapshot || busy) return;
    const bindings = rows.map((row) => row.binding);
    setBusy(true);
    try {
      await persistence.reorderNarrativeEffectBindings(projectId, owner, moveEffectBinding(bindings, bindingId, direction));
      await reload();
    } catch (caught) {
      setError(localizeRuntimeError(caught, "narrativeState.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border-t border-slate-200 pt-3">
      <span className="tooltip-wrapper" data-tooltip={tr("narrativeState.effectsTooltip")}>
        <button
          aria-expanded={open}
          className="inline-flex items-center gap-2 rounded-md border border-teal-300 bg-white px-3 py-2 text-sm font-semibold text-teal-800"
          onClick={() => open ? close() : setOpen(true)}
          ref={triggerRef}
          type="button"
        >
          <GitCompareArrows size={15} aria-hidden="true" />
          {tr("narrativeState.effects")}{snapshot && !open ? ` (${rows.length})` : ""}
        </button>
      </span>
      {open ? (
        <div className="mt-3 space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3">
          <div className="flex items-center justify-between gap-2">
            <div><strong className="text-sm text-slate-800">{tr("narrativeState.effectsAtStep")}</strong><p className="text-xs text-slate-500">{tr("narrativeState.effectsHint")}</p></div>
            <span className="tooltip-wrapper" data-tooltip={tr("narrativeState.closeEffects")}><button aria-label={tr("narrativeState.closeEffects")} className="icon-button" onClick={close} type="button"><X size={15} aria-hidden="true" /></button></span>
          </div>
          {rows.map(({ binding, effect }, index) => {
            const focused = canonFocusMatches(canonFocus ?? null, effect.id) || canonFocusMatches(canonFocus ?? null, binding.id);
            const ownerId = canonFocusMatches(canonFocus ?? null, binding.id) ? binding.id : effect.id;
            return (
            <div className={`flex items-start gap-2 rounded border border-slate-200 bg-white p-2 ${focused ? "canon-specialized-owner-target" : ""}`} data-canon-issue-target={focused || undefined} data-canon-owner-id={ownerId} key={binding.id} tabIndex={-1}>
              {focused ? <CanonDiagnosticMarker focus={canonFocus!} /> : null}
              <div className="min-w-0 flex-1"><strong className="block truncate text-sm text-slate-800">{effectTitle(effect, canonicalNodes)}</strong><p className="truncate text-xs text-slate-500">{effect.explanation}</p></div>
              <span className="tooltip-wrapper" data-tooltip={tr("narrativeState.moveEarlier")}><button aria-label={tr("narrativeState.moveEarlier")} className="icon-button" disabled={busy || index === 0} onClick={() => void move(binding.id, -1)} type="button"><ArrowUp size={14} aria-hidden="true" /></button></span>
              <span className="tooltip-wrapper" data-tooltip={tr("common.edit")}><button aria-label={tr("common.edit")} className="icon-button" disabled={busy} onClick={() => { setEditingEffectId(effect.id); setDraft(domainDraftFromEffect(effect)); }} type="button"><Pencil size={14} aria-hidden="true" /></button></span>
              <span className="tooltip-wrapper" data-tooltip={tr("common.delete")}><button aria-label={tr("common.delete")} className="icon-button text-rose-700" disabled={busy} onClick={() => void removeEffect(binding.id, effect.id)} type="button"><Trash2 size={14} aria-hidden="true" /></button></span>
              <span className="tooltip-wrapper" data-tooltip={tr("narrativeState.moveLater")}><button aria-label={tr("narrativeState.moveLater")} className="icon-button" disabled={busy || index === rows.length - 1} onClick={() => void move(binding.id, 1)} type="button"><ArrowDown size={14} aria-hidden="true" /></button></span>
            </div>
            );
          })}
          {!snapshot ? <p className="text-xs text-slate-500" role="status">{tr("narrativeState.loading")}</p> : null}
          {snapshot && !rows.length ? <p className="text-xs text-slate-500">{tr("narrativeState.noEffects")}</p> : null}
          <EffectDraftFields draft={draft} nodes={canonicalNodes} onChange={setDraft} snapshot={snapshot} />
          {error ? <p className="text-sm font-semibold text-rose-700" role="alert">{error}</p> : null}
          <div className="flex justify-end gap-2">
            {editingEffectId ? <button className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold" onClick={() => { setEditingEffectId(null); setDraft(emptyDraft(canonicalNodes, owner)); }} type="button">{tr("common.cancel")}</button> : null}
            <button className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={busy || !validDraft(draft)} onClick={() => void saveEffect()} type="button">{editingEffectId ? <Save size={15} aria-hidden="true" /> : <Plus size={15} aria-hidden="true" />}{tr(editingEffectId ? "common.save" : "narrativeState.addEffect")}</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function EffectDraftFields({ draft, nodes, onChange, snapshot }: { draft: DomainEffectDraft; nodes: Node<NarrativeNodeData>[]; onChange: (draft: DomainEffectDraft) => void; snapshot: NarrativeStateSnapshot | null }) {
  const options = (kind: NarrativeNodeData["kind"]): SelectOption[] => nodes.filter((node) => node.data.kind === kind).map((node) => ({ id: canonicalId(node), label: node.data.title, detail: node.data.summary }));
  const holderOptions: SelectOption[] = [
    { id: "player", label: tr("narrativeState.player") },
    { id: "party", label: tr("narrativeState.party") },
    { id: "unowned", label: tr("narrativeState.unowned") },
    ...nodes.filter((node) => ["Character", "Location", "Faction"].includes(node.data.kind)).map((node) => ({ id: `${node.data.kind.toLocaleLowerCase()}:${canonicalId(node)}`, label: node.data.title, detail: node.data.kind }))
  ];
  const flags = Array.from(new Set([
    ...(snapshot?.initial_states.flatMap((state) => Object.keys(state.flags)) ?? []),
    ...(snapshot?.effects.flatMap((effect) => effect.operation === "set_flag" || effect.operation === "clear_flag" ? [effect.payload.flag] : []) ?? [])
  ])).sort();
  const itemAction = ["give_item", "take_item", "move_item"].includes(draft.action);

  return (
    <div className="grid gap-3 border-t border-slate-200 pt-3 sm:grid-cols-2">
      <label className="block text-xs font-semibold text-slate-600 sm:col-span-2">{tr("narrativeState.action")}<select className="mt-1 h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm" onChange={(event) => onChange(actionDraft(draft, event.target.value as DomainEffectAction, nodes))} value={draft.action}><option value="give_item">{tr("narrativeState.giveItem")}</option><option value="take_item">{tr("narrativeState.takeItem")}</option><option value="move_item">{tr("narrativeState.moveItem")}</option><option value="set_flag">{tr("narrativeState.setFlag")}</option><option value="clear_flag">{tr("narrativeState.clearFlag")}</option><option value="update_quest">{tr("narrativeState.updateQuest")}</option><option value="record_choice">{tr("narrativeState.recordChoice")}</option></select></label>
      {itemAction ? <><SearchableEntitySelect label={tr("narrativeState.item")} onChange={(itemNodeId) => onChange({ ...draft, itemNodeId })} options={options("Item")} value={draft.itemNodeId} /><SearchableEntitySelect label={tr("narrativeState.fromHolder")} onChange={(value) => onChange({ ...draft, fromHolder: decodeHolder(value) })} options={holderOptions} value={encodeHolder(draft.fromHolder)} /><SearchableEntitySelect label={tr("narrativeState.toHolder")} onChange={(value) => onChange({ ...draft, toHolder: decodeHolder(value) })} options={holderOptions} value={encodeHolder(draft.toHolder)} /></> : null}
      {draft.action === "set_flag" || draft.action === "clear_flag" ? <label className="block text-xs font-semibold text-slate-600 sm:col-span-2">{tr("narrativeState.flag")}<input className="mt-1 h-10 w-full rounded-md border border-slate-300 px-3 text-sm" list="narrative-state-flags" onChange={(event) => onChange({ ...draft, flag: event.target.value })} value={draft.flag} /><datalist id="narrative-state-flags">{flags.map((flag) => <option key={flag} value={flag} />)}</datalist></label> : null}
      {draft.action === "update_quest" ? <><SearchableEntitySelect label={tr("narrativeState.quest")} onChange={(questNodeId) => onChange({ ...draft, questNodeId })} options={options("Quest")} value={draft.questNodeId} /><label className="block text-xs font-semibold text-slate-600">{tr("narrativeState.questStatus")}<select className="mt-1 h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm" onChange={(event) => onChange({ ...draft, questStatus: event.target.value as DomainEffectDraft["questStatus"] })} value={draft.questStatus}>{(["inactive", "active", "completed", "failed"] as const).map((status) => <option key={status} value={status}>{questStatusLabel(status)}</option>)}</select></label></> : null}
      {draft.action === "record_choice" ? <><SearchableEntitySelect label={tr("narrativeState.dialogue")} onChange={(dialogueNodeId) => onChange({ ...draft, dialogueNodeId })} options={options("Dialogue")} value={draft.dialogueNodeId} /><label className="block text-xs font-semibold text-slate-600">{tr("narrativeState.choiceId")}<input className="mt-1 h-10 w-full rounded-md border border-slate-300 px-3 text-sm" onChange={(event) => onChange({ ...draft, choiceId: event.target.value })} value={draft.choiceId} /></label></> : null}
      <label className="block text-xs font-semibold text-slate-600 sm:col-span-2">{tr("narrativeState.explanation")}<textarea className="mt-1 min-h-16 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" onChange={(event) => onChange({ ...draft, explanation: event.target.value })} value={draft.explanation} /></label>
      <label className="flex items-center gap-2 text-xs font-semibold text-slate-600 sm:col-span-2"><input checked={draft.repeatPolicy === "per_visit"} onChange={(event) => onChange({ ...draft, repeatPolicy: event.target.checked ? "per_visit" : "once" })} type="checkbox" />{tr("narrativeState.repeatPerVisit")}</label>
    </div>
  );
}

/** Explicit review control keeps semantic ownership and initial custody independent. */
export function RelationshipInitialHolderControl({ edge, flows, persistence, projectId }: { edge: { id: string; data?: NarrativeEdgeData }; flows: StoryFlowSnapshot[]; persistence: RuntimeNarrativeStatePersistence; projectId: string }) {
  const [flowId, setFlowId] = useState(flows[0]?.flow.id ?? "");
  const [previewed, setPreviewed] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!flows.length) return null;
  async function preview() {
    setBusy(true);
    try {
      const preview = await persistence.previewRelationshipInitialState(projectId, edge.id, flowId);
      setPreviewed(!preview.conflict_holder);
      setStatus(preview.conflict_holder ? tr("narrativeState.initialHolderConflict") : preview.already_applied ? tr("narrativeState.initialHolderAlreadySet") : tr("narrativeState.initialHolderPreview"));
    } catch (caught) { setStatus(localizeRuntimeError(caught, "narrativeState.saveFailed")); }
    finally { setBusy(false); }
  }
  async function apply() {
    setBusy(true);
    try {
      const result = await persistence.applyRelationshipInitialState(projectId, edge.id, flowId);
      setPreviewed(false);
      setStatus(tr(result.changed ? "narrativeState.initialHolderApplied" : "narrativeState.initialHolderAlreadySet"));
    } catch (caught) { setStatus(localizeRuntimeError(caught, "narrativeState.saveFailed")); }
    finally { setBusy(false); }
  }
  return <section className="border-t border-slate-200 pt-3"><strong className="block text-sm text-slate-800">{tr("narrativeState.initialHolder")}</strong><p className="mb-2 text-xs text-slate-500">{tr("narrativeState.initialHolderHint")}</p><div className="flex gap-2"><select className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" onChange={(event) => { setFlowId(event.target.value); setPreviewed(false); }} value={flowId}>{flows.map((flow) => <option key={flow.flow.id} value={flow.flow.id}>{flow.flow.name}</option>)}</select><button className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold" disabled={busy} onClick={() => void preview()} type="button">{tr("narrativeState.preview")}</button>{previewed ? <button className="rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white" disabled={busy} onClick={() => void apply()} type="button">{tr("common.accept")}</button> : null}</div>{status ? <p aria-live="polite" className="mt-2 text-xs text-slate-600">{status}</p> : null}</section>;
}

function emptyDraft(nodes: Node<NarrativeNodeData>[], owner: NarrativeEffectOwnerRef): DomainEffectDraft {
  const dialogueContext = owner.owner_kind === "dialogue_element" || owner.owner_kind === "dialogue_option" ? owner.context_node_id : nodes.find((node) => node.data.kind === "Dialogue") ? canonicalId(nodes.find((node) => node.data.kind === "Dialogue")!) : "";
  return { action: "move_item", itemNodeId: canonicalId(nodes.find((node) => node.data.kind === "Item")), fromHolder: { holder_version: 1, kind: "unowned" }, toHolder: { holder_version: 1, kind: "player" }, flag: "", questNodeId: canonicalId(nodes.find((node) => node.data.kind === "Quest")), questStatus: "active", dialogueNodeId: dialogueContext, choiceId: owner.owner_kind === "dialogue_option" ? owner.owner_id : "", repeatPolicy: "once", explanation: "" };
}

function actionDraft(draft: DomainEffectDraft, action: DomainEffectAction, nodes: Node<NarrativeNodeData>[]): DomainEffectDraft {
  const character = nodes.find((node) => node.data.kind === "Character");
  const holder: StateHolderRef = character ? { holder_version: 1, kind: "character", node_id: canonicalId(character) } : { holder_version: 1, kind: "unowned" };
  if (action === "give_item") return { ...draft, action, fromHolder: holder, toHolder: { holder_version: 1, kind: "player" } };
  if (action === "take_item") return { ...draft, action, fromHolder: { holder_version: 1, kind: "player" }, toHolder: holder };
  return { ...draft, action };
}

function validDraft(draft: DomainEffectDraft): boolean {
  if (!draft.explanation.trim()) return false;
  if (["give_item", "take_item", "move_item"].includes(draft.action)) return Boolean(draft.itemNodeId) && encodeHolder(draft.fromHolder) !== encodeHolder(draft.toHolder);
  if (draft.action === "set_flag" || draft.action === "clear_flag") return Boolean(draft.flag.trim());
  if (draft.action === "update_quest") return Boolean(draft.questNodeId);
  return Boolean(draft.dialogueNodeId && draft.choiceId.trim());
}

function canonicalId(node: Node<NarrativeNodeData> | undefined): string { return node ? node.data.canonicalNodeId ?? node.id : ""; }
function encodeHolder(holder: StateHolderRef): string { return holder.kind === "character" || holder.kind === "location" || holder.kind === "faction" ? `${holder.kind}:${holder.node_id}` : holder.kind; }
function decodeHolder(value: string): StateHolderRef { const [kind, nodeId] = value.split(":"); return nodeId ? { holder_version: 1, kind: kind as "character" | "location" | "faction", node_id: nodeId } : { holder_version: 1, kind: kind as "player" | "party" | "unowned" }; }
function effectTitle(effect: NarrativeEffectDefinition, nodes: Node<NarrativeNodeData>[]): string { const title = (id: string) => nodes.find((node) => canonicalId(node) === id)?.data.title ?? id; switch (effect.operation) { case "transfer_item": return `${tr("narrativeState.moveItem")}: ${title(effect.payload.item_node_id)}`; case "set_flag": return `${tr("narrativeState.setFlag")}: ${effect.payload.flag}`; case "clear_flag": return `${tr("narrativeState.clearFlag")}: ${effect.payload.flag}`; case "set_quest_status": return `${tr("narrativeState.updateQuest")}: ${title(effect.payload.quest_node_id)}`; case "record_dialogue_choice": return `${tr("narrativeState.recordChoice")}: ${effect.payload.choice_id}`; } }
function questStatusLabel(status: DomainEffectDraft["questStatus"]): string { const labels = { inactive: "narrativeState.quest.inactive", active: "narrativeState.quest.active", completed: "narrativeState.quest.completed", failed: "narrativeState.quest.failed" } as const; return tr(labels[status]); }

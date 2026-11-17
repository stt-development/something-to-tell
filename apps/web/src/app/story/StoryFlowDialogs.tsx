import type { FlowExit,FlowExitBinding,FlowInvocation } from "@something-to-tell/contracts/composable-story-flow";
import {
type Edge,
type Node
} from "@xyflow/react";
import {
ArrowRight,
CircleStop,
GitBranch,
Link2,
Plus,
Save
} from "lucide-react";
import { useState,type ReactNode } from "react";
import { CanonDiagnosticMarker,canonFocusMatches,type CanonDiagnosticFocus } from "../../canon/CanonDiagnosticMarker";
import {
tr
} from "../../localization/i18n";
import { type FlowTransitionDraft,type StoryFlowDeletionImpact,type StoryFlowKind,type StoryFlowSnapshot } from "../../story-flow/contracts";
import {
type ProgressionCandidate,
type ProgressionMigrationReview
} from "../../story-flow/progressionMigration";
import {
type NarrativeEdgeData,
type NarrativeNodeData,
type NodeDraft
} from "../../types";

import { DialogShell,LabeledInput } from "../shared/DialogShell";
import { NODE_KINDS,OutcomeFlowCommand,displayNodeKind } from "../workspaceShared";

export function StoryFlowEditorDialog({
  error,
  flow,
  mode,
  onClose,
  onSave
}: {
  error: string | null;
  flow?: StoryFlowSnapshot;
  mode: "create" | "rename";
  onClose: () => void;
  onSave: (draft: { description: string; kind: StoryFlowKind; name: string }) => void;
}) {
  const [name, setName] = useState(flow?.flow.name ?? "");
  const [description, setDescription] = useState(flow?.flow.description ?? "");
  const [kind, setKind] = useState<StoryFlowKind>(flow?.flow.kind ?? "standalone");
  return (
    <DialogShell onClose={onClose} title={tr(mode === "create" ? "flow.create" : "flow.rename")}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) onSave({ name: name.trim(), description: description.trim(), kind });
        }}
      >
        <LabeledInput label={tr("common.name")} onChange={setName} value={name} />
        <label className="block text-sm font-semibold text-slate-700">
          {tr("common.kind")}
          <select className="mt-1 h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm" onChange={(event) => setKind(event.target.value as StoryFlowKind)} value={kind}>
            <option value="main">{tr("flow.main")}</option>
            <option value="side">{tr("flow.side")}</option>
            <option value="standalone">{tr("flow.standalone")}</option>
          </select>
        </label>
        <label className="block text-sm font-semibold text-slate-700">
          {tr("common.description")}
          <textarea className="mt-1 min-h-24 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" onChange={(event) => setDescription(event.target.value)} value={description} />
        </label>
        {error ? <p className="text-sm font-semibold text-rose-700">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <button className="rounded-md border border-slate-300 px-3 py-2 text-sm" onClick={onClose} type="button">{tr("common.cancel")}</button>
          <button className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white" type="submit">
            {mode === "create" ? <Plus size={15} aria-hidden="true" /> : <Save size={15} aria-hidden="true" />}
            {tr(mode === "create" ? "flow.createAction" : "flow.saveAction")}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

export function StoryFlowDeleteDialog({
  flow,
  impact,
  onClose,
  onConfirm
}: {
  flow: StoryFlowSnapshot;
  impact: StoryFlowDeletionImpact;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <DialogShell onClose={onClose} title={`Delete ${flow.flow.name}`}>
      <p className="text-sm text-slate-700">{tr("flow.deleteHint")}</p>
      <dl className="flow-delete-impact">
        <div><dt>{tr("flow.memberships")}</dt><dd>{impact.membership_count}</dd></div>
        <div><dt>{tr("flow.transitions")}</dt><dd>{impact.transition_count}</dd></div>
        <div><dt>{tr("flow.sceneBoundaries")}</dt><dd>{impact.scene_boundary_count}</dd></div>
        <div><dt>{tr("flow.canonicalNodes")}</dt><dd>{tr("flow.preserved")}</dd></div>
      </dl>
      <div className="mt-5 flex justify-end gap-2">
        <button className="rounded-md border border-slate-300 px-3 py-2 text-sm" onClick={onClose} type="button">{tr("common.cancel")}</button>
        <button className="rounded-md bg-rose-700 px-3 py-2 text-sm font-semibold text-white" onClick={onConfirm} type="button">{tr("flow.delete")}</button>
      </div>
    </DialogShell>
  );
}

/** Resolves an ambiguous Graph gesture at the moment the connection is made. */
export function ConnectionTypeDialog({
  activeFlowName,
  onChoose,
  onClose,
  sourceTitle,
  targetTitle
}: {
  activeFlowName: string | null;
  onChoose: (intent: "relationship" | "flow") => void;
  onClose: () => void;
  sourceTitle: string;
  targetTitle: string;
}) {
  return (
    <DialogShell onClose={onClose} title={tr("flow.createConnection")}>
      <p className="text-sm text-slate-600">
        <strong className="text-slate-900">{sourceTitle}</strong> {tr("common.to")} <strong className="text-slate-900">{targetTitle}</strong>
      </p>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <button className="connection-type-option" onClick={() => onChoose("relationship")} type="button">
          <Link2 size={18} aria-hidden="true" />
          <span><strong>{tr("flow.relationship")}</strong><small>{tr("flow.relationshipHint")}</small></span>
        </button>
        <button className="connection-type-option" disabled={!activeFlowName} onClick={() => onChoose("flow")} type="button">
          <GitBranch size={18} aria-hidden="true" />
          <span><strong>{tr("flow.storyTransition")}</strong><small>{activeFlowName ? tr("flow.continue", { name: activeFlowName }) : tr("flow.selectFirst")}</small></span>
        </button>
      </div>
      <div className="mt-4 flex justify-end">
        <button className="rounded-md border border-slate-300 px-3 py-2 text-sm" onClick={onClose} type="button">{tr("common.cancel")}</button>
      </div>
    </DialogShell>
  );
}

export function ContinueFlowDialog({
  error,
  initialTargetId,
  nodes,
  onClose,
  onSave,
  priority,
  sourceTitle,
  usedPriorities
}: {
  error: string | null;
  initialTargetId: string | null;
  nodes: Node<NarrativeNodeData>[];
  onClose: () => void;
  onSave: (command: { mode: "existing" | "new"; targetNodeId: string; node: NodeDraft; transition: FlowTransitionDraft }) => void;
  priority: number;
  sourceTitle: string;
  usedPriorities: number[];
}) {
  const [mode, setMode] = useState<"existing" | "new">(initialTargetId ? "existing" : "existing");
  const [targetNodeId, setTargetNodeId] = useState(initialTargetId ?? (nodes[0] ? nodes[0].data.canonicalNodeId ?? nodes[0].id : ""));
  const [kind, setKind] = useState<NodeDraft["kind"]>("Event");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [transitionKind, setTransitionKind] = useState<FlowTransitionDraft["kind"]>("next");
  const [label, setLabel] = useState("");
  const [condition, setCondition] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [transitionPriority, setTransitionPriority] = useState(priority);
  const targetValid = mode === "existing" ? Boolean(targetNodeId) : Boolean(title.trim());
  const branchValid = transitionKind !== "branch" || isDefault || Boolean(condition.trim());
  const priorityValid = transitionPriority >= 0 && !usedPriorities.includes(transitionPriority);
  const valid = targetValid && branchValid && priorityValid;
  return (
    <DialogShell onClose={onClose} title={`Continue from ${sourceTitle}`}>
      <form className="space-y-3" onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        onSave({
          mode,
          targetNodeId,
          node: { kind, title: title.trim(), summary: summary.trim(), tags: [] },
          transition: {
            kind: transitionKind,
            label: label.trim(),
            condition: isDefault && transitionKind === "branch" ? "" : condition.trim(),
            priority: transitionPriority,
            is_default: isDefault && transitionKind === "branch"
          }
        });
      }}>
        <div className="workspace-mode-control w-fit" aria-label={tr("flow.continuationTarget")} role="group">
          <button aria-pressed={mode === "existing"} className={mode === "existing" ? "workspace-mode-active" : ""} onClick={() => setMode("existing")} type="button">{tr("authoring.existingNode")}</button>
          <button aria-pressed={mode === "new"} className={mode === "new" ? "workspace-mode-active" : ""} onClick={() => setMode("new")} type="button">{tr("authoring.newNode")}</button>
        </div>
        {mode === "existing" ? (
          <label className="block text-sm font-semibold text-slate-700">{tr("authoring.targetNode")}
            <select autoFocus className="mt-1 h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm" onChange={(event) => setTargetNodeId(event.target.value)} value={targetNodeId}>
              {nodes.map((node) => <option key={node.id} value={node.data.canonicalNodeId ?? node.id}>{displayNodeKind(node.data.kind)}: {node.data.title}</option>)}
            </select>
          </label>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm font-semibold text-slate-700">{tr("authoring.nodeType")}
              <select className="mt-1 h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm" onChange={(event) => setKind(event.target.value as NodeDraft["kind"])} value={kind}>
                {NODE_KINDS.map((nodeKind) => <option key={nodeKind} value={nodeKind}>{displayNodeKind(nodeKind)}</option>)}
              </select>
            </label>
            <LabeledInput label={tr("common.title")} onChange={setTitle} value={title} />
            <label className="block text-sm font-semibold text-slate-700 sm:col-span-2">{tr("common.description")}
              <textarea className="mt-1 min-h-20 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" onChange={(event) => setSummary(event.target.value)} value={summary} />
            </label>
          </div>
        )}
        <div className="grid gap-3 border-t border-slate-200 pt-3 sm:grid-cols-2">
          <label className="block text-sm font-semibold text-slate-700">{tr("flow.transition")}
            <select className="mt-1 h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm" onChange={(event) => setTransitionKind(event.target.value as FlowTransitionDraft["kind"])} value={transitionKind}>
              <option value="next">{tr("flow.next")}</option><option value="branch">{tr("flow.branch")}</option><option value="optional">{tr("flow.optional")}</option><option value="return">{tr("flow.return")}</option>
            </select>
          </label>
          <label className="block text-sm font-semibold text-slate-700">{tr("common.priority")}
            <input className="mt-1 h-10 w-full rounded-md border border-slate-300 px-3 text-sm" min={0} onChange={(event) => setTransitionPriority(Number(event.target.value))} type="number" value={transitionPriority} />
          </label>
          <LabeledInput label={tr("common.label")} onChange={setLabel} value={label} />
          <LabeledInput label={tr("common.condition")} onChange={setCondition} value={condition} />
          <label className="flex items-center gap-2 text-sm font-semibold text-slate-700 sm:col-span-2">
            <input checked={isDefault} disabled={transitionKind !== "branch"} onChange={(event) => setIsDefault(event.target.checked)} type="checkbox" />
            {tr("authoring.defaultBranch")}
          </label>
        </div>
        {!branchValid ? <p className="text-xs font-semibold text-amber-700">{tr("flow.branchConditionRequired")}</p> : null}
        {!priorityValid ? <p className="text-xs font-semibold text-amber-700">{tr("flow.priorityInvalid")}</p> : null}
        {error ? <p className="text-sm font-semibold text-rose-700">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <button className="rounded-md border border-slate-300 px-3 py-2 text-sm" onClick={onClose} type="button">{tr("common.cancel")}</button>
          <button className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white" disabled={!valid} type="submit">{tr("flow.addContinuation")}</button>
        </div>
      </form>
    </DialogShell>
  );
}

/** Authors one explicit call route while keeping semantic Graph edges untouched. */
export function CallFlowDialog({
  error,
  flows,
  onClose,
  onSave,
  priority,
  sourceTitle,
  usedPriorities
}: {
  error: string | null;
  flows: StoryFlowSnapshot[];
  onClose: () => void;
  onSave: (command: { mode: "existing" | "new"; targetFlowId: string; newFlowName: string; label: string; condition: string; priority: number; isDefault: boolean }) => void;
  priority: number;
  sourceTitle: string;
  usedPriorities: number[];
}) {
  const [mode, setMode] = useState<"existing" | "new">(flows.length ? "existing" : "new");
  const [targetFlowId, setTargetFlowId] = useState(flows[0]?.flow.id ?? "");
  const [newFlowName, setNewFlowName] = useState("");
  const [label, setLabel] = useState("");
  const [condition, setCondition] = useState("");
  const [routePriority, setRoutePriority] = useState(priority);
  const [isDefault, setIsDefault] = useState(false);
  const targetValid = mode === "existing" ? Boolean(targetFlowId) : Boolean(newFlowName.trim());
  const priorityValid = routePriority >= 0 && !usedPriorities.includes(routePriority);
  const conditionValid = !isDefault || !condition.trim();
  return (
    <DialogShell onClose={onClose} title={tr("flow.callFrom", { name: sourceTitle })}>
      <form className="space-y-4" onSubmit={(event) => {
        event.preventDefault();
        if (!targetValid || !priorityValid || !conditionValid) return;
        onSave({ mode, targetFlowId, newFlowName: newFlowName.trim(), label: label.trim(), condition: condition.trim(), priority: routePriority, isDefault });
      }}>
        <div aria-label={tr("flow.callTargetMode")} className="workspace-mode-control w-fit" role="group">
          <button aria-pressed={mode === "existing"} className={mode === "existing" ? "workspace-mode-active" : ""} disabled={!flows.length} onClick={() => setMode("existing")} type="button">{tr("flow.existingFlow")}</button>
          <button aria-pressed={mode === "new"} className={mode === "new" ? "workspace-mode-active" : ""} onClick={() => setMode("new")} type="button">{tr("flow.newSideFlow")}</button>
        </div>
        {mode === "existing" ? (
          <label className="block text-sm font-semibold text-slate-700">{tr("flow.calledFlow")}
            <select autoFocus className="mt-1 h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm" onChange={(event) => setTargetFlowId(event.target.value)} value={targetFlowId}>
              {flows.map((flow) => <option key={flow.flow.id} value={flow.flow.id}>{flow.flow.name} · {tr(`flow.${flow.flow.kind}` as keyof typeof import("../../localization/catalogs").enCatalog)}</option>)}
            </select>
          </label>
        ) : <LabeledInput label={tr("flow.sideFlowName")} onChange={setNewFlowName} value={newFlowName} />}
        <div className="grid gap-3 border-t border-slate-200 pt-3 sm:grid-cols-2">
          <LabeledInput label={tr("common.label")} onChange={setLabel} value={label} />
          <label className="block text-sm font-semibold text-slate-700">{tr("common.priority")}<input className="mt-1 h-10 w-full rounded-md border border-slate-300 px-3 text-sm" min={0} onChange={(event) => setRoutePriority(Number(event.target.value))} type="number" value={routePriority} /></label>
          <label className="block text-sm font-semibold text-slate-700 sm:col-span-2">{tr("common.condition")}<input className="mt-1 h-10 w-full rounded-md border border-slate-300 px-3 text-sm" disabled={isDefault} onChange={(event) => setCondition(event.target.value)} value={condition} /></label>
          <label className="flex items-center gap-2 text-sm font-semibold text-slate-700 sm:col-span-2"><input checked={isDefault} onChange={(event) => { setIsDefault(event.target.checked); if (event.target.checked) setCondition(""); }} type="checkbox" />{tr("common.default")}</label>
        </div>
        {!priorityValid ? <p className="text-xs font-semibold text-amber-700">{tr("flow.priorityInvalid")}</p> : null}
        {!conditionValid ? <p className="text-xs font-semibold text-amber-700">{tr("flow.defaultCallConditionInvalid")}</p> : null}
        {error ? <p className="text-sm font-semibold text-rose-700" role="alert">{error}</p> : null}
        <div className="flex justify-end gap-2"><button className="rounded-md border border-slate-300 px-3 py-2 text-sm" onClick={onClose} type="button">{tr("common.cancel")}</button><button className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={!targetValid || !priorityValid || !conditionValid} type="submit"><ArrowRight size={15} aria-hidden="true" />{tr("flow.createCall")}</button></div>
      </form>
    </DialogShell>
  );
}

/** Creates one diagnostic named terminal exit from the selected flow member. */
export function FlowExitDialog({ error, existingKeys, nodeTitle, onClose, onSave }: { error: string | null; existingKeys: string[]; nodeTitle: string; onClose: () => void; onSave: (key: string, label: string) => void }) {
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const normalizedKey = key.trim().toLocaleLowerCase().replace(/\s+/g, "-");
  const valid = /^[a-z][a-z0-9_-]*$/.test(normalizedKey) && !existingKeys.includes(normalizedKey);
  return (
    <DialogShell onClose={onClose} title={tr("flow.exitFrom", { name: nodeTitle })}>
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (valid) onSave(normalizedKey, label.trim()); }}>
        <LabeledInput label={tr("flow.exitKey")} onChange={setKey} value={key} />
        <LabeledInput label={tr("common.label")} onChange={setLabel} value={label} />
        <p className="text-xs text-slate-500">{tr("flow.exitKeyHint")}</p>
        {key && !valid ? <p className="text-xs font-semibold text-amber-700">{tr("flow.exitKeyInvalid")}</p> : null}
        {error ? <p className="text-sm font-semibold text-rose-700" role="alert">{error}</p> : null}
        <div className="flex justify-end gap-2"><button className="rounded-md border border-slate-300 px-3 py-2 text-sm" onClick={onClose} type="button">{tr("common.cancel")}</button><button className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={!valid} type="submit">{tr("flow.createExit")}</button></div>
      </form>
    </DialogShell>
  );
}

/** Maps every callee exit back to a member of the immediate caller. */
export function FlowCallBindingsDialog({ bindings, caller, canonFocus, exits, invocation, invocationEffects, nodes, onClose, onDelete, onOpenTarget, onSave, renderExitEffects, targetFlow }: { bindings: FlowExitBinding[]; caller: StoryFlowSnapshot; canonFocus?: CanonDiagnosticFocus | null; exits: FlowExit[]; invocation: FlowInvocation; invocationEffects?: ReactNode; nodes: Node<NarrativeNodeData>[]; onClose: () => void; onDelete: () => void; onOpenTarget: () => void; onSave: (flowExit: FlowExit, targetNodeId: string) => void; renderExitEffects?: (flowExit: FlowExit) => ReactNode; targetFlow: StoryFlowSnapshot | null }) {
  const canonicalById = new Map(nodes.map((node) => [node.data.canonicalNodeId ?? node.id, node]));
  return (
    <DialogShell onClose={onClose} title={tr("flow.callBindingsTitle", { flow: targetFlow?.flow.name ?? invocation.target_flow_id })}>
      <div className="space-y-4">
        <div className={`flow-call-overview ${canonFocusMatches(canonFocus ?? null, invocation.id) ? "canon-specialized-owner-target" : ""}`} data-canon-issue-target={canonFocusMatches(canonFocus ?? null, invocation.id) || undefined} data-canon-owner-id={invocation.id} tabIndex={-1}><ArrowRight size={18} aria-hidden="true" />{canonFocusMatches(canonFocus ?? null, invocation.id) ? <CanonDiagnosticMarker focus={canonFocus!} /> : null}<span><strong>{invocation.label || tr("flow.callFlow")}</strong><small>{caller.flow.name} → {targetFlow?.flow.name ?? invocation.target_flow_id}</small></span><button className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-semibold" onClick={onOpenTarget} type="button">{tr("flow.openCalledFlow")}</button></div>
        {invocationEffects}
        {exits.length ? exits.map((flowExit) => (
          <section className={`rounded-md border border-slate-200 p-3 ${canonFocusMatches(canonFocus ?? null, flowExit.id) ? "canon-specialized-owner-target" : ""}`} data-canon-issue-target={canonFocusMatches(canonFocus ?? null, flowExit.id) || undefined} data-canon-owner-id={flowExit.id} key={flowExit.id} tabIndex={-1}>
            {canonFocusMatches(canonFocus ?? null, flowExit.id) ? <CanonDiagnosticMarker focus={canonFocus!} /> : null}
            <FlowExitBindingRow
              binding={bindings.find((item) => item.invocation_id === invocation.id && item.exit_id === flowExit.id) ?? null}
              canonFocus={canonFocus}
              caller={caller}
              canonicalById={canonicalById}
              flowExit={flowExit}
              onSave={onSave}
            />
            {renderExitEffects?.(flowExit)}
          </section>
        )) : <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-900" role="status">{tr("flow.calledFlowNeedsExits")}</div>}
        <div className="flex justify-between border-t border-slate-200 pt-4"><button className="rounded-md border border-rose-300 bg-white px-3 py-2 text-sm font-semibold text-rose-700" onClick={onDelete} type="button">{tr("flow.deleteCall")}</button><button className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white" onClick={onClose} type="button">{tr("common.close")}</button></div>
      </div>
    </DialogShell>
  );
}

export function FlowExitBindingRow({ binding, caller, canonicalById, canonFocus, flowExit, onSave }: { binding: FlowExitBinding | null; caller: StoryFlowSnapshot; canonicalById: Map<string, Node<NarrativeNodeData>>; canonFocus?: CanonDiagnosticFocus | null; flowExit: FlowExit; onSave: (flowExit: FlowExit, targetNodeId: string) => void }) {
  const [targetNodeId, setTargetNodeId] = useState(binding?.target_node_id ?? caller.nodes[0]?.node_id ?? "");
  return (
    <div className={`flow-binding-row ${binding ? "flow-binding-row-valid" : "flow-binding-row-draft"} ${binding && canonFocusMatches(canonFocus ?? null, binding.id) ? "canon-specialized-owner-target" : ""}`} data-canon-issue-target={Boolean(binding && canonFocusMatches(canonFocus ?? null, binding.id)) || undefined} data-canon-owner-id={binding?.id} tabIndex={binding ? -1 : undefined}>
      {binding && canonFocusMatches(canonFocus ?? null, binding.id) ? <CanonDiagnosticMarker focus={canonFocus!} /> : null}
      <div><CircleStop size={15} aria-hidden="true" /><span><strong>{flowExit.label || flowExit.key}</strong><small>{flowExit.key}</small></span></div>
      <ArrowRight size={15} aria-hidden="true" />
      <select aria-label={tr("flow.returnTargetFor", { exit: flowExit.key })} onChange={(event) => setTargetNodeId(event.target.value)} value={targetNodeId}>{caller.nodes.map((member) => <option key={member.id} value={member.node_id}>{canonicalById.get(member.node_id)?.data.title ?? member.node_id}</option>)}</select>
      <button className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-semibold" disabled={!targetNodeId || targetNodeId === binding?.target_node_id} onClick={() => onSave(flowExit, targetNodeId)} type="button">{binding ? tr("common.save") : tr("flow.bindExit")}</button>
    </div>
  );
}

export function StoryFlowEntryDialog({ currentTitle, nextTitle, onClose, onConfirm }: { currentTitle: string; nextTitle: string; onClose: () => void; onConfirm: () => void }) {
  return (
    <DialogShell onClose={onClose} title={tr("flow.replaceEntry")}>
      <p className="text-sm text-slate-700">{tr("flow.replaceEntryHint", { current: currentTitle, next: nextTitle })}</p>
      <div className="mt-5 flex justify-end gap-2">
        <button className="rounded-md border border-slate-300 px-3 py-2 text-sm" onClick={onClose} type="button">{tr("common.cancel")}</button>
        <button className="rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white" onClick={onConfirm} type="button">{tr("flow.setEntry")}</button>
      </div>
    </DialogShell>
  );
}

export function BuildWorldDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (draft: NodeDraft) => void }) {
  const [kind, setKind] = useState<NodeDraft["kind"]>("Lore");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const worldKinds: NodeDraft["kind"][] = ["Lore", "Character", "Faction", "Item"];
  return (
    <DialogShell onClose={onClose} title={tr("authoring.buildWorld")}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (title.trim()) onCreate({ kind, title: title.trim(), summary: summary.trim(), tags: [] });
        }}
      >
        <label className="block text-sm font-semibold text-slate-700">
          {tr("authoring.buildWorldType")}
          <select
            autoFocus
            className="mt-1 h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
            onChange={(event) => setKind(event.target.value as NodeDraft["kind"])}
            value={kind}
          >
            {worldKinds.map((value) => <option key={value} value={value}>{displayNodeKind(value)}</option>)}
          </select>
        </label>
        <LabeledInput label={tr("common.name")} onChange={setTitle} value={title} />
        <label className="block text-sm font-semibold text-slate-700">
          {tr("common.description")}
          <textarea className="mt-1 min-h-24 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" onChange={(event) => setSummary(event.target.value)} value={summary} />
        </label>
        <div className="flex justify-end gap-2">
          <button className="rounded-md border border-slate-300 px-3 py-2 text-sm" onClick={onClose} type="button">{tr("common.cancel")}</button>
          <button className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white" type="submit">
            <Plus aria-hidden="true" size={15} />
            {tr("authoring.createNode")}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

/** Edits only Flow-owned routing for canonical children of one Scene. */
export function SceneFlowBoundaryDialog({
  boundary,
  canonFocus,
  children,
  flow,
  onClose,
  onDelete,
  onSave,
  sceneTitle
}: {
  boundary: StoryFlowSnapshot["scene_boundaries"][number] | null;
  canonFocus?: CanonDiagnosticFocus | null;
  children: Node<NarrativeNodeData>[];
  flow: StoryFlowSnapshot;
  onClose: () => void;
  onDelete: () => void;
  onSave: (entryNodeId: string, exitNodeIds: string[]) => void;
  sceneTitle: string;
}) {
  const memberIds = new Set(flow.nodes.map((item) => item.node_id));
  const eligible = children.filter((node) => memberIds.has(node.id));
  const [entryNodeId, setEntryNodeId] = useState(boundary?.entry_node_id ?? eligible[0]?.id ?? "");
  const [exitNodeIds, setExitNodeIds] = useState(boundary?.exit_node_ids ?? []);
  const childIds = new Set(children.map((node) => node.id));
  const invalidReferences = boundary
    ? [boundary.entry_node_id, ...boundary.exit_node_ids].filter((nodeId) => !childIds.has(nodeId) || !memberIds.has(nodeId))
    : [];

  return (
    <DialogShell onClose={onClose} title={tr("flow.sceneBoundaryTitle", { title: sceneTitle })}>
      <div className={`space-y-4 ${boundary && canonFocusMatches(canonFocus ?? null, boundary.id) ? "canon-specialized-owner-target" : ""}`} data-canon-issue-target={Boolean(boundary && canonFocusMatches(canonFocus ?? null, boundary.id)) || undefined} data-canon-owner-id={boundary?.id} tabIndex={boundary ? -1 : undefined}>
        {boundary && canonFocusMatches(canonFocus ?? null, boundary.id) ? <CanonDiagnosticMarker focus={canonFocus!} /> : null}
        <p className="text-sm text-slate-600">{tr("flow.boundaryHint")}</p>
        {invalidReferences.length ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">
            {tr("flow.boundaryInvalid", { nodes: invalidReferences.join(", ") })}
          </div>
        ) : null}
        {eligible.length ? (
          <>
            <label className="block text-sm font-semibold text-slate-700">
              {tr("flow.entryChild")}
              <select className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" onChange={(event) => setEntryNodeId(event.target.value)} value={entryNodeId}>
                {eligible.map((node) => <option key={node.id} value={node.id}>{displayNodeKind(node.data.kind)}: {node.data.title}</option>)}
              </select>
            </label>
            <fieldset>
              <legend className="text-sm font-semibold text-slate-700">{tr("flow.exitChildren")}</legend>
              <div className="mt-2 max-h-52 overflow-y-auto rounded-md border border-slate-200 bg-white">
                {eligible.map((node) => (
                  <label className="flex items-center gap-3 border-b border-slate-100 px-3 py-2 last:border-b-0" key={node.id}>
                    <input
                      checked={exitNodeIds.includes(node.id)}
                      onChange={() => setExitNodeIds((current) =>
                        current.includes(node.id) ? current.filter((id) => id !== node.id) : [...current, node.id]
                      )}
                      type="checkbox"
                    />
                    <span className="min-w-0 truncate text-sm">{node.data.title}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          </>
        ) : (
          <div className="rounded-md border border-slate-300 bg-slate-50 px-3 py-3 text-sm text-slate-700" role="status">
            {tr("flow.boundaryNeedsChildren", { flow: flow.flow.name })}
          </div>
        )}
        <div className="flex justify-between border-t border-slate-200 pt-4">
          <button className="rounded-md border border-rose-300 bg-white px-3 py-2 text-sm font-semibold text-rose-700 disabled:text-slate-400" disabled={!boundary} onClick={onDelete} type="button">{tr("flow.removeBoundary")}</button>
          <button className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:bg-slate-400" disabled={!entryNodeId || exitNodeIds.length === 0} onClick={() => onSave(entryNodeId, exitNodeIds)} type="button">{tr("flow.saveBoundary")}</button>
        </div>
      </div>
    </DialogShell>
  );
}

/** Converts one semantic specialized outcome into explicit order only on confirmation. */
export function OutcomeFlowDialog({
  edge,
  error,
  flows,
  onClose,
  onSave,
  preferredFlowId
}: {
  edge: Edge<NarrativeEdgeData>;
  error: string | null;
  flows: StoryFlowSnapshot[];
  onClose: () => void;
  onSave: (command: OutcomeFlowCommand) => void;
  preferredFlowId: string | null;
}) {
  const existingDirectFlow = flows.find((flow) =>
    flow.transitions.some((transition) => transition.metadata.semantic_edge_id === edge.id)
  );
  const association = edge.data?.outcomeFlowComposition;
  const existingCaller = association
    ? flows.find((flow) => flow.flow.id === association.sourceFlowId)
    : null;
  const existingInvocation = existingCaller?.invocations?.find((invocation) => invocation.id === association?.invocationId);
  const initialSourceFlowId = existingCaller?.flow.id ?? existingDirectFlow?.flow.id ?? preferredFlowId ?? flows[0]?.flow.id ?? "";
  const initialMode: OutcomeFlowCommand["mode"] = existingInvocation ? "existing" : "direct";
  const existingTransition = existingDirectFlow?.transitions.find((transition) => transition.metadata.semantic_edge_id === edge.id);
  const [mode, setMode] = useState<OutcomeFlowCommand["mode"]>(initialMode);
  const [sourceFlowId, setSourceFlowId] = useState(initialSourceFlowId);
  const [targetFlowId, setTargetFlowId] = useState(existingInvocation?.target_flow_id ?? flows.find((flow) => flow.flow.id !== initialSourceFlowId)?.flow.id ?? "");
  const [newFlowName, setNewFlowName] = useState("");
  const [kind, setKind] = useState<FlowTransitionDraft["kind"]>(existingTransition?.kind ?? "next");
  const [condition, setCondition] = useState(existingInvocation?.condition ?? existingTransition?.condition ?? "");
  const [label, setLabel] = useState(existingInvocation?.label ?? String(edge.data?.label ?? edge.label ?? ""));
  const caller = flows.find((flow) => flow.flow.id === sourceFlowId);
  const usedPriorities = [
    ...(caller?.transitions ?? []).filter((transition) => transition.source_node_id === edge.source).map((transition) => transition.priority),
    ...(caller?.invocations ?? []).filter((invocation) => invocation.source_node_id === edge.source && invocation.id !== existingInvocation?.id).map((invocation) => invocation.priority)
  ];
  const [priority, setPriority] = useState(existingInvocation?.priority ?? (usedPriorities.length ? Math.max(...usedPriorities) + 1 : 0));
  const [isDefault, setIsDefault] = useState(existingInvocation?.is_default ?? false);
  const targetFlows = flows.filter((flow) => flow.flow.id !== sourceFlowId);
  const duplicateName = mode === "new" && flows.some((flow) => flow.flow.name.trim().toLocaleLowerCase() === newFlowName.trim().toLocaleLowerCase());
  const directValid = Boolean(sourceFlowId && (kind !== "branch" || existingTransition?.is_default || condition.trim()));
  const callTargetValid = mode === "existing" ? Boolean(targetFlowId && targetFlowId !== sourceFlowId) : Boolean(newFlowName.trim() && !duplicateName);
  const callValid = Boolean(sourceFlowId && callTargetValid && label.trim() && priority >= 0 && !usedPriorities.includes(priority) && (!isDefault || !condition.trim()));
  const valid = mode === "direct" ? directValid : callValid;

  return (
    <DialogShell onClose={onClose} title={tr("flow.outcomeTitle")}>
      <div className="space-y-4">
        <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-3">
          <div className="text-sm font-semibold text-slate-800">{String(edge.data?.label ?? edge.label ?? tr("flow.outcomeFallback"))}</div>
          <div className="mt-1 text-xs text-slate-500">{tr("flow.semanticHint")}</div>
        </div>
        {error ? <div className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800" role="alert">{error}</div> : null}
        <div aria-label={tr("flow.outcomeMode")} className="workspace-mode-control" role="group">
          <button aria-pressed={mode === "direct"} className={mode === "direct" ? "workspace-mode-active" : ""} onClick={() => setMode("direct")} type="button">{tr("flow.directOutcome")}</button>
          <button aria-pressed={mode === "existing"} className={mode === "existing" ? "workspace-mode-active" : ""} disabled={!targetFlows.length} onClick={() => setMode("existing")} type="button">{tr("flow.existingOutcomeFlow")}</button>
          <button aria-pressed={mode === "new"} className={mode === "new" ? "workspace-mode-active" : ""} onClick={() => setMode("new")} type="button">{tr("flow.newOutcomeFlow")}</button>
        </div>
        <label className="block text-sm font-semibold text-slate-700">
          {tr("flow.parentFlow")}
          <select className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" onChange={(event) => {
            const nextSourceFlowId = event.target.value;
            setSourceFlowId(nextSourceFlowId);
            if (targetFlowId === nextSourceFlowId) setTargetFlowId(flows.find((flow) => flow.flow.id !== nextSourceFlowId)?.flow.id ?? "");
          }} value={sourceFlowId}>
            {flows.map((flow) => <option key={flow.flow.id} value={flow.flow.id}>{flow.flow.name}</option>)}
          </select>
        </label>
        {mode === "direct" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm font-semibold text-slate-700">{tr("flow.transitionType")}<select className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" onChange={(event) => setKind(event.target.value as FlowTransitionDraft["kind"])} value={kind}><option value="next">{tr("flow.next")}</option><option value="branch">{tr("flow.branch")}</option><option value="optional">{tr("flow.optional")}</option><option value="return">{tr("flow.return")}</option></select></label>
            <label className="block text-sm font-semibold text-slate-700">{tr("common.condition")}<input className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" onChange={(event) => setCondition(event.target.value)} placeholder={tr("common.optional")} value={condition} /></label>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {mode === "existing" ? (
              <label className="block text-sm font-semibold text-slate-700 sm:col-span-2">{tr("flow.calledFlow")}<select className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" onChange={(event) => setTargetFlowId(event.target.value)} value={targetFlowId}>{targetFlows.map((flow) => <option key={flow.flow.id} value={flow.flow.id}>{flow.flow.name}</option>)}</select></label>
            ) : (
              <label className="block text-sm font-semibold text-slate-700 sm:col-span-2">{tr("flow.sideFlowName")}<input className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" onChange={(event) => setNewFlowName(event.target.value)} value={newFlowName} /></label>
            )}
            <label className="block text-sm font-semibold text-slate-700">{tr("common.label")}<input className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" onChange={(event) => setLabel(event.target.value)} value={label} /></label>
            <label className="block text-sm font-semibold text-slate-700">{tr("common.priority")}<input className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" min={0} onChange={(event) => setPriority(Number(event.target.value))} type="number" value={priority} /></label>
            <label className="block text-sm font-semibold text-slate-700 sm:col-span-2">{tr("common.condition")}<input className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" disabled={isDefault} onChange={(event) => setCondition(event.target.value)} placeholder={tr("common.optional")} value={condition} /></label>
            <label className="flex items-center gap-2 text-sm font-semibold text-slate-700 sm:col-span-2"><input checked={isDefault} onChange={(event) => { setIsDefault(event.target.checked); if (event.target.checked) setCondition(""); }} type="checkbox" />{tr("common.default")}</label>
            {existingInvocation && mode === "existing" && targetFlowId === existingInvocation.target_flow_id ? <p className="text-xs text-teal-700 sm:col-span-2">{tr("flow.reuseOutcomeCall")}</p> : null}
            {duplicateName ? <p className="text-xs font-semibold text-amber-700 sm:col-span-2">{tr("flow.duplicateFlowName")}</p> : null}
          </div>
        )}
        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <button className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700" onClick={onClose} type="button">{tr("flow.keepSemantic")}</button>
          <button className="rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white disabled:bg-slate-400" disabled={!valid} onClick={() => onSave(mode === "direct"
            ? { condition: condition.trim(), kind, mode, sourceFlowId }
            : mode === "existing"
              ? { condition: condition.trim(), isDefault, label: label.trim(), mode, priority, sourceFlowId, targetFlowId }
              : { condition: condition.trim(), isDefault, label: label.trim(), mode, newFlowName: newFlowName.trim(), priority, sourceFlowId }
          )} type="button">{tr(mode === "direct" ? (existingTransition ? "flow.updateStory" : "flow.addToStory") : "flow.callFromOutcome")}</button>
        </div>
      </div>
    </DialogShell>
  );
}

/** Hosts explicit, individually persisted progression migration decisions. */
export function ProgressionMigrationDialog({
  error,
  flows,
  loading,
  nodes,
  onAccept,
  onClose,
  onReject,
  review
}: {
  error: string | null;
  flows: StoryFlowSnapshot[];
  loading: boolean;
  nodes: Node<NarrativeNodeData>[];
  onAccept: (
    candidate: ProgressionCandidate,
    command: { condition: string; flowId: string; kind: FlowTransitionDraft["kind"]; preserveRelationship: boolean }
  ) => void;
  onClose: () => void;
  onReject: (candidate: ProgressionCandidate) => void;
  review: ProgressionMigrationReview | null;
}) {
  const nodeTitles = new Map(nodes.map((node) => [node.id, node.data.title]));
  return (
    <DialogShell onClose={onClose} title={tr("flow.reviewMigrations")} wide>
      <div className="space-y-5">
        {loading ? <div className="text-sm text-slate-500" role="status">{tr("flow.loadingCandidates")}</div> : null}
        {error ? <div className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800" role="alert">{error}</div> : null}
        {review?.pending.map((candidate) => (
          <ProgressionCandidateCard
            candidate={candidate}
            flows={flows}
            key={candidate.fingerprint}
            nodeTitles={nodeTitles}
            onAccept={onAccept}
            onReject={onReject}
          />
        ))}
        {!loading && review?.pending.length === 0 ? (
          <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-600">{tr("flow.noCandidates")}</div>
        ) : null}
        {review?.decisions.length ? (
          <section aria-label={tr("flow.migrationHistory")} className="border-t border-slate-200 pt-4">
            <h3 className="text-sm font-semibold text-slate-800">{tr("flow.decisionHistory")}</h3>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {review.decisions.map((decision) => (
                <div className="flex items-center justify-between gap-3 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm" key={decision.id}>
                  <span className="min-w-0 truncate">{decision.candidate.label || decision.edge_id}</span>
                  <span className={`shrink-0 text-xs font-semibold ${decision.status === "accepted" ? "text-emerald-700" : "text-rose-700"}`}>
                    {decision.status}{decision.original_relationship !== "unchanged" ? ` · ${decision.original_relationship}` : ""}
                  </span>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </DialogShell>
  );
}

export function ProgressionCandidateCard({
  candidate,
  flows,
  nodeTitles,
  onAccept,
  onReject
}: {
  candidate: ProgressionCandidate;
  flows: StoryFlowSnapshot[];
  nodeTitles: Map<string, string>;
  onAccept: ProgressionMigrationDialogProps["onAccept"];
  onReject: (candidate: ProgressionCandidate) => void;
}) {
  const [flowId, setFlowId] = useState(flows[0]?.flow.id ?? "");
  const [kind, setKind] = useState<FlowTransitionDraft["kind"]>(candidate.origin_kind === "relationship" ? "next" : "branch");
  const [condition, setCondition] = useState(candidate.condition);
  const [preserveRelationship, setPreserveRelationship] = useState(true);
  const flow = flows.find((item) => item.flow.id === flowId);
  const members = new Set(flow?.nodes.map((item) => item.node_id) ?? []);
  const additions = [candidate.source_node_id, candidate.target_node_id].filter((nodeId) => !members.has(nodeId));
  return (
    <article aria-label={`Migration candidate ${candidate.label || candidate.edge_id}`} className="rounded-md border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-slate-900">{nodeTitles.get(candidate.source_node_id) ?? candidate.source_node_id} → {nodeTitles.get(candidate.target_node_id) ?? candidate.target_node_id}</div>
          <div className="mt-1 text-xs text-slate-500">{candidate.origin_kind} · {candidate.label || tr("flow.unlabelledProgression")}</div>
        </div>
        <span className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-800">{tr("flow.unresolved")}</span>
      </div>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-slate-600">
        {candidate.evidence.map((item) => <li key={item}>{item}</li>)}
      </ul>
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <label className="text-xs font-semibold text-slate-700">{tr("flow.targetFlow")}<select className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" onChange={(event) => setFlowId(event.target.value)} value={flowId}>{flows.map((item) => <option key={item.flow.id} value={item.flow.id}>{item.flow.name}</option>)}</select></label>
        <label className="text-xs font-semibold text-slate-700">{tr("flow.transitionType")}<select className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" onChange={(event) => setKind(event.target.value as FlowTransitionDraft["kind"])} value={kind}><option value="next">{tr("flow.next")}</option><option value="branch">{tr("flow.branch")}</option><option value="optional">{tr("flow.optional")}</option><option value="return">{tr("flow.return")}</option></select></label>
        <label className="text-xs font-semibold text-slate-700">{tr("common.condition")}<input className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" onChange={(event) => setCondition(event.target.value)} value={condition} /></label>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-slate-600">
          {additions.length ? tr("flow.membershipAdditions", { nodes: additions.map((id) => nodeTitles.get(id) ?? id).join(", ") }) : tr("flow.endpointsAlreadyMembers")}
        </div>
        <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-700"><input checked={preserveRelationship} onChange={(event) => setPreserveRelationship(event.target.checked)} type="checkbox" />{tr("flow.preserveRelationship")}</label>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button className="rounded-md border border-rose-300 bg-white px-3 py-2 text-sm font-semibold text-rose-700" onClick={() => onReject(candidate)} type="button">{tr("common.reject")}</button>
        <button className="rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white disabled:bg-slate-400" disabled={!flowId || (kind === "branch" && !condition.trim())} onClick={() => onAccept(candidate, { condition: condition.trim(), flowId, kind, preserveRelationship })} type="button">{tr("flow.acceptConversion")}</button>
      </div>
    </article>
  );
}

export type ProgressionMigrationDialogProps = Parameters<typeof ProgressionMigrationDialog>[0];

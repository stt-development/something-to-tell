import type { NarrativeEffectOwnerRef } from "@something-to-tell/contracts/narrative-state";
import {
type Edge,
type Node
} from "@xyflow/react";
import {
ArrowDown,
ArrowUp,
Copy,
Plus,
Save,
Search,
Trash2,
X
} from "lucide-react";
import { useEffect,useMemo,useState,type ReactNode } from "react";
import { CanonDiagnosticMarker,canonFocusMatches,type CanonDiagnosticFocus } from "../../canon/CanonDiagnosticMarker";
import {
tr
} from "../../localization/i18n";
import { validateQuestDocument,type QuestDocument } from "../../quest/contracts";
import {
appendQuestBranch,
appendQuestStage,
deleteQuestBranch,
deleteQuestStage,
duplicateQuestStage,
moveQuestStage,
questStageDeletionImpact,
updateQuestBranch,
updateQuestStage
} from "../../quest/editor";
import {
type EdgeDraft,
type NarrativeEdgeData,
type NarrativeEdgeType,
type NarrativeNodeData,
type QuestTransitionDraft
} from "../../types";

import { QUEST_EXTERNAL_TARGET_KINDS } from "../editors/EditNodeDialog";
import { relationshipTypeForEdge } from "../graph/graphProjection";
import { DialogShell } from "../shared/DialogShell";
import { EngineTagPicker } from "../engineTags/EngineTagPicker";
import type { RuntimeEngineTagPersistence } from "../../runtime/apiTypes";
import { EDGE_TYPES,OutcomeDeletionImpact,displayNodeKind,displayRelationshipType } from "../workspaceShared";
import { StyleRecommendationAction, StyleRecommendationRequest, type StyleRecommendationLaunch, type StyleRecommendationRuntimeContext } from "../style/StyleRecommendationRequest";
import { createQuestStageTargets, QuestStageTargets, QuestStageTargetSelect } from "./QuestStageTargetSelect";

export function QuestEditorDialog({
  canonFocus,
  document,
  error,
  loading,
  node,
  nodeEffects,
  nodes,
  onClose,
  onConfigureStoryFlow,
  onCreateTransition,
  onDeleteTransition,
  outcomeDeletionImpact,
  renderEffects,
  onSave,
  onSaveNodeText,
  onUpdateTransition,
  storyFlowNames,
  styleContext,
  transitions,
  engineTagContext
}: {
  canonFocus?: CanonDiagnosticFocus | null;
  document: QuestDocument;
  error?: string | null;
  loading?: boolean;
  node: Node<NarrativeNodeData>;
  nodeEffects?: ReactNode;
  nodes: Node<NarrativeNodeData>[];
  onClose: () => void;
  onConfigureStoryFlow?: (edge: Edge<NarrativeEdgeData>) => void;
  onCreateTransition: (draft: QuestTransitionDraft) => void;
  onDeleteTransition: (edgeId: string) => void;
  outcomeDeletionImpact?: (edge: Edge<NarrativeEdgeData>) => OutcomeDeletionImpact;
  renderEffects?: (owner: NarrativeEffectOwnerRef) => ReactNode;
  onSave: (document: QuestDocument) => void;
  onSaveNodeText: (summary: string) => void;
  onUpdateTransition: (edgeId: string, draft: EdgeDraft) => void;
  storyFlowNames?: (edge: Edge<NarrativeEdgeData>) => string[];
  styleContext?: StyleRecommendationRuntimeContext;
  engineTagContext?: { persistence: RuntimeEngineTagPersistence; projectId: string; sessionId: string };
  transitions: Edge<NarrativeEdgeData>[];
}) {
  const [draft, setDraft] = useState(document);
  const [pendingDeletion, setPendingDeletion] = useState<{ branchId?: string; stageId: string } | null>(null);
  const [styleLaunch, setStyleLaunch] = useState<StyleRecommendationLaunch | null>(null);
  const [nodeText, setNodeText] = useState(node.data.summary);
  const characters = useMemo(() => nodes.filter((candidate) => candidate.data.kind === "Character"), [nodes]);
  const requirements = useMemo(() => nodes.filter((candidate) => candidate.data.kind === "Condition"), [nodes]);
  const rewards = useMemo(() => nodes.filter((candidate) => candidate.data.kind === "Item"), [nodes]);
  const validationIssues = useMemo(() => validateQuestDocument(draft), [draft]);
  const persistedStages = useMemo(() => createQuestStageTargets(document.stages).byId, [document.stages]);

  useEffect(() => setDraft(document), [document]);
  useEffect(() => setNodeText(node.data.summary), [node.data.summary]);

  function toggleReference(field: "prerequisite_node_ids" | "reward_node_ids", id: string) {
    setDraft((current) => ({
      ...current,
      [field]: current[field].includes(id) ? current[field].filter((value) => value !== id) : [...current[field], id]
    }));
  }

  function closeStyleRequest() {
    const actionId = styleLaunch?.actionId;
    setStyleLaunch(null);
    window.requestAnimationFrame(() => {
      if (actionId) globalThis.document.querySelector<HTMLElement>(`[data-style-action-id="${actionId}"]`)?.focus();
    });
  }

  return (
    <DialogShell onClose={styleLaunch ? closeStyleRequest : onClose} title={styleLaunch ? tr("style.recommendationRequest") : tr("quest.editNamed", { name: node.data.title })} wide>
      {styleLaunch && styleContext ? (
        <StyleRecommendationRequest
          contentLocale={styleContext.contentLocale}
          launch={styleLaunch}
          onApproved={styleContext.onApproved}
          onClose={closeStyleRequest}
          onCreateMemory={styleContext.onCreateMemory}
          onManageMemory={styleContext.onManageMemory}
          persistence={styleContext.persistence}
          providerConfigured={styleContext.providerConfigured}
          sessionId={styleContext.sessionId}
        />
      ) : (
      <form className="quest-editor-form space-y-5" onSubmit={(event) => {
        event.preventDefault();
        if (validateQuestDocument(draft).length === 0) onSave(draft);
      }}>
        {engineTagContext ? <EngineTagPicker
          owners={[{ kind: "node", project_id: engineTagContext.projectId, node_id: node.data.canonicalNodeId ?? node.id }]}
          persistence={engineTagContext.persistence}
          sessionId={engineTagContext.sessionId}
          suggestionDescription={node.data.summary}
          suggestionLabel={`${node.data.kind} ${node.data.title}`}
        /> : null}
        {loading ? <div className="text-sm text-slate-500" role="status">{tr("quest.loading")}</div> : null}
        {error ? <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">{error}. {tr("quest.localDocument")}</div> : null}

        <section className="rounded-md border border-slate-200 bg-slate-50 p-3">
          <div className="dialogue-field-heading">
            <h3 className="text-xs font-semibold text-slate-700">{tr("common.text")}</h3>
            <div className="flex items-center gap-2">
              {styleContext ? <StyleRecommendationAction
                disabled={!node.data.summary.trim() || nodeText !== node.data.summary}
                launch={{
                  actionId: `quest-node-text-${node.data.canonicalNodeId ?? node.id}`,
                  label: tr("style.nodeTextNamed", { name: node.data.title }),
                  nodeId: node.data.canonicalNodeId ?? node.id,
                  placementId: node.data.placementId ?? null,
                  sourceText: node.data.summary,
                  target: { kind: "node_text", node_id: node.data.canonicalNodeId ?? node.id }
                }}
                onLaunch={setStyleLaunch}
              /> : null}
              <button aria-label={`${tr("common.save")}: ${tr("common.text")}`} className="icon-button" disabled={nodeText === node.data.summary} onClick={() => onSaveNodeText(nodeText)} title={tr("common.save")} type="button"><Save size={15} aria-hidden="true" /></button>
            </div>
          </div>
          <textarea aria-label={tr("common.text")} className="mt-1 min-h-24 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" onChange={(event) => setNodeText(event.target.value)} value={nodeText} />
        </section>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="block text-sm font-semibold text-slate-700">
            <span className="dialogue-field-heading"><label htmlFor={`quest-objective-${node.id}`}>{tr("quest.objective")}</label>{styleContext ? <StyleRecommendationAction
              disabled={!draft.objective.trim() || draft.objective !== document.objective}
              launch={{ actionId: `quest-objective-${node.data.canonicalNodeId ?? node.id}`, label: tr("style.questObjectiveNamed", { name: node.data.title }), nodeId: node.data.canonicalNodeId ?? node.id, placementId: node.data.placementId ?? null, sourceText: document.objective, target: { kind: "quest_field", node_id: node.data.canonicalNodeId ?? node.id, field_kind: "objective", stage_id: null } }}
              onLaunch={setStyleLaunch}
            /> : null}</span>
            <textarea className="mt-1 min-h-24 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" id={`quest-objective-${node.id}`} onChange={(event) => setDraft({ ...draft, objective: event.target.value })} value={draft.objective} />
          </div>
          <div className="block text-sm font-semibold text-slate-700">
            <label className="dialogue-field-heading" htmlFor={`quest-giver-${node.id}`}>{tr("quest.giver")}</label>
            <select className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" id={`quest-giver-${node.id}`} onChange={(event) => setDraft({ ...draft, quest_giver_node_id: event.target.value || null })} value={draft.quest_giver_node_id ?? ""}>
              <option value="">{tr("quest.notAssigned")}</option>
              {characters.map((character) => <option key={character.id} value={character.id}>{character.data.title}</option>)}
            </select>
          </div>
        </div>

        <div className="grid gap-4 border-y border-slate-200 py-4 md:grid-cols-2">
          <QuestReferencePicker label={tr("quest.requirements")} nodes={requirements} onToggle={(id) => toggleReference("prerequisite_node_ids", id)} selectedIds={draft.prerequisite_node_ids} />
          <QuestReferencePicker label={tr("quest.rewards")} nodes={rewards} onToggle={(id) => toggleReference("reward_node_ids", id)} selectedIds={draft.reward_node_ids} />
        </div>
        {nodeEffects}

        <QuestStageTargets stages={draft.stages}>
        <section aria-labelledby="quest-stages-heading">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-800" id="quest-stages-heading">{tr("quest.stages")}</h3>
              <p className="text-xs text-slate-500">{tr("quest.pathHint")}</p>
            </div>
            <button className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700" onClick={() => setDraft(appendQuestStage(draft))} type="button">
              <Plus size={15} aria-hidden="true" /> {tr("quest.addStage")}
            </button>
          </div>

          <div className="mt-3 space-y-4">
            {draft.stages.map((stage, stageIndex) => {
              const ownedTransitions = transitions.filter((edge) => edge.data?.questStageId === stage.id);
              const impact = pendingDeletion?.stageId === stage.id && !pendingDeletion.branchId ? questStageDeletionImpact(draft, stage.id) : null;
              return (
                <article className={`rounded-md border border-slate-200 bg-slate-50/60 p-4 ${canonFocusMatches(canonFocus ?? null, stage.id) ? "canon-specialized-owner-target" : ""}`} data-canon-issue-target={canonFocusMatches(canonFocus ?? null, stage.id) || undefined} data-canon-owner-id={stage.id} key={stage.id} tabIndex={-1}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold uppercase text-slate-500">{tr("quest.stageNumber", { count: stageIndex + 1 })}</span>
                      {canonFocusMatches(canonFocus ?? null, stage.id) ? <CanonDiagnosticMarker focus={canonFocus!} /> : null}
                      <label className="inline-flex items-center gap-1 text-xs text-slate-600">
                        <input checked={draft.entry_stage_id === stage.id} name="quest-entry" onChange={() => setDraft({ ...draft, entry_stage_id: stage.id })} type="radio" /> {tr("quest.entryStage")}
                      </label>
                    </div>
                    <div className="flex gap-1">
                      <button aria-label={tr("quest.moveNamedUp", { name: stage.title })} className="icon-button" disabled={stageIndex === 0} onClick={() => setDraft(moveQuestStage(draft, stage.id, "up"))} title={tr("quest.moveStageUp")} type="button"><ArrowUp size={15} aria-hidden="true" /></button>
                      <button aria-label={tr("quest.moveNamedDown", { name: stage.title })} className="icon-button" disabled={stageIndex === draft.stages.length - 1} onClick={() => setDraft(moveQuestStage(draft, stage.id, "down"))} title={tr("quest.moveStageDown")} type="button"><ArrowDown size={15} aria-hidden="true" /></button>
                      <button aria-label={tr("quest.duplicateNamed", { name: stage.title })} className="icon-button" onClick={() => setDraft(duplicateQuestStage(draft, stage.id))} title={tr("quest.duplicateStage")} type="button"><Copy size={15} aria-hidden="true" /></button>
                      <button aria-label={tr("quest.deleteNamedStage", { name: stage.title })} className="icon-button text-rose-700" onClick={() => setPendingDeletion({ stageId: stage.id })} title={tr("quest.deleteStage")} type="button"><Trash2 size={15} aria-hidden="true" /></button>
                    </div>
                  </div>
                  {engineTagContext ? <EngineTagPicker
                    owners={[{ kind: "quest_stage", project_id: engineTagContext.projectId, quest_node_id: node.data.canonicalNodeId ?? node.id, stage_id: stage.id }]}
                    persistence={engineTagContext.persistence}
                    sessionId={engineTagContext.sessionId}
                    suggestionDescription={stage.description}
                    suggestionLabel={`${node.data.kind} ${node.data.title} ${stage.title || stage.id}`}
                  /> : null}
                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    <div className="block text-xs font-semibold text-slate-600"><label className="dialogue-field-heading" htmlFor={`quest-stage-title-${stage.id}`}>{tr("common.title")}</label><input className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" id={`quest-stage-title-${stage.id}`} onChange={(event) => setDraft(updateQuestStage(draft, stage.id, { title: event.target.value }))} value={stage.title} /></div>
                    <div className="block text-xs font-semibold text-slate-600"><span className="dialogue-field-heading"><label htmlFor={`quest-stage-description-${stage.id}`}>{tr("common.description")}</label>{styleContext ? <StyleRecommendationAction
                      disabled={!stage.description.trim() || persistedStages.get(stage.id)?.description !== stage.description}
                      launch={{ actionId: `quest-stage-description-${stage.id}`, label: tr("style.questStageDescriptionNamed", { name: stage.title }), nodeId: node.data.canonicalNodeId ?? node.id, placementId: node.data.placementId ?? null, sourceText: stage.description, target: { kind: "quest_field", node_id: node.data.canonicalNodeId ?? node.id, field_kind: "stage_description", stage_id: stage.id } }}
                      onLaunch={setStyleLaunch}
                    /> : null}</span><textarea aria-label={`${tr("common.description")}: ${stage.title}`} className="mt-1 min-h-20 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" id={`quest-stage-description-${stage.id}`} onChange={(event) => setDraft(updateQuestStage(draft, stage.id, { description: event.target.value }))} value={stage.description} /></div>
                  </div>

                  <div className="mt-4 flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-600">{tr("quest.branchesCount", { count: stage.branches.length })}</span>
                    <button className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700" onClick={() => setDraft(appendQuestBranch(draft, stage.id))} type="button"><Plus size={14} aria-hidden="true" /> {tr("quest.addBranch")}</button>
                  </div>
                  <div className="mt-2 space-y-3">
                    {stage.branches.map((branch) => {
                      const branchTransitions = transitions.filter((edge) => edge.data?.questBranchId === branch.id);
                      const deletingBranch = pendingDeletion?.stageId === stage.id && pendingDeletion.branchId === branch.id;
                      return (
                        <div className={`rounded-md border border-slate-200 bg-white p-3 ${canonFocusMatches(canonFocus ?? null, branch.id) ? "canon-specialized-owner-target" : ""}`} data-canon-issue-target={canonFocusMatches(canonFocus ?? null, branch.id) || undefined} data-canon-owner-id={branch.id} key={branch.id} tabIndex={-1}>
                          {canonFocusMatches(canonFocus ?? null, branch.id) ? <CanonDiagnosticMarker focus={canonFocus!} /> : null}
                          {engineTagContext ? <EngineTagPicker
                            owners={[{ kind: "quest_branch", project_id: engineTagContext.projectId, quest_node_id: node.data.canonicalNodeId ?? node.id, stage_id: stage.id, branch_id: branch.id }]}
                            persistence={engineTagContext.persistence}
                            sessionId={engineTagContext.sessionId}
                            suggestionDescription={branch.condition}
                            suggestionLabel={`${node.data.kind} ${node.data.title} ${stage.title || stage.id} ${branch.label || branch.id}`}
                          /> : null}
                          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_180px_210px_36px]">
                            <label className="block text-xs font-semibold text-slate-600">{tr("quest.branchLabel")}<input className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" onChange={(event) => setDraft(updateQuestBranch(draft, stage.id, branch.id, { label: event.target.value }))} value={branch.label} /></label>
                            <label className="block text-xs font-semibold text-slate-600">{tr("common.condition")}<input className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" onChange={(event) => setDraft(updateQuestBranch(draft, stage.id, branch.id, { condition: event.target.value }))} placeholder={tr("common.optional")} value={branch.condition} /></label>
                            <QuestStageTargetSelect stages={draft.stages} ownerId={stage.id} value={branch.target_stage_id}
                              onChange={(target_stage_id) => setDraft(updateQuestBranch(draft, stage.id, branch.id, { target_stage_id }))} />
                            <button aria-label={tr("quest.deleteNamedBranch", { name: branch.label })} className="icon-button self-end text-rose-700" onClick={() => setPendingDeletion({ branchId: branch.id, stageId: stage.id })} title={tr("quest.deleteBranch")} type="button"><Trash2 size={15} aria-hidden="true" /></button>
                          </div>
                          <QuestOriginTransitions
                            branchId={branch.id}
                            disabled={Boolean(branch.target_stage_id) || validationIssues.length > 0}
                            nodes={nodes}
                            onCreate={(transition) => onCreateTransition({ ...transition, document: draft, questNodeId: node.id, stageId: stage.id })}
                            onConfigureStoryFlow={onConfigureStoryFlow}
                            onDelete={onDeleteTransition}
                            outcomeDeletionImpact={outcomeDeletionImpact}
                            onUpdate={onUpdateTransition}
                            questNode={node}
                            stageId={stage.id}
                            storyFlowNames={storyFlowNames}
                            transitions={branchTransitions}
                          />
                          {renderEffects?.({ owner_version: 1, owner_kind: "quest_branch", owner_id: branch.id, context_node_id: node.data.canonicalNodeId ?? node.id })}
                          {branch.target_stage_id === null ? renderEffects?.({ owner_version: 1, owner_kind: "quest_outcome", owner_id: branch.id, context_node_id: node.data.canonicalNodeId ?? node.id }) : null}
                          {deletingBranch ? (
                            <QuestDeletionConfirmation message={`Delete this branch? ${branchTransitions.length} external outcome(s) will also be deleted.`} onCancel={() => setPendingDeletion(null)} onConfirm={() => {
                              branchTransitions.forEach((edge) => onDeleteTransition(edge.id));
                              setDraft(deleteQuestBranch(draft, stage.id, branch.id));
                              setPendingDeletion(null);
                            }} />
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                  {impact ? (
                    <QuestDeletionConfirmation message={`Delete this stage? ${impact.incomingBranchIds.length} internal branch(es) become endings and ${ownedTransitions.length} external outcome(s) will be deleted.${impact.removesEntry ? " The next stage becomes the entry." : ""}`} onCancel={() => setPendingDeletion(null)} onConfirm={() => {
                      ownedTransitions.forEach((edge) => onDeleteTransition(edge.id));
                      setDraft(deleteQuestStage(draft, stage.id));
                      setPendingDeletion(null);
                    }} />
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>
        </QuestStageTargets>
        {validationIssues.length > 0 ? <div className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800" role="alert">{validationIssues.map((entry) => <div key={`${entry.path}-${entry.code}`}>{entry.message}</div>)}</div> : null}
        <div className="flex justify-end border-t border-slate-200 pt-4">
          <button className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:bg-slate-400" disabled={loading || validationIssues.length > 0} type="submit"><Save size={16} aria-hidden="true" /> {tr("quest.save")}</button>
        </div>
      </form>
      )}
    </DialogShell>
  );
}

export function QuestReferencePicker({ label, nodes, onToggle, selectedIds }: { label: string; nodes: Node<NarrativeNodeData>[]; onToggle: (id: string) => void; selectedIds: string[] }) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const filteredNodes = useMemo(() => nodes.filter((node) =>
    `${node.data.title} ${node.data.summary} ${node.data.tags.join(" ")}`.toLowerCase().includes(normalizedQuery)
  ), [nodes, normalizedQuery]);

  return (
    <fieldset className="min-w-0">
      <div className="flex items-center justify-between gap-3">
        <legend className="text-sm font-semibold text-slate-700">{label}</legend>
        <span className="text-xs text-slate-500">{tr("quest.selectedCount", { count: selectedIds.length })}</span>
      </div>
      <label className="relative mt-2 block">
        <span className="sr-only">{tr("quest.searchNamed", { name: label })}</span>
        <Search className="pointer-events-none absolute left-3 top-2.5 text-slate-400" size={15} aria-hidden="true" />
        <input
          aria-label={tr("quest.searchNamed", { name: label })}
          className="w-full rounded-md border border-slate-300 py-2 pl-9 pr-3 text-sm"
          onChange={(event) => setQuery(event.target.value)}
          placeholder={tr("quest.searchNamed", { name: label.toLocaleLowerCase() })}
          type="search"
          value={query}
        />
      </label>
      <div aria-label={tr("quest.availableNamed", { name: label })} className="mt-2 max-h-40 overflow-y-auto rounded-md border border-slate-200 bg-white" role="list">
        {filteredNodes.map((node) => {
          const selected = selectedIds.includes(node.id);
          return (
            <label className={`flex cursor-pointer items-start gap-3 border-b border-slate-100 px-3 py-2 last:border-b-0 ${selected ? "bg-orange-50" : "hover:bg-slate-50"}`} key={node.id} role="listitem">
              <input aria-label={node.data.title} checked={selected} className="mt-0.5" onChange={() => onToggle(node.id)} type="checkbox" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-slate-800">{node.data.title}</span>
                <span className="block truncate text-xs text-slate-500">{displayNodeKind(node.data.kind)}{node.data.summary ? ` · ${node.data.summary}` : ""}</span>
              </span>
            </label>
          );
        })}
        {filteredNodes.length === 0 ? <p className="px-3 py-5 text-center text-sm text-slate-500">{tr(nodes.length === 0 ? "quest.noAvailableNodes" : "quest.noMatchingNodes")}</p> : null}
      </div>
    </fieldset>
  );
}

export function QuestDeletionConfirmation({ message, onCancel, onConfirm }: { message: string; onCancel: () => void; onConfirm: () => void }) {
  return <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900" role="alert"><span>{message}</span><span className="flex gap-2"><button className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-semibold text-slate-700" onClick={onCancel} type="button">{tr("common.cancel")}</button><button className="rounded-md bg-rose-700 px-3 py-1.5 font-semibold text-white" onClick={onConfirm} type="button">{tr("common.delete")}</button></span></div>;
}

export function QuestOriginTransitions({ branchId, disabled, nodes, onCreate, onConfigureStoryFlow, onDelete, onUpdate, outcomeDeletionImpact, questNode, stageId, storyFlowNames, transitions }: {
  branchId: string;
  disabled: boolean;
  nodes: Node<NarrativeNodeData>[];
  onCreate: (draft: Omit<QuestTransitionDraft, "document" | "questNodeId" | "stageId">) => void;
  onConfigureStoryFlow?: (edge: Edge<NarrativeEdgeData>) => void;
  onDelete: (edgeId: string) => void;
  outcomeDeletionImpact?: (edge: Edge<NarrativeEdgeData>) => OutcomeDeletionImpact;
  onUpdate: (edgeId: string, draft: EdgeDraft) => void;
  questNode: Node<NarrativeNodeData>;
  stageId: string;
  storyFlowNames?: (edge: Edge<NarrativeEdgeData>) => string[];
  transitions: Edge<NarrativeEdgeData>[];
}) {
  const [adding, setAdding] = useState(false);
  const targets = nodes.filter((candidate) => candidate.id !== questNode.id && QUEST_EXTERNAL_TARGET_KINDS.includes(candidate.data.kind));
  const addDisabled = disabled || transitions.length > 0;
  return (
    <section aria-label={tr("quest.outcomesFor", { name: branchId })} className="mt-3 border-l-2 border-orange-300 pl-3">
      <div className="flex items-center justify-between gap-2"><span className="text-xs font-semibold text-slate-600">{tr("quest.graphOutcomes", { count: transitions.length })}</span><button className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 disabled:text-slate-400" disabled={addDisabled} onClick={() => setAdding((value) => !value)} title={tr(addDisabled ? "quest.outcomeTargetRequired" : "quest.addOutcome")} type="button">{adding ? <X size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}{tr(adding ? "common.cancel" : "quest.addOutcome")}</button></div>
      {transitions.map((edge) => <QuestTransitionRow deletionImpact={outcomeDeletionImpact?.(edge)} edge={edge} flowNames={storyFlowNames?.(edge) ?? []} key={edge.id} nodes={targets} onConfigureStoryFlow={() => onConfigureStoryFlow?.(edge)} onDelete={() => onDelete(edge.id)} onUpdate={(draft) => onUpdate(edge.id, draft)} />)}
      {adding ? <QuestTransitionCreateForm branchId={branchId} nodes={targets} onCreate={(draft) => { onCreate(draft); setAdding(false); }} questNodeId={questNode.id} stageId={stageId} /> : null}
    </section>
  );
}

export function QuestTransitionRow({ deletionImpact, edge, flowNames, nodes, onConfigureStoryFlow, onDelete, onUpdate }: { deletionImpact?: OutcomeDeletionImpact; edge: Edge<NarrativeEdgeData>; flowNames: string[]; nodes: Node<NarrativeNodeData>[]; onConfigureStoryFlow: () => void; onDelete: () => void; onUpdate: (draft: EdgeDraft) => void }) {
  const [label, setLabel] = useState(String(edge.data?.label ?? edge.label ?? ""));
  const [relationshipType, setRelationshipType] = useState<NarrativeEdgeType>(relationshipTypeForEdge(edge));
  const [target, setTarget] = useState(edge.target);
  const [confirmingDeletion, setConfirmingDeletion] = useState(false);
  const reviewedImpact = deletionImpact && (deletionImpact.callCount > 0 || deletionImpact.returnCount > 0 || deletionImpact.transitionCount > 0);
  return <div className="mt-2 border-t border-slate-200 pt-2"><div className="grid items-end gap-2 md:grid-cols-[minmax(0,1fr)_150px_190px_120px_36px_36px]">
    <label className="block text-xs font-semibold text-slate-600">{tr("authoring.outcomeLabel")}<input className="dialogue-outcome-control mt-1 w-full rounded-md border border-slate-300 px-2 text-sm" onChange={(event) => setLabel(event.target.value)} value={label} /></label>
    <label className="block text-xs font-semibold text-slate-600">{tr("common.type")}<select className="dialogue-outcome-control mt-1 w-full rounded-md border border-slate-300 bg-white px-2 text-sm" onChange={(event) => setRelationshipType(event.target.value as NarrativeEdgeType)} value={relationshipType}>{EDGE_TYPES.map((type) => <option key={type} value={type}>{displayRelationshipType(type)}</option>)}</select></label>
    <label className="block text-xs font-semibold text-slate-600">{tr("common.target")}<select className="dialogue-outcome-control mt-1 w-full rounded-md border border-slate-300 bg-white px-2 text-sm" onChange={(event) => setTarget(event.target.value)} value={target}>{nodes.map((node) => <option key={node.id} value={node.id}>{displayNodeKind(node.data.kind)}: {node.data.title}</option>)}</select></label>
    <button className="dialogue-outcome-control inline-flex w-full items-center justify-center rounded-md border border-teal-600 bg-white px-2 text-xs font-semibold text-teal-800" onClick={onConfigureStoryFlow} title={tr("quest.chooseStoryOrder")} type="button">{flowNames.length ? flowNames.join(", ") : tr("quest.addToFlow")}</button>
    <button aria-label={tr("quest.saveNamedOutcome", { name: edge.id })} className="icon-button self-end" onClick={() => onUpdate({ label: label.trim(), relationshipType, source: edge.source, sourceHandle: edge.sourceHandle, target, targetHandle: target === edge.target ? edge.targetHandle : null })} title={tr("quest.saveOutcome")} type="button"><Save size={15} aria-hidden="true" /></button>
    <button aria-label={tr("quest.deleteNamedOutcome", { name: edge.id })} className="icon-button self-end text-rose-700" onClick={() => reviewedImpact ? setConfirmingDeletion(true) : onDelete()} title={tr("quest.deleteOutcome")} type="button"><Trash2 size={15} aria-hidden="true" /></button>
  </div>{confirmingDeletion && deletionImpact ? <QuestDeletionConfirmation message={tr("flow.outcomeDeletionImpact", { calls: deletionImpact.callCount, flows: deletionImpact.flowNames.join(", ") || tr("flow.none"), returns: deletionImpact.returnCount, transitions: deletionImpact.transitionCount })} onCancel={() => setConfirmingDeletion(false)} onConfirm={onDelete} /> : null}</div>;
}

export function QuestTransitionCreateForm({ branchId, nodes, onCreate }: { branchId: string; nodes: Node<NarrativeNodeData>[]; onCreate: (draft: Omit<QuestTransitionDraft, "document" | "questNodeId" | "stageId">) => void; questNodeId: string; stageId: string }) {
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [targetNodeId, setTargetNodeId] = useState(nodes[0]?.id ?? "");
  const [kind, setKind] = useState<NarrativeNodeData["kind"]>("Event");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [label, setLabel] = useState("");
  const [relationshipType, setRelationshipType] = useState<NarrativeEdgeType>("leads_to");
  const valid = Boolean(label.trim() && (mode === "existing" ? targetNodeId : title.trim()));
  return <div className="mt-3 rounded-md border border-orange-200 bg-orange-50/50 p-3">
    <div className="inline-flex rounded-md border border-slate-300 bg-white p-0.5"><button aria-pressed={mode === "existing"} className={`rounded px-3 py-1.5 text-xs font-semibold ${mode === "existing" ? "bg-slate-900 text-white" : "text-slate-600"}`} onClick={() => setMode("existing")} type="button">{tr("authoring.existingNode")}</button><button aria-pressed={mode === "new"} className={`rounded px-3 py-1.5 text-xs font-semibold ${mode === "new" ? "bg-slate-900 text-white" : "text-slate-600"}`} onClick={() => setMode("new")} type="button">{tr("authoring.newNode")}</button></div>
    <div className="mt-3 grid gap-2 md:grid-cols-2">
      {mode === "existing" ? <label className="block text-xs font-semibold text-slate-600 md:col-span-2">{tr("quest.targetNode")}<select className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" onChange={(event) => setTargetNodeId(event.target.value)} value={targetNodeId}>{nodes.map((node) => <option key={node.id} value={node.id}>{displayNodeKind(node.data.kind)}: {node.data.title}</option>)}</select></label> : <><label className="block text-xs font-semibold text-slate-600">{tr("quest.newNodeType")}<select className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" onChange={(event) => setKind(event.target.value as NarrativeNodeData["kind"])} value={kind}>{QUEST_EXTERNAL_TARGET_KINDS.map((nodeKind) => <option key={nodeKind} value={nodeKind}>{displayNodeKind(nodeKind)}</option>)}</select></label><label className="block text-xs font-semibold text-slate-600">{tr("quest.newNodeTitle")}<input className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" onChange={(event) => setTitle(event.target.value)} value={title} /></label><label className="block text-xs font-semibold text-slate-600 md:col-span-2">{tr("quest.newNodeDescription")}<textarea className="mt-1 min-h-16 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" onChange={(event) => setSummary(event.target.value)} value={summary} /></label></>}
      <label className="block text-xs font-semibold text-slate-600">{tr("authoring.outcomeLabel")}<input className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" onChange={(event) => setLabel(event.target.value)} value={label} /></label>
      <label className="block text-xs font-semibold text-slate-600">{tr("authoring.relationshipType")}<select className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" onChange={(event) => setRelationshipType(event.target.value as NarrativeEdgeType)} value={relationshipType}>{EDGE_TYPES.map((type) => <option key={type} value={type}>{displayRelationshipType(type)}</option>)}</select></label>
    </div>
    <button className="mt-3 inline-flex items-center gap-2 rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white disabled:bg-slate-400" disabled={!valid} onClick={() => onCreate({ branchId, label: label.trim(), relationshipType, ...(mode === "existing" ? { targetNodeId } : { newTarget: { kind, summary: summary.trim(), tags: [], title: title.trim() } }) })} type="button"><Plus size={15} aria-hidden="true" /> {tr("authoring.createOutcome")}</button>
  </div>;
}

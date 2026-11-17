import type { NarrativeEffectOwnerRef } from "@something-to-tell/contracts/narrative-state";
import {
type Edge,
type Node
} from "@xyflow/react";
import {
ArrowDown,
ArrowUp,
Copy,
Flag,
GitBranch,
MessageSquare,
Plus,
Save,
Search,
ShieldCheck,
Trash2,
UserPlus,
X
} from "lucide-react";
import { useEffect,useMemo,useState,type ReactNode } from "react";
import { CanonDiagnosticMarker,type CanonDiagnosticFocus } from "../../canon/CanonDiagnosticMarker";
import { validateDialogueDocument,type DialogueDocument } from "../../dialogue/contracts";
import {
appendChoiceOption,
appendDialogueElement,
deleteChoiceOption,
deleteDialogueElement,
dialogueDeletionImpact,
duplicateDialogueElement,
moveDialogueElement,
updateChoiceOption,
updateDialogueChoice,
updateDialogueLine
} from "../../dialogue/editor";
import {
tr
} from "../../localization/i18n";
import {
type DialogueTransitionDraft,
type EdgeDraft,
type NarrativeEdgeData,
type NarrativeEdgeType,
type NarrativeIssue,
type NarrativeNodeData
} from "../../types";

import { relationshipTypeForEdge } from "../graph/graphProjection";
import { indexDialogueCharacters, indexDialogueIssues, indexDialogueTransitions, indexPersistedDialogue } from "./dialogueEditorLookups";
import { DialogueNextSelect, DialogueNextTargets } from "./DialogueNextSelect";
export { DialogueNextSelect, dialogueElementSummary } from "./DialogueNextSelect";
import { QuestDeletionConfirmation } from "../quest/QuestEditorDialog";
import { EngineTagPicker } from "../engineTags/EngineTagPicker";
import type { RuntimeEngineTagPersistence } from "../../runtime/apiTypes";
import { DialogShell,IssueDetailsList } from "../shared/DialogShell";
import { EDGE_TYPES,NODE_KINDS,OutcomeDeletionImpact,displayNodeKind,displayRelationshipType } from "../workspaceShared";
import { StyleRecommendationAction, StyleRecommendationRequest, type StyleRecommendationLaunch, type StyleRecommendationRuntimeContext } from "../style/StyleRecommendationRequest";

export function DialogueEditorDialog({
  canonFocus,
  canonTargetId,
  characters,
  document,
  error,
  issues = [],
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
  canonTargetId?: string | null;
  characters: Node<NarrativeNodeData>[];
  document: DialogueDocument;
  error?: string | null;
  issues?: NarrativeIssue[];
  loading?: boolean;
  node: Node<NarrativeNodeData>;
  nodeEffects?: ReactNode;
  nodes: Node<NarrativeNodeData>[];
  onClose: () => void;
  onConfigureStoryFlow?: (edge: Edge<NarrativeEdgeData>) => void;
  onCreateTransition: (draft: DialogueTransitionDraft) => void;
  onDeleteTransition: (edgeId: string) => void;
  outcomeDeletionImpact?: (edge: Edge<NarrativeEdgeData>) => OutcomeDeletionImpact;
  renderEffects?: (owner: NarrativeEffectOwnerRef) => ReactNode;
  onSave: (document: DialogueDocument) => void;
  onSaveNodeText: (summary: string) => void;
  onUpdateTransition: (edgeId: string, draft: EdgeDraft) => void;
  storyFlowNames?: (edge: Edge<NarrativeEdgeData>) => string[];
  styleContext?: StyleRecommendationRuntimeContext;
  engineTagContext?: { persistence: RuntimeEngineTagPersistence; projectId: string; sessionId: string };
  transitions: Edge<NarrativeEdgeData>[];
}) {
  const [draft, setDraft] = useState(document);
  const [participantError, setParticipantError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [nodeText, setNodeText] = useState(node.data.summary);
  const [styleLaunch, setStyleLaunch] = useState<StyleRecommendationLaunch | null>(null);
  const filteredCharacters = characters.filter((character) =>
    `${character.data.title} ${character.data.summary}`.toLowerCase().includes(query.trim().toLowerCase())
  );
  const generalIssues = issues.filter((issue) => !issue.dialogueOwnerIds?.length);

  useEffect(() => {
    setDraft(document);
  }, [document]);

  useEffect(() => {
    setNodeText(node.data.summary);
  }, [node.data.summary]);

  function toggleParticipant(character: Node<NarrativeNodeData>) {
    const selected = draft.participants.includes(character.id);
    if (selected) {
      // Speaker references must be reassigned by the branching editor before
      // participant removal can preserve a valid dialogue document.
      const usedLineCount = draft.elements.filter((element) => element.kind === "line" && element.speaker_node_id === character.id).length;
      if (usedLineCount > 0) {
        setParticipantError(tr("dialogue.participantInUse", { count: usedLineCount, name: character.data.title }));
        return;
      }
    }
    setParticipantError(null);
    setDraft((current) => ({
      ...current,
      participants: selected
        ? current.participants.filter((participantId) => participantId !== character.id)
        : [...current.participants, character.id]
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
    <DialogShell onClose={styleLaunch ? closeStyleRequest : onClose} title={styleLaunch ? tr("style.recommendationRequest") : tr("dialogue.editNamed", { name: node.data.title })} wide>
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
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (validateDialogueDocument(draft).length === 0) {
            onSave(draft);
          }
        }}
      >
        {engineTagContext ? <EngineTagPicker
          owners={[{ kind: "node", project_id: engineTagContext.projectId, node_id: node.data.canonicalNodeId ?? node.id }]}
          persistence={engineTagContext.persistence}
          sessionId={engineTagContext.sessionId}
          suggestionDescription={node.data.summary}
          suggestionLabel={`${node.data.kind} ${node.data.title}`}
        /> : null}
        {loading ? <div className="text-sm text-slate-500" role="status">{tr("dialogue.loading")}</div> : null}
        {error ? <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">{error}. {tr("dialogue.localDocument")}</div> : null}
        {nodeEffects}
        {/* Node Text owns a separate history command from the branching document. */}
        <section className="rounded-md border border-slate-200 bg-slate-50 p-3">
          <div className="dialogue-field-heading">
            <h3 className="text-xs font-semibold text-slate-700">{tr("style.dialogueNodeText")}</h3>
            <div className="flex items-center gap-2">
              {styleContext ? <StyleRecommendationAction
                disabled={nodeText !== node.data.summary}
                launch={{
                  actionId: `dialogue-node-text-${node.data.canonicalNodeId ?? node.id}`,
                  label: tr("style.nodeTextNamed", { name: node.data.title }),
                  nodeId: node.data.canonicalNodeId ?? node.id,
                  placementId: node.data.placementId ?? null,
                  sourceText: node.data.summary,
                  target: { kind: "node_text", node_id: node.data.canonicalNodeId ?? node.id }
                }}
                onLaunch={setStyleLaunch}
              /> : null}
              <button
                aria-label={`${tr("common.save")}: ${tr("style.dialogueNodeText")}`}
                className="icon-button"
                disabled={nodeText === node.data.summary}
                onClick={() => onSaveNodeText(nodeText)}
                title={tr("common.save")}
                type="button"
              >
                <Save size={15} aria-hidden="true" />
              </button>
            </div>
          </div>
          <textarea
            aria-label={tr("style.dialogueNodeText")}
            className="mt-1 min-h-24 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            onChange={(event) => setNodeText(event.target.value)}
            value={nodeText}
          />
        </section>
        <IssueDetailsList issues={generalIssues} />
        <div className="grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
        <section aria-labelledby="dialogue-participants-heading" className="lg:border-r lg:border-slate-200 lg:pr-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-slate-800" id="dialogue-participants-heading">{tr("dialogue.participants")}</h3>
            <span className="text-xs text-slate-500">{tr("dialogue.selectedCount", { count: draft.participants.length })}</span>
          </div>
          <label className="mt-3 block text-sm font-semibold text-slate-700">
            {tr("dialogue.searchCharacters")}
            <div className="relative mt-1">
              <Search className="pointer-events-none absolute left-3 top-2.5 text-slate-400" size={16} aria-hidden="true" />
              <input
                className="w-full rounded-md border border-slate-300 py-2 pl-9 pr-3 text-sm"
                onChange={(event) => setQuery(event.target.value)}
                type="search"
                value={query}
              />
            </div>
          </label>
          <div aria-label={tr("dialogue.projectCharacters")} className="mt-3 max-h-64 space-y-2 overflow-y-auto" role="list">
            {filteredCharacters.map((character) => {
              const selected = draft.participants.includes(character.id);
              return (
                <div key={character.id} role="listitem">
                  <button
                    aria-pressed={selected}
                    className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left ${selected ? "border-cyan-600 bg-cyan-50" : "border-slate-200 bg-white hover:border-slate-400"}`}
                    onClick={() => toggleParticipant(character)}
                    type="button"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-slate-800">{character.data.title}</span>
                      <span className="block truncate text-xs text-slate-500">{character.data.summary}</span>
                    </span>
                    <span className="ml-3 inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-slate-600">
                      {tr(selected ? "dialogue.selected" : "dialogue.addParticipant")}
                      {selected ? <X size={15} aria-hidden="true" /> : <UserPlus size={15} aria-hidden="true" />}
                    </span>
                  </button>
                </div>
              );
            })}
            {filteredCharacters.length === 0 ? <p className="py-4 text-center text-sm text-slate-500">{tr("dialogue.noMatching")}</p> : null}
          </div>
        </section>
        <DialogueBranchEditor
          canonFocus={canonFocus}
          canonTargetId={canonTargetId}
          characters={characters}
          dialogueNode={node}
          document={draft}
          engineTagContext={engineTagContext}
          issues={issues}
          nodes={nodes}
          onChange={setDraft}
          onStyleLaunch={styleContext ? setStyleLaunch : undefined}
          placementId={node.data.placementId ?? null}
          persistedDocument={document}
          onConfigureStoryFlow={onConfigureStoryFlow}
          onCreateTransition={(transition) => onCreateTransition({ ...transition, document: draft })}
          onDeleteTransition={onDeleteTransition}
          outcomeDeletionImpact={outcomeDeletionImpact}
          renderEffects={renderEffects}
          onUpdateTransition={onUpdateTransition}
          storyFlowNames={storyFlowNames}
          transitions={transitions}
        />
        </div>
        {participantError ? <div className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800" role="alert">{participantError}</div> : null}
        <div className="flex justify-end border-t border-slate-200 pt-4">
          <button className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:bg-slate-400" disabled={loading} type="submit">
            <Save size={16} aria-hidden="true" />
            {tr("dialogue.save")}
          </button>
        </div>
      </form>
      )}
    </DialogShell>
  );
}

export function DialogueBranchEditor({
  canonFocus,
  canonTargetId,
  characters,
  dialogueNode,
  document,
  engineTagContext,
  issues,
  nodes,
  onChange,
  onStyleLaunch,
  persistedDocument,
  placementId,
  onConfigureStoryFlow,
  onCreateTransition,
  onDeleteTransition,
  outcomeDeletionImpact,
  renderEffects,
  onUpdateTransition,
  storyFlowNames,
  transitions
}: {
  canonFocus?: CanonDiagnosticFocus | null;
  canonTargetId?: string | null;
  characters: Node<NarrativeNodeData>[];
  dialogueNode: Node<NarrativeNodeData>;
  document: DialogueDocument;
  engineTagContext?: { persistence: RuntimeEngineTagPersistence; projectId: string; sessionId: string };
  issues: NarrativeIssue[];
  nodes: Node<NarrativeNodeData>[];
  onChange: (document: DialogueDocument) => void;
  onStyleLaunch?: (launch: StyleRecommendationLaunch) => void;
  persistedDocument: DialogueDocument;
  placementId: string | null;
  onConfigureStoryFlow?: (edge: Edge<NarrativeEdgeData>) => void;
  onCreateTransition: (draft: Omit<DialogueTransitionDraft, "document">) => void;
  onDeleteTransition: (edgeId: string) => void;
  outcomeDeletionImpact?: (edge: Edge<NarrativeEdgeData>) => OutcomeDeletionImpact;
  renderEffects?: (owner: NarrativeEffectOwnerRef) => ReactNode;
  onUpdateTransition: (edgeId: string, draft: EdgeDraft) => void;
  storyFlowNames?: (edge: Edge<NarrativeEdgeData>) => string[];
  transitions: Edge<NarrativeEdgeData>[];
}) {
  const [pendingDeletion, setPendingDeletion] = useState<
    { choiceId?: string; elementId?: string; optionId?: string } | null
  >(null);
  const charactersById = useMemo(() => indexDialogueCharacters(characters), [characters]);
  const participantCharacters = useMemo(() => document.participants
    .map((participantId) => charactersById.get(participantId))
    .filter((character): character is Node<NarrativeNodeData> => Boolean(character)), [document.participants, charactersById]);
  const persistedElements = useMemo(() => indexPersistedDialogue(persistedDocument), [persistedDocument]);
  const transitionsByOrigin = useMemo(() => indexDialogueTransitions(transitions), [transitions]);
  const issuesByOwner = useMemo(() => indexDialogueIssues(issues), [issues]);
  const validationIssues = useMemo(() => validateDialogueDocument(document), [document]);

  return (
    <DialogueNextTargets document={document}>
    <section aria-labelledby="dialogue-flow-heading" className="dialogue-branch-editor min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-800" id="dialogue-flow-heading">{tr("dialogue.flow")}</h3>
          <p className="mt-1 text-xs text-slate-500">{tr("dialogue.elementsCount", { count: document.elements.length })}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="inline-flex items-center gap-2 rounded-md border border-cyan-700 bg-white px-3 py-2 text-sm font-semibold text-cyan-800 disabled:border-slate-200 disabled:text-slate-400"
            disabled={participantCharacters.length === 0}
            onClick={() => onChange(appendDialogueElement(document, "line", participantCharacters[0]?.id))}
            title={tr(participantCharacters.length === 0 ? "dialogue.addParticipantFirst" : "dialogue.addLine")}
            type="button"
          >
            <MessageSquare size={16} aria-hidden="true" />
            {tr("dialogue.addLine")}
          </button>
          <button
            className="inline-flex items-center gap-2 rounded-md border border-violet-600 bg-white px-3 py-2 text-sm font-semibold text-violet-700"
            onClick={() => onChange(appendDialogueElement(document, "choice"))}
            type="button"
          >
            <GitBranch size={16} aria-hidden="true" />
            {tr("dialogue.addChoice")}
          </button>
        </div>
      </div>

      {document.elements.length === 0 ? (
        <div className="mt-4 rounded-md border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500">
          {tr("dialogue.noElements")}
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {document.elements.map((element, index) => {
            const persisted = persistedElements.get(element.id);
            const persistedElement = persisted?.element;
            const deletionImpact = pendingDeletion?.elementId === element.id
              ? dialogueDeletionImpact(document, element.id)
              : null;
            const ownedOriginIds = element.kind === "line" ? [element.id] : element.options.map((option) => option.id);
            // Only the active deletion needs a cross-origin scan in original transition order.
            const ownedTransitions = deletionImpact ? transitions.filter((transition) =>
              ownedOriginIds.includes(transition.data?.dialogueElementId ?? "")
            ) : [];
            const elementIssues = issuesByOwner.get(element.id) ?? [];
            return (
              <article
                className={`rounded-md border bg-white p-4 ${element.kind === "line" ? "border-cyan-200" : "border-violet-200"} ${canonTargetId === element.id ? "dialogue-canon-issue-target" : ""}`}
                data-canon-owner-id={element.id}
                data-canon-issue-target={canonTargetId === element.id || undefined}
                key={element.id}
                tabIndex={-1}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border text-xs font-bold ${element.kind === "line" ? "border-cyan-200 bg-cyan-50 text-cyan-800" : "border-violet-200 bg-violet-50 text-violet-700"}`}>
                      {index + 1}
                    </span>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-800">{tr(element.kind === "line" ? "dialogue.line" : "dialogue.choice")}</div>
                      <div className="truncate text-xs text-slate-500">{element.id}</div>
                    </div>
                    {document.entry_element_id === element.id ? (
                      <span className="rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">{tr("dialogue.entry")}</span>
                    ) : null}
                    {canonTargetId === element.id ? (canonFocus ? <CanonDiagnosticMarker focus={canonFocus} /> : <CanonDialogueIssueBadge />) : null}
                  </div>
                  <div className="flex items-center gap-1">
                    {document.entry_element_id !== element.id ? (
                      <button aria-label={tr("dialogue.setNamedEntry", { name: element.id })} className="icon-button" onClick={() => onChange({ ...document, entry_element_id: element.id })} title={tr("dialogue.setEntry")} type="button">
                        <Flag size={15} aria-hidden="true" />
                      </button>
                    ) : null}
                    <button aria-label={tr("dialogue.moveNamedUp", { name: element.id })} className="icon-button" disabled={index === 0} onClick={() => onChange(moveDialogueElement(document, element.id, "up"))} title={tr("dialogue.moveUp")} type="button">
                      <ArrowUp size={15} aria-hidden="true" />
                    </button>
                    <button aria-label={tr("dialogue.moveNamedDown", { name: element.id })} className="icon-button" disabled={index === document.elements.length - 1} onClick={() => onChange(moveDialogueElement(document, element.id, "down"))} title={tr("dialogue.moveDown")} type="button">
                      <ArrowDown size={15} aria-hidden="true" />
                    </button>
                    <button aria-label={tr("dialogue.duplicateNamed", { name: element.id })} className="icon-button" onClick={() => onChange(duplicateDialogueElement(document, element.id))} title={tr("dialogue.duplicateElement")} type="button">
                      <Copy size={15} aria-hidden="true" />
                    </button>
                    <button aria-label={tr("dialogue.deleteNamed", { name: element.id })} className="icon-button text-rose-700" onClick={() => setPendingDeletion({ elementId: element.id })} title={tr("dialogue.deleteElement")} type="button">
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  </div>
                </div>

                {engineTagContext ? <EngineTagPicker
                  owners={[element.kind === "line"
                    ? { kind: "dialogue_line", project_id: engineTagContext.projectId, dialogue_node_id: dialogueNode.data.canonicalNodeId ?? dialogueNode.id, line_id: element.id }
                    : { kind: "dialogue_choice", project_id: engineTagContext.projectId, dialogue_node_id: dialogueNode.data.canonicalNodeId ?? dialogueNode.id, choice_id: element.id }]}
                  persistence={engineTagContext.persistence}
                  sessionId={engineTagContext.sessionId}
                  suggestionDescription={element.kind === "line" ? element.text : element.prompt}
                  suggestionLabel={`${dialogueNode.data.kind} ${dialogueNode.data.title} ${element.kind === "line" ? element.text || element.id : element.prompt || element.id}`}
                /> : null}

                {element.kind === "line" ? (
                  <div className="mt-4 grid gap-3 sm:grid-cols-[180px_minmax(0,1fr)]">
                    <label className="block text-xs font-semibold text-slate-600">
                      <span className="dialogue-field-heading">{tr("dialogue.speaker")}</span>
                      <select
                        className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                        onChange={(event) => onChange(updateDialogueLine(document, element.id, { speaker_node_id: event.target.value }))}
                        value={element.speaker_node_id}
                      >
                        {participantCharacters.map((character) => <option key={character.id} value={character.id}>{character.data.title}</option>)}
                      </select>
                    </label>
                    <div className="block text-xs font-semibold text-slate-600">
                      <span className="dialogue-field-heading">
                        <span>{tr("common.text")}</span>
                        {onStyleLaunch ? (
                          <StyleRecommendationAction
                            disabled={persistedElement?.kind !== "line" || persistedElement.text !== element.text}
                            launch={{
                              actionId: `dialogue-line-${element.id}`,
                              label: tr("style.dialogueLineNamed", { name: element.id }),
                              nodeId: dialogueNode.data.canonicalNodeId ?? dialogueNode.id,
                              placementId,
                              sourceText: element.text,
                              target: { kind: "dialogue_field", node_id: dialogueNode.data.canonicalNodeId ?? dialogueNode.id, field_kind: "line_text", element_id: element.id, option_id: null }
                            }}
                            onLaunch={onStyleLaunch}
                          />
                        ) : null}
                      </span>
                      <textarea
                        aria-label={tr("common.text")}
                        className="mt-1 min-h-20 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                        onChange={(event) => onChange(updateDialogueLine(document, element.id, { text: event.target.value }))}
                        value={element.text}
                      />
                    </div>
                    <DialogueNextSelect
                      document={document}
                      label={tr("dialogue.next")}
                      onChange={(nextElementId) => onChange(updateDialogueLine(document, element.id, { next_element_id: nextElementId }))}
                      value={element.next_element_id}
                    />
                    <div className="sm:col-span-2">
                      <DialogueOriginTransitions
                        dialogueNode={dialogueNode}
                        disabled={validationIssues.length > 0}
                        nodes={nodes}
                        onCreate={onCreateTransition}
                        onConfigureStoryFlow={onConfigureStoryFlow}
                        onDelete={onDeleteTransition}
                        outcomeDeletionImpact={outcomeDeletionImpact}
                        onUpdate={onUpdateTransition}
                        originId={element.id}
                        storyFlowNames={storyFlowNames}
                        transitions={transitionsByOrigin.get(element.id) ?? []}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="mt-4 space-y-3">
                    <div className="block text-xs font-semibold text-slate-600">
                      <span className="dialogue-field-heading">
                        <span>{tr("dialogue.prompt")}</span>
                        {onStyleLaunch ? (
                          <StyleRecommendationAction
                            disabled={!element.prompt.trim() || persistedElement?.kind !== "choice" || persistedElement.prompt !== element.prompt}
                            launch={{
                              actionId: `dialogue-prompt-${element.id}`,
                              label: tr("style.dialoguePromptNamed", { name: element.id }),
                              nodeId: dialogueNode.data.canonicalNodeId ?? dialogueNode.id,
                              placementId,
                              sourceText: element.prompt,
                              target: { kind: "dialogue_field", node_id: dialogueNode.data.canonicalNodeId ?? dialogueNode.id, field_kind: "choice_prompt", element_id: element.id, option_id: null }
                            }}
                            onLaunch={onStyleLaunch}
                          />
                        ) : null}
                      </span>
                      <input
                        aria-label={tr("dialogue.prompt")}
                        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                        onChange={(event) => onChange(updateDialogueChoice(document, element.id, { prompt: event.target.value }))}
                        value={element.prompt}
                      />
                    </div>
                    <div className="space-y-2" aria-label={tr("dialogue.answersFor", { name: element.id })}>
                      {element.options.map((option, optionIndex) => (
                        <div
                          className={`border-t border-slate-200 pt-3 ${canonTargetId === option.id ? "dialogue-canon-issue-target dialogue-canon-option-target" : ""}`}
                          data-canon-issue-target={canonTargetId === option.id || undefined}
                          data-canon-owner-id={option.id}
                          key={option.id}
                          tabIndex={-1}
                        >
                          {canonTargetId === option.id ? (canonFocus ? <CanonDiagnosticMarker focus={canonFocus} /> : <CanonDialogueIssueBadge />) : null}
                          {engineTagContext ? <EngineTagPicker
                            owners={[{ kind: "dialogue_option", project_id: engineTagContext.projectId, dialogue_node_id: dialogueNode.data.canonicalNodeId ?? dialogueNode.id, choice_id: element.id, option_id: option.id }]}
                            persistence={engineTagContext.persistence}
                            sessionId={engineTagContext.sessionId}
                            suggestionDescription={option.text}
                            suggestionLabel={`${dialogueNode.data.kind} ${dialogueNode.data.title} ${element.prompt || element.id} ${option.text || option.id}`}
                          /> : null}
                          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_160px_190px_36px]">
                            <div className="block text-xs font-semibold text-slate-600">
                              <span className="dialogue-field-heading">
                                <span>{tr("dialogue.answerNumber", { count: optionIndex + 1 })}</span>
                                {onStyleLaunch ? (
                                  <StyleRecommendationAction
                                    disabled={persistedElement?.kind !== "choice" || persisted?.options.get(option.id)?.text !== option.text}
                                    launch={{
                                      actionId: `dialogue-option-${option.id}`,
                                      label: tr("style.dialogueOptionNamed", { name: option.id }),
                                      nodeId: dialogueNode.data.canonicalNodeId ?? dialogueNode.id,
                                      placementId,
                                      sourceText: option.text,
                                      target: { kind: "dialogue_field", node_id: dialogueNode.data.canonicalNodeId ?? dialogueNode.id, field_kind: "option_text", element_id: element.id, option_id: option.id }
                                    }}
                                    onLaunch={onStyleLaunch}
                                  />
                                ) : null}
                              </span>
                              <input aria-label={tr("dialogue.answerNumber", { count: optionIndex + 1 })} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" onChange={(event) => onChange(updateChoiceOption(document, element.id, option.id, { text: event.target.value }))} value={option.text} />
                            </div>
                            <label className="block text-xs font-semibold text-slate-600">
                              <span className="dialogue-field-heading">{tr("common.condition")}</span>
                              <input className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" onChange={(event) => onChange(updateChoiceOption(document, element.id, option.id, { condition: event.target.value }))} placeholder={tr("common.optional")} value={option.condition} />
                            </label>
                            <DialogueNextSelect document={document} label={tr("dialogue.next")} onChange={(nextElementId) => onChange(updateChoiceOption(document, element.id, option.id, { next_element_id: nextElementId }))} value={option.next_element_id} />
                            <button aria-label={tr("dialogue.deleteNamed", { name: option.id })} className="icon-button self-end text-rose-700" onClick={() => setPendingDeletion({ choiceId: element.id, optionId: option.id })} title={tr("dialogue.deleteAnswer")} type="button">
                              <Trash2 size={15} aria-hidden="true" />
                            </button>
                          </div>
                          {pendingDeletion?.optionId === option.id ? (
                            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800" role="alert">
                              <span>
                                Delete this answer{option.next_element_id ? ` and its branch to ${option.next_element_id}` : ""}?
                                {transitionsByOrigin.get(option.id)?.length
                                  ? ` ${transitionsByOrigin.get(option.id)!.length} external transition(s) will also be deleted.`
                                  : ""}
                              </span>
                              <span className="flex gap-2">
                                <button className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-semibold text-slate-700" onClick={() => setPendingDeletion(null)} type="button">{tr("common.cancel")}</button>
                                <button className="rounded-md bg-rose-700 px-3 py-1.5 font-semibold text-white" onClick={() => {
                                  (transitionsByOrigin.get(option.id) ?? [])
                                    .forEach((transition) => onDeleteTransition(transition.id));
                                  onChange(deleteChoiceOption(document, element.id, option.id));
                                  setPendingDeletion(null);
                                }} type="button">{tr("dialogue.deleteAnswer")}</button>
                              </span>
                            </div>
                          ) : null}
                          <DialogueOriginTransitions
                            dialogueNode={dialogueNode}
                            disabled={validationIssues.length > 0}
                            nodes={nodes}
                            onCreate={onCreateTransition}
                            onConfigureStoryFlow={onConfigureStoryFlow}
                            onDelete={onDeleteTransition}
                            outcomeDeletionImpact={outcomeDeletionImpact}
                            onUpdate={onUpdateTransition}
                            originId={option.id}
                            storyFlowNames={storyFlowNames}
                            transitions={transitionsByOrigin.get(option.id) ?? []}
                          />
                          {renderEffects?.({ owner_version: 1, owner_kind: "dialogue_option", owner_id: option.id, context_node_id: dialogueNode.data.canonicalNodeId ?? dialogueNode.id })}
                          <div className="dialogue-branch-issues">
                            <IssueDetailsList issues={issuesByOwner.get(option.id) ?? []} />
                          </div>
                        </div>
                      ))}
                    </div>
                    <button className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700" onClick={() => onChange(appendChoiceOption(document, element.id))} type="button">
                      <Plus size={15} aria-hidden="true" />
                      Add answer
                    </button>
                  </div>
                )}

                {renderEffects?.({ owner_version: 1, owner_kind: "dialogue_element", owner_id: element.id, context_node_id: dialogueNode.data.canonicalNodeId ?? dialogueNode.id })}
                <div className="dialogue-branch-issues">
                  <IssueDetailsList issues={elementIssues} />
                </div>

                {deletionImpact ? (
                  <div className="mt-3 rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900" role="alert">
                    <div className="font-semibold">Delete {element.id}?</div>
                    <p className="mt-1">
                      {deletionImpact.incomingOrigins.length > 0
                        ? `${deletionImpact.incomingOrigins.length} incoming branch${deletionImpact.incomingOrigins.length === 1 ? "" : "es"} (${deletionImpact.incomingOrigins.join(", ")}) will become endings.`
                        : "No incoming branches reference this element."}
                      {deletionImpact.removesEntry ? " The next element will become the entry point." : ""}
                      {ownedTransitions.length > 0 ? ` ${ownedTransitions.length} external transition(s) will also be deleted.` : ""}
                    </p>
                    <div className="mt-3 flex gap-2">
                      <button className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-semibold text-slate-700" onClick={() => setPendingDeletion(null)} type="button">{tr("common.cancel")}</button>
                      <button className="rounded-md bg-rose-700 px-3 py-1.5 font-semibold text-white" onClick={() => {
                        ownedTransitions.forEach((transition) => onDeleteTransition(transition.id));
                        onChange(deleteDialogueElement(document, element.id));
                        setPendingDeletion(null);
                      }} type="button">{tr("dialogue.deleteElement")}</button>
                    </div>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}

      {validationIssues.length > 0 ? (
        <div className="mt-4 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800" role="alert">
          {validationIssues.map((issue) => <div key={`${issue.path}-${issue.code}`}>{issue.message}</div>)}
        </div>
      ) : null}
    </section>
    </DialogueNextTargets>
  );
}

/** Marks the exact dialogue fragment selected from Canon review. */
export function CanonDialogueIssueBadge() {
  return (
    <span className="dialogue-canon-issue-badge" role="status">
      <ShieldCheck size={13} aria-hidden="true" />
      {tr("dialogue.canonIssue")}
    </span>
  );
}

export function DialogueOriginTransitions({
  dialogueNode,
  disabled,
  nodes,
  onCreate,
  onConfigureStoryFlow,
  onDelete,
  outcomeDeletionImpact,
  onUpdate,
  originId,
  storyFlowNames,
  transitions
}: {
  dialogueNode: Node<NarrativeNodeData>;
  disabled: boolean;
  nodes: Node<NarrativeNodeData>[];
  onCreate: (draft: Omit<DialogueTransitionDraft, "document">) => void;
  onConfigureStoryFlow?: (edge: Edge<NarrativeEdgeData>) => void;
  onDelete: (edgeId: string) => void;
  outcomeDeletionImpact?: (edge: Edge<NarrativeEdgeData>) => OutcomeDeletionImpact;
  onUpdate: (edgeId: string, draft: EdgeDraft) => void;
  originId: string;
  storyFlowNames?: (edge: Edge<NarrativeEdgeData>) => string[];
  transitions: Edge<NarrativeEdgeData>[];
}) {
  const [adding, setAdding] = useState(false);
  const targets = nodes.filter((node) => node.id !== dialogueNode.id);

  return (
    <section aria-label={tr("dialogue.outcomesFor", { name: originId })} className="mt-3 border-l-2 border-amber-300 pl-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold text-slate-600">{tr("dialogue.outcomesCount", { count: transitions.length })}</div>
        <button className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 disabled:text-slate-400" disabled={disabled} onClick={() => setAdding((value) => !value)} title={tr(disabled ? "dialogue.resolveBeforeOutcome" : "quest.addOutcome")} type="button">
          {adding ? <X size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
          {tr(adding ? "common.cancel" : "quest.addOutcome")}
        </button>
      </div>
      {transitions.map((transition) => (
        <DialogueTransitionRow
          edge={transition}
          deletionImpact={outcomeDeletionImpact?.(transition)}
          flowNames={storyFlowNames?.(transition) ?? []}
          key={transition.id}
          nodes={targets}
          onConfigureStoryFlow={() => onConfigureStoryFlow?.(transition)}
          onDelete={() => onDelete(transition.id)}
          onUpdate={(draft) => onUpdate(transition.id, draft)}
        />
      ))}
      {adding ? (
        <DialogueTransitionCreateForm
          dialogueNodeId={dialogueNode.id}
          nodes={targets}
          onCreate={(draft) => {
            onCreate(draft);
            setAdding(false);
          }}
          originId={originId}
        />
      ) : null}
    </section>
  );
}

export function DialogueTransitionRow({
  deletionImpact,
  edge,
  flowNames,
  nodes,
  onConfigureStoryFlow,
  onDelete,
  onUpdate
}: {
  deletionImpact?: OutcomeDeletionImpact;
  edge: Edge<NarrativeEdgeData>;
  flowNames: string[];
  nodes: Node<NarrativeNodeData>[];
  onConfigureStoryFlow: () => void;
  onDelete: () => void;
  onUpdate: (draft: EdgeDraft) => void;
}) {
  const [label, setLabel] = useState(String(edge.data?.label ?? edge.label ?? ""));
  const [relationshipType, setRelationshipType] = useState<NarrativeEdgeType>(relationshipTypeForEdge(edge));
  const [target, setTarget] = useState(edge.target);
  const [confirmingDeletion, setConfirmingDeletion] = useState(false);
  const reviewedImpact = deletionImpact && (deletionImpact.callCount > 0 || deletionImpact.returnCount > 0 || deletionImpact.transitionCount > 0);

  return (
    <div className="mt-2 border-t border-slate-200 pt-2"><div className="grid items-end gap-2 md:grid-cols-[minmax(0,1fr)_150px_180px_120px_36px_36px]">
      <label className="block text-xs font-semibold text-slate-600">
        {tr("dialogue.outcomeLabel")}
        <input className="dialogue-outcome-control mt-1 w-full rounded-md border border-slate-300 px-2 text-sm" onChange={(event) => setLabel(event.target.value)} value={label} />
      </label>
      <label className="block text-xs font-semibold text-slate-600">
        {tr("common.type")}
        <select className="dialogue-outcome-control mt-1 w-full rounded-md border border-slate-300 bg-white px-2 text-sm" onChange={(event) => setRelationshipType(event.target.value as NarrativeEdgeType)} value={relationshipType}>
          {EDGE_TYPES.map((type) => <option key={type} value={type}>{displayRelationshipType(type)}</option>)}
        </select>
      </label>
      <label className="block text-xs font-semibold text-slate-600">
        {tr("common.target")}
        <select className="dialogue-outcome-control mt-1 w-full rounded-md border border-slate-300 bg-white px-2 text-sm" onChange={(event) => setTarget(event.target.value)} value={target}>
          {nodes.map((node) => <option key={node.id} value={node.id}>{displayNodeKind(node.data.kind)}: {node.data.title}</option>)}
        </select>
      </label>
      <button className="dialogue-outcome-control inline-flex items-center justify-center rounded-md border border-teal-600 bg-white px-2 text-xs font-semibold text-teal-800" onClick={onConfigureStoryFlow} title={tr("dialogue.chooseStoryOrder")} type="button">{flowNames.length ? flowNames.join(", ") : tr("dialogue.addToFlow")}</button>
      <button aria-label={tr("dialogue.saveNamedOutcome", { name: edge.id })} className="icon-button self-end" onClick={() => onUpdate({
        label: label.trim(),
        relationshipType,
        source: edge.source,
        sourceHandle: edge.sourceHandle,
        target,
        targetHandle: target === edge.target ? edge.targetHandle : null
      })} title={tr("dialogue.saveOutcome")} type="button">
        <Save size={15} aria-hidden="true" />
      </button>
      <button aria-label={tr("dialogue.deleteNamedOutcome", { name: edge.id })} className="icon-button self-end text-rose-700" onClick={() => reviewedImpact ? setConfirmingDeletion(true) : onDelete()} title={tr("dialogue.deleteOutcome")} type="button">
        <Trash2 size={15} aria-hidden="true" />
      </button>
    </div>{confirmingDeletion && deletionImpact ? <QuestDeletionConfirmation message={tr("flow.outcomeDeletionImpact", { calls: deletionImpact.callCount, flows: deletionImpact.flowNames.join(", ") || tr("flow.none"), returns: deletionImpact.returnCount, transitions: deletionImpact.transitionCount })} onCancel={() => setConfirmingDeletion(false)} onConfirm={onDelete} /> : null}</div>
  );
}

export function DialogueTransitionCreateForm({
  dialogueNodeId,
  nodes,
  onCreate,
  originId
}: {
  dialogueNodeId: string;
  nodes: Node<NarrativeNodeData>[];
  onCreate: (draft: Omit<DialogueTransitionDraft, "document">) => void;
  originId: string;
}) {
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [targetNodeId, setTargetNodeId] = useState(nodes[0]?.id ?? "");
  const [kind, setKind] = useState<NarrativeNodeData["kind"]>("Event");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [label, setLabel] = useState("");
  const [relationshipType, setRelationshipType] = useState<NarrativeEdgeType>("leads_to");
  const canCreate = Boolean(label.trim() && (mode === "existing" ? targetNodeId : title.trim()));

  return (
    <div className="mt-3 rounded-md border border-amber-200 bg-amber-50/50 p-3">
      <div className="inline-flex rounded-md border border-slate-300 bg-white p-0.5" aria-label={tr("authoring.outcomeTargetMode")}>
        <button aria-pressed={mode === "existing"} className={`rounded px-3 py-1.5 text-xs font-semibold ${mode === "existing" ? "bg-slate-900 text-white" : "text-slate-600"}`} onClick={() => setMode("existing")} type="button">{tr("dialogue.existingNode")}</button>
        <button aria-pressed={mode === "new"} className={`rounded px-3 py-1.5 text-xs font-semibold ${mode === "new" ? "bg-slate-900 text-white" : "text-slate-600"}`} onClick={() => setMode("new")} type="button">{tr("dialogue.newNode")}</button>
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {mode === "existing" ? (
          <label className="block text-xs font-semibold text-slate-600 md:col-span-2">
            {tr("quest.targetNode")}
            <select className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" onChange={(event) => setTargetNodeId(event.target.value)} value={targetNodeId}>
              {nodes.map((node) => <option key={node.id} value={node.id}>{displayNodeKind(node.data.kind)}: {node.data.title}</option>)}
            </select>
          </label>
        ) : (
          <>
            <label className="block text-xs font-semibold text-slate-600">
              {tr("quest.newNodeType")}
              <select className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" onChange={(event) => setKind(event.target.value as NarrativeNodeData["kind"])} value={kind}>
                {NODE_KINDS.map((nodeKind) => <option key={nodeKind} value={nodeKind}>{displayNodeKind(nodeKind)}</option>)}
              </select>
            </label>
            <label className="block text-xs font-semibold text-slate-600">
              {tr("quest.newNodeTitle")}
              <input className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" onChange={(event) => setTitle(event.target.value)} value={title} />
            </label>
            <label className="block text-xs font-semibold text-slate-600 md:col-span-2">
              {tr("quest.newNodeDescription")}
              <textarea className="mt-1 min-h-20 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" onChange={(event) => setSummary(event.target.value)} value={summary} />
            </label>
          </>
        )}
        <label className="block text-xs font-semibold text-slate-600">
          {tr("dialogue.outcomeLabel")}
          <input className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" onChange={(event) => setLabel(event.target.value)} value={label} />
        </label>
        <label className="block text-xs font-semibold text-slate-600">
          {tr("authoring.relationshipType")}
          <select className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" onChange={(event) => setRelationshipType(event.target.value as NarrativeEdgeType)} value={relationshipType}>
            {EDGE_TYPES.map((type) => <option key={type} value={type}>{displayRelationshipType(type)}</option>)}
          </select>
        </label>
      </div>
      <button className="mt-3 inline-flex items-center gap-2 rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white disabled:bg-slate-400" disabled={!canCreate} onClick={() => onCreate({
        dialogueNodeId,
        label: label.trim(),
        originId,
        relationshipType,
        ...(mode === "existing"
          ? { targetNodeId }
          : { newTarget: { kind, summary: summary.trim(), tags: [], title: title.trim() } })
      })} type="button">
        <Plus size={15} aria-hidden="true" />
        {tr("dialogue.createOutcome")}
      </button>
    </div>
  );
}

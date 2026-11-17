import {
type Node
} from "@xyflow/react";
import {
Save,
Trash2,
UserPlus
} from "lucide-react";
import { useState,type ReactNode } from "react";
import {
tr
} from "../../localization/i18n";
import {
type EdgeDraft,
type NarrativeEdgeData,
type NarrativeEdgeType,
type NarrativeIssue,
type NarrativeNodeData,
type NodeDraft
} from "../../types";

import { relationshipTypeForEdge } from "../graph/graphProjection";
import { DialogShell,IssueDetailsList,LabeledInput } from "../shared/DialogShell";
import { EngineTagPicker } from "../engineTags/EngineTagPicker";
import type { RuntimeEngineTagPersistence } from "../../runtime/apiTypes";
import { EDGE_TYPES,NODE_KINDS,displayNodeKind,displayRelationshipType } from "../workspaceShared";
import { SceneStyleSelector } from "./SceneStyleSelector";
import { StyleRecommendationAction, StyleRecommendationRequest, type StyleRecommendationLaunch, type StyleRecommendationRuntimeContext } from "../style/StyleRecommendationRequest";

export function EditNodeDialog({
  characters,
  effects,
  issues,
  members,
  node,
  onAddMember,
  onClose,
  onRemoveMember,
  onSave,
  projectNodes,
  styleContext,
  engineTagContext
}: {
  characters: Node<NarrativeNodeData>[];
  effects?: ReactNode;
  issues: NarrativeIssue[];
  members: Node<NarrativeNodeData>[];
  node: Node<NarrativeNodeData>;
  onAddMember: (characterId: string) => { message: string; valid: boolean };
  onClose: () => void;
  onRemoveMember: (characterId: string) => { message: string; valid: boolean };
  onSave: (draft: NodeDraft) => void;
  projectNodes: Node<NarrativeNodeData>[];
  styleContext?: StyleRecommendationRuntimeContext & {
    projectId: string;
  };
  engineTagContext?: { persistence: RuntimeEngineTagPersistence; projectId: string; sessionId: string };
}) {
  const [draft, setDraft] = useState<NodeDraft>({
    kind: node.data.kind,
    summary: node.data.summary,
    tags: node.data.tags,
    title: node.data.title,
    ...(node.data.kind === "Character" ? { characterRole: node.data.characterRole ?? "" } : {}),
    ...(node.data.kind === "Item" ? { itemPurpose: node.data.itemPurpose ?? "" } : {}),
    ...(node.data.kind === "Condition"
      ? { requirement: node.data.requirement ?? { subject: node.data.title, predicate: node.data.summary, expression: "" } }
      : {}),
    ...(node.data.kind === "Consequence"
      ? { outcome: node.data.outcome ?? { effect: node.data.summary, targetNodeIds: [] } }
      : {})
  });
  const [memberQuery, setMemberQuery] = useState("");
  const [membershipNotice, setMembershipNotice] = useState<string | null>(null);
  const [styleLaunch, setStyleLaunch] = useState<StyleRecommendationLaunch | null>(null);
  const memberIds = new Set(members.map((member) => member.data.canonicalNodeId ?? member.id));
  const availableCharacters = characters.filter((character) => {
    const id = character.data.canonicalNodeId ?? character.id;
    const query = memberQuery.trim().toLowerCase();
    return !memberIds.has(id) && (!query || `${character.data.title} ${character.data.summary} ${character.data.tags.join(" ")}`.toLowerCase().includes(query));
  });

  function closeStyleRequest() {
    const actionId = styleLaunch?.actionId;
    setStyleLaunch(null);
    window.requestAnimationFrame(() => {
      if (actionId) document.querySelector<HTMLElement>(`[data-style-action-id="${actionId}"]`)?.focus();
    });
  }

  return (
    <DialogShell onClose={styleLaunch ? closeStyleRequest : onClose} title={styleLaunch ? tr("style.recommendationRequest") : tr("authoring.editNode")}>
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
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(draft);
        }}
      >
        <LabeledInput label={tr("common.label")} onChange={(value) => setDraft((current) => ({ ...current, title: value }))} value={draft.title} />
        <label className="block text-sm font-semibold text-slate-700">
          {tr("common.type")}
          {node.data.isFrame ? (
            <input className="mt-1 w-full rounded-md border border-slate-200 bg-slate-100 px-3 py-2 text-sm text-slate-500" disabled value={displayNodeKind(draft.kind)} />
          ) : (
            <select className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" onChange={(event) => setDraft((current) => ({ ...current, kind: event.target.value as NarrativeNodeData["kind"] }))} value={draft.kind}>
              {NODE_KINDS.map((kind) => (
                <option key={kind} value={kind}>{displayNodeKind(kind)}</option>
              ))}
            </select>
          )}
        </label>
        <div className="block text-sm font-semibold text-slate-700">
          <span className="flex items-center justify-between gap-2">
            <span>{tr("common.text")}</span>
            {styleContext ? (
              <StyleRecommendationAction
                disabled={draft.summary !== node.data.summary}
                launch={{
                  actionId: `node-text-${node.data.canonicalNodeId ?? node.id}`,
                  label: tr("style.nodeTextNamed", { name: node.data.title }),
                  nodeId: node.data.canonicalNodeId ?? node.id,
                  placementId: node.data.placementId ?? null,
                  sourceText: node.data.summary,
                  target: { kind: "node_text", node_id: node.data.canonicalNodeId ?? node.id }
                }}
                onLaunch={setStyleLaunch}
              />
            ) : null}
          </span>
          <textarea aria-label={tr("common.text")} className="mt-1 min-h-40 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" onChange={(event) => setDraft((current) => ({ ...current, summary: event.target.value }))} value={draft.summary} />
        </div>
        <LabeledInput label={tr("common.tags")} onChange={(value) => setDraft((current) => ({ ...current, tags: value.split(",").map((tag) => tag.trim()).filter(Boolean) }))} value={draft.tags.join(", ")} />
        {engineTagContext ? <EngineTagPicker
          owners={[{ kind: "node", project_id: engineTagContext.projectId, node_id: node.data.canonicalNodeId ?? node.id }]}
          persistence={engineTagContext.persistence}
          sessionId={engineTagContext.sessionId}
          suggestionDescription={node.data.summary}
          suggestionLabel={`${node.data.kind} ${node.data.title}`}
        /> : null}
        {node.data.kind === "Scene" && styleContext ? (
          <SceneStyleSelector
            persistence={styleContext.persistence}
            projectId={styleContext.projectId}
            sceneNodeId={node.data.canonicalNodeId ?? node.id}
            sessionId={styleContext.sessionId}
          />
        ) : null}
        {draft.kind === "Character" ? (
          <section className="semantic-field-editor">
            <LabeledInput label={tr("authoring.role")} onChange={(value) => setDraft((current) => ({ ...current, characterRole: value }))} value={draft.characterRole ?? ""} />
          </section>
        ) : null}
        {draft.kind === "Item" ? (
          <section className="semantic-field-editor">
            <LabeledInput label={tr("authoring.purpose")} onChange={(value) => setDraft((current) => ({ ...current, itemPurpose: value }))} value={draft.itemPurpose ?? ""} />
          </section>
        ) : null}
        {draft.kind === "Condition" ? (
          <section className="causal-node-editor">
            <h3 className="text-sm font-semibold text-purple-800">{tr("authoring.requirement")}</h3>
            <LabeledInput label={tr("common.subject")} onChange={(value) => setDraft((current) => ({ ...current, requirement: { expression: current.requirement?.expression, predicate: current.requirement?.predicate ?? "", subject: value } }))} value={draft.requirement?.subject ?? ""} />
            <label className="block text-sm font-semibold text-slate-700">
              {tr("common.predicate")}
              <textarea className="mt-1 min-h-20 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" onChange={(event) => setDraft((current) => ({ ...current, requirement: { expression: current.requirement?.expression, predicate: event.target.value, subject: current.requirement?.subject ?? "" } }))} value={draft.requirement?.predicate ?? ""} />
            </label>
            <LabeledInput label={tr("common.expressionOptional")} onChange={(value) => setDraft((current) => ({ ...current, requirement: { expression: value, predicate: current.requirement?.predicate ?? "", subject: current.requirement?.subject ?? "" } }))} value={draft.requirement?.expression ?? ""} />
          </section>
        ) : null}
        {draft.kind === "Consequence" ? (
          <section className="causal-node-editor">
            <h3 className="text-sm font-semibold text-rose-800">{tr("authoring.outcome")}</h3>
            <label className="block text-sm font-semibold text-slate-700">
              {tr("common.effect")}
              <textarea className="mt-1 min-h-20 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" onChange={(event) => setDraft((current) => ({ ...current, outcome: { effect: event.target.value, targetNodeIds: current.outcome?.targetNodeIds ?? [] } }))} value={draft.outcome?.effect ?? ""} />
            </label>
            <fieldset>
              <legend className="text-sm font-semibold text-slate-700">{tr("authoring.affectedTargets")}</legend>
              <div className="causal-target-list">
                {projectNodes.filter((candidate) => (candidate.data.canonicalNodeId ?? candidate.id) !== (node.data.canonicalNodeId ?? node.id)).map((candidate) => {
                  const targetId = candidate.data.canonicalNodeId ?? candidate.id;
                  const checked = draft.outcome?.targetNodeIds.includes(targetId) ?? false;
                  return (
                    <label className="causal-target-option" key={targetId}>
                      <input aria-label={tr("authoring.affectNamed", { name: candidate.data.title })} checked={checked} onChange={() => setDraft((current) => {
                        const targetNodeIds = current.outcome?.targetNodeIds ?? [];
                        return { ...current, outcome: { effect: current.outcome?.effect ?? "", targetNodeIds: checked ? targetNodeIds.filter((id) => id !== targetId) : [...targetNodeIds, targetId] } };
                      })} type="checkbox" />
                      <span><strong>{candidate.data.title}</strong><small>{displayNodeKind(candidate.data.kind)}</small></span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          </section>
        ) : null}
        {node.data.kind === "Faction" ? (
          <section className="faction-membership-editor">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-800">{tr("authoring.members")}</h3>
                <p className="text-xs text-slate-500">{tr("authoring.characterCount", { count: members.length })}</p>
              </div>
              <UserPlus className="text-indigo-600" size={18} aria-hidden="true" />
            </div>
            <div className="mt-2 space-y-1" aria-label={tr("authoring.currentFactionMembers")}>
              {members.map((member) => (
                <div className="faction-member-row" key={member.data.canonicalNodeId ?? member.id}>
                  <div className="min-w-0 flex-1">
                    <strong className="block truncate text-sm text-slate-800">{member.data.title}</strong>
                    <span className="block truncate text-xs text-slate-500">{member.data.tags.join(", ") || member.data.summary}</span>
                  </div>
                  <button aria-label={tr("authoring.removeMemberNamed", { faction: node.data.title, member: member.data.title })} className="icon-button" onClick={() => setMembershipNotice(onRemoveMember(member.id).message)} title={tr("authoring.removeMembership")} type="button">
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                </div>
              ))}
              {members.length === 0 ? <p className="text-xs text-slate-500">{tr("authoring.noCharacterMembers")}</p> : null}
            </div>
            <label className="mt-3 block text-sm font-semibold text-slate-700">
              {tr("authoring.findCharacter")}
              <input className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" onChange={(event) => setMemberQuery(event.target.value)} placeholder={tr("authoring.searchEntity")} value={memberQuery} />
            </label>
            <div className="mt-2 max-h-36 space-y-1 overflow-y-auto" aria-label={tr("authoring.availableFactionMembers")}>
              {availableCharacters.map((character) => (
                <button className="faction-character-option" key={character.id} onClick={() => setMembershipNotice(onAddMember(character.id).message)} type="button">
                  <UserPlus size={14} aria-hidden="true" />
                  <span className="min-w-0 flex-1 text-left">
                    <strong className="block truncate">{character.data.title}</strong>
                    <span className="block truncate text-xs text-slate-500">{character.data.tags.join(", ") || character.data.summary}</span>
                  </span>
                </button>
              ))}
              {availableCharacters.length === 0 ? <p className="text-xs text-slate-500">{tr("authoring.noMatchingCharacters")}</p> : null}
            </div>
            {membershipNotice ? <p aria-live="polite" className="mt-2 text-xs font-medium text-slate-600">{membershipNotice}</p> : null}
          </section>
        ) : null}
        <IssueDetailsList issues={issues} />
        {effects}
        <button className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white" type="submit">
          <Save size={16} aria-hidden="true" />
          {tr("common.save")}
        </button>
      </form>
      )}
    </DialogShell>
  );
}

export const QUEST_EXTERNAL_TARGET_KINDS: NarrativeNodeData["kind"][] = ["Event", "Dialogue", "Consequence", "Scene", "Location", "Quest"];

export function EditEdgeDialog({
  edge,
  initialHolderControl,
  issues = [],
  onClose,
  onSave,
  engineTagContext
}: {
  edge: { id?: string; data?: NarrativeEdgeData; label?: ReactNode; source: string; sourceHandle?: string | null; target: string; targetHandle?: string | null };
  initialHolderControl?: ReactNode;
  issues?: NarrativeIssue[];
  onClose: () => void;
  onSave: (draft: EdgeDraft) => void;
  engineTagContext?: { persistence: RuntimeEngineTagPersistence; projectId: string; sessionId: string };
}) {
  const [label, setLabel] = useState(String(edge.data?.label ?? edge.label ?? ""));
  const [relationshipType, setRelationshipType] = useState<NarrativeEdgeType>(relationshipTypeForEdge(edge));

  return (
    <DialogShell onClose={onClose} title={tr("authoring.editEdge")}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({
            label: label.trim(),
            relationshipType,
            source: edge.source,
            sourceHandle: edge.sourceHandle,
            target: edge.target,
            targetHandle: edge.targetHandle
          });
        }}
      >
        <label className="block text-sm font-semibold text-slate-700">
          {tr("authoring.relationshipType")}
          <select className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" onChange={(event) => setRelationshipType(event.target.value as NarrativeEdgeType)} value={relationshipType}>
            {EDGE_TYPES.map((type) => (
              <option key={type} value={type}>
                {displayRelationshipType(type)}
              </option>
            ))}
          </select>
        </label>
        <LabeledInput label={tr("common.label")} onChange={setLabel} value={label} />
        {engineTagContext ? <EngineTagPicker
          owners={[{ kind: "relationship", project_id: engineTagContext.projectId, edge_id: edge.id ?? edge.source }]}
          persistence={engineTagContext.persistence}
          sessionId={engineTagContext.sessionId}
          suggestionLabel={`Relationship ${label || relationshipType} ${edge.source} ${edge.target}`}
        /> : null}
        {relationshipType === "owns" ? initialHolderControl : null}
        <IssueDetailsList issues={issues} />
        <button className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white" type="submit">
          <Save size={16} aria-hidden="true" />
          {tr("common.save")}
        </button>
      </form>
    </DialogShell>
  );
}

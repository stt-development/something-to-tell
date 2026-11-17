import type { Edge } from "@xyflow/react";
import type { NarrativeEdgeData } from "../types";
import type { StoryFlowSnapshot } from "./contracts";

export interface ProgressionCandidate {
  candidate_version: 1;
  fingerprint: string;
  project_id: string;
  edge_id: string;
  source_node_id: string;
  target_node_id: string;
  origin_kind: "relationship" | "dialogue" | "quest";
  label: string;
  condition: string;
  evidence: string[];
  origin_metadata: Record<string, string>;
}

export interface ProgressionDecision {
  decision_version: 1;
  id: string;
  project_id: string;
  fingerprint: string;
  edge_id: string;
  status: "accepted" | "rejected";
  flow_id: string | null;
  transition_id: string | null;
  original_relationship: "preserved" | "removed" | "unchanged";
  candidate: ProgressionCandidate;
}

export interface ProgressionMigrationReview {
  review_version: 1;
  pending: ProgressionCandidate[];
  decisions: ProgressionDecision[];
}

/** Builds offline review candidates from semantic facts, never canvas geometry. */
export function projectProgressionMigrationReview(
  projectId: string,
  edges: Edge<NarrativeEdgeData>[],
  flows: StoryFlowSnapshot[],
  remembered: ProgressionDecision[] = []
): ProgressionMigrationReview {
  const candidates = edges.filter(isEligible).map((edge) => progressionCandidate(projectId, edge));
  const accepted = flows.flatMap((flow) => flow.transitions.flatMap((transition) => {
    const edgeId = transition.metadata.semantic_edge_id;
    const candidate = candidates.find((item) => item.edge_id === edgeId);
    return typeof edgeId === "string" && candidate
      ? [{
          decision_version: 1 as const,
          id: `accepted:${flow.flow.id}:${transition.id}`,
          project_id: projectId,
          fingerprint: candidate.fingerprint,
          edge_id: edgeId,
          status: "accepted" as const,
          flow_id: flow.flow.id,
          transition_id: transition.id,
          original_relationship: "preserved" as const,
          candidate
        }]
      : [];
  }));
  const decisions = [...remembered, ...accepted.filter((item) =>
    !remembered.some((decision) => decision.fingerprint === item.fingerprint)
  )];
  const decided = new Set(decisions.map((item) => item.fingerprint));
  return {
    review_version: 1,
    pending: candidates.filter((item) => !decided.has(item.fingerprint)).sort((left, right) => left.edge_id.localeCompare(right.edge_id)),
    decisions
  };
}

/** Creates the persisted-shape local rejection used by offline review. */
export function rejectProgressionCandidateLocally(candidate: ProgressionCandidate): ProgressionDecision {
  return {
    decision_version: 1,
    id: `rejected:${candidate.fingerprint}`,
    project_id: candidate.project_id,
    fingerprint: candidate.fingerprint,
    edge_id: candidate.edge_id,
    status: "rejected",
    flow_id: null,
    transition_id: null,
    original_relationship: "unchanged",
    candidate
  };
}

/** Records the complete local acceptance after its Flow transition succeeds. */
export function acceptProgressionCandidateLocally(
  candidate: ProgressionCandidate,
  flowId: string,
  transitionId: string,
  preserveRelationship: boolean
): ProgressionDecision {
  return {
    decision_version: 1,
    id: `accepted:${candidate.fingerprint}`,
    project_id: candidate.project_id,
    fingerprint: candidate.fingerprint,
    edge_id: candidate.edge_id,
    status: "accepted",
    flow_id: flowId,
    transition_id: transitionId,
    original_relationship: preserveRelationship ? "preserved" : "removed",
    candidate
  };
}

function isEligible(edge: Edge<NarrativeEdgeData>) {
  return edge.data?.relationshipType === "leads_to"
    || Boolean(edge.data?.dialogueElementId)
    || Boolean(edge.data?.questBranchId);
}

function progressionCandidate(projectId: string, edge: Edge<NarrativeEdgeData>): ProgressionCandidate {
  const originKind = edge.data?.dialogueElementId ? "dialogue" : edge.data?.questBranchId ? "quest" : "relationship";
  const originMetadata: Record<string, string> = {};
  if (edge.data?.dialogueElementId) originMetadata.dialogue_element_id = edge.data.dialogueElementId;
  if (edge.data?.questStageId) originMetadata.quest_stage_id = edge.data.questStageId;
  if (edge.data?.questBranchId) originMetadata.quest_branch_id = edge.data.questBranchId;
  const label = String(edge.data?.label ?? edge.label ?? "");
  const condition = String(edge.data?.condition ?? "");
  const signature = JSON.stringify({
    edge_id: edge.id,
    source_node_id: edge.source,
    target_node_id: edge.target,
    type: edge.data?.relationshipType ?? "",
    label,
    condition,
    origin_metadata: originMetadata
  });
  const evidence = [`Relationship type is ${edge.data?.relationshipType ?? "unknown"}.`];
  if (originKind === "dialogue") evidence.push(`Owned by Dialogue origin ${originMetadata.dialogue_element_id}.`);
  if (originKind === "quest") evidence.push(`Owned by Quest stage ${originMetadata.quest_stage_id ?? "unknown"} branch ${originMetadata.quest_branch_id}.`);
  return {
    candidate_version: 1,
    fingerprint: stableLocalFingerprint(signature),
    project_id: projectId,
    edge_id: edge.id,
    source_node_id: edge.source,
    target_node_id: edge.target,
    origin_kind: originKind,
    label,
    condition,
    evidence,
    origin_metadata: originMetadata
  };
}

function stableLocalFingerprint(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `local-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

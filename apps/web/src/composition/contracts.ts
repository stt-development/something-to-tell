import type { NarrativeNodeKind } from "../types";

/**
 * Frontend mirror of the runtime-owned Phase 3.6 composition schema.
 * Keep this module aligned with services/runtime/stt_runtime/schemas/composition.py
 * until generated shared contracts replace the documented mirror.
 */
export const SCENE_CHILD_KINDS = [
  "Character",
  "Quest",
  "Lore",
  "Location",
  "Dialogue",
  "Faction",
  "Item",
  "Event",
  "Condition",
  "Consequence"
] as const satisfies readonly NarrativeNodeKind[];

export const LOCATION_CHILD_KINDS = [
  "Character",
  "Quest",
  "Lore",
  "Location",
  "Faction",
  "Item",
  "Event",
  "Condition",
  "Consequence"
] as const satisfies readonly NarrativeNodeKind[];

export type SemanticRelationshipType = "contains" | "member_of";
export type PlacementPresentationState = "expanded" | "collapsed";

export interface PlacementPosition {
  x: number;
  y: number;
}

export interface PlacementSize {
  width: number;
  height: number;
}

export interface VisualPlacement {
  placement_version: 1;
  id: string;
  project_id: string;
  container_node_id: string | null;
  canonical_node_id: string;
  position: PlacementPosition;
  size: PlacementSize;
  is_primary: boolean;
  presentation_state: PlacementPresentationState;
  metadata: Record<string, unknown>;
}

export interface SemanticRelationship {
  edge_id: string;
  project_id: string;
  relationship_type: SemanticRelationshipType;
  source_node_id: string;
  target_node_id: string;
  canvas_visibility: "hidden";
  metadata: Record<string, unknown>;
}

export interface ProjectCompositionSnapshot {
  composition_version: 1;
  project_id: string;
  placements: VisualPlacement[];
  semantic_relationships: SemanticRelationship[];
}

export interface CompositionValidationIssue {
  code: "duplicate_id" | "duplicate_scope" | "invalid_child_kind" | "invalid_primary" | "location_cycle" | "project_mismatch" | "self_containment";
  message: string;
  placement_id?: string;
}

export function allowsComposition(containerKind: NarrativeNodeKind, childKind: NarrativeNodeKind): boolean {
  if (containerKind === "Scene") {
    return (SCENE_CHILD_KINDS as readonly NarrativeNodeKind[]).includes(childKind);
  }
  if (containerKind === "Location") {
    return (LOCATION_CHILD_KINDS as readonly NarrativeNodeKind[]).includes(childKind);
  }
  return false;
}

/** Validates project-wide invariants that TypeScript interfaces cannot express. */
export function validateCompositionSnapshot(
  snapshot: ProjectCompositionSnapshot,
  nodeKinds?: ReadonlyMap<string, NarrativeNodeKind>
): CompositionValidationIssue[] {
  const issues: CompositionValidationIssue[] = [];
  const placementIds = new Set<string>();
  const scopes = new Set<string>();
  const primaryCounts = new Map<string, number>();

  for (const placement of snapshot.placements) {
    if (placement.project_id !== snapshot.project_id) {
      issues.push(issue("project_mismatch", "Placement belongs to another project.", placement.id));
    }
    if (placement.container_node_id === placement.canonical_node_id) {
      issues.push(issue("self_containment", "A canonical node cannot be placed inside itself.", placement.id));
    }
    if (placementIds.has(placement.id)) {
      issues.push(issue("duplicate_id", `Duplicate placement id: ${placement.id}`, placement.id));
    }
    placementIds.add(placement.id);
    const scope = `${placement.container_node_id ?? "<root>"}\u0000${placement.canonical_node_id}`;
    if (scopes.has(scope)) {
      issues.push(issue("duplicate_scope", "Canonical node has duplicate placements in one scope.", placement.id));
    }
    scopes.add(scope);
    primaryCounts.set(
      placement.canonical_node_id,
      (primaryCounts.get(placement.canonical_node_id) ?? 0) + Number(placement.is_primary)
    );
  }

  for (const [canonicalNodeId, count] of primaryCounts) {
    if (count !== 1) {
      issues.push(issue("invalid_primary", `Canonical node requires exactly one primary placement: ${canonicalNodeId}`));
    }
  }
  for (const relationship of snapshot.semantic_relationships) {
    if (relationship.project_id !== snapshot.project_id) {
      issues.push(issue("project_mismatch", "Semantic relationship belongs to another project."));
    }
    if (nodeKinds && relationship.relationship_type === "contains") {
      const containerKind = nodeKinds.get(relationship.source_node_id);
      const childKind = nodeKinds.get(relationship.target_node_id);
      if (containerKind && childKind && !allowsComposition(containerKind, childKind)) {
        issues.push(issue("invalid_child_kind", `${containerKind} cannot contain ${childKind}.`));
      }
    }
  }
  if (nodeKinds && hasLocationContainmentCycle(nodeKinds, snapshot.semantic_relationships)) {
    issues.push(issue("location_cycle", "Location containment cannot create a cycle."));
  }
  return issues;
}

/** Detects only Location containment cycles; linked reuse across other scopes is valid. */
export function hasLocationContainmentCycle(
  nodeKinds: ReadonlyMap<string, NarrativeNodeKind>,
  relationships: readonly SemanticRelationship[]
): boolean {
  const adjacency = new Map<string, string[]>();
  for (const relationship of relationships) {
    if (
      relationship.relationship_type === "contains" &&
      nodeKinds.get(relationship.source_node_id) === "Location" &&
      nodeKinds.get(relationship.target_node_id) === "Location"
    ) {
      adjacency.set(relationship.source_node_id, [
        ...(adjacency.get(relationship.source_node_id) ?? []),
        relationship.target_node_id
      ]);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    if ((adjacency.get(nodeId) ?? []).some(visit)) return true;
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };
  return [...adjacency.keys()].some((nodeId) => !visited.has(nodeId) && visit(nodeId));
}

function issue(
  code: CompositionValidationIssue["code"],
  message: string,
  placementId?: string
): CompositionValidationIssue {
  return { code, message, ...(placementId ? { placement_id: placementId } : {}) };
}

import { describe, expect, it } from "vitest";
import {
  allowsComposition,
  hasLocationContainmentCycle,
  type ProjectCompositionSnapshot,
  type SemanticRelationship,
  validateCompositionSnapshot,
  type VisualPlacement
} from "./contracts";

function placement(
  id: string,
  canonicalNodeId: string,
  containerNodeId: string | null,
  isPrimary = false
): VisualPlacement {
  return {
    placement_version: 1,
    id,
    project_id: "project-aurora",
    container_node_id: containerNodeId,
    canonical_node_id: canonicalNodeId,
    position: { x: 120, y: 80 },
    size: { width: 240, height: 140 },
    is_primary: isPrimary,
    presentation_state: "expanded",
    metadata: {}
  };
}

function relationship(edgeId: string, sourceNodeId: string, targetNodeId: string): SemanticRelationship {
  return {
    edge_id: edgeId,
    project_id: "project-aurora",
    relationship_type: "contains",
    source_node_id: sourceNodeId,
    target_node_id: targetNodeId,
    canvas_visibility: "hidden",
    metadata: {}
  };
}

function snapshot(placements: VisualPlacement[], semanticRelationships: SemanticRelationship[] = []): ProjectCompositionSnapshot {
  return {
    composition_version: 1,
    project_id: "project-aurora",
    placements,
    semantic_relationships: semanticRelationships
  };
}

describe("composition contracts", () => {
  it("accepts linked placements in root and multiple container scopes", () => {
    const document = snapshot(
      [
        placement("placement-root", "character-mara", null, true),
        placement("placement-scene", "character-mara", "scene-dock"),
        placement("placement-location", "character-mara", "location-harbor")
      ],
      [relationship("edge-scene-mara", "scene-dock", "character-mara")]
    );

    expect(validateCompositionSnapshot(document)).toEqual([]);
    expect(document.semantic_relationships[0]?.canvas_visibility).toBe("hidden");
  });

  it("reports duplicate placement ownership and invalid primary state", () => {
    const document = snapshot([
      placement("placement-a", "character-mara", "scene-dock", true),
      placement("placement-a", "character-mara", "scene-dock", true)
    ]);

    expect(validateCompositionSnapshot(document).map((entry) => entry.code)).toEqual([
      "duplicate_id",
      "duplicate_scope",
      "invalid_primary"
    ]);
  });

  it("encodes distinct Scene and Location child matrices", () => {
    expect(allowsComposition("Scene", "Dialogue")).toBe(true);
    expect(allowsComposition("Scene", "Scene")).toBe(false);
    expect(allowsComposition("Location", "Location")).toBe(true);
    expect(allowsComposition("Location", "Dialogue")).toBe(false);
    expect(allowsComposition("Location", "Scene")).toBe(false);
    expect(allowsComposition("Faction", "Character")).toBe(false);
  });

  it("allows Location hierarchy and detects direct or indirect cycles", () => {
    const kinds = new Map([
      ["harbor", "Location"],
      ["warehouse", "Location"],
      ["office", "Location"]
    ] as const);
    const hierarchy = [relationship("edge-1", "harbor", "warehouse"), relationship("edge-2", "warehouse", "office")];

    expect(hasLocationContainmentCycle(kinds, hierarchy)).toBe(false);
    expect(hasLocationContainmentCycle(kinds, [...hierarchy, relationship("edge-3", "office", "harbor")])).toBe(true);
  });

  it("rejects invalid imported Location hierarchy against canonical node kinds", () => {
    const document = snapshot(
      [placement("scene", "scene", null, true), placement("harbor", "harbor", null, true), placement("office", "office", null, true)],
      [
        relationship("invalid-scene", "harbor", "scene"),
        relationship("harbor-office", "harbor", "office"),
        relationship("office-harbor", "office", "harbor")
      ]
    );
    const kinds = new Map([
      ["scene", "Scene"],
      ["harbor", "Location"],
      ["office", "Location"]
    ] as const);

    expect(validateCompositionSnapshot(document, kinds).map((entry) => entry.code)).toEqual(["invalid_child_kind", "location_cycle"]);
  });
});

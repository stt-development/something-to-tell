import { describe, expect, it } from "vitest";
import type { Edge } from "@xyflow/react";
import { projectFixture } from "../testFixtures/projectFixtures";
import type { NarrativeEdgeData } from "../types";
import {
  acceptProgressionCandidateLocally,
  projectProgressionMigrationReview,
  rejectProgressionCandidateLocally
} from "./progressionMigration";

const PROJECT_AURORA_STORY_FLOWS = projectFixture("aurora").storyFlows;

const edges: Edge<NarrativeEdgeData>[] = [
  { id: "dialogue", source: "d", target: "e", data: { label: "Act", relationshipType: "leads_to", dialogueElementId: "line" } },
  { id: "quest", source: "q", target: "e", data: { label: "Route", relationshipType: "leads_to", questStageId: "stage", questBranchId: "branch" } },
  { id: "context", source: "a", target: "b", data: { label: "Mentions", relationshipType: "mentions" } }
];

describe("progression migration review", () => {
  it("derives evidence only from semantic edges and omits accepted fingerprints", () => {
    const flows = structuredClone(PROJECT_AURORA_STORY_FLOWS);
    flows[0]!.transitions[0]!.metadata.semantic_edge_id = "dialogue";
    const review = projectProgressionMigrationReview("project-aurora", edges, flows);

    expect(review.pending.map((item) => item.edge_id)).toEqual(["quest"]);
    expect(review.decisions[0]).toMatchObject({ edge_id: "dialogue", status: "accepted" });
    expect(review.pending[0]?.evidence).toContain("Owned by Quest stage stage branch branch.");
  });

  it("remembers a rejection until a semantic source field changes", () => {
    const first = projectProgressionMigrationReview("project", [edges[1]!], []);
    const rejected = rejectProgressionCandidateLocally(first.pending[0]!);
    expect(projectProgressionMigrationReview("project", [edges[1]!], [], [rejected]).pending).toEqual([]);

    const changed = { ...edges[1]!, label: "Changed", data: { ...edges[1]!.data!, label: "Changed" } };
    const next = projectProgressionMigrationReview("project", [changed], [], [rejected]);
    expect(next.pending).toHaveLength(1);
    expect(next.pending[0]?.fingerprint).not.toBe(rejected.fingerprint);
  });

  it("records whether acceptance preserves the original relationship", () => {
    const candidate = projectProgressionMigrationReview("project", [edges[0]!], []).pending[0]!;
    expect(acceptProgressionCandidateLocally(candidate, "flow", "transition", false)).toMatchObject({
      status: "accepted",
      flow_id: "flow",
      transition_id: "transition",
      original_relationship: "removed"
    });
  });
});

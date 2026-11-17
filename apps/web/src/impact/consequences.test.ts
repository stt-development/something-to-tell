import { describe, expect, it } from "vitest";
import type { ImpactFinding } from "@something-to-tell/contracts/impact-analysis";
import type { StoryDocumentProjection } from "../story-flow/storyDocument";
import type { StoryFlowSnapshot } from "../story-flow/contracts";
import { projectImpactExperiences } from "./consequences";

const story = {
  entries: [],
  sections: [{ flowId: "main", node: { id: "gate", data: {} }, via: { id: "to-gate" } }],
  unreachable: []
} as unknown as StoryDocumentProjection;
const flows = [{
  flow: { id: "main" },
  nodes: [{ id: "member-gate", node_id: "gate" }],
  scene_boundaries: []
}] as unknown as StoryFlowSnapshot[];

function finding(id: string, domain: ImpactFinding["domain"], ownerType: string, ownerId: string, contextId: string | null = null): ImpactFinding {
  const target = { owner_type: ownerType, owner_id: ownerId, context_type: contextId ? "flow" : null, context_id: contextId };
  return {
    finding_version: 1,
    id,
    seeds: [],
    target,
    domain,
    direction: "downstream",
    impact_type: "execution",
    propagation: "required",
    distance: 1,
    message_key: "impact.dependency.flowReachability",
    message_parameters: {},
    paths: [{ path_version: 1, direction: "downstream", propagation: "required", resources: [target], dependencies: [] }]
  };
}

describe("projectImpactExperiences", () => {
  it("projects authored owners into Story without duplicating Playback findings", () => {
    const node = finding("node", "graph", "node", "gate");
    const transition = finding("transition", "flow", "flow_transition", "to-gate");
    const playback = finding("playback", "playback", "playback_definition", "main", "main");
    const unrelated = finding("unrelated", "graph", "node", "harbor");

    const projection = projectImpactExperiences([node, transition, playback, unrelated], story, flows);

    expect([...projection.storyFindingIds]).toEqual(["node", "transition"]);
    expect(projection.playbackFindings).toEqual([playback]);
  });
});

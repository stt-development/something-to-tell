import { describe, expect, it } from "vitest";
import type { ImpactAnalysisRun, ImpactFinding } from "@something-to-tell/contracts/impact-analysis";
import type { Edge, Node } from "@xyflow/react";
import type { NarrativeEdgeData, NarrativeNodeData } from "../types";
import { firstHop, projectImpactHighlights } from "./navigation";

const source = { owner_type: "node", owner_id: "hero", context_type: null, context_id: null };
const direct = { owner_type: "edge", owner_id: "relationship", context_type: null, context_id: null };
const transitive = { owner_type: "node", owner_id: "quest", context_type: null, context_id: null };

function finding(id: string, target: typeof direct | typeof transitive, distance: number): ImpactFinding {
  return {
    finding_version: 1,
    id,
    seeds: [{ seed_version: 1, resource: source }],
    target,
    domain: "graph",
    direction: "downstream",
    impact_type: "structural",
    propagation: distance === 1 ? "required" : "conditional",
    distance,
    message_key: `impact.${id}`,
    message_parameters: {},
    paths: [{
      path_version: 1,
      direction: "downstream",
      propagation: "required",
      resources: [source, target],
      dependencies: [{
        dependency_version: 1,
        source,
        target,
        domain: "graph",
        kind: id,
        propagation: "required",
        message_key: `impact.dependency.${id}`,
        message_parameters: {},
        evidence: []
      }]
    }]
  };
}

function run(status: ImpactAnalysisRun["status"] = "completed"): ImpactAnalysisRun {
  const findings = [finding("direct", direct, 1), finding("transitive", transitive, 2)];
  return {
    run_version: 1,
    id: "run",
    project_id: "project",
    saved_revision: 1,
    history_revision: 0,
    source_checksum: "a".repeat(64),
    status,
    request: {
      request_version: 1,
      observed_saved_revision: 1,
      expected_history_revision: 0,
      source_checksum: "a".repeat(64),
      scenario: { scenario_version: 1, type: "selection", intent: "modify", seeds: [{ seed_version: 1, resource: source }] },
      direction: "both",
      domains: ["graph"],
      limits: { limits_version: 1, max_depth: 3, max_paths_per_target: 3, max_targets: 500 }
    },
    findings,
    summary: { summary_version: 1, finding_count: 2, direct_count: 1, transitive_count: 1, propagation: { required: 1, conditional: 1, contextual: 0 }, truncated: false, omitted_count: 0 },
    diagnostics: [],
    started_at: "2026-08-27T10:00:00Z",
    completed_at: "2026-08-27T10:00:01Z"
  };
}

const nodes = [
  { id: "hero", data: { canonicalNodeId: "hero", title: "Hero" } },
  { id: "quest", data: { canonicalNodeId: "quest", title: "Quest" } }
] as Array<Node<NarrativeNodeData>>;
const edges = [{ id: "relationship", source: "hero", target: "quest", data: { label: "starts" } }] as Array<Edge<NarrativeEdgeData>>;

describe("Impact navigation projection", () => {
  it("distinguishes seeds, direct findings, transitive findings, and first-hop explanations", () => {
    const projection = projectImpactHighlights(nodes, edges, run(), "Seed", (item) => item.id);
    expect(projection.nodes.find((node) => node.id === "hero")?.data.impactHighlight).toMatchObject({ role: "seed", preview: "Seed" });
    expect(projection.edges[0]).toMatchObject({ data: { impactHighlight: { role: "direct" } }, style: { stroke: "#dc2626", strokeWidth: 4 } });
    expect(projection.nodes.find((node) => node.id === "quest")?.data.impactHighlight).toMatchObject({ role: "transitive", propagation: "conditional" });
    expect(projection.storyNodes.get("quest")?.role).toBe("transitive");
    expect(firstHop(run().findings[0]!)?.kind).toBe("direct");
  });

  it("does not expose authoritative highlights for stale runs", () => {
    const projection = projectImpactHighlights(nodes, edges, run("stale"), "Seed", (item) => item.id);
    expect(projection.nodes.every((node) => node.data.impactHighlight === undefined)).toBe(true);
    expect(projection.edges[0]?.data?.impactHighlight).toBeUndefined();
    expect(projection.storyNodes.size).toBe(0);
  });
});

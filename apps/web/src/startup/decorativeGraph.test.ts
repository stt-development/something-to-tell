import { describe, expect, it } from "vitest";
import { createDecorativeGraph, STARTUP_GRAPH_BUDGET, STARTUP_GRAPH_SEED } from "./decorativeGraph";

describe("decorative startup graph", () => {
  it("is deterministic for the owned production seed", () => {
    const first = createDecorativeGraph(STARTUP_GRAPH_SEED);
    const second = createDecorativeGraph(STARTUP_GRAPH_SEED);

    expect(second).toEqual(first);
    expect(first.nodes.slice(0, 2)).toEqual([
      expect.objectContaining({ id: "decorative-0-0", kind: "quest" }),
      expect.objectContaining({ id: "decorative-0-1", kind: "event" })
    ]);
  });

  it("stays inside the documented node and edge budget with branches and both edge semantics", () => {
    const graph = createDecorativeGraph();
    const nodeIds = new Set(graph.nodes.map((node) => node.id));

    expect(graph.nodes).toHaveLength(STARTUP_GRAPH_BUDGET.nodes);
    expect(graph.edges).toHaveLength(STARTUP_GRAPH_BUDGET.edges);
    expect(graph.edges.filter((edge) => edge.id.startsWith("branch-"))).toHaveLength(8);
    expect(new Set(graph.edges.map((edge) => edge.kind))).toEqual(new Set(["relationship", "story"]));
    expect(graph.edges.every((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))).toBe(true);
    expect(graph.nodes.every((node) => node.x >= 0 && node.y >= 0 && node.y + node.height <= graph.worldHeight)).toBe(true);
  });

  it("changes layout for a different seed without changing the budget", () => {
    const original = createDecorativeGraph();
    const alternative = createDecorativeGraph(STARTUP_GRAPH_SEED + 1);

    expect(alternative.nodes).toHaveLength(original.nodes.length);
    expect(alternative.edges).toHaveLength(original.edges.length);
    expect(alternative.nodes).not.toEqual(original.nodes);
  });
});

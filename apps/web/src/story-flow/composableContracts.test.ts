import {
  orderOutgoingRoutes,
  type ComposableFlowGraph,
  type ComposableFlowTransition,
  type FlowExit,
  type FlowExitBinding,
  type FlowInvocation,
  validateComposableFlowGraph
} from "@something-to-tell/contracts/composable-story-flow";
import { describe, expect, it } from "vitest";

const timestamp = "2026-08-03T10:00:00Z";

function invocation(updates: Partial<FlowInvocation> = {}): FlowInvocation {
  return {
    invocation_version: 1,
    id: "invocation-side",
    project_id: "project-composable",
    source_flow_id: "flow-main",
    source_node_id: "main-start",
    target_flow_id: "flow-side",
    label: "Enter side story",
    condition: "",
    priority: 0,
    is_default: false,
    created_at: timestamp,
    updated_at: timestamp,
    ...updates
  };
}

function flowExit(updates: Partial<FlowExit> = {}): FlowExit {
  return {
    exit_version: 1,
    id: "exit-side-success",
    project_id: "project-composable",
    flow_id: "flow-side",
    key: "success",
    label: "Success",
    source_node_id: "side-end",
    created_at: timestamp,
    updated_at: timestamp,
    ...updates
  };
}

function binding(updates: Partial<FlowExitBinding> = {}): FlowExitBinding {
  return {
    binding_version: 1,
    id: "binding-side-success",
    project_id: "project-composable",
    invocation_id: "invocation-side",
    exit_id: "exit-side-success",
    target_node_id: "main-return",
    created_at: timestamp,
    updated_at: timestamp,
    ...updates
  };
}

function transition(updates: Partial<ComposableFlowTransition> = {}): ComposableFlowTransition {
  return {
    id: "transition-main-return",
    project_id: "project-composable",
    flow_id: "flow-main",
    source_node_id: "main-start",
    target_node_id: "main-return",
    condition: "",
    priority: 1,
    is_default: false,
    ...updates
  };
}

function validGraph(): ComposableFlowGraph {
  return {
    composition_version: 1,
    project_id: "project-composable",
    flows: [
      { id: "flow-main", project_id: "project-composable", entry_node_id: "main-start" },
      { id: "flow-side", project_id: "project-composable", entry_node_id: "side-start" },
      { id: "flow-other", project_id: "project-composable", entry_node_id: "other-start" }
    ],
    memberships: [
      { id: "member-main-start", project_id: "project-composable", flow_id: "flow-main", node_id: "main-start" },
      { id: "member-main-return", project_id: "project-composable", flow_id: "flow-main", node_id: "main-return" },
      { id: "member-side-start", project_id: "project-composable", flow_id: "flow-side", node_id: "side-start" },
      { id: "member-side-end", project_id: "project-composable", flow_id: "flow-side", node_id: "side-end" },
      { id: "member-other-start", project_id: "project-composable", flow_id: "flow-other", node_id: "other-start" },
      { id: "member-other-end", project_id: "project-composable", flow_id: "flow-other", node_id: "other-end" }
    ],
    transitions: [transition()],
    invocations: [invocation()],
    exits: [flowExit()],
    bindings: [binding()]
  };
}

describe("composable Story Flow contracts", () => {
  it("accepts one owned invocation, named exit, and immediate-caller return", () => {
    expect(validateComposableFlowGraph(validGraph())).toEqual([]);
  });

  it("shares deterministic priority/default ordering without mutating inputs", () => {
    const transitions = [transition({ priority: 2 }), transition({ id: "transition-first", priority: 0 })];
    const invocations = [invocation({ priority: 1 })];
    const before = structuredClone({ transitions, invocations });

    expect(orderOutgoingRoutes(transitions, invocations).map((route) => route.id)).toEqual([
      "transition-first",
      "invocation-side",
      "transition-main-return"
    ]);
    expect({ transitions, invocations }).toEqual(before);

    const graph = validGraph();
    graph.transitions[0]!.priority = 0;
    expect(validateComposableFlowGraph(graph).map((issue) => issue.code)).toContain("duplicate_priority");
  });

  it("reports ownership, membership, entry, and terminal-exit violations", () => {
    const graph = validGraph();
    graph.invocations[0]!.project_id = "project-other";
    graph.invocations[0]!.source_node_id = "missing";
    graph.flows[1]!.entry_node_id = null;
    graph.transitions.push(transition({ id: "side-continues", flow_id: "flow-side", source_node_id: "side-end", target_node_id: "side-start" }));

    expect(validateComposableFlowGraph(graph).map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "owner_mismatch",
      "invalid_invocation_source",
      "invalid_entry",
      "terminal_exit_continues"
    ]));
  });

  it("detects indirect call cycles", () => {
    const graph = validGraph();
    graph.transitions = [];
    graph.invocations.push(
      invocation({ id: "invocation-other", source_flow_id: "flow-side", source_node_id: "side-start", target_flow_id: "flow-other" }),
      invocation({ id: "invocation-main", source_flow_id: "flow-other", source_node_id: "other-start", target_flow_id: "flow-main" })
    );

    expect(validateComposableFlowGraph(graph).map((issue) => issue.code)).toContain("flow_cycle");
  });

  it("requires unique exit keys and call-site mappings to matching callee exits", () => {
    const graph = validGraph();
    graph.exits.push(flowExit({ id: "exit-copy" }));
    graph.bindings.push(binding({ id: "binding-copy" }));
    graph.bindings.push(binding({ id: "binding-wrong", exit_id: "exit-other" }));
    graph.exits.push(flowExit({ id: "exit-other", flow_id: "flow-other", source_node_id: "other-end", key: "failure" }));

    expect(validateComposableFlowGraph(graph).map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "duplicate_exit_key",
      "duplicate_binding",
      "invalid_binding_exit"
    ]));
  });
});

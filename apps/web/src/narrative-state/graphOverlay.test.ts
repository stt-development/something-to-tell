import type { Edge, Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import type { NarrativeEdgeData, NarrativeNodeData } from "../types";
import type { TemporalEffectPresentation } from "./projection";
import { projectTemporalGraphOverlay, temporalOwnerForGraphSelection } from "./graphOverlay";

const nodes: Node<NarrativeNodeData>[] = [
  { id: "mara", position: { x: 0, y: 0 }, data: { kind: "Character", title: "Mara", label: "Mara", summary: "", tags: [] } },
  { id: "ledger", position: { x: 0, y: 0 }, data: { kind: "Item", title: "Ledger", label: "Ledger", summary: "", tags: [] } }
];
const flowEdge: Edge<NarrativeEdgeData> = { id: "story-flow:transition-1", source: "mara", target: "ledger", data: { label: "Present", flowTransition: { flowId: "flow", transitionId: "transition-1", kind: "next", priority: 0, isDefault: false, condition: "" } } };

describe("temporal Graph overlay", () => {
  it("maps node and Flow selections but ignores semantic relationships", () => {
    const semantic: Edge<NarrativeEdgeData> = { id: "owns", source: "mara", target: "ledger", data: { label: "owns", relationshipType: "owns" } };

    expect(temporalOwnerForGraphSelection({ type: "node", id: "mara" }, nodes, [semantic, flowEdge])).toMatchObject({ owner_kind: "node_entry", owner_id: "mara" });
    expect(temporalOwnerForGraphSelection({ type: "edge", id: flowEdge.id }, nodes, [semantic, flowEdge])).toMatchObject({ owner_kind: "flow_transition", owner_id: "transition-1" });
    expect(temporalOwnerForGraphSelection({ type: "edge", id: semantic.id }, nodes, [semantic, flowEdge])).toBeNull();
  });

  it("keeps only the final repeated Item holder as a distinct non-authored edge", () => {
    const first = transfer("binding-1", "mara");
    const second = transfer("binding-2", "mara");
    const authored = [flowEdge];
    const overlay = projectTemporalGraphOverlay([first, second], nodes);

    expect(overlay.edges).toHaveLength(1);
    expect(overlay.edges[0]).toMatchObject({ id: "temporal-state:binding-2", source: "mara", target: "ledger", reconnectable: false, selectable: false, data: { temporalStateOverlay: { effectId: "effect-binding-2" } } });
    expect(overlay.affectedNodeIds).toEqual(new Set(["ledger", "mara"]));
    expect(authored).toEqual([flowEdge]);
  });
});

function transfer(bindingId: string, holderId: string): TemporalEffectPresentation {
  const owner = { owner_version: 1 as const, owner_kind: "flow_transition" as const, owner_id: "transition-1" };
  const effect = { effect_version: 1 as const, id: `effect-${bindingId}`, project_id: "project", operation: "transfer_item" as const, payload: { item_node_id: "ledger", from_holder: { holder_version: 1 as const, kind: "unowned" as const }, to_holder: { holder_version: 1 as const, kind: "character" as const, node_id: holderId } }, repeat_policy: "once" as const, explanation: "Mara holds the Ledger." };
  return { affectedNodeIds: ["ledger", holderId], affectedNodeTitles: { ledger: "Ledger", [holderId]: "Mara" }, after: { kind: "holder", holder: effect.payload.to_holder }, before: { kind: "holder", holder: effect.payload.from_holder }, bindingId, effect, owner, subjectId: "ledger", subjectTitle: "Ledger" };
}

import type { NarrativeEffectBinding, NarrativeEffectDefinition, NarrativeEffectOwnerRef } from "@something-to-tell/contracts/narrative-state";
import { describe, expect, it } from "vitest";
import { domainDraftFromEffect, effectFromDomainDraft, effectsForOwner, moveEffectBinding } from "./editor";

const owner: NarrativeEffectOwnerRef = { owner_version: 1, owner_kind: "flow_transition", owner_id: "route-1" };

function effect(id: string): NarrativeEffectDefinition {
  return {
    effect_version: 1,
    id,
    project_id: "project-1",
    operation: "set_flag",
    payload: { flag: id },
    repeat_policy: "once",
    explanation: id
  };
}

function binding(id: string, effectId: string, order: number): NarrativeEffectBinding {
  return { binding_version: 1, id, project_id: "project-1", effect_id: effectId, owner, application_order: order };
}

describe("domain effect editor model", () => {
  it("maps author verbs to typed runtime operations and rehydrates them", () => {
    const authored = effectFromDomainDraft({
      action: "give_item",
      itemNodeId: "ledger",
      fromHolder: { holder_version: 1, kind: "character", node_id: "ilya" },
      toHolder: { holder_version: 1, kind: "character", node_id: "mara" },
      flag: "",
      questNodeId: "",
      questStatus: "inactive",
      dialogueNodeId: "",
      choiceId: "",
      repeatPolicy: "once",
      explanation: " Mara receives the ledger. "
    }, "project-1", "effect-ledger");

    expect(authored).toMatchObject({
      operation: "transfer_item",
      explanation: "Mara receives the ledger.",
      payload: { item_node_id: "ledger" }
    });
    expect(domainDraftFromEffect(authored)).toMatchObject({
      action: "move_item",
      itemNodeId: "ledger",
      explanation: "Mara receives the ledger."
    });
  });

  it("filters by stable owner identity and preserves application order", () => {
    const other: NarrativeEffectOwnerRef = { owner_version: 1, owner_kind: "node_entry", owner_id: "node-1" };
    const bindings = [binding("b2", "e2", 1), binding("b1", "e1", 0), { ...binding("other", "e3", 0), owner: other }];

    expect(effectsForOwner(owner, bindings, [effect("e3"), effect("e2"), effect("e1")]).map(({ effect: item }) => item.id)).toEqual(["e1", "e2"]);
  });

  it("creates a complete contiguous reorder batch without mutating bindings", () => {
    const bindings = [binding("b1", "e1", 0), binding("b2", "e2", 1), binding("b3", "e3", 2)];
    const before = structuredClone(bindings);

    expect(moveEffectBinding(bindings, "b2", -1)).toEqual([
      { binding_id: "b2", application_order: 0 },
      { binding_id: "b1", application_order: 1 },
      { binding_id: "b3", application_order: 2 }
    ]);
    expect(bindings).toEqual(before);
  });
});

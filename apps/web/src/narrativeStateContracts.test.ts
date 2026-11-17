import {
  validateNarrativeStateContract,
  type NarrativeEffectOwnerRef,
  type NarrativeStateContract
} from "@something-to-tell/contracts/narrative-state";
import { describe, expect, it } from "vitest";

const PROJECT_ID = "project-aurora";

function validContract(): NarrativeStateContract {
  const owners: NarrativeEffectOwnerRef[] = [
    { owner_version: 1, owner_kind: "node_entry", owner_id: "node-character" },
    { owner_version: 1, owner_kind: "flow_transition", owner_id: "transition-1" },
    { owner_version: 1, owner_kind: "dialogue_element", owner_id: "line-1", context_node_id: "node-dialogue" },
    { owner_version: 1, owner_kind: "dialogue_option", owner_id: "option-1", context_node_id: "node-dialogue" },
    { owner_version: 1, owner_kind: "quest_branch", owner_id: "branch-1", context_node_id: "node-quest" },
    { owner_version: 1, owner_kind: "quest_outcome", owner_id: "outcome-1", context_node_id: "node-quest" },
    { owner_version: 1, owner_kind: "flow_invocation", owner_id: "invocation-1" },
    { owner_version: 1, owner_kind: "flow_exit", owner_id: "exit-1" }
  ];
  return {
    contract_version: 1,
    project_id: PROJECT_ID,
    canonical_nodes: [
      { id: "node-character", project_id: PROJECT_ID, type: "Character" },
      { id: "node-location", project_id: PROJECT_ID, type: "Location" },
      { id: "node-faction", project_id: PROJECT_ID, type: "Faction" },
      { id: "node-item", project_id: PROJECT_ID, type: "Item" },
      { id: "node-quest", project_id: PROJECT_ID, type: "Quest" },
      { id: "node-dialogue", project_id: PROJECT_ID, type: "Dialogue" }
    ],
    flows: [{ id: "flow-main", project_id: PROJECT_ID }],
    owners: owners.map((owner) => ({ project_id: PROJECT_ID, owner })),
    initial_states: [{
      state_version: 1,
      project_id: PROJECT_ID,
      flow_id: "flow-main",
      flags: { harbor_open: false },
      item_custody: [{
        custody_version: 1,
        item_node_id: "node-item",
        holder: { holder_version: 1, kind: "faction", node_id: "node-faction" }
      }],
      quest_statuses: { "node-quest": "active" }
    }],
    effects: [
      {
        effect_version: 1,
        id: "effect-transfer",
        project_id: PROJECT_ID,
        operation: "transfer_item",
        payload: {
          item_node_id: "node-item",
          from_holder: { holder_version: 1, kind: "character", node_id: "node-character" },
          to_holder: { holder_version: 1, kind: "location", node_id: "node-location" }
        },
        repeat_policy: "once",
        explanation: "Mara leaves the ledger at the harbor office."
      },
      {
        effect_version: 1,
        id: "effect-quest",
        project_id: PROJECT_ID,
        operation: "set_quest_status",
        payload: { quest_node_id: "node-quest", status: "completed" },
        repeat_policy: "once",
        explanation: "Complete the route quest."
      },
      {
        effect_version: 1,
        id: "effect-choice",
        project_id: PROJECT_ID,
        operation: "record_dialogue_choice",
        payload: { dialogue_node_id: "node-dialogue", choice_id: "option-1" },
        repeat_policy: "once",
        explanation: "Record the selected answer."
      }
    ],
    bindings: owners.map((owner, index) => ({
      binding_version: 1,
      id: `binding-${index}`,
      project_id: PROJECT_ID,
      effect_id: index % 2 === 0 ? "effect-transfer" : "effect-quest",
      owner,
      application_order: 0
    }))
  };
}

describe("Phase 3.11 narrative state contracts", () => {
  it("accepts every stable owner kind without mutating the mirrored contract", () => {
    const contract = validContract();
    const before = structuredClone(contract);

    expect(validateNarrativeStateContract(contract)).toEqual([]);
    expect(contract).toEqual(before);
    expect(new Set(contract.owners.map(({ owner }) => owner.owner_kind))).toEqual(new Set([
      "node_entry",
      "flow_transition",
      "dialogue_element",
      "dialogue_option",
      "quest_branch",
      "quest_outcome",
      "flow_invocation",
      "flow_exit"
    ]));
  });

  it("reports project ownership and canonical node type violations", () => {
    const contract = validContract();
    contract.canonical_nodes[0]!.project_id = "project-other";
    contract.initial_states[0]!.item_custody[0]!.item_node_id = "node-character";
    const questEffect = contract.effects[1]!;
    if (questEffect.operation !== "set_quest_status") throw new Error("fixture must contain a Quest effect");
    questEffect.payload.quest_node_id = "node-item";

    expect(validateNarrativeStateContract(contract)).toEqual(expect.arrayContaining([
      { code: "owner_mismatch", record_id: "node-character" },
      { code: "invalid_node_type", record_id: "node-character" },
      { code: "invalid_node_type", record_id: "effect-quest" }
    ]));
  });

  it("reports transfer holder and precondition violations", () => {
    const contract = validContract();
    const transfer = contract.effects[0]!;
    if (transfer.operation !== "transfer_item") throw new Error("fixture must begin with transfer_item");
    const invalidHolder = {
      holder_version: 1,
      kind: "player",
      node_id: "node-character"
    } as unknown as typeof transfer.payload.from_holder;
    transfer.payload.from_holder = invalidHolder;
    transfer.payload.to_holder = invalidHolder;

    expect(validateNarrativeStateContract(contract)).toEqual(expect.arrayContaining([
      { code: "invalid_holder", record_id: "effect-transfer" },
      { code: "same_transfer_holder", record_id: "effect-transfer" }
    ]));
  });

  it("requires existing effects and owners with a unique deterministic order", () => {
    const contract = validContract();
    contract.bindings[0]!.effect_id = "effect-missing";
    contract.bindings[1]!.owner = contract.bindings[0]!.owner;
    contract.bindings[1]!.application_order = contract.bindings[0]!.application_order;
    contract.bindings[2]!.owner = { owner_version: 1, owner_kind: "flow_exit", owner_id: "exit-missing" };

    expect(validateNarrativeStateContract(contract)).toEqual(expect.arrayContaining([
      { code: "missing_effect", record_id: "binding-0" },
      { code: "duplicate_application_order", record_id: "binding-1" },
      { code: "missing_owner", record_id: "binding-2" }
    ]));
  });
});

import type { NarrativeEffectOwnerRef } from "@something-to-tell/contracts/narrative-state";
import type { Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import type { NarrativeNodeData } from "../types";
import type { NarrativeStateSnapshot } from "./contracts";
import { projectTemporalState, temporalEffectsForOwner } from "./projection";

const timestamp = "2026-08-07T10:00:00Z";
const nodes: Node<NarrativeNodeData>[] = [
  { id: "ledger", position: { x: 0, y: 0 }, data: { kind: "Item", title: "Sealed Ledger", label: "Ledger", summary: "", tags: [] } },
  { id: "ilya", position: { x: 0, y: 0 }, data: { kind: "Character", title: "Ilya", label: "Ilya", summary: "", tags: [] } },
  { id: "mara", position: { x: 0, y: 0 }, data: { kind: "Character", title: "Mara", label: "Mara", summary: "", tags: [] } },
  { id: "quest", position: { x: 0, y: 0 }, data: { kind: "Quest", title: "Ledger route", label: "Quest", summary: "", tags: [] } }
];
const owner: NarrativeEffectOwnerRef = { owner_version: 1, owner_kind: "flow_transition", owner_id: "transition-1" };

function snapshot(): NarrativeStateSnapshot {
  return {
    project_id: "project",
    initial_states: [{ id: "state", state_version: 1, project_id: "project", flow_id: "flow", flags: {}, item_custody: [], quest_statuses: { quest: "active" }, created_at: timestamp, updated_at: timestamp }],
    effects: [
      { effect_version: 1, id: "move-1", project_id: "project", operation: "transfer_item", payload: { item_node_id: "ledger", from_holder: { holder_version: 1, kind: "character", node_id: "ilya" }, to_holder: { holder_version: 1, kind: "character", node_id: "mara" } }, repeat_policy: "once", explanation: "Mara receives the ledger." },
      { effect_version: 1, id: "move-2", project_id: "project", operation: "transfer_item", payload: { item_node_id: "ledger", from_holder: { holder_version: 1, kind: "character", node_id: "mara" }, to_holder: { holder_version: 1, kind: "player" } }, repeat_policy: "once", explanation: "The player receives the ledger." },
      { effect_version: 1, id: "quest-effect", project_id: "project", operation: "set_quest_status", payload: { quest_node_id: "quest", status: "completed" }, repeat_policy: "once", explanation: "The route is complete." }
    ],
    bindings: [
      { id: "binding-1", binding_version: 1, project_id: "project", effect_id: "move-1", owner, application_order: 0, created_at: timestamp, updated_at: timestamp },
      { id: "binding-2", binding_version: 1, project_id: "project", effect_id: "move-2", owner, application_order: 1, created_at: timestamp, updated_at: timestamp },
      { id: "binding-3", binding_version: 1, project_id: "project", effect_id: "quest-effect", owner, application_order: 2, created_at: timestamp, updated_at: timestamp }
    ],
    integrity: { project_id: "project", facts: [] }
  };
}

describe("temporal state presentation projection", () => {
  it("degrades an incomplete runtime response to an empty presentation", () => {
    expect(projectTemporalState({ project_id: "project" } as NarrativeStateSnapshot, nodes)).toEqual({ byOwner: new Map(), effects: [] });
  });

  it("keeps repeated Item transfers ordered with explicit before and after holders", () => {
    const projection = projectTemporalState(snapshot(), nodes);
    const effects = temporalEffectsForOwner(projection, owner);

    expect(effects.map((item) => item.effect.id)).toEqual(["move-1", "move-2", "quest-effect"]);
    expect(effects[0]).toMatchObject({ subjectTitle: "Sealed Ledger", before: { holder: { node_id: "ilya" } }, after: { holder: { node_id: "mara" } }, affectedNodeIds: ["ledger", "ilya", "mara"] });
    expect(effects[1]).toMatchObject({ before: { holder: { node_id: "mara" } }, after: { holder: { kind: "player" } } });
    expect(effects[2]).toMatchObject({ before: { value: "active" }, after: { value: "completed" } });
  });

  it("keeps branch owners independent instead of executing one display branch into another", () => {
    const value = snapshot();
    const branchOwner: NarrativeEffectOwnerRef = { owner_version: 1, owner_kind: "flow_transition", owner_id: "transition-branch" };
    value.bindings[1] = { ...value.bindings[1]!, owner: branchOwner, application_order: 0 };
    const projection = projectTemporalState(value, nodes);

    expect(temporalEffectsForOwner(projection, owner).map((item) => item.effect.id)).toEqual(["move-1", "quest-effect"]);
    expect(temporalEffectsForOwner(projection, branchOwner)[0]?.before).toEqual({ kind: "holder", holder: { holder_version: 1, kind: "character", node_id: "mara" } });
  });
});

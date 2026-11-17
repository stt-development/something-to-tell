import { describe, expect, it } from "vitest";
import { effectApplicationFixtures } from "./effectApplicationFixtures";

describe("playback effect application fixtures", () => {
  it("exposes ordered runtime state changes for presentation", () => {
    const result = effectApplicationFixtures.applied;

    expect(result.success).toBe(true);
    expect(result.changes.map((change) => change.path)).toEqual([
      "flags.gate_open",
      "inventory.item-citadel-key"
    ]);
    expect(result.state_after.applied_effect_ids).toEqual(["effect-gate", "effect-key"]);
  });

  it("exposes an unchanged atomic boundary when runtime rejects a batch", () => {
    const result = effectApplicationFixtures.rejected;

    expect(result.success).toBe(false);
    expect(result.state_after).toEqual(result.state_before);
    expect(result.applied_effect_ids).toEqual([]);
    expect(result.changes).toEqual([]);
    expect(result.facts[0]?.code).toBe("conflicting_effects");
  });
});

import { describe, expect, it } from "vitest";
import { conditionResultFixtures } from "./conditionResultFixtures";

describe("playback condition result fixtures", () => {
  it("exposes the runtime explanation tree without frontend evaluation", () => {
    const result = conditionResultFixtures.eligible;

    expect(result.status).toBe("true");
    expect(result.children.map((child) => child.expression)).toEqual([
      "flags.route_open",
      '"show_key" in dialogue.dialogue-gate.choices'
    ]);
  });

  it("preserves stable runtime diagnostics for presentation", () => {
    const result = conditionResultFixtures.unknownQuest;

    expect(result.value).toBeNull();
    expect(result.diagnostic_code).toBe("unknown_condition_path");
    expect(result.message).toBe("Unknown playback state path: quests.quest-missing.status.");
  });
});

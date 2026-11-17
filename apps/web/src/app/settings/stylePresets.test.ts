import { describe, expect, it } from "vitest";
import { stylePresetDraft, stylePresets } from "./stylePresets";

describe("built-in style presets", () => {
  it("publishes the same stable catalog in both content languages", () => {
    expect(stylePresets("en").map((preset) => preset.id)).toEqual([
      "balanced-narrative",
      "cinematic-tension",
      "literary-introspection",
      "light-comedy",
      "gothic-horror",
      "cosmic-horror",
      "psychological-horror",
      "hard-science-fiction",
      "space-opera",
      "epic-fantasy",
      "dark-fantasy"
    ]);
    expect(stylePresets("ru").map((preset) => preset.id)).toEqual(
      stylePresets("en").map((preset) => preset.id)
    );
  });

  it("localizes authored guidance by content locale", () => {
    expect(stylePresetDraft("cinematic-tension", "en")?.name).toBe("Cinematic tension");
    expect(stylePresetDraft("cinematic-tension", "ru")?.name).toBe("Кинематографическое напряжение");
    expect(stylePresetDraft("cosmic-horror", "en")?.name).toBe("Cosmic horror");
    expect(stylePresetDraft("cosmic-horror", "ru")?.name).toBe("Космический хоррор");
    expect(stylePresetDraft("hard-science-fiction", "ru")?.guidance).toContain("правила");
    expect(stylePresetDraft("epic-fantasy", "en")?.traits.tone).toContain("wondrous");
  });

  it("keeps every genre preset complete in both content languages", () => {
    for (const locale of ["en", "ru"] as const) {
      for (const preset of stylePresets(locale)) {
        expect(preset.draft.name.trim()).not.toBe("");
        expect(preset.draft.description.trim()).not.toBe("");
        expect(preset.draft.guidance.trim()).not.toBe("");
        expect(preset.draft.traits.tone.length).toBeGreaterThan(0);
        expect(preset.draft.positive_examples[0]?.trim()).not.toBe("");
      }
    }
  });

  it("returns defensive copies for project-owned editing", () => {
    const first = stylePresetDraft("balanced-narrative", "en");
    expect(first).not.toBeNull();
    first!.traits.tone.push("mutated");
    first!.positive_examples[0] = "Changed";

    const fresh = stylePresetDraft("balanced-narrative", "en");
    expect(fresh?.traits.tone).toEqual(["clear", "grounded"]);
    expect(fresh?.positive_examples[0]).toContain("Mara checked the seal");
  });
});

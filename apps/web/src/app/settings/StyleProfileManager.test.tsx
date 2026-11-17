import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { StyleCatalogV1, StyleProfileV1 } from "@something-to-tell/contracts/style-system";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18next } from "../../localization/i18n";
import type { RuntimeStylePersistence } from "../../runtime/apiTypes";
import { emptyStyleProfileDraft, StyleProfileFields, StyleProfileManager } from "./StyleProfileManager";

it("does not steal focus when an existing profile loads asynchronously", () => {
  const view = render(<input aria-label="Project name draft" />);
  const input = screen.getByLabelText("Project name draft"); input.focus();
  view.rerender(<><input aria-label="Project name draft" /><StyleProfileFields contentLocale="en" draft={emptyStyleProfileDraft()} onChange={() => {}} /></>);
  expect(screen.getByLabelText("Project name draft")).toHaveFocus();
});

const profile: StyleProfileV1 = {
  style_profile_version: 1,
  id: "style-default",
  project_id: "project-one",
  name: "Restrained",
  description: "Quiet descriptive prose.",
  guidance: "Prefer concrete verbs.",
  traits: {
    traits_version: 1,
    tone: ["quiet"],
    rhythm: [],
    pacing: [],
    vocabulary: [],
    dramatic_intensity: null
  },
  positive_examples: ["The latch settles."],
  created_at: "2026-09-07T10:00:00Z",
  updated_at: "2026-09-07T10:00:00Z"
};

function catalog(overrides: Partial<StyleCatalogV1> = {}): StyleCatalogV1 {
  return {
    catalog_version: 1,
    project_id: "project-one",
    default_style_profile_id: profile.id,
    profiles: [profile],
    scene_assignments: [],
    ...overrides
  };
}

function persistence(source = catalog(), usesProjectDefault = false) {
  return {
    loadStyleCatalog: vi.fn().mockResolvedValue(source),
    createStyleProfile: vi.fn(async (value: StyleProfileV1) => value),
    updateStyleProfile: vi.fn(async (value: StyleProfileV1) => value),
    inspectStyleProfileDeletionImpact: vi.fn().mockResolvedValue({
      impact_version: 1,
      profile_id: profile.id,
      uses_project_default: usesProjectDefault,
      scene_node_ids: ["scene-one"]
    }),
    deleteStyleProfile: vi.fn().mockResolvedValue(undefined)
  } as unknown as RuntimeStylePersistence;
}

describe("StyleProfileManager", () => {
  beforeEach(async () => {
    await i18next.changeLanguage("en");
  });

  it("edits a profile, signals an unsaved draft, and saves through the runtime", async () => {
    const runtime = persistence();
    const onDefaultChange = vi.fn();
    render(
      <StyleProfileManager
        activeSessionId="session-one"
        contentLocale="en"
        defaultStyleProfileId={profile.id}
        onDefaultChange={onDefaultChange}
        persistence={runtime}
        projectId="project-one"
      />
    );

    const guidance = await screen.findByLabelText("Style guidance");
    fireEvent.change(guidance, { target: { value: "Use concrete verbs and short clauses." } });
    expect(screen.getByText("Unsaved profile edits")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(runtime.updateStyleProfile).toHaveBeenCalledWith(
      expect.objectContaining({ guidance: "Use concrete verbs and short clauses." })
    ));
    fireEvent.change(screen.getByLabelText("Project default style"), { target: { value: "" } });
    expect(onDefaultChange).toHaveBeenCalledWith(null);
  });

  it("shows assignment impact before deleting the project default", async () => {
    const runtime = persistence(catalog(), true);
    render(
      <StyleProfileManager
        activeSessionId="session-one"
        contentLocale="en"
        defaultStyleProfileId={profile.id}
        onDefaultChange={vi.fn()}
        persistence={runtime}
        projectId="project-one"
      />
    );
    fireEvent.click(await screen.findByRole("button", { name: "Delete style profile" }));
    const warning = await screen.findByText("This is the project default and is assigned to 1 Scenes. Choose how to replace its references.");
    expect(warning).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("renders the compact management flow in Russian", async () => {
    await i18next.changeLanguage("ru");
    render(
      <StyleProfileManager
        activeSessionId="session-one"
        contentLocale="ru"
        defaultStyleProfileId={profile.id}
        onDefaultChange={vi.fn()}
        persistence={persistence()}
        projectId="project-one"
      />
    );
    expect(await screen.findByText("Стили текста")).toBeInTheDocument();
    expect(screen.getByLabelText("Стиль проекта по умолчанию")).toBeInTheDocument();
  });

  it("uses content language rather than UI language for a base preset", () => {
    const onChange = vi.fn();
    render(
      <StyleProfileFields
        contentLocale="ru"
        draft={emptyStyleProfileDraft()}
        onChange={onChange}
      />
    );

    expect(screen.getByRole("option", { name: "Литературная интроспекция" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Готический хоррор" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Космическая опера" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Эпическое фэнтези" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: /^Base style preset/ }), {
      target: { value: "literary-introspection" }
    });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      name: "Литературная интроспекция",
      guidance: expect.stringContaining("внутренние наблюдения")
    }));
  });
});

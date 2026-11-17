import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18next } from "../../localization/i18n";
import type { RuntimeStylePersistence } from "../../runtime/apiTypes";
import { SceneStyleSelector } from "./SceneStyleSelector";

function persistence() {
  const catalog = {
    catalog_version: 1 as const,
    project_id: "project-one",
    default_style_profile_id: "style-default",
    profiles: [{
      style_profile_version: 1 as const,
      id: "style-default",
      project_id: "project-one",
      name: "Project voice",
      description: "Measured prose.",
      guidance: "Stay measured.",
      traits: { traits_version: 1 as const, tone: [], rhythm: [], pacing: [], vocabulary: [], dramatic_intensity: null },
      positive_examples: [],
      created_at: "2026-09-07T10:00:00Z",
      updated_at: "2026-09-07T10:00:00Z"
    }],
    scene_assignments: []
  };
  return {
    loadStyleCatalog: vi.fn().mockResolvedValue(catalog),
    upsertSceneStyleAssignment: vi.fn(async (value) => value),
    clearSceneStyleAssignment: vi.fn().mockResolvedValue(undefined)
  } as unknown as RuntimeStylePersistence;
}

describe("SceneStyleSelector", () => {
  beforeEach(async () => {
    await i18next.changeLanguage("en");
  });

  it("shows inherited effective style and persists an explicit Scene override", async () => {
    const runtime = persistence();
    render(<SceneStyleSelector persistence={runtime} projectId="project-one" sceneNodeId="scene-one" sessionId="session-one" />);

    expect(await screen.findByText("Effective style: Project voice")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Inherit project style" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Style profile"), { target: { value: "style-default" } });
    await waitFor(() => expect(runtime.upsertSceneStyleAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ scene_node_id: "scene-one", style_profile_id: "style-default" })
    ));
  });
});

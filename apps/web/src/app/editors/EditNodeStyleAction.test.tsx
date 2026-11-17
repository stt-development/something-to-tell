import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Node } from "@xyflow/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18next } from "../../localization/i18n";
import type { RuntimeApiClient } from "../../runtime/apiClient";
import type { NarrativeNodeData } from "../../types";
import { EditNodeDialog } from "./EditNodeDialog";

const node: Node<NarrativeNodeData> = {
  id: "character-one",
  position: { x: 0, y: 0 },
  data: {
    kind: "Character",
    label: "Mara",
    title: "Mara",
    summary: "Mara watches the harbor.",
    tags: []
  }
};

/** Keeps the generic node editor contract independent from a running provider. */
function persistence() {
  return {
    loadAgentMemoryWorkspace: vi.fn().mockResolvedValue({
      catalog: { catalog_version: 1, project_id: "project-one", entries: [] },
      source_checksum: "a".repeat(64),
      history_revision: 1,
      owners: []
    }),
    resolveAgentMemory: vi.fn().mockResolvedValue({
      resolution_version: 1,
      project_id: "project-one",
      agent_id: "style_rewriter",
      content_locale: "en",
      source_checksum: "a".repeat(64),
      history_revision: 1,
      status: "resolved",
      entries: [],
      included_characters: 0,
      omitted_entries: 0,
      omissions: [],
      conflicts: []
    }),
    resolveEffectiveStyle: vi.fn().mockResolvedValue({
      resolution_version: 1,
      target_node_id: node.id,
      status: "resolved",
      source: "project_default",
      scene_context: null,
      candidate_contexts: [],
      style_profile_id: "style-one",
      profile: { id: "style-one", name: "Harbor noir", description: "Restrained prose." },
      unavailable_reason: null
    })
  } as unknown as RuntimeApiClient;
}

describe("EditNodeDialog style action", () => {
  beforeEach(async () => {
    await i18next.changeLanguage("en");
  });

  it("opens in the current modal and returns focus to the exact Text action", async () => {
    render(
      <EditNodeDialog
        characters={[]}
        issues={[]}
        members={[]}
        node={node}
        onAddMember={vi.fn()}
        onClose={vi.fn()}
        onRemoveMember={vi.fn()}
        onSave={vi.fn()}
        projectNodes={[node]}
        styleContext={{
          onApproved: vi.fn(),
          persistence: persistence(),
          projectId: "project-one",
          providerConfigured: true,
          sessionId: "session-one"
        }}
      />
    );

    const action = screen.getByRole("button", { name: "Get style recommendation: Text for Mara" });
    fireEvent.click(action);
    expect(await screen.findByText("Harbor noir")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(
      screen.getByRole("button", { name: "Get style recommendation: Text for Mara" })
    ).toHaveFocus());
  });

  it("requires the edited Text to be saved before launching", () => {
    render(
      <EditNodeDialog
        characters={[]}
        issues={[]}
        members={[]}
        node={node}
        onAddMember={vi.fn()}
        onClose={vi.fn()}
        onRemoveMember={vi.fn()}
        onSave={vi.fn()}
        projectNodes={[node]}
        styleContext={{
          onApproved: vi.fn(),
          persistence: persistence(),
          projectId: "project-one",
          providerConfigured: true,
          sessionId: "session-one"
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "Unsaved text." } });
    expect(screen.getByRole("button", { name: "Get style recommendation: Text for Mara" })).toBeDisabled();
  });
});

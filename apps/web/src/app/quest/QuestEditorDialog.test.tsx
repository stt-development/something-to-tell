import { fireEvent, render, screen } from "@testing-library/react";
import type { Node } from "@xyflow/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18next } from "../../localization/i18n";
import type { QuestDocument } from "../../quest/contracts";
import type { RuntimeApiClient } from "../../runtime/apiClient";
import type { NarrativeNodeData } from "../../types";
import { QuestEditorDialog } from "./QuestEditorDialog";

const quest: QuestDocument = {
  quest_version: 1,
  objective: "Open the harbor route.",
  quest_giver_node_id: null,
  entry_stage_id: "stage-one",
  prerequisite_node_ids: [],
  reward_node_ids: [],
  stages: [{
    id: "stage-one",
    title: "Find the ledger",
    description: "Recover the forged embargo evidence.",
    branches: []
  }]
};

const node = {
  id: "quest-one",
  position: { x: 0, y: 0 },
  data: {
    canonicalNodeId: "quest-one",
    kind: "Quest",
    label: "Quest",
    summary: "The harbor route is blocked.",
    tags: [],
    title: "Smuggler Route"
  }
} satisfies Node<NarrativeNodeData>;

describe("QuestEditorDialog", () => {
  beforeEach(async () => { await i18next.changeLanguage("en"); });

  it("edits common Text and exposes style recommendations for all quest prose", () => {
    const onSaveNodeText = vi.fn();
    render(
      <QuestEditorDialog
        document={quest}
        node={node}
        nodes={[node]}
        onClose={vi.fn()}
        onCreateTransition={vi.fn()}
        onDeleteTransition={vi.fn()}
        onSave={vi.fn()}
        onSaveNodeText={onSaveNodeText}
        onUpdateTransition={vi.fn()}
        styleContext={{
          onApproved: vi.fn(),
          persistence: {} as RuntimeApiClient,
          providerConfigured: true,
          sessionId: "session-one"
        }}
        transitions={[]}
      />
    );

    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "The route can be reopened." } });
    fireEvent.click(screen.getByRole("button", { name: "Save: Text" }));
    expect(onSaveNodeText).toHaveBeenCalledWith("The route can be reopened.");

    expect(screen.getByRole("button", { name: "Get style recommendation: Text for Smuggler Route" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Get style recommendation: Objective for Smuggler Route" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Get style recommendation: Stage description for Find the ledger" })).toBeInTheDocument();
    expect(screen.getByText("Objective").closest(".dialogue-field-heading")).not.toBeNull();
    expect(screen.getByText("Quest giver").closest(".dialogue-field-heading")).not.toBeNull();
    expect(screen.getByText("Title").closest(".dialogue-field-heading")).not.toBeNull();
  });
});

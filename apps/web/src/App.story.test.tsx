import {
createDefaultProjectSettings,
PROJECT_SETTINGS_VERSION
} from "@something-to-tell/contracts/project-manifest";
import { fireEvent,render,screen,waitFor,within } from "@testing-library/react";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import {
App,
canvasEdgeType,
composableFlowErrorMessage,
ConnectionTypeDialog,
factionMembers,
FlowCallBindingsDialog,
FrameDescriptionControl,
hideSemanticEdges,
mergeAtomicOutcomeFlowResult,
nodePresentationMetrics,
projectFrameWorkspace,
projectTreeEntries
} from "./App";
import { applyProjectLocale } from "./localization/i18n";
import { RuntimeApiError } from "./runtime/apiClient";
import { useGraphStore } from "./state/graphStore";
import { createProjectFixtureRuntimeFetch,loadProjectFixturesForTests,projectFixture } from "./testFixtures/projectFixtures";

const PROJECT_AURORA_STORY_FLOWS = projectFixture("aurora").storyFlows;

describe("App Story Flow and graph authoring", () => {
beforeEach(async () => {
    window.localStorage.clear();
    await applyProjectLocale("en");
    useGraphStore.setState(useGraphStore.getInitialState(), true);
    loadProjectFixturesForTests();
    vi.stubGlobal("fetch", createProjectFixtureRuntimeFetch());
  });

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

it("authors a continuation and confirms entry replacement from Flow controls", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Flow" }));

    fireEvent.click(screen.getAllByRole("button", { name: "Continue from Opening Dock" })[0]!);
    const continuation = screen.getByRole("heading", { name: "Continue from Opening Dock" }).closest("section")!;
    fireEvent.change(within(continuation).getByLabelText("Target node"), { target: { value: "node-sealed-ledger" } });
    fireEvent.change(within(continuation).getByLabelText("Transition"), { target: { value: "optional" } });
    fireEvent.change(within(continuation).getByLabelText("Label"), { target: { value: "Inspect evidence" } });
    fireEvent.click(within(continuation).getByRole("button", { name: "Add continuation" }));

    await waitFor(() => expect(screen.getByText("7 members / 6 transitions")).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "Set Sealed Ledger as flow entry" })[0]!);
    const impact = screen.getByRole("heading", { name: "Replace Story Flow entry" }).closest("section")!;
    expect(impact).toHaveTextContent("Both nodes and every membership remain unchanged");
    fireEvent.click(within(impact).getByRole("button", { name: "Set entry" }));
    await waitFor(() => expect(within(screen.getByTestId("rf__node-node-sealed-ledger")).getByLabelText("Story Flow role")).toHaveTextContent("Entry"));
  });

it("seeds an empty Story Flow and continues authoring without leaving Graph", async () => {
    render(<App />);
    expect(screen.getByRole("button", { name: "Graph" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("group", { name: "Graph connection type" })).not.toBeInTheDocument();
    expect(screen.getByText("16 nodes / 10 relations / 5 transitions")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Create Story Flow" }));
    const createDialog = screen.getByRole("heading", { name: "Create Story Flow" }).closest("section")!;
    fireEvent.change(within(createDialog).getByLabelText("Name"), { target: { value: "Citadel Route" } });
    fireEvent.click(within(createDialog).getByRole("button", { name: "Create flow" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open Story Flow Citadel Route" })).toBeInTheDocument());

    expect(screen.getByRole("button", { name: "Graph" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Add Mara Vale to Citadel Route" }));

    await waitFor(() => expect(screen.getAllByRole("button", { name: "Continue from Mara Vale" })).toHaveLength(2));
    expect(screen.getByLabelText("Citadel Route members")).toHaveTextContent("Entry: Mara Vale");
    expect(within(screen.getByTestId("rf__node-node-hero")).getByLabelText("Story Flow role")).toHaveTextContent("Entry");
  });

it("chooses connection ownership after a Graph connection gesture", () => {
    const onChoose = vi.fn();
    const { rerender } = render(
      <ConnectionTypeDialog
        activeFlowName="Main Story"
        onChoose={onChoose}
        onClose={vi.fn()}
        sourceTitle="Opening Dock"
        targetTitle="Harbor Inspection"
      />
    );

    expect(screen.getByText("Opening Dock")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Relationship/ }));
    fireEvent.click(screen.getByRole("button", { name: /Story transition/ }));
    expect(onChoose.mock.calls).toEqual([["relationship"], ["flow"]]);

    rerender(
      <ConnectionTypeDialog
        activeFlowName={null}
        onChoose={onChoose}
        onClose={vi.fn()}
        sourceTitle="Opening Dock"
        targetTitle="Harbor Inspection"
      />
    );
    expect(screen.getByRole("button", { name: /Story transition/ })).toBeDisabled();
  });

it("restores the last project-local mode and selected Story Flow", () => {
    window.localStorage.setItem("stt.workspace.preferences.v1", JSON.stringify({
      "project-aurora": { mode: "flow", activeFlowId: "flow-smuggler-route" }
    }));

    render(<App />);

    expect(screen.getByRole("button", { name: "Flow" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Flow summary")).toHaveTextContent("Smuggler Route");
    expect(screen.getByText("5 members / 5 transitions")).toBeInTheDocument();
    expect(screen.getByTestId("rf__node-node-smuggler-route")).toBeInTheDocument();
  });

it("shows Aurora call context and restores focus after call authoring", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open Story Flow Main Story" }));
    fireEvent.click(screen.getByRole("button", { name: "Flow" }));
    expect(screen.getByText("Calls Call the covert harbor route")).toBeInTheDocument();
    const callButtons = screen.getAllByRole("button", { name: "Call a Story Flow from Harbor Inspection" });
    expect(callButtons.length).toBeGreaterThanOrEqual(2);
    for (const button of callButtons) {
      expect(button).toHaveAttribute("data-tooltip", "Call a Story Flow from Harbor Inspection");
    }
    const exitButtons = screen.getAllByRole("button", { name: "Create named exit from Harbor Inspection" });
    expect(exitButtons.length).toBeGreaterThanOrEqual(2);
    for (const button of exitButtons) {
      expect(button).toHaveAttribute("data-tooltip", "Create named exit from Harbor Inspection");
    }
    const opener = callButtons[0]!;
    opener.focus();
    fireEvent.click(opener);
    const createDialog = screen.getByRole("heading", { name: "Call a Story Flow from Harbor Inspection" }).closest("section")!;
    expect(within(createDialog).getByLabelText("Called Story Flow")).toHaveTextContent("Smuggler Route");
    fireEvent.click(within(createDialog).getByRole("button", { name: "Close dialog" }));
    await waitFor(() => expect(opener).toHaveFocus());
  });

it("navigates and edits Aurora call return bindings", () => {
    const caller = PROJECT_AURORA_STORY_FLOWS.find((item) => item.flow.id === "flow-main-story")!;
    const target = PROJECT_AURORA_STORY_FLOWS.find((item) => item.flow.id === "flow-smuggler-route")!;
    const invocation = caller.invocations!.find((candidate) => candidate.id === "flow-invocation-inspection-smuggler-route")!;
    const onOpenTarget = vi.fn();
    const onSave = vi.fn();
    render(
      <FlowCallBindingsDialog
        bindings={caller.bindings!}
        caller={caller}
        exits={target.exits!}
        invocation={invocation}
        nodes={useGraphStore.getState().getActiveGraph().nodes}
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onOpenTarget={onOpenTarget}
        onSave={onSave}
        targetFlow={target}
      />
    );

    const bindings = screen.getByRole("heading", { name: "Returns from Smuggler Route" }).closest("section")!;
    expect(within(bindings).getByText("Patrol evaded")).toBeInTheDocument();
    expect(within(bindings).getByLabelText("Return target for success")).toHaveValue("node-route-consequence");
    fireEvent.click(within(bindings).getByRole("button", { name: "Open called flow" }));
    expect(onOpenTarget).toHaveBeenCalledOnce();
    const successSelect = within(bindings).getByLabelText("Return target for success");
    fireEvent.change(successSelect, { target: { value: "node-opening" } });
    fireEvent.click(within(successSelect.closest(".flow-binding-row") as HTMLElement).getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(target.exits!.find((exit) => exit.key === "success"), "node-opening");
  });

it("retains the returned invocation when an outcome atomically changes side flow", () => {
    const source = PROJECT_AURORA_STORY_FLOWS.find((item) => item.flow.id === "flow-main-story")!;
    const target = PROJECT_AURORA_STORY_FLOWS.find((item) => item.flow.id === "flow-z-blockade-outcome")!;
    const invocation = {
      ...source.invocations![0]!,
      id: "flow-invocation-atomic-replacement",
      target_flow_id: target.flow.id
    };

    const merged = mergeAtomicOutcomeFlowResult(
      PROJECT_AURORA_STORY_FLOWS,
      "flow-invocation-dialogue-smuggler-route",
      { invocation, sourceFlow: { ...source, invocations: [], exits: [], bindings: [] }, targetFlow: target }
    );
    const mergedSource = merged.find((item) => item.flow.id === source.flow.id)!;

    expect(mergedSource.invocations).toEqual(expect.arrayContaining([invocation]));
    expect(mergedSource.invocations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "flow-invocation-dialogue-smuggler-route" })
    ]));
    expect(mergedSource.bindings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ invocation_id: "flow-invocation-dialogue-smuggler-route" })
    ]));
  });

it("localizes atomic outcome composition failures from stable runtime codes", async () => {
    await applyProjectLocale("ru");

    expect(composableFlowErrorMessage(
      new RuntimeApiError("backend detail", "composable_flow_outcome_not_found", 404),
      "fallback"
    )).toBe("Результат диалога или квеста больше не существует.");
  });

it("creates, renames, previews, and deletes a project-local Story Flow", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Create Story Flow" }));
    const createDialog = screen.getByRole("heading", { name: "Create Story Flow" }).closest("section")!;
    fireEvent.change(within(createDialog).getByLabelText("Name"), { target: { value: "Harbor Detour" } });
    fireEvent.change(within(createDialog).getByLabelText("Kind"), { target: { value: "side" } });
    fireEvent.change(within(createDialog).getByLabelText("Description"), { target: { value: "Optional route around inspection." } });
    fireEvent.click(within(createDialog).getByRole("button", { name: "Create flow" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Open Story Flow Harbor Detour" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Graph" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("16 nodes / 10 relations / 0 transitions")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Rename Harbor Detour" }));
    const renameDialog = screen.getByRole("heading", { name: "Rename Story Flow" }).closest("section")!;
    fireEvent.change(within(renameDialog).getByLabelText("Name"), { target: { value: "Customs Detour" } });
    fireEvent.click(within(renameDialog).getByRole("button", { name: "Save flow" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Delete Customs Detour" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Delete Customs Detour" }));
    const deleteDialog = await screen.findByRole("heading", { name: "Delete Customs Detour" });
    expect(deleteDialog.closest("section")).toHaveTextContent("Canonical nodesPreserved");
    fireEvent.click(within(deleteDialog.closest("section")!).getByRole("button", { name: "Delete Story Flow" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Open Story Flow Customs Detour" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Open Story Flow Main Story" })).toBeInTheDocument();
  });

it("authors Faction membership through searchable Characters without rendering semantic arrows", () => {
    const graph = useGraphStore.getState().getActiveGraph();
    expect(factionMembers(graph.nodes, graph.edges, "node-trade-guild").map((node) => node.data.title)).toEqual(["Mara Vale"]);
    expect(hideSemanticEdges(graph.edges).some((edge) => edge.data?.relationshipType === "member_of")).toBe(false);
    render(<App />);

    fireEvent.doubleClick(screen.getByTestId("rf__node-node-trade-guild"));
    const dialog = screen.getByRole("heading", { name: "Edit node" }).closest("section")!;
    expect(within(dialog).getByLabelText("Current faction members")).toHaveTextContent("Mara Vale");
    fireEvent.change(within(dialog).getByLabelText("Find Character"), { target: { value: "dockmaster" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Ilya Voss/ }));
    expect(within(dialog).getByLabelText("Current faction members")).toHaveTextContent("Ilya Voss");

    fireEvent.click(within(dialog).getByRole("button", { name: "Remove Mara Vale from Trade Guild" }));
    expect(within(dialog).getByLabelText("Current faction members")).not.toHaveTextContent("Mara Vale");
    expect(useGraphStore.getState().getActiveGraph().nodes.some((node) => node.id === "node-hero")).toBe(true);
  });

it("uses the HTML label renderer only for semantic edges in Graph", () => {
    const relationship = useGraphStore.getState().getActiveGraph().edges.find((edge) => edge.data?.relationshipType === "leads_to")!;

    expect(canvasEdgeType(relationship, "relationships")).toBe("relationship");
    expect(canvasEdgeType(relationship, "flow")).toBe(relationship.type);
    expect(canvasEdgeType({ data: { label: "Next", flowTransition: { flowId: "flow", transitionId: "next", kind: "next", priority: 0, isDefault: false, condition: "" } }, type: "storyFlow" }, "relationships")).toBe("storyFlow");
  });

it("keeps an empty specialized card readable at minimum size and editable", () => {
    useGraphStore.getState().addNodeAt({ title: "Unplanned Route", kind: "Quest", summary: "", tags: [] }, { x: 120, y: 120 });
    const quest = useGraphStore.getState().getActiveGraph().nodes.at(-1)!;
    useGraphStore.getState().onNodesChange([{ id: quest.id, type: "dimensions", dimensions: { width: 220, height: 120 }, resizing: false, setAttributes: true }]);
    const graph = useGraphStore.getState().getActiveGraph();
    expect(nodePresentationMetrics(graph.nodes, graph.edges, graph.nodes.find((node) => node.id === quest.id)!)).toEqual({ incoming: 0, instances: 1, outgoing: 0 });
    render(<App />);

    const card = screen.getByTestId(`rf__node-${quest.id}`);
    expect(card).toHaveStyle({ width: "220px", height: "120px" });
    expect(within(card).getByLabelText("Quest details")).toHaveTextContent("0 stages0 branches · 0 req · 0 rewardsNo tags");
    fireEvent.doubleClick(card);
    expect(screen.getByRole("heading", { name: "Edit quest: Unplanned Route" })).toBeInTheDocument();
  });

it("authors the seeded Quest aggregate in its dedicated editor", () => {
    render(<App />);
    fireEvent.doubleClick(screen.getByTestId("rf__node-node-smuggler-route"));
    const dialog = screen.getByRole("heading", { name: "Edit quest: Smuggler Route" }).closest("section")!;

    expect(within(dialog).getByLabelText("Quest giver")).toHaveValue("node-dockmaster");
    expect(within(dialog).getByRole("checkbox", { name: "Ledger Acquired" })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "Sealed Ledger" })).toBeChecked();
    fireEvent.change(within(dialog).getByLabelText("Search Requirements"), { target: { value: "missing requirement" } });
    expect(within(dialog).getByLabelText("Available Requirements")).toHaveTextContent("No matching nodes");
    fireEvent.change(within(dialog).getByLabelText("Search Requirements"), { target: { value: "ledger" } });
    expect(within(dialog).getByLabelText("Available Requirements")).toHaveTextContent("Ledger Acquired");
    fireEvent.change(within(dialog).getByLabelText("Search Rewards"), { target: { value: "evidence" } });
    expect(within(dialog).getByLabelText("Available Rewards")).toHaveTextContent("Sealed Ledger");
    expect(within(dialog).getByLabelText("Outcomes for branch-legal-route")).toHaveTextContent("Graph outcomes (1)");
    expect(within(dialog).getByLabelText("Outcomes for branch-legal-route").querySelector('button[title="Choose whether this outcome defines story order"]') as HTMLButtonElement).toHaveClass("dialogue-outcome-control");
    fireEvent.change(within(dialog).getByLabelText("Objective"), { target: { value: "Open either harbor route." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add stage" }));
    fireEvent.change(within(dialog).getByDisplayValue("Stage 3"), { target: { value: "Report the outcome" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save quest" }));

    const saved = useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === "node-smuggler-route")?.data.questDocument;
    expect(saved?.objective).toBe("Open either harbor route.");
    expect(saved?.stages.at(-1)?.title).toBe("Report the outcome");
  });

it("discovers project folders and switches runtime sessions", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const dialog = screen.getByRole("heading", { name: "Open project" }).closest("section")!;
    fireEvent.click(await within(dialog).findByRole("button", { name: /Citadel Branch/ }));

    await waitFor(() => expect(screen.getAllByText("Citadel Branch")).toHaveLength(2));
    expect(screen.getByText("0 nodes / 0 relations / 0 transitions")).toBeInTheDocument();
  });

it("creates a project from the project dialog", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    const dialog = screen.getByRole("heading", { name: "Create project" }).closest("section")!;
    expect(within(dialog).getByLabelText("Storage")).toBeEnabled();
    expect(within(dialog).getByLabelText("Storage")).toHaveClass("bg-white");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "New Game" } });
    fireEvent.change(within(dialog).getByLabelText("Description"), { target: { value: "New project notes" } });
    fireEvent.change(within(dialog).getByLabelText("Interface language"), { target: { value: "ru" } });
    fireEvent.change(within(dialog).getByLabelText("Interval (minutes)"), { target: { value: "10" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(screen.getAllByText("New Game")).toHaveLength(2));
    expect(screen.getByText("0 узлов / 0 отношений / 0 переходов")).toBeInTheDocument();
    expect(useGraphStore.getState().activeProjectManifest?.settings).toMatchObject({
      ui_locale: "ru",
      content_locale: "en",
      autosave: { enabled: true, interval_seconds: 600 }
    });
  });

it("configures PostgreSQL while creating the first project", async () => {
    useGraphStore.setState(useGraphStore.getInitialState(), true);
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    let dialog = screen.getByRole("heading", { name: "Create project" }).closest("section")!;
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Remote Story" } });
    fireEvent.change(within(dialog).getByLabelText("Storage"), { target: { value: "configure" } });

    const profileDialog = screen.getByRole("heading", { name: "Add PostgreSQL connection" }).closest("section")!;
    fireEvent.change(within(profileDialog).getByLabelText("Connection name"), { target: { value: "Story Database" } });
    fireEvent.change(within(profileDialog).getByLabelText("Database"), { target: { value: "remote_story" } });
    fireEvent.change(within(profileDialog).getByLabelText("Username"), { target: { value: "writer" } });
    fireEvent.change(within(profileDialog).getByLabelText("Password"), { target: { value: "not-persisted" } });
    fireEvent.click(within(profileDialog).getByRole("button", { name: "Add connection" }));

    dialog = screen.getByRole("heading", { name: "Create project" }).closest("section")!;
    expect(within(dialog).getByLabelText("Storage")).toHaveValue("postgresql");
    expect(within(dialog).getByLabelText("Storage")).toHaveTextContent("Story Database");
    expect(screen.queryByDisplayValue("not-persisted")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Remote Story" })).toBeInTheDocument());
    expect(useGraphStore.getState().activeProjectManifest?.settings.storage).toEqual({
      mode: "postgresql",
      connection_profile_id: "profile-project"
    });
  });

it("configures PostgreSQL when creating a project from an open workspace", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    let dialog = screen.getByRole("heading", { name: "Create project" }).closest("section")!;
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Remote Sequel" } });
    fireEvent.change(within(dialog).getByLabelText("Storage"), { target: { value: "configure" } });
    const profileDialog = screen.getByRole("heading", { name: "Add PostgreSQL connection" }).closest("section")!;
    fireEvent.change(within(profileDialog).getByLabelText("Connection name"), { target: { value: "Sequel Database" } });
    fireEvent.change(within(profileDialog).getByLabelText("Database"), { target: { value: "remote_sequel" } });
    fireEvent.change(within(profileDialog).getByLabelText("Username"), { target: { value: "writer" } });
    fireEvent.change(within(profileDialog).getByLabelText("Password"), { target: { value: "not-persisted" } });
    fireEvent.click(within(profileDialog).getByRole("button", { name: "Add connection" }));
    dialog = screen.getByRole("heading", { name: "Create project" }).closest("section")!;
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Remote Sequel" })).toBeInTheDocument());
    expect(useGraphStore.getState().activeProjectManifest?.settings.storage.mode).toBe("postgresql");
  });

it("creates an explicitly identified portable project copy", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const openDialog = screen.getByRole("heading", { name: "Open project" }).closest("section")!;
    fireEvent.click(await within(openDialog).findByRole("button", { name: /Project Aurora/ }));

    const saveMenuButton = screen.getByRole("button", { name: "More save actions" });
    await waitFor(() => expect(saveMenuButton).toBeEnabled());
    expect(screen.queryByRole("menuitem", { name: "Save project as" })).not.toBeInTheDocument();
    fireEvent.click(saveMenuButton);
    expect(saveMenuButton).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menuitem", { name: "Save project as" })).not.toBeInTheDocument();
    expect(saveMenuButton).toHaveFocus();
    fireEvent.click(saveMenuButton);
    fireEvent.click(screen.getByRole("menuitem", { name: "Save project as" }));
    const dialog = screen.getByRole("heading", { name: "Save project as" }).closest("section")!;
    expect(within(dialog).getByLabelText("Independent copy")).toBeChecked();
    expect(within(dialog).getByText(/uses local SQLite/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByLabelText("Preserve identity"));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Replace an existing destination/ }));
    fireEvent.change(within(dialog).getByLabelText("Copy folder name"), {
      target: { value: "Aurora Portable" }
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create copy" }));

    await waitFor(() => expect(within(dialog).getByText("Portable project copy created")).toBeInTheDocument());
    expect(within(dialog).getByText("/home/author/.narrative/AuroraPortable.narrative")).toBeInTheDocument();
    expect(within(dialog).getByText(/backup-fixture/)).toBeInTheDocument();
    expect(useGraphStore.getState().activeProjectSession?.save_status).toBe("clean");
  });

it("edits confirmed project settings without changing project identity or folder", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const openDialog = screen.getByRole("heading", { name: "Open project" }).closest("section")!;
    fireEvent.click(await within(openDialog).findByRole("button", { name: /Project Aurora/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Project settings" })).toBeEnabled());
    const original = useGraphStore.getState().activeProjectManifest!;
    const originalPath = useGraphStore.getState().activeProjectSession!.project_path;

    fireEvent.click(screen.getByRole("button", { name: "Project settings" }));
    const dialog = screen.getByRole("heading", { name: "Project settings" }).closest("section")!;
    expect(within(dialog).getByText(original.project_id)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Aurora Revised" } });
    fireEvent.change(within(dialog).getByLabelText("Description"), { target: { value: "Confirmed settings update" } });
    expect(within(dialog).getByRole("checkbox", { name: "Enable deterministic checks" })).toBeChecked();
    expect(within(dialog).getByLabelText("Style Rewriter agent")).toHaveValue("disabled");
    fireEvent.click(within(dialog).getByText("Deterministic rule settings"));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Unresolved condition path" }));
    fireEvent.change(within(dialog).getByLabelText("Severity for Unresolved condition path"), {
      target: { value: "critical" }
    });
    fireEvent.change(within(dialog).getByLabelText("Canon agent"), { target: { value: "configured" } });
    const canonProvider = within(dialog).getByLabelText("Canon agent provider settings");
    fireEvent.change(within(canonProvider).getByLabelText("Provider source"), { target: { value: "override" } });
    await waitFor(() => expect(within(canonProvider).getByRole("button", { name: "Add provider profile" })).toBeEnabled());
    fireEvent.click(within(canonProvider).getByRole("button", { name: "Add provider profile" }));
    expect(within(canonProvider).getByRole("option", { name: "Anthropic" })).toBeInTheDocument();
    fireEvent.change(within(canonProvider).getByLabelText("Name", { selector: 'input[name="label"]' }), { target: { value: "Writing account" } });
    fireEvent.change(within(canonProvider).getByLabelText("Provider"), { target: { value: "openai" } });
    fireEvent.change(within(canonProvider).getByLabelText("API key"), { target: { value: "sk-transient-test-key" } });
    fireEvent.click(within(canonProvider).getByRole("button", { name: "Connect and load models" }));
    await waitFor(() => expect(within(canonProvider).getByLabelText("Canon provider profile")).toHaveValue("fixture-provider-openai"));
    fireEvent.change(within(canonProvider).getByLabelText("Canon model"), { target: { value: "canon-model-v1" } });
    expect(within(canonProvider).getByRole("button", { name: "Delete profile" })).toBeEnabled();
    fireEvent.click(within(canonProvider).getByRole("button", { name: "Edit profile" }));
    expect(within(canonProvider).getByText("Leave blank to keep the existing API key.")).toBeInTheDocument();
    expect(within(canonProvider).getByLabelText("API key")).toHaveValue("");
    fireEvent.change(within(canonProvider).getByLabelText("Name", { selector: 'input[name="label"]' }), {
      target: { value: "Primary writing account" }
    });
    fireEvent.click(within(canonProvider).getByRole("button", { name: "Verify and save profile" }));
    await waitFor(() => expect(within(canonProvider).getByText("Primary writing account")).toBeInTheDocument());
    fireEvent.change(within(canonProvider).getByLabelText("Canon model"), { target: { value: "canon-model-v2" } });
    fireEvent.change(within(dialog).getByLabelText("Interface language"), { target: { value: "ru" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Autosave" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Aurora Revised" })).toBeInTheDocument());
    const state = useGraphStore.getState();
    expect(state.activeProjectManifest).toMatchObject({
      project_id: original.project_id,
      name: "Aurora Revised",
      description: "Confirmed settings update",
      settings: {
        ui_locale: "ru",
        content_locale: "en",
        autosave: { enabled: false },
        canon_check: {
          agent_mode: "configured",
          content_policy: "evidence_only",
          enabled_rules: { "condition.unresolved-path": false },
          severity_overrides: { "condition.unresolved-path": "critical" },
          provider_profile_id: "fixture-provider-openai",
          model_preference: "canon-model-v2"
        }
      }
    });
    expect(state.activeProjectSession?.project_path).toBe(originalPath);
    expect(JSON.stringify(state.activeProjectManifest)).not.toContain("sk-transient-test-key");
  });

it("deletes a machine-local Canon profile through explicit confirmation", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const openDialog = screen.getByRole("heading", { name: "Open project" }).closest("section")!;
    fireEvent.click(await within(openDialog).findByRole("button", { name: /Project Aurora/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Project settings" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Project settings" }));
    const dialog = screen.getByRole("heading", { name: "Project settings" }).closest("section")!;
    fireEvent.change(within(dialog).getByLabelText("Canon agent"), { target: { value: "configured" } });
    const canonProvider = within(dialog).getByLabelText("Canon agent provider settings");
    await waitFor(() => expect(within(canonProvider).getByRole("button", { name: "Add provider profile" })).toBeEnabled());
    fireEvent.click(within(canonProvider).getByRole("button", { name: "Add provider profile" }));
    fireEvent.change(within(canonProvider).getByLabelText("Name", { selector: 'input[name="label"]' }), {
      target: { value: "Disposable profile" }
    });
    fireEvent.change(within(canonProvider).getByLabelText("API key"), {
      target: { value: "sk-disposable-secret" }
    });
    fireEvent.click(within(canonProvider).getByRole("button", { name: "Connect and load models" }));
    await waitFor(() => expect(within(canonProvider).getByRole("button", { name: "Delete profile" })).toBeEnabled());

    fireEvent.click(within(canonProvider).getByRole("button", { name: "Delete profile" }));
    const confirmation = within(canonProvider).getByRole("alert");
    expect(within(confirmation).getByText(/Delete the machine-local profile Disposable profile/)).toBeInTheDocument();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(within(dialog).getByLabelText("Canon agent")).toHaveValue("disabled"));
    expect(within(dialog).queryByLabelText("Canon provider settings")).not.toBeInTheDocument();
  });

it("routes storage changes through the explicit migration workflow", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const openDialog = screen.getByRole("heading", { name: "Open project" }).closest("section")!;
    fireEvent.click(await within(openDialog).findByRole("button", { name: /Project Aurora/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Project settings" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Project settings" }));
    const storage = screen.getByLabelText("Storage");
    expect(storage).toBeEnabled();
    expect(storage).toHaveClass("bg-white");
    fireEvent.change(storage, { target: { value: "configure" } });

    expect(screen.getByRole("heading", { name: "Storage migration" })).toBeInTheDocument();
    expect(screen.getByText(/source remains authoritative/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Connection profile")).toHaveValue("studio-primary"));
    expect(screen.queryByText(/password/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/Connected · TLS active · Schema/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Migrate to PostgreSQL" }));

    await waitFor(() => expect(screen.queryByRole("heading", { name: "Storage migration" })).not.toBeInTheDocument());
    expect(useGraphStore.getState().activeProjectManifest?.settings.storage).toEqual({
      mode: "postgresql",
      connection_profile_id: "studio-primary"
    });
  });

it("adds a project-owned storage connection from the migration workflow", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const openDialog = screen.getByRole("heading", { name: "Open project" }).closest("section")!;
    fireEvent.click(await within(openDialog).findByRole("button", { name: /Project Aurora/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Project settings" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Project settings" }));
    fireEvent.change(screen.getByLabelText("Storage"), { target: { value: "configure" } });
    await screen.findByRole("heading", { name: "Storage migration" });
    fireEvent.click(screen.getByRole("button", { name: "Add connection" }));

    const dialog = screen.getByRole("heading", { name: "Add PostgreSQL connection" }).closest("section")!;
    fireEvent.change(within(dialog).getByLabelText("Connection name"), { target: { value: "Project DB" } });
    fireEvent.change(within(dialog).getByLabelText("Database"), { target: { value: "story" } });
    fireEvent.change(within(dialog).getByLabelText("Username"), { target: { value: "writer" } });
    fireEvent.change(within(dialog).getByLabelText("Password"), { target: { value: "not-returned" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add connection" }));

    await waitFor(() => expect(screen.getByLabelText("Connection profile")).toHaveValue("profile-project"));
    expect(screen.queryByDisplayValue("not-returned")).not.toBeInTheDocument();
  });

it("offers keyboard-focusable starter commands only for a newly created empty project", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    const dialog = screen.getByRole("heading", { name: "Create project" }).closest("section")!;
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Empty Aurora" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    const starter = await screen.findByLabelText("Start empty project");
    const firstScene = within(starter).getByRole("button", { name: "Create first scene" });
    expect(firstScene).toHaveFocus();
    expect(within(starter).getByRole("button", { name: "Create story event" })).toBeInTheDocument();
    expect(within(starter).getByRole("button", { name: "Build world" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const openDialog = screen.getByRole("heading", { name: "Open project" }).closest("section")!;
    fireEvent.click(await within(openDialog).findByRole("button", { name: /Citadel Branch/ }));
    await waitFor(() => expect(screen.queryByLabelText("Start empty project")).not.toBeInTheDocument());
  });

it("bootstraps a first Scene, active Main Story, membership, and entry locally", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    const dialog = screen.getByRole("heading", { name: "Create project" }).closest("section")!;
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Scene First" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await screen.findByLabelText("Start empty project");
    fireEvent.click(screen.getByRole("button", { name: "Create first scene" }));

    await waitFor(() => expect(screen.queryByLabelText("Start empty project")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Flow" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("1 member / 0 transitions")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Story Flow Main Story" })).toBeInTheDocument();
    const node = useGraphStore.getState().getActiveGraph().nodes[0]!;
    expect(node).toMatchObject({
      width: 520,
      height: 360,
      data: { isFrame: true, kind: "Scene", title: "Opening Scene" }
    });
    expect(screen.getByText("Entry")).toBeInTheDocument();
  });

it("bootstraps a first Event without requiring a Scene", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    const dialog = screen.getByRole("heading", { name: "Create project" }).closest("section")!;
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Event First" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await screen.findByLabelText("Start empty project");
    fireEvent.click(screen.getByRole("button", { name: "Create story event" }));

    await waitFor(() => expect(screen.queryByLabelText("Start empty project")).not.toBeInTheDocument());
    expect(useGraphStore.getState().getActiveGraph().nodes[0]).toMatchObject({
      data: { kind: "Event", title: "Opening Event" }
    });
    expect(screen.getByText("1 member / 0 transitions")).toBeInTheDocument();
  });

it("builds world content without creating an implicit Story Flow", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    const projectDialog = screen.getByRole("heading", { name: "Create project" }).closest("section")!;
    fireEvent.change(within(projectDialog).getByLabelText("Name"), { target: { value: "World First" } });
    fireEvent.click(within(projectDialog).getByRole("button", { name: "Create" }));

    await screen.findByLabelText("Start empty project");
    fireEvent.click(screen.getByRole("button", { name: "Build world" }));
    const worldDialog = screen.getByRole("heading", { name: "Build world" }).closest("section")!;
    fireEvent.change(within(worldDialog).getByLabelText("Name"), { target: { value: "Founding Myth" } });
    fireEvent.change(within(worldDialog).getByLabelText("Description"), { target: { value: "A disputed origin story." } });
    fireEvent.click(within(worldDialog).getByRole("button", { name: "Create node" }));

    expect(screen.queryByLabelText("Start empty project")).not.toBeInTheDocument();
    expect(screen.getByText("No Story Flows")).toBeInTheDocument();
    expect(useGraphStore.getState().getActiveGraph().nodes[0]).toMatchObject({
      data: { kind: "Lore", title: "Founding Myth", summary: "A disputed origin story." },
      position: { x: 344, y: 136 }
    });
  });

it("creates a node by choosing a toolbar tool and clicking the canvas", () => {
    const { container } = render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Dialogue" }));
    fireEvent.click(container.querySelector(".react-flow__pane")!, { clientX: 500, clientY: 300 });

    const createdDialogue = useGraphStore.getState().getActiveGraph().nodes.find((node) => node.data.kind === "Dialogue" && node.data.title === "Dialogue node");
    expect(createdDialogue).toBeDefined();
    const emptyDialogueCard = screen.getByTestId(`rf__node-${createdDialogue!.id}`);
    expect(within(emptyDialogueCard).getByTitle("0 participants")).toBeInTheDocument();
    expect(within(emptyDialogueCard).getByTitle("0 lines")).toBeInTheDocument();
    expect(within(emptyDialogueCard).getByTitle("0 choices")).toBeInTheDocument();
    expect(within(emptyDialogueCard).getByTitle("0 endings")).toBeInTheDocument();
  });

it("creates a default Scene frame by clicking the canvas", () => {
    const { container } = render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Scene Frame" }));
    fireEvent.click(container.querySelector(".react-flow__pane")!, { clientX: 500, clientY: 300 });

    const frame = useGraphStore.getState().getActiveGraph().nodes.at(-1)!;
    expect(frame).toMatchObject({ width: 520, height: 360, data: { isFrame: true, kind: "Scene" } });
  });

it("draws a Location frame and clamps short drags to minimum dimensions", () => {
    const { container } = render(<App />);
    const pane = container.querySelector(".react-flow__pane")!;

    fireEvent.click(screen.getByRole("button", { name: "Location Frame" }));
    fireEvent.mouseDown(pane, { button: 0, clientX: 400, clientY: 260 });
    fireEvent.mouseMove(pane, { buttons: 1, clientX: 430, clientY: 290 });
    expect(container.querySelector(".frame-draw-preview")).toBeInTheDocument();
    fireEvent.mouseUp(pane, { button: 0, clientX: 430, clientY: 290 });

    const frame = useGraphStore.getState().getActiveGraph().nodes.at(-1)!;
    expect(frame).toMatchObject({ width: 320, height: 220, data: { isFrame: true, kind: "Location" } });
    expect(container.querySelector(".frame-draw-preview")).not.toBeInTheDocument();
  });

it("cancels an active frame draw with Escape", () => {
    const { container } = render(<App />);
    const pane = container.querySelector(".react-flow__pane")!;
    const initialCount = useGraphStore.getState().getActiveGraph().nodes.length;

    fireEvent.click(screen.getByRole("button", { name: "Scene Frame" }));
    fireEvent.mouseDown(pane, { button: 0, clientX: 400, clientY: 260 });
    fireEvent.mouseMove(pane, { buttons: 1, clientX: 700, clientY: 500 });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.mouseUp(pane, { button: 0, clientX: 700, clientY: 500 });

    expect(useGraphStore.getState().getActiveGraph().nodes).toHaveLength(initialCount);
    expect(container.querySelector(".frame-draw-preview")).not.toBeInTheDocument();
  });

it("fits frame content from its title control", () => {
    useGraphStore.getState().onNodesChange([
      { id: "node-opening", type: "dimensions", dimensions: { width: 900, height: 700 }, resizing: false }
    ]);
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Fit content in Opening Dock" }));

    expect(useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === "node-opening")).toMatchObject({ width: 1044, height: 564 });
  });

it("shows Scene content counts and restores its placements after collapse", () => {
    render(<App />);
    const scene = screen.getByTestId("rf__node-node-opening");

    expect(scene.querySelector(".frame-content-count")).toHaveTextContent("6");
    expect(scene.querySelector(".frame-content-count")).toHaveAttribute("data-tooltip", "1 character, 1 lore, 1 location, 1 dialogue, 1 item, 1 event");
    expect(within(scene).getByRole("button", { name: "Add linked node to Opening Dock" })).toBeInTheDocument();
    expect(within(scene).getByRole("button", { name: "Focus Opening Dock" })).toBeInTheDocument();

    fireEvent.click(within(scene).getByRole("button", { name: "Collapse Opening Dock" }));
    expect(screen.queryByTestId("rf__node-node-dock-dialogue")).not.toBeInTheDocument();
    expect(useGraphStore.getState().getActiveGraph().nodes.filter((node) => node.parentId === "node-opening")).toHaveLength(6);
    expect(useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === "node-opening")).toMatchObject({ width: 280, height: 112 });

    fireEvent.click(within(screen.getByTestId("rf__node-node-opening")).getByRole("button", { name: "Expand Opening Dock" }));
    expect(screen.getByTestId("rf__node-node-dock-dialogue")).toBeInTheDocument();
    expect(useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === "node-opening")).toMatchObject({ width: 1060, height: 580 });
  });

it("opens and exits a focused Scene canvas from its title action", () => {
    const graph = useGraphStore.getState().getActiveGraph();
    expect(projectFrameWorkspace(graph.nodes, graph.edges, "node-opening").edges.map((edge) => edge.id)).toContain("edge-dialogue-blockade");
    render(<App />);

    fireEvent.click(within(screen.getByTestId("rf__node-node-opening")).getByRole("button", { name: "Focus Opening Dock" }));

    expect(screen.getByLabelText("Focused frame workspace")).toHaveTextContent("Opening Dock");
    expect(screen.getByLabelText("Focused frame workspace").closest("header")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Exit focused frame workspace" }).closest("header")).not.toBeNull();
    expect(screen.getByTestId("rf__node-node-opening")).toBeInTheDocument();
    expect(screen.getByTestId("rf__node-node-dock-dialogue")).toBeInTheDocument();
    expect(screen.getByTestId("rf__node-node-mara-runs-blockade")).toBeInTheDocument();
    expect(screen.queryByTestId("rf__node-node-trade-guild")).not.toBeInTheDocument();
    expect(screen.queryByTestId("rf__node-node-hero")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Exit focused frame workspace" }));
    expect(screen.getByTestId("rf__node-node-trade-guild")).toBeInTheDocument();
  });

it("supports Location counts, collapse, expand, and focused workspace", () => {
    render(<App />);
    const harbor = screen.getByTestId("rf__node-node-harbor");

    expect(harbor.querySelector(".frame-content-count")).toHaveTextContent("1");
    expect(harbor.querySelector(".frame-content-count")).toHaveAttribute("data-tooltip", "1 location");
    expect(screen.getByTestId("rf__node-node-customs-office").querySelector(".frame-content-count")).not.toBeInTheDocument();
    fireEvent.click(within(harbor).getByRole("button", { name: "Collapse Glass Harbor" }));
    expect(screen.queryByTestId("rf__node-node-customs-office")).not.toBeInTheDocument();
    expect(useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === "node-customs-office")?.parentId).toBe("node-harbor");

    fireEvent.click(within(screen.getByTestId("rf__node-node-harbor")).getByRole("button", { name: "Expand Glass Harbor" }));
    fireEvent.click(within(screen.getByTestId("rf__node-node-harbor")).getByRole("button", { name: "Focus Glass Harbor" }));
    expect(screen.getByLabelText("Focused frame workspace")).toHaveTextContent("Location workspace");
    expect(screen.getByTestId("rf__node-node-customs-office")).toBeInTheDocument();
    expect(screen.queryByTestId("rf__node-node-opening")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Exit focused frame workspace" }));
    expect(screen.getByTestId("rf__node-node-opening")).toBeInTheDocument();
  });

it("opens frame descriptions explicitly without hiding nested nodes", () => {
    render(<App />);
    const scene = screen.getByTestId("rf__node-node-opening");
    const nestedDialogue = screen.getByTestId("rf__node-node-dock-dialogue");
    const description = within(scene).getByLabelText("Description for Opening Dock");
    const trigger = within(scene).getByRole("button", { name: "Show description for Opening Dock" });

    fireEvent.mouseEnter(description);
    expect(nestedDialogue).toBeVisible();
    expect(scene).not.toHaveClass("issue-tooltip-active");

    trigger.focus();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("dialog", { name: "Opening Dock" })).toHaveTextContent(
      "First playable scene where the embargo is revealed."
    );
    expect(nestedDialogue).toBeVisible();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Opening Dock" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Opening Dock" })).not.toBeInTheDocument();

    const locationTrigger = within(screen.getByTestId("rf__node-node-harbor")).getByRole("button", {
      name: "Show description for Glass Harbor"
    });
    fireEvent.click(locationTrigger);
    expect(screen.getByRole("dialog", { name: "Glass Harbor" })).toHaveTextContent(
      "Neutral port where the embargo enforcement is easiest to inspect."
    );
    fireEvent.click(locationTrigger);
    expect(screen.queryByRole("dialog", { name: "Glass Harbor" })).not.toBeInTheDocument();
  });

it("renders empty and long frame descriptions in the bounded popover", () => {
    const longDescription = "A long location description. ".repeat(80);
    render(
      <div>
        <FrameDescriptionControl summary="" title="Empty Harbor" />
        <FrameDescriptionControl summary={longDescription} title="Archive District" />
      </div>
    );

    fireEvent.click(screen.getByRole("button", { name: "Show description for Empty Harbor" }));
    expect(screen.getByRole("dialog", { name: "Empty Harbor" })).toHaveTextContent("No description yet.");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("button", { name: "Show description for Empty Harbor" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Show description for Archive District" }));
    const body = screen.getByRole("dialog", { name: "Archive District" }).querySelector(".frame-description-popover-body");
    expect(body).toHaveTextContent("A long location description.");
  });

it("opens standard node editing for Scene and Location on double click", () => {
    render(<App />);

    fireEvent.doubleClick(screen.getByTestId("rf__node-node-opening"));
    let dialog = screen.getByRole("heading", { name: "Edit node" }).closest("section")!;
    expect(within(dialog).getByLabelText("Label")).toHaveValue("Opening Dock");
    expect(within(dialog).getByLabelText("Text")).toHaveValue("First playable scene where the embargo is revealed.");
    expect(within(dialog).getByLabelText("Type")).toBeDisabled();
    expect(within(dialog).getByLabelText("Type")).toHaveValue("Scene");
    fireEvent.click(within(dialog).getByTitle("Close dialog"));

    fireEvent.doubleClick(screen.getByTestId("rf__node-node-harbor"));
    dialog = screen.getByRole("heading", { name: "Edit node" }).closest("section")!;
    expect(within(dialog).getByLabelText("Label")).toHaveValue("Glass Harbor");
    expect(within(dialog).getByLabelText("Tags")).toHaveValue("port, travel");
    expect(within(dialog).getByLabelText("Type")).toBeDisabled();
    expect(within(dialog).getByLabelText("Type")).toHaveValue("Location");
  });

it("edits Requirement and Outcome fields while preserving their canonical kinds", () => {
    render(<App />);

    fireEvent.doubleClick(screen.getByTestId("rf__node-node-ledger-condition"));
    let dialog = screen.getByRole("heading", { name: "Edit node" }).closest("section")!;
    expect(within(dialog).getByLabelText("Type")).toHaveValue("Condition");
    expect(within(dialog).getByLabelText("Subject")).toHaveValue("Mara Vale");
    expect(within(dialog).getByLabelText("Predicate")).toHaveValue("has acquired the Sealed Ledger");
    expect(within(dialog).getByLabelText("Expression (optional)")).toHaveValue("inventory.has('sealed-ledger')");
    fireEvent.change(within(dialog).getByLabelText("Predicate"), { target: { value: "carries verified guild evidence" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === "node-ledger-condition")?.data).toMatchObject({
      kind: "Condition",
      requirement: { subject: "Mara Vale", predicate: "carries verified guild evidence" }
    });

    fireEvent.doubleClick(screen.getByTestId("rf__node-node-route-consequence"));
    dialog = screen.getByRole("heading", { name: "Edit node" }).closest("section")!;
    expect(within(dialog).getByLabelText("Type")).toHaveValue("Consequence");
    expect(within(dialog).getByLabelText("Effect")).toHaveValue("The legal departure route through Glass Harbor becomes available.");
    expect(within(dialog).getByLabelText("Affect Glass Harbor")).toBeChecked();
    fireEvent.click(within(dialog).getByLabelText("Affect Mara Vale"));
    fireEvent.change(within(dialog).getByLabelText("Effect"), { target: { value: "Harbor access is restored." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === "node-route-consequence")?.data).toMatchObject({
      kind: "Consequence",
      outcome: { effect: "Harbor access is restored.", targetNodeIds: expect.arrayContaining(["node-harbor", "node-hero"]) }
    });

    const graph = useGraphStore.getState().getActiveGraph();
    expect(graph.edges.find((edge) => edge.id === "edge-condition-inspection")).toMatchObject({ source: "node-ledger-condition", target: "node-inspection" });
    expect(graph.edges.find((edge) => edge.id === "edge-inspection-consequence")).toMatchObject({ source: "node-inspection", target: "node-route-consequence" });
  });

it("lazily initializes specialized fields for legacy causal nodes", () => {
    useGraphStore.getState().addManualNode({ title: "Legacy Gate", kind: "Condition", summary: "The player owns a pass.", tags: [] });
    const requirementId = useGraphStore.getState().getActiveGraph().nodes.at(-1)!.id;
    useGraphStore.getState().addManualNode({ title: "Legacy Result", kind: "Consequence", summary: "The door opens.", tags: [] });
    const outcomeId = useGraphStore.getState().getActiveGraph().nodes.at(-1)!.id;
    render(<App />);

    fireEvent.doubleClick(screen.getByTestId(`rf__node-${requirementId}`));
    let dialog = screen.getByRole("heading", { name: "Edit node" }).closest("section")!;
    expect(within(dialog).getByLabelText("Subject")).toHaveValue("Legacy Gate");
    expect(within(dialog).getByLabelText("Predicate")).toHaveValue("The player owns a pass.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === requirementId)?.data.requirement).toMatchObject({ subject: "Legacy Gate", predicate: "The player owns a pass." });

    fireEvent.doubleClick(screen.getByTestId(`rf__node-${outcomeId}`));
    dialog = screen.getByRole("heading", { name: "Edit node" }).closest("section")!;
    expect(within(dialog).getByLabelText("Effect")).toHaveValue("The door opens.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === outcomeId)?.data.outcome).toEqual({ effect: "The door opens.", targetNodeIds: [] });
  });

it("edits Character role and Item purpose independently from tags", () => {
    render(<App />);

    fireEvent.doubleClick(screen.getByTestId("rf__node-node-hero"));
    let dialog = screen.getByRole("heading", { name: "Edit node" }).closest("section")!;
    expect(within(dialog).getByLabelText("Role")).toHaveValue("Protagonist and smuggler captain");
    expect(within(dialog).getByLabelText("Tags")).toHaveValue("crew, voice");
    fireEvent.change(within(dialog).getByLabelText("Role"), { target: { value: "Player captain" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === "node-hero")?.data).toMatchObject({ characterRole: "Player captain", tags: ["crew", "voice"] });

    fireEvent.doubleClick(screen.getByTestId("rf__node-node-sealed-ledger"));
    dialog = screen.getByRole("heading", { name: "Edit node" }).closest("section")!;
    expect(within(dialog).getByLabelText("Purpose")).toHaveValue("Proof that the embargo order was manipulated");
    expect(within(dialog).getByLabelText("Tags")).toHaveValue("evidence");
    fireEvent.change(within(dialog).getByLabelText("Purpose"), { target: { value: "Negotiation evidence" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(useGraphStore.getState().getActiveGraph().nodes.filter((node) => (node.data.canonicalNodeId ?? node.id) === "node-sealed-ledger").every((node) => node.data.itemPurpose === "Negotiation evidence")).toBe(true);
  });

it("omits invalid Scene and cyclic Location candidates from Location add menus", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Add linked node to Glass Harbor" }));
    let dialog = screen.getByRole("heading", { name: "Add linked node to Glass Harbor" }).closest("section")!;
    expect(within(dialog).queryByRole("button", { name: /Opening Dock/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Dockmaster Warning/ })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByTitle("Close dialog"));

    fireEvent.click(screen.getByRole("button", { name: "Add linked node to Customs Office" }));
    dialog = screen.getByRole("heading", { name: "Add linked node to Customs Office" }).closest("section")!;
    expect(within(dialog).queryByRole("button", { name: /Glass Harbor/ })).not.toBeInTheDocument();
  });

it("projects primary containment as a nested project tree without duplicate linked entries", () => {
    const entries = projectTreeEntries(useGraphStore.getState().getActiveGraph().nodes);

    expect(entries.find((entry) => entry.node.id === "node-opening")?.depth).toBe(0);
    expect(entries.find((entry) => entry.node.id === "node-harbor")?.depth).toBe(1);
    expect(entries.find((entry) => entry.node.id === "node-customs-office")?.depth).toBe(2);
    expect(entries.filter((entry) => entry.node.data.title === "Sealed Ledger")).toHaveLength(1);

    render(<App />);
    expect(screen.getByRole("button", { name: "Location: Customs Office" }).closest(".project-tree-row")).toHaveAttribute("data-depth", "2");
  });
});

function cleanProjectSessionResponse() {
  const timestamp = "2026-07-28T10:00:00Z";
  return {
    session: {
      session_version: 1,
      session_id: "session-clean",
      project_id: "project-clean",
      project_path: "/stories/CleanStart.narrative",
      storage_mode: "local_sqlite",
      loaded_revision: 0,
      saved_revision: 0,
      save_status: "clean",
      lifecycle: "open",
      opened_at: timestamp,
      last_saved_at: timestamp,
      save_error: null
    },
    document: {
      document_version: 5,
      checksum: "checksum",
      manifest: {
        format_version: 2,
        project_id: "project-clean",
        name: "Clean Start",
        description: "",
        created_at: timestamp,
        updated_at: timestamp,
        saved_revision: 0,
        settings_version: PROJECT_SETTINGS_VERSION,
        settings: createDefaultProjectSettings(),
        asset_paths: []
      },
      project_metadata: {},
      nodes: [],
      edges: [],
      issues: [],
      suggestions: [],
      engine_tags: [],
      placements: [],
      dialogues: [],
      quests: [],
      story_flows: [],
      story_flow_nodes: [],
      flow_transitions: [],
      scene_flow_boundaries: [],
      flow_invocations: [],
      flow_exits: [],
      flow_exit_bindings: [],
      flow_initial_states: [],
      narrative_effects: [],
      narrative_effect_bindings: []
    }
  };
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
    status
  });
}
